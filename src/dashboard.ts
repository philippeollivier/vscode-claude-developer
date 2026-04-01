import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionInfo, SubagentInfo, DashboardSettings, SetupStatus } from './types';
import { escapeHtml, renderMarkdown } from './utils';
import { getOpenClaudeFiles, findTabsByUri } from './tabs';
import { getConfig } from './config';
import { tailSessionMessages, parseSubagents } from './session';
import { setDashboardCallbacks } from './state';
import { closeTerminalForEditor, forkSession, openTaskTerminal, withSyncGuard } from './terminal';
import { checkSetupStatus } from './setup';
import { getRegistry } from './registry';
import { DASHBOARD_REFRESH_INTERVAL_MS, CONFIG_NAMESPACE } from './constants';
import { getDashboardCss } from './dashboard-styles';
import { getCardsHtml, renderToggleSetting, renderSelectSetting, renderHealthCheck } from './dashboard-view';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const dashboardState = {
    panel: undefined as vscode.WebviewPanel | undefined,
    context: undefined as vscode.ExtensionContext | undefined,
    interval: undefined as ReturnType<typeof setInterval> | undefined,
    canPostMessage: false,
    disposables: [] as vscode.Disposable[],
    tailCache: new Map<string, { mtimeMs: number; result: string }>(),
};

// Backward-compatible re-exports (extension.ts imports dashboardPanel).
// Prefer getDashboardPanel() / getExtensionContext() for new code.
export let dashboardPanel: vscode.WebviewPanel | undefined;
export let extensionContext: vscode.ExtensionContext | undefined;

export function getDashboardPanel(): vscode.WebviewPanel | undefined { return dashboardState.panel; }
export function getExtensionContext(): vscode.ExtensionContext | undefined { return dashboardState.context; }

/** Keep the legacy exported `let` variables in sync with dashboardState. */
function syncExports(): void {
    dashboardPanel = dashboardState.panel;
    extensionContext = dashboardState.context;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Validate the path on the message, look up the registry entry, and return both.
 * Returns `undefined` if the path is unsafe or has no registry entry.
 * When `warnIfMissing` is true a VS Code warning is shown when no terminal exists.
 */
function resolveRegistryEntry(msgPath: string, warnIfMissing = false) {
    if (!isPathSafe(msgPath)) { return undefined; }
    const entry = getRegistry().get(msgPath);
    if (!entry?.terminal && warnIfMissing) {
        vscode.window.showWarningMessage(`No terminal found for ${path.basename(msgPath, '.claude')}`);
    }
    return entry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setExtensionContext(ctx: vscode.ExtensionContext): void {
    dashboardState.context = ctx;
    syncExports();
}

// ---------------------------------------------------------------------------
// Message-handler functions (one per webview command)
// ---------------------------------------------------------------------------

async function handleRefresh(): Promise<void> {
    refreshDashboard();
}

async function handleOpen(msg: any): Promise<void> {
    if (!msg.path || !isPathSafe(msg.path as string)) { return; }
    const uri = vscode.Uri.file(msg.path as string);
    const tabs = findTabsByUri(uri.toString());
    const viewColumn = tabs.length > 0 ? tabs[0].group.viewColumn : vscode.ViewColumn.One;
    vscode.window.showTextDocument(uri, { viewColumn, preserveFocus: false });
}

async function handleRevealTerminal(msg: any): Promise<void> {
    if (!msg.path) { return; }
    const entry = resolveRegistryEntry(msg.path as string, true);
    if (entry?.terminal) {
        withSyncGuard(() => entry.terminal!.show(false));
    }
}

async function handleSetting(msg: any): Promise<void> {
    if (!msg.key) { return; }
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const settingKey = (msg.key as string).replace(`${CONFIG_NAMESPACE}.`, '');
    await config.update(settingKey, msg.value, vscode.ConfigurationTarget.Global);
}

async function handleFork(msg: any): Promise<void> {
    if (!msg.path || !dashboardState.context) { return; }
    if (!isPathSafe(msg.path as string)) { return; }
    await forkSession(vscode.Uri.file(msg.path).toString(), dashboardState.context);
    refreshDashboard();
}

async function handleClose(msg: any): Promise<void> {
    if (!msg.path || !isPathSafe(msg.path as string)) { return; }
    await closeTabByPath(msg.path as string);
    refreshDashboard();
}

async function handleCreate(msg: any): Promise<void> {
    if (!msg.dir || !isPathSafe(msg.dir as string)) { return; }
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

async function handleSendMessage(msg: any): Promise<void> {
    if (!msg.path) { return; }
    const entry = resolveRegistryEntry(msg.path as string, true);
    if (entry?.terminal) {
        const text = await vscode.window.showInputBox({
            prompt: `Send to ${path.basename(msg.path as string, '.claude')}`,
            placeHolder: 'Type a message...',
        });
        if (text) {
            entry.terminal.sendText(text);
        }
    }
}

async function handleSendSkill(msg: any): Promise<void> {
    if (!msg.path || !msg.skill) { return; }
    const entry = resolveRegistryEntry(msg.path as string, true);
    if (entry?.terminal) {
        entry.terminal.sendText(msg.skill as string);
    }
}

async function handleDelete(msg: any): Promise<void> {
    if (!msg.path || !isPathSafe(msg.path as string)) { return; }
    const filePath = msg.path as string;
    await closeTabByPath(filePath);
    try { fs.unlinkSync(filePath); } catch {}
    refreshDashboard();
}

async function handleRunTask(msg: any): Promise<void> {
    if (!msg.dir || !msg.skill || !isPathSafe(msg.dir as string)) { return; }
    const skill = msg.skill as string;
    const details = await vscode.window.showInputBox({
        prompt: `${skill} — enter details (or leave empty)`,
        placeHolder: 'e.g. issue number, description...',
    });
    if (details === undefined) { return; } // cancelled
    const fullCommand = details ? `${skill} ${details}` : skill;
    if (dashboardState.context) {
        await openTaskTerminal(msg.dir as string, fullCommand, dashboardState.context);
        refreshDashboard();
    }
}

async function handleAddTaskCommand(msg: any): Promise<void> {
    if (!msg.dir || !isPathSafe(msg.dir as string)) { return; }
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
        dashboardState.canPostMessage = false;
        refreshDashboard();
    }
}

async function handleRevealTaskTerminal(msg: any): Promise<void> {
    if (!msg.taskId) { return; }
    const entry = getRegistry().get(msg.taskId as string);
    if (entry?.terminal) {
        withSyncGuard(() => entry.terminal!.show(false));
    }
}

async function handleConfigureHooks(): Promise<void> {
    vscode.commands.executeCommand('tabTerminal.configureHooks');
}

async function handleExpandAgent(msg: any): Promise<void> {
    if (!msg.logPath) { return; }
    try {
        const lines = await tailSessionMessages(msg.logPath as string, 8);
        const html = lines.map(l => {
            const isUser = l.startsWith('>');
            const rendered = renderMarkdown(escapeHtml(l));
            return `<div class="tail-line ${isUser ? 'tail-user' : ''}">${rendered}</div>`;
        }).join('');
        dashboardState.panel?.webview.postMessage({
            command: 'agentContent',
            logPath: msg.logPath,
            html: html || '<em>No messages yet</em>',
        });
    } catch {
        dashboardState.panel?.webview.postMessage({
            command: 'agentContent',
            logPath: msg.logPath,
            html: '<em>Could not read agent log</em>',
        });
    }
}

async function handleCreateSection(): Promise<void> {
    const dir = await vscode.window.showInputBox({
        prompt: 'Directory path for the new section',
        placeHolder: '/Users/you/projects/my-project',
        validateInput: (v) => {
            const trimmed = v.trim();
            if (!trimmed) { return 'Path cannot be empty'; }
            if (!path.isAbsolute(trimmed)) { return 'Path must be absolute'; }
            return undefined;
        },
    });
    if (!dir) { return; }
    const dirPath = dir.trim();

    // Create directory if it doesn't exist
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    const name = await vscode.window.showInputBox({
        prompt: 'New .claude file name',
        placeHolder: 'my-task',
        validateInput: (v) => {
            const trimmed = v.trim();
            if (!trimmed) { return 'Name cannot be empty'; }
            if (trimmed !== v) { return 'No leading or trailing spaces'; }
            const baseName = trimmed.replace(/\.claude$/, '');
            if (/[/\\:]/.test(baseName)) { return 'Invalid characters'; }
            if (/^\.{1,2}$/.test(baseName)) { return 'Name cannot be just dots'; }
            return undefined;
        },
    });
    if (!name) { return; }

    let fileName = name.trim();
    if (!fileName.endsWith('.claude')) { fileName += '.claude'; }
    const filePath = path.join(dirPath, fileName);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    refreshDashboard();
}

async function handleCloseTask(msg: any): Promise<void> {
    if (!msg.taskId) { return; }
    const entry = getRegistry().get(msg.taskId as string);
    if (entry?.terminal) {
        entry.terminal.dispose();
    }
    getRegistry().unregister(msg.taskId as string);
    refreshDashboard();
}

// ---------------------------------------------------------------------------
// Command dispatch map
// ---------------------------------------------------------------------------

const messageHandlers: Record<string, (msg: any) => Promise<void>> = {
    'refresh': handleRefresh,
    'open': handleOpen,
    'revealTerminal': handleRevealTerminal,
    'setting': handleSetting,
    'fork': handleFork,
    'close': handleClose,
    'create': handleCreate,
    'sendMessage': handleSendMessage,
    'sendSkill': handleSendSkill,
    'delete': handleDelete,
    'runTask': handleRunTask,
    'addTaskCommand': handleAddTaskCommand,
    'revealTaskTerminal': handleRevealTaskTerminal,
    'configureHooks': handleConfigureHooks,
    'expandAgent': handleExpandAgent,
    'closeTask': handleCloseTask,
    'createSection': handleCreateSection,
};

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

export function getDashboardHtml(sessions: SessionInfo[], summaries: Map<string, string>, settings: DashboardSettings, subagents: Map<string, SubagentInfo[]> = new Map(), setupStatus?: SetupStatus): string {
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
                <h3>Setup Status</h3>
                ${setupStatus ? renderHealthCheck(setupStatus) : '<div class="health-row">Loading...</div>'}
            </div>
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

        function createMenuItem(label, onClick, className) {
            const item = document.createElement('div');
            item.className = 'context-menu-item' + (className ? ' ' + className : '');
            item.innerHTML = label;
            item.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
            return item;
        }

        function showCardMenu(e, cardPath) {
            e.preventDefault();
            e.stopPropagation();
            dismissCardMenu();

            const menu = document.createElement('div');
            menu.className = 'context-menu';

            const card = e.target.closest('.card') || document.querySelector('.card[data-path="' + cardPath + '"]');
            const isFork = card && card.dataset.fork === '1';

            menu.appendChild(createMenuItem('Send message\u2026', () => {
                dismissCardMenu();
                vscode.postMessage({ command: 'sendMessage', path: cardPath });
            }));

            menu.appendChild(createMenuItem('Fork session', () => {
                dismissCardMenu();
                vscode.postMessage({ command: 'fork', path: cardPath });
            }));

            if (isFork) {
                menu.appendChild(createMenuItem('Delete fork', () => {
                    dismissCardMenu();
                    vscode.postMessage({ command: 'delete', path: cardPath });
                }, 'context-menu-item-danger'));
            }

            if (skills.length > 0) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                menu.appendChild(sep);

                skills.forEach(skill => {
                    menu.appendChild(createMenuItem(
                        '<span class="skill-slash">/</span>' + skill.replace(/^\\//, ''),
                        () => {
                            vscode.postMessage({ command: 'sendSkill', path: cardPath, skill: skill });
                            dismissCardMenu();
                        }
                    ));
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

        // Agent chain of thought viewer
        function toggleAgent(row, logPath) {
            const existing = row.nextElementSibling;
            if (existing && existing.classList.contains('agent-content')) {
                existing.remove();
                return;
            }
            const container = document.createElement('div');
            container.className = 'agent-content';
            container.dataset.logPath = logPath;
            container.textContent = 'Loading...';
            row.after(container);
            vscode.postMessage({ command: 'expandAgent', logPath: logPath });
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'agentContent' && msg.logPath) {
                const containers = document.querySelectorAll('.agent-content');
                for (const c of containers) {
                    if (c.dataset.logPath === msg.logPath) {
                        c.innerHTML = msg.html || '<em>No messages yet</em>';
                    }
                }
            }
        });

        // Keyboard navigation
        let selectedIndex = -1;
        let hoveredIndex = -1;

        function getCards() {
            return Array.from(document.querySelectorAll('#content .card'));
        }

        function selectCard(index) {
            const cards = getCards();
            if (cards.length === 0) return;
            cards.forEach(c => c.classList.remove('selected'));
            if (index < 0) index = 0;
            if (index >= cards.length) index = cards.length - 1;
            selectedIndex = index;
            cards[selectedIndex].classList.add('selected');
            cards[selectedIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        // Track mouse hover so keyboard nav starts from hovered card
        document.addEventListener('mouseover', (e) => {
            const card = e.target.closest('.card');
            if (card) {
                const cards = getCards();
                hoveredIndex = cards.indexOf(card);
            }
        });

        // Mouse movement exits keyboard mode and clears keyboard selection
        document.addEventListener('mousemove', () => {
            if (document.body.classList.contains('keyboard-nav')) {
                document.body.classList.remove('keyboard-nav');
                getCards().forEach(c => c.classList.remove('selected'));
                selectedIndex = -1;
            }
        });

        document.addEventListener('keydown', (e) => {
            if (activeMenu) return;
            if (document.activeElement && document.activeElement.tagName === 'INPUT') return;

            const cards = getCards();
            if (cards.length === 0) return;

            if (e.key === 'ArrowDown' || e.key === 'j') {
                e.preventDefault();
                document.body.classList.add('keyboard-nav');
                if (selectedIndex < 0 && hoveredIndex >= 0) {
                    selectCard(hoveredIndex);
                } else {
                    selectCard(selectedIndex + 1);
                }
            } else if (e.key === 'ArrowUp' || e.key === 'k') {
                e.preventDefault();
                document.body.classList.add('keyboard-nav');
                if (selectedIndex < 0 && hoveredIndex >= 0) {
                    selectCard(hoveredIndex);
                } else {
                    selectCard(selectedIndex - 1);
                }
            } else if (e.key === 'Escape') {
                document.body.classList.remove('keyboard-nav');
                cards.forEach(c => c.classList.remove('selected'));
                selectedIndex = -1;
            } else if (e.key === 'Enter' && selectedIndex >= 0 && selectedIndex < cards.length) {
                e.preventDefault();
                const card = cards[selectedIndex];
                const taskId = card.dataset.taskId;
                const cardPath = card.dataset.path;
                if (taskId) {
                    vscode.postMessage({ command: 'revealTaskTerminal', taskId: taskId });
                } else if (cardPath) {
                    if (e.metaKey) {
                        vscode.postMessage({ command: 'revealTerminal', path: cardPath });
                    } else {
                        vscode.postMessage({ command: 'open', path: cardPath });
                    }
                }
            }
        });

        // Preserve selection across content updates
        window.addEventListener('message', event => {
            if (event.data.command === 'updateContent' && selectedIndex >= 0) {
                setTimeout(() => selectCard(selectedIndex), 0);
            }
        });

        function showTaskPicker(e, dir) {
            e.preventDefault();
            e.stopPropagation();
            dismissCardMenu();

            const menu = document.createElement('div');
            menu.className = 'context-menu';

            skills.forEach(skill => {
                menu.appendChild(createMenuItem(
                    '<span class="skill-slash">/</span>' + skill.replace(/^\\//, ''),
                    () => {
                        dismissCardMenu();
                        vscode.postMessage({ command: 'runTask', dir: dir, skill: skill });
                    }
                ));
            });

            const sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);

            menu.appendChild(createMenuItem('Add command\u2026', () => {
                dismissCardMenu();
                vscode.postMessage({ command: 'addTaskCommand', dir: dir });
            }));

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

// ---------------------------------------------------------------------------
// Refresh / auto-refresh
// ---------------------------------------------------------------------------

export async function refreshDashboard(): Promise<void> {
    if (!dashboardState.panel) { return; }

    const sessions = await getOpenClaudeFiles();
    const summaries = new Map<string, string>();
    const subagentMap = new Map<string, SubagentInfo[]>();

    for (const s of sessions) {
        if (!s.logPath) { continue; }
        try {
            let tailResult: string;
            const stat = await fs.promises.stat(s.logPath);
            const cached = dashboardState.tailCache.get(s.logPath);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                tailResult = cached.result;
            } else {
                const lines = await tailSessionMessages(s.logPath, 12);
                tailResult = lines.map(l => escapeHtml(l)).join('\n');
                dashboardState.tailCache.set(s.logPath, { mtimeMs: stat.mtimeMs, result: tailResult });
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

    if (dashboardState.canPostMessage) {
        dashboardState.panel.webview.postMessage({
            command: 'updateContent',
            html: getCardsHtml(sessions, summaries, subagentMap),
        });
    } else {
        const setupStatus = dashboardState.context ? await checkSetupStatus(dashboardState.context) : undefined;
        dashboardState.panel.webview.html = getDashboardHtml(sessions, summaries, getConfig(), subagentMap, setupStatus);
        dashboardState.canPostMessage = true;
    }
}

export function startDashboardAutoRefresh(): void {
    stopDashboardAutoRefresh();
    dashboardState.interval = setInterval(() => {
        if (dashboardState.panel?.visible) { refreshDashboard(); }
    }, DASHBOARD_REFRESH_INTERVAL_MS);
}

export function stopDashboardAutoRefresh(): void {
    if (dashboardState.interval) { clearInterval(dashboardState.interval); dashboardState.interval = undefined; }
}

// ---------------------------------------------------------------------------
// Open / create the dashboard panel
// ---------------------------------------------------------------------------

export async function openDashboard(): Promise<void> {
    if (dashboardState.panel) {
        dashboardState.panel.reveal();
    } else {
        dashboardState.disposables.forEach(d => d.dispose());
        dashboardState.disposables = [];
        dashboardState.panel = vscode.window.createWebviewPanel(
            'claudeDashboard', 'Dashboard', vscode.ViewColumn.One,
            { enableScripts: true },
        );
        syncExports();
        if (dashboardState.context) {
            dashboardState.panel.iconPath = vscode.Uri.joinPath(dashboardState.context.extensionUri, 'claude-icon.svg');
        }
        dashboardState.disposables.push(dashboardState.panel.onDidDispose(() => {
            dashboardState.panel = undefined;
            dashboardState.canPostMessage = false;
            syncExports();
            stopDashboardAutoRefresh();
            dashboardState.disposables.forEach(d => d.dispose());
            dashboardState.disposables = [];
        }));
        dashboardState.disposables.push(dashboardState.panel.onDidChangeViewState(() => {
            if (dashboardState.panel?.visible) {
                dashboardState.canPostMessage = false;
                refreshDashboard();
            }
        }));
        dashboardState.disposables.push(dashboardState.panel.webview.onDidReceiveMessage(async (msg) => {
            const handler = messageHandlers[msg.command];
            if (handler) { await handler(msg); }
        }));
        startDashboardAutoRefresh();
    }
    refreshDashboard();
}

// ---------------------------------------------------------------------------
// Wire up external callbacks
// ---------------------------------------------------------------------------

setDashboardCallbacks(
    () => refreshDashboard(),
    () => dashboardState.panel?.visible ?? false,
    () => openDashboard(),
    (claudeFile: string) => {
        const registry = getRegistry();
        const entry = registry.getByClaudeFile(claudeFile);
        if (entry) {
            vscode.window.showTextDocument(vscode.Uri.file(entry.filePath));
        }
    },
);
