import * as vscode from 'vscode';
import * as path from 'path';
import { isClaudeFile } from './utils';
import { forEachClaudeTab } from './tabs';
import { getConfig, initConfig } from './config';
import {
    editorTerminalMap,
    managedTerminals,
    isSyncing,
    openTerminalForEditor,
    closeTerminalForEditor,
    cleanupTerminal,
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

// Track the last-navigated index for cycling through waiting agents
let goToNotificationIndex = 0;

export function activate(context: vscode.ExtensionContext) {
    console.log('Claude Developer extension is now active');
    setExtensionContext(context);
    initConfig(context);

    // Create status bar item (left side, high priority to be visible)
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'tabTerminal.goToNotification';
    statusBarItem.text = '$(check) Agents active';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    setStatusBarItem(statusBarItem);

    // Set custom editor label for .claude files to hide extension and directory (one-time)
    const labelConfig = vscode.workspace.getConfiguration('workbench.editor.customLabels');
    const patterns = labelConfig.get<Record<string, string>>('patterns', {});
    if (!patterns || patterns['**/*.claude'] !== '${filename}') {
        const updated = { ...patterns, '**/*.claude': '${filename}' };
        labelConfig.update('patterns', updated, vscode.ConfigurationTarget.Global);
    }

    // Command to manually open a terminal for the current tab
    const openTerminalCommand = vscode.commands.registerCommand(
        'tabTerminal.openTerminalForTab',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                openTerminalForEditor(editor, context);
            } else {
                vscode.window.showInformationMessage('No active editor to pair with terminal');
            }
        }
    );

    // Command to close the terminal for the current tab
    const closeTerminalCommand = vscode.commands.registerCommand(
        'tabTerminal.closeTerminalForTab',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                closeTerminalForEditor(editor.document.uri.toString());
            }
        }
    );

    // Command to toggle auto-terminal feature
    const toggleAutoCommand = vscode.commands.registerCommand(
        'tabTerminal.toggleAutoTerminal',
        async () => {
            const current = getConfig().autoOpenTerminal;
            await vscode.workspace.getConfiguration('tabTerminal').update('autoOpenTerminal', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Auto Terminal: ${!current ? 'Enabled' : 'Disabled'}`
            );
        }
    );

    // Listen for when a text editor becomes active
    const editorChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || isSyncing) {
            return;
        }

        if (getConfig().autoOpenTerminal) {
            // Only auto-open/swap terminals for .claude files
            if (!isClaudeFile(editor.document.uri.fsPath)) {
                return;
            }

            // Check if this editor already has a terminal
            const uri = editor.document.uri.toString();
            if (!editorTerminalMap.has(uri)) {
                openTerminalForEditor(editor, context);
            } else {
                // Focus the existing terminal for this editor
                const terminal = editorTerminalMap.get(uri);
                if (terminal) {
                    withSyncGuard(() => terminal.show(true));
                }
            }
        }
    });

    // Listen for when a terminal becomes active -- swap to its paired .claude file
    const terminalChangeListener = vscode.window.onDidChangeActiveTerminal(async (terminal) => {
        if (!terminal || isSyncing || !managedTerminals.has(terminal)) {
            return;
        }

        // Reverse lookup: find the URI paired with this terminal
        let pairedUri: string | undefined;
        for (const [uri, t] of editorTerminalMap.entries()) {
            if (t === terminal) {
                pairedUri = uri;
                break;
            }
        }

        if (pairedUri) {
            const docUri = vscode.Uri.parse(pairedUri);
            if (isClaudeFile(docUri.fsPath)) {
                withSyncGuard(() => vscode.window.showTextDocument(docUri, { preserveFocus: true }));
            }
        }
    });

    // Listen for tab closes to dispose paired terminals
    const tabCloseListener = vscode.window.tabGroups.onDidChangeTabs(async (event) => {
        for (const tab of event.closed) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri.toString();
                const filePath = tab.input.uri.fsPath;

                if (isClaudeFile(filePath) && editorTerminalMap.has(uri)) {
                    const confirmClose = getConfig().confirmCloseClaudeFile;
                    if (confirmClose) {
                        const choice = await vscode.window.showWarningMessage(
                            'Closing this .claude file will also close its paired terminal. Continue?',
                            { modal: true },
                            'Close'
                        );
                        if (choice === 'Close') {
                            closeTerminalForEditor(uri);
                        } else {
                            await vscode.commands.executeCommand('vscode.open', tab.input.uri);
                        }
                    } else {
                        closeTerminalForEditor(uri);
                    }
                } else {
                    closeTerminalForEditor(uri);
                }
            }
        }
    });

    // Listen for when a terminal is closed (cleanup our tracking)
    const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
        if (managedTerminals.has(terminal)) {
            cleanupTerminal(terminal);
        }
    });

    // Close all non-.claude editors and unmanaged terminals
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

        // Close all tabs in one batch call
        if (tabsToClose.length) {
            await vscode.window.tabGroups.close(tabsToClose);
        }

        for (const terminal of vscode.window.terminals) {
            if (!managedTerminals.has(terminal)) {
                terminal.dispose();
            }
        }
    }

    // Open terminals for all open .claude tabs that don't already have one
    async function openTerminalsForAllClaudeFiles() {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText && isClaudeFile(tab.input.uri.fsPath)) {
                    const uri = tab.input.uri.toString();
                    if (!editorTerminalMap.has(uri)) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(tab.input.uri);
                            const editor = { document: doc } as vscode.TextEditor;
                            openTerminalForEditor(editor, context);
                        } catch (err) {
                            console.error(`Failed to open terminal for ${tab.input.uri.fsPath}:`, err);
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

    // Auto-close non-claude files, then open terminals and dashboard
    async function initializeWorkspace() {
        await closeNonClaudeFiles();
        await openTerminalsForAllClaudeFiles();
        openDashboard();
    }

    const autoSetup = getConfig().autoSetupOnStart;
    if (autoSetup) {
        // onStartupFinished activation ensures workspace is ready; defer to next tick
        // to let VS Code finish rendering before we close/open tabs
        setTimeout(() => { initializeWorkspace(); }, 0);
    }

    // Start watching hook state directory globally (for status bar + dashboard refresh)
    startGlobalStateWatcher();
    updateStatusBar();

    const dashboardCommand = vscode.commands.registerCommand(
        'tabTerminal.openDashboard',
        () => openDashboard()
    );

    const goToNotificationCommand = vscode.commands.registerCommand(
        'tabTerminal.goToNotification',
        () => {
            // Cycle through waiting agents (already filtered to open tabs with mtime checks)
            const waiting = getWaitingAgents();
            if (waiting.length === 0) {
                vscode.window.showInformationMessage('No agents need attention');
                return;
            }
            // Sort by timestamp, most recent first
            waiting.sort((a, b) => b.state.timestamp - a.state.timestamp);
            // Wrap the index if it's out of bounds
            if (goToNotificationIndex >= waiting.length) {
                goToNotificationIndex = 0;
            }
            const target = waiting[goToNotificationIndex];
            goToNotificationIndex = (goToNotificationIndex + 1) % waiting.length;
            // Find and focus the matching open tab
            let found = false;
            forEachClaudeTab((uri, fsPath) => {
                if (!found && path.basename(fsPath, '.claude') === target.file) {
                    vscode.window.showTextDocument(uri);
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
    // Clean up all managed terminals
    for (const terminal of managedTerminals) {
        terminal.dispose();
    }
    editorTerminalMap.clear();
    managedTerminals.clear();
}
