import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionInfo, SubagentInfo, DashboardSettings } from './types';
import { escapeHtml } from './utils';
import { getOpenClaudeFiles, findTabsByUri } from './tabs';
import { getConfig } from './config';
import { tailSessionMessages, parseSubagents } from './session';
import { setDashboardCallbacks } from './state';
import { closeTerminalForEditor, forkSession, openTaskTerminal, withSyncGuard } from './terminal';
import { getRegistry } from './registry';
import { DASHBOARD_REFRESH_INTERVAL_MS, CONFIG_NAMESPACE } from './constants';
import { getDashboardCss } from './dashboard-styles';
import { getCardsHtml, renderToggleSetting, renderSelectSetting } from './dashboard-view';

export let dashboardPanel: vscode.WebviewPanel | undefined;
export let extensionContext: vscode.ExtensionContext | undefined;

let dashboardInterval: ReturnType<typeof setInterval> | undefined;
let canPostMessage = false;
let panelDisposables: vscode.Disposable[] = [];

const tailCache = new Map<string, { mtimeMs: number; result: string }>();

function isPathSafe(p: string): boolean {
    const normalized = path.normalize(p);
    if (normalized !== p && normalized !== p.replace(/\/$/, '')) { return false; }
    if (!path.isAbsolute(normalized)) { return false; }
    return true;
}

async function closeTabByPath(filePath: string): Promise<void> {
    closeTerminalForEditor(filePath);
    const uri = vscode.Uri.file(filePath).toString();
    for (const tab of findTabsByUri(uri)) {
        await vscode.window.tabGroups.close(tab);
    }
}

export function setExtensionContext(ctx: vscode.ExtensionContext): void {
    extensionContext = ctx;
}

export function getDashboardHtml(sessions: SessionInfo[], summaries: Map<string, string>, settings: DashboardSettings, subagents: Map<string, SubagentInfo[]> = new Map()): string {
    const body = getCardsHtml(sessions, summaries, subagents);

    return `<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        ${getDashboardCss()}
    </style>
</head>
<body>
    <div id="content">${body}</div>
    <div class="settings-panel">
        <div class="settings-toggle" onclick="toggleSettings()">
            <span class="arrow" id="settingsArrow">&#x25B6;</span>
            <span>Settings & Hotkeys</span>
        </div>
        <div class="settings-body" id="settingsBody">
            <div class="settings-section">
                <h3>Settings</h3>
                ${renderToggleSetting('Auto-open terminal', 'Open a paired terminal when switching to a .claude tab', `${CONFIG_NAMESPACE}.autoOpenTerminal`, settings.autoOpenTerminal)}
                ${renderToggleSetting('Auto-setup on start', 'Close non-.claude files and open all terminals on startup', `${CONFIG_NAMESPACE}.autoSetupOnStart`, settings.autoSetupOnStart)}
                ${renderToggleSetting('Confirm close', 'Ask before closing a .claude file with a running terminal', `${CONFIG_NAMESPACE}.confirmCloseClaudeFile`, settings.confirmCloseClaudeFile)}
                ${renderSelectSetting('Terminal location', 'Where to place paired terminals', `${CONFIG_NAMESPACE}.terminalLocation`, settings.terminalLocation, [
                    { value: 'right', label: 'Right' },
                    { value: 'below', label: 'Below' },
                ])}
            </div>
            <div class="settings-section">
                <h3>Hotkeys</h3>
                <div class="hotkeys">
                    <span class="hotkey-key">&#x2318;D</span><span class="hotkey-desc">Open Dashboard</span>
                    <span class="hotkey-key">&#x2318;&#x21E7;D</span><span class="hotkey-desc">Cycle through waiting agents</span>
                </div>
            </div>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const skills = ${JSON.stringify(settings.skills)};

        let activeMenu = null;

        function positionMenu(menu, e) {
            menu.style.left = '0px';
            menu.style.top = '0px';
            const menuRect = menu.getBoundingClientRect();
            let x, y;
            if (e.type === 'contextmenu') {
                x = e.clientX;
                y = e.clientY;
            } else {
                const btnRect = e.currentTarget.getBoundingClientRect();
                x = btnRect.right - menuRect.width;
                y = btnRect.bottom + 4;
            }
            if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
            if (y + menuRect.height > window.innerHeight) y = y - menuRect.height - 4;
            if (x < 4) x = 4;
            if (y < 4) y = 4;
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
        }

        function showCardMenu(e, cardPath) {
            e.preventDefault();
            e.stopPropagation();
            dismissCardMenu();

            const menu = document.createElement('div');
            menu.className = 'context-menu';

            const card = e.target.closest('.card') || document.querySelector('.card[data-path="' + cardPath + '"]');
            const isFork = card && card.dataset.fork === '1';

            // Send message
            const sendItem = document.createElement('div');
            sendItem.className = 'context-menu-item';
            sendItem.textContent = 'Send message\u2026';
            sendItem.addEventListener('click', (ev) => {
                ev.stopPropagation();
                dismissCardMenu();
                vscode.postMessage({ command: 'sendMessage', path: cardPath });
            });
            menu.appendChild(sendItem);

            // Fork
            const forkItem = document.createElement('div');
            forkItem.className = 'context-menu-item';
            forkItem.textContent = 'Fork session';
            forkItem.addEventListener('click', (ev) => {
                ev.stopPropagation();
                dismissCardMenu();
                vscode.postMessage({ command: 'fork', path: cardPath });
            });
            menu.appendChild(forkItem);

            // Delete (forks only)
            if (isFork) {
                const deleteItem = document.createElement('div');
                deleteItem.className = 'context-menu-item context-menu-item-danger';
                deleteItem.textContent = 'Delete fork';
                deleteItem.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    dismissCardMenu();
                    vscode.postMessage({ command: 'delete', path: cardPath });
                });
                menu.appendChild(deleteItem);
            }

            // Skills section
            if (skills.length > 0) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                menu.appendChild(sep);

                skills.forEach(skill => {
                    const item = document.createElement('div');
                    item.className = 'context-menu-item';
                    item.innerHTML = '<span class="skill-slash">/</span>' + skill.replace(/^\\//, '');
                    item.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        vscode.postMessage({ command: 'sendSkill', path: cardPath, skill: skill });
                        dismissCardMenu();
                    });
                    menu.appendChild(item);
                });
            }

            document.body.appendChild(menu);
            activeMenu = menu;
            positionMenu(menu, e);
        }

        function dismissCardMenu() {
            if (activeMenu) {
                activeMenu.remove();
                activeMenu = null;
            }
        }

        document.addEventListener('click', dismissCardMenu);

        function showTaskPicker(e, dir) {
            e.preventDefault();
            e.stopPropagation();
            dismissCardMenu();

            const menu = document.createElement('div');
            menu.className = 'context-menu';

            skills.forEach(skill => {
                const item = document.createElement('div');
                item.className = 'context-menu-item';
                item.innerHTML = '<span class="skill-slash">/</span>' + skill.replace(/^\\//, '');
                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    dismissCardMenu();
                    vscode.postMessage({ command: 'runTask', dir: dir, skill: skill });
                });
                menu.appendChild(item);
            });

            const sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);
            const addItem = document.createElement('div');
            addItem.className = 'context-menu-item';
            addItem.textContent = 'Add command\u2026';
            addItem.addEventListener('click', (ev) => {
                ev.stopPropagation();
                dismissCardMenu();
                vscode.postMessage({ command: 'addTaskCommand', dir: dir });
            });
            menu.appendChild(addItem);

            document.body.appendChild(menu);
            activeMenu = menu;
            positionMenu(menu, e);
        }

        function toggleSettings() {
            const body = document.getElementById('settingsBody');
            const arrow = document.getElementById('settingsArrow');
            body.classList.toggle('open');
            arrow.classList.toggle('open');
            const state = vscode.getState() || {};
            state.settingsOpen = body.classList.contains('open');
            vscode.setState(state);
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'updateContent') {
                const container = document.getElementById('content');
                const cards = container.querySelectorAll('.card');
                let anchorName = null;
                let anchorOffset = 0;
                for (const card of cards) {
                    const rect = card.getBoundingClientRect();
                    if (rect.bottom > 0) {
                        const h2 = card.querySelector('h2');
                        anchorName = h2 ? h2.textContent : null;
                        anchorOffset = rect.top;
                        break;
                    }
                }
                container.innerHTML = msg.html;
                if (anchorName) {
                    const newH2s = container.querySelectorAll('.card h2');
                    for (const h2 of newH2s) {
                        if (h2.textContent === anchorName) {
                            const newRect = h2.closest('.card').getBoundingClientRect();
                            window.scrollBy(0, newRect.top - anchorOffset);
                            break;
                        }
                    }
                }
            }
        });

        (function() {
            const state = vscode.getState() || {};
            if (state.settingsOpen) {
                document.getElementById('settingsBody').classList.add('open');
                document.getElementById('settingsArrow').classList.add('open');
            }
            if (state.scrollTop) {
                document.documentElement.scrollTop = state.scrollTop;
            }
            window.addEventListener('scroll', () => {
                const s = vscode.getState() || {};
                s.scrollTop = document.documentElement.scrollTop;
                vscode.setState(s);
            });
        })();
    </script>
</body>
</html>`;
}

export async function refreshDashboard(): Promise<void> {
    if (!dashboardPanel) { return; }

    const sessions = await getOpenClaudeFiles();
    const summaries = new Map<string, string>();
    const subagentMap = new Map<string, SubagentInfo[]>();

    for (const s of sessions) {
        if (!s.logPath) { continue; }
        try {
            let tailResult: string;
            const stat = await fs.promises.stat(s.logPath);
            const cached = tailCache.get(s.logPath);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                tailResult = cached.result;
            } else {
                const lines = await tailSessionMessages(s.logPath, 12);
                tailResult = lines.map(l => escapeHtml(l)).join('\n');
                tailCache.set(s.logPath, { mtimeMs: stat.mtimeMs, result: tailResult });
            }
            summaries.set(s.claudeFile, tailResult);
            const agents = await parseSubagents(s.logPath);
            if (agents.length > 0) {
                subagentMap.set(s.claudeFile, agents);
            }
        } catch {
            // skip unreadable logs
        }
    }

    if (canPostMessage) {
        dashboardPanel.webview.postMessage({
            command: 'updateContent',
            html: getCardsHtml(sessions, summaries, subagentMap),
        });
    } else {
        dashboardPanel.webview.html = getDashboardHtml(sessions, summaries, getConfig(), subagentMap);
        canPostMessage = true;
    }
}

export function startDashboardAutoRefresh(): void {
    stopDashboardAutoRefresh();
    dashboardInterval = setInterval(() => {
        if (dashboardPanel?.visible) { refreshDashboard(); }
    }, DASHBOARD_REFRESH_INTERVAL_MS);
}

export function stopDashboardAutoRefresh(): void {
    if (dashboardInterval) { clearInterval(dashboardInterval); dashboardInterval = undefined; }
}

export async function openDashboard(): Promise<void> {
    if (dashboardPanel) {
        dashboardPanel.reveal();
    } else {
        panelDisposables.forEach(d => d.dispose());
        panelDisposables = [];
        dashboardPanel = vscode.window.createWebviewPanel(
            'claudeDashboard', 'Dashboard', vscode.ViewColumn.One,
            { enableScripts: true },
        );
        if (extensionContext) {
            dashboardPanel.iconPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'claude-icon.svg');
        }
        panelDisposables.push(dashboardPanel.onDidDispose(() => {
            dashboardPanel = undefined;
            canPostMessage = false;
            stopDashboardAutoRefresh();
            panelDisposables.forEach(d => d.dispose());
            panelDisposables = [];
        }));
        panelDisposables.push(dashboardPanel.onDidChangeViewState(() => {
            if (dashboardPanel?.visible) {
                canPostMessage = false;
                refreshDashboard();
            }
        }));
        panelDisposables.push(dashboardPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'refresh') { refreshDashboard(); }

            if (msg.command === 'open' && msg.path) {
                if (!isPathSafe(msg.path as string)) { return; }
                const uri = vscode.Uri.file(msg.path as string);
                const tabs = findTabsByUri(uri.toString());
                const viewColumn = tabs.length > 0 ? tabs[0].group.viewColumn : vscode.ViewColumn.One;
                vscode.window.showTextDocument(uri, { viewColumn, preserveFocus: false });
            }

            if (msg.command === 'revealTerminal' && msg.path) {
                if (!isPathSafe(msg.path as string)) { return; }
                const entry = getRegistry().get(msg.path as string);
                if (entry?.terminal) {
                    withSyncGuard(() => entry.terminal!.show(false));
                } else {
                    vscode.window.showWarningMessage(`No terminal found for ${path.basename(msg.path as string, '.claude')}`);
                }
            }

            if (msg.command === 'setting' && msg.key) {
                const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
                const settingKey = (msg.key as string).replace(`${CONFIG_NAMESPACE}.`, '');
                await config.update(settingKey, msg.value, vscode.ConfigurationTarget.Global);
            }

            if (msg.command === 'fork' && msg.path && extensionContext) {
                if (!isPathSafe(msg.path as string)) { return; }
                await forkSession(vscode.Uri.file(msg.path).toString(), extensionContext);
                refreshDashboard();
            }

            if (msg.command === 'close' && msg.path) {
                if (!isPathSafe(msg.path as string)) { return; }
                await closeTabByPath(msg.path as string);
                refreshDashboard();
            }

            if (msg.command === 'create' && msg.dir) {
                if (!isPathSafe(msg.dir as string)) { return; }
                const name = await vscode.window.showInputBox({
                    prompt: 'New .claude file name',
                    placeHolder: 'my-task',
                    validateInput: (v) => {
                        const trimmed = v.trim();
                        if (!trimmed) { return 'Name cannot be empty'; }
                        if (trimmed !== v) { return 'Name must not have leading or trailing spaces'; }
                        const baseName = trimmed.replace(/\.claude$/, '');
                        if (/[/\\:]/.test(baseName)) { return 'Invalid characters in name'; }
                        if (/^\.{1,2}$/.test(baseName)) { return 'Name cannot be just dots'; }
                        const RESERVED = /^(CON|PRN|NUL|AUX|COM[1-9]|LPT[1-9])$/i;
                        if (RESERVED.test(baseName)) { return 'Reserved file name'; }
                        return undefined;
                    },
                });
                if (name) {
                    let fileName = name.trim();
                    if (!fileName.endsWith('.claude')) { fileName += '.claude'; }
                    const filePath = path.join(msg.dir as string, fileName);
                    if (!fs.existsSync(filePath)) {
                        fs.writeFileSync(filePath, '');
                    }
                    await vscode.window.showTextDocument(vscode.Uri.file(filePath));
                    refreshDashboard();
                }
            }

            if (msg.command === 'sendMessage' && msg.path) {
                if (!isPathSafe(msg.path as string)) { return; }
                const entry = getRegistry().get(msg.path as string);
                if (entry?.terminal) {
                    const text = await vscode.window.showInputBox({
                        prompt: `Send to ${path.basename(msg.path as string, '.claude')}`,
                        placeHolder: 'Type a message...',
                    });
                    if (text) {
                        entry.terminal.sendText(text);
                    }
                } else {
                    vscode.window.showWarningMessage(`No terminal found for ${path.basename(msg.path as string, '.claude')}`);
                }
            }

            if (msg.command === 'sendSkill' && msg.path && msg.skill) {
                if (!isPathSafe(msg.path as string)) { return; }
                const entry = getRegistry().get(msg.path as string);
                if (entry?.terminal) {
                    entry.terminal.sendText(msg.skill as string);
                } else {
                    vscode.window.showWarningMessage(`No terminal found for ${path.basename(msg.path as string, '.claude')}`);
                }
            }

            if (msg.command === 'delete' && msg.path) {
                if (!isPathSafe(msg.path as string)) { return; }
                const filePath = msg.path as string;
                await closeTabByPath(filePath);
                try { fs.unlinkSync(filePath); } catch {}
                refreshDashboard();
            }

            if (msg.command === 'runTask' && msg.dir && msg.skill) {
                if (!isPathSafe(msg.dir as string)) { return; }
                const skill = msg.skill as string;
                const details = await vscode.window.showInputBox({
                    prompt: `${skill} — enter details (or leave empty)`,
                    placeHolder: 'e.g. issue number, description...',
                });
                if (details === undefined) { return; } // cancelled
                const fullCommand = details ? `${skill} ${details}` : skill;
                if (extensionContext) {
                    await openTaskTerminal(msg.dir as string, fullCommand, extensionContext);
                    refreshDashboard();
                }
            }

            if (msg.command === 'addTaskCommand' && msg.dir) {
                if (!isPathSafe(msg.dir as string)) { return; }
                // Discover all commands from ~/.claude/commands/ and local .claude/commands/
                const commands: string[] = [];
                const globalDir = path.join(os.homedir(), '.claude', 'commands');
                const localDir = path.join(msg.dir as string, '.claude', 'commands');
                for (const dir of [globalDir, localDir]) {
                    try {
                        const files = fs.readdirSync(dir);
                        for (const f of files) {
                            if (f.endsWith('.md')) {
                                const name = '/' + f.replace(/\.md$/, '');
                                if (!commands.includes(name)) { commands.push(name); }
                            }
                        }
                    } catch { /* dir doesn't exist */ }
                }
                const picked = await vscode.window.showQuickPick(commands, {
                    placeHolder: 'Select a command to add to the task menu',
                });
                if (picked) {
                    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
                    const current = config.get<string[]>('skills', []);
                    if (!current.includes(picked)) {
                        await config.update('skills', [...current, picked], vscode.ConfigurationTarget.Global);
                    }
                    canPostMessage = false;
                    refreshDashboard();
                }
            }

            if (msg.command === 'revealTaskTerminal' && msg.taskId) {
                const entry = getRegistry().get(msg.taskId as string);
                if (entry?.terminal) {
                    withSyncGuard(() => entry.terminal!.show(false));
                }
            }

            if (msg.command === 'closeTask' && msg.taskId) {
                const entry = getRegistry().get(msg.taskId as string);
                if (entry?.terminal) {
                    entry.terminal.dispose();
                }
                getRegistry().unregister(msg.taskId as string);
                refreshDashboard();
            }
        }));
        startDashboardAutoRefresh();
    }
    refreshDashboard();
}

setDashboardCallbacks(
    () => refreshDashboard(),
    () => dashboardPanel?.visible ?? false,
    () => openDashboard(),
    (claudeFile: string) => {
        const registry = getRegistry();
        const entry = registry.getByClaudeFile(claudeFile);
        if (entry) {
            vscode.window.showTextDocument(vscode.Uri.file(entry.filePath));
        }
    },
);
