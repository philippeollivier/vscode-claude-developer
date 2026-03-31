import * as vscode from 'vscode';
import * as path from 'path';
import { isClaudeFile } from './utils';
import { forEachClaudeTab, findTabsByUri } from './tabs';
import { getConfig, initConfig } from './config';
import { CONFIG_NAMESPACE } from './constants';
import { SessionRegistry, setRegistry, getRegistry } from './registry';
import {
    isSyncing,
    openTerminalForEditor,
    closeTerminalForEditor,
    withSyncGuard,
    forkSession,
} from './terminal';
import {
    setStatusBarItem,
    getWaitingAgents,
    updateStatusBar,
    startGlobalStateWatcher,
    stopGlobalStateWatcher,
} from './state';
import {
    setExtensionContext,
    openDashboard,
    refreshDashboard,
    dashboardPanel,
    stopDashboardAutoRefresh,
} from './dashboard';

let goToNotificationIndex = 0;

export function activate(context: vscode.ExtensionContext) {
    console.log('Claude Developer extension is now active');

    const registry = new SessionRegistry(context.globalState);
    setRegistry(registry);

    setExtensionContext(context);
    initConfig(context);

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'tabTerminal.goToNotification';
    statusBarItem.text = '$(check) Agents active';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    setStatusBarItem(statusBarItem);

    const labelConfig = vscode.workspace.getConfiguration('workbench.editor.customLabels');
    const patterns = labelConfig.get<Record<string, string>>('patterns', {});
    if (!patterns || patterns['**/*.claude'] !== '${filename}') {
        const updated = { ...patterns, '**/*.claude': '${filename}' };
        labelConfig.update('patterns', updated, vscode.ConfigurationTarget.Global);
    }

    const openTerminalCommand = vscode.commands.registerCommand(
        'tabTerminal.openTerminalForTab',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await openTerminalForEditor(editor, context);
            } else {
                vscode.window.showInformationMessage('No active editor to pair with terminal');
            }
        }
    );

    const closeTerminalCommand = vscode.commands.registerCommand(
        'tabTerminal.closeTerminalForTab',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                closeTerminalForEditor(editor.document.uri.fsPath);
            }
        }
    );

    const toggleAutoCommand = vscode.commands.registerCommand(
        'tabTerminal.toggleAutoTerminal',
        async () => {
            try {
                const current = getConfig().autoOpenTerminal;
                await vscode.workspace.getConfiguration(CONFIG_NAMESPACE).update('autoOpenTerminal', !current, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(
                    `Auto Terminal: ${!current ? 'Enabled' : 'Disabled'}`
                );
            } catch (err) {
                console.error('Claude Developer: failed to toggle auto-terminal:', err);
            }
        }
    );

    const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (!editor || isSyncing) { return; }
        if (!getConfig().autoOpenTerminal) { return; }
        if (!isClaudeFile(editor.document.uri.fsPath)) { return; }

        const filePath = editor.document.uri.fsPath;
        const entry = registry.get(filePath);

        if (entry?.terminal && registry.validateTerminal(filePath)) {
            withSyncGuard(() => entry.terminal!.show(true));
        } else {
            await openTerminalForEditor(editor, context);
        }
    });

    const terminalChangeListener = vscode.window.onDidChangeActiveTerminal(async (terminal) => {
        if (!terminal || isSyncing) { return; }
        if (!registry.isManaged(terminal)) { return; }

        const entry = registry.getByTerminal(terminal);
        if (entry && isClaudeFile(entry.filePath)) {
            const docUri = vscode.Uri.file(entry.filePath);
            const tabs = findTabsByUri(docUri.toString());
            const viewColumn = tabs.length > 0 ? tabs[0].group.viewColumn : undefined;
            withSyncGuard(() => vscode.window.showTextDocument(docUri, { preserveFocus: true, viewColumn }));
        }
    });

    const tabCloseListener = vscode.window.tabGroups.onDidChangeTabs(async (event) => {
        try {
            for (const tab of event.closed) {
                if (!(tab.input instanceof vscode.TabInputText)) { continue; }

                const filePath = tab.input.uri.fsPath;

                if (!isClaudeFile(filePath) || !registry.has(filePath)) {
                    closeTerminalForEditor(filePath);
                    continue;
                }

                const confirmClose = getConfig().confirmCloseClaudeFile;
                if (!confirmClose) {
                    closeTerminalForEditor(filePath);
                    registry.unregister(filePath);
                    continue;
                }

                const choice = await vscode.window.showWarningMessage(
                    'Closing this .claude file will also close its paired terminal. Continue?',
                    { modal: true },
                    'Close'
                );
                if (choice === 'Close') {
                    closeTerminalForEditor(filePath);
                    registry.unregister(filePath);
                } else {
                    await vscode.commands.executeCommand('vscode.open', tab.input.uri);
                }
            }
        } catch (err) {
            console.error('Claude Developer: tab close handler error:', err);
        }
    });

    const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
        registry.clearTerminalByRef(terminal);
    });

    async function closeNonClaudeFiles() {
        const tabsToClose: vscode.Tab[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input instanceof vscode.TabInputText) {
                    if (!isClaudeFile(input.uri.fsPath)) {
                        tabsToClose.push(tab);
                    }
                } else if (input instanceof vscode.TabInputTextDiff) {
                    tabsToClose.push(tab);
                } else if (input instanceof vscode.TabInputWebview) {
                    if (!tab.label.includes('Dashboard')) {
                        tabsToClose.push(tab);
                    }
                } else if (!(input instanceof vscode.TabInputTerminal)) {
                    tabsToClose.push(tab);
                }
            }
        }

        if (tabsToClose.length) {
            await vscode.window.tabGroups.close(tabsToClose);
        }

        for (const terminal of vscode.window.terminals) {
            if (!registry.isManaged(terminal)) {
                terminal.dispose();
            }
        }
    }

    async function openTerminalsForAllClaudeFiles() {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText && isClaudeFile(tab.input.uri.fsPath)) {
                    const filePath = tab.input.uri.fsPath;
                    const entry = registry.get(filePath);
                    if (!entry?.terminal || !registry.validateTerminal(filePath)) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(tab.input.uri);
                            const editor = { document: doc } as vscode.TextEditor;
                            await openTerminalForEditor(editor, context);
                        } catch (err) {
                            console.error(`Failed to open terminal for ${filePath}:`, err);
                        }
                    }
                }
            }
        }
    }

    const forkCommand = vscode.commands.registerCommand(
        'tabTerminal.forkSession',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isClaudeFile(editor.document.uri.fsPath)) {
                vscode.window.showInformationMessage('Open a .claude file to fork');
                return;
            }
            await forkSession(editor.document.uri.toString(), context);
        }
    );

    const closeNonClaudeCommand = vscode.commands.registerCommand(
        'tabTerminal.closeNonClaudeFiles',
        () => closeNonClaudeFiles()
    );

    async function initializeWorkspace() {
        await closeNonClaudeFiles();
        await openTerminalsForAllClaudeFiles();
        openDashboard();
    }

    const autoSetup = getConfig().autoSetupOnStart;
    if (autoSetup) {
        setTimeout(async () => {
            try { await initializeWorkspace(); }
            catch (err) { console.error('Claude Developer: initialization failed:', err); }
        }, 0);
    }

    startGlobalStateWatcher();
    updateStatusBar();

    const dashboardCommand = vscode.commands.registerCommand(
        'tabTerminal.openDashboard',
        () => openDashboard()
    );

    const goToNotificationCommand = vscode.commands.registerCommand(
        'tabTerminal.goToNotification',
        async () => {
            const waiting = await getWaitingAgents();
            if (waiting.length === 0) {
                vscode.window.showInformationMessage('No agents need attention');
                return;
            }
            waiting.sort((a, b) => b.state.timestamp - a.state.timestamp);
            if (goToNotificationIndex >= waiting.length) {
                goToNotificationIndex = 0;
            }
            const target = waiting[goToNotificationIndex];
            goToNotificationIndex = (goToNotificationIndex + 1) % waiting.length;

            let found = false;
            forEachClaudeTab((uri, fsPath) => {
                if (!found && path.basename(fsPath, '.claude') === target.file) {
                    const tabs = findTabsByUri(uri.toString());
                    const viewColumn = tabs.length > 0 ? tabs[0].group.viewColumn : undefined;
                    vscode.window.showTextDocument(uri, { viewColumn });
                    found = true;
                }
            });
        }
    );

    context.subscriptions.push(
        openTerminalCommand,
        closeTerminalCommand,
        toggleAutoCommand,
        forkCommand,
        closeNonClaudeCommand,
        dashboardCommand,
        goToNotificationCommand,
        editorChangeListener,
        terminalChangeListener,
        tabCloseListener,
        terminalCloseListener
    );
}

export function deactivate() {
    stopGlobalStateWatcher();
    stopDashboardAutoRefresh();
    getRegistry().dispose();
}
