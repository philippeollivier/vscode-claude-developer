import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Map to track which terminal belongs to which editor (by document URI)
const editorTerminalMap = new Map<string, vscode.Terminal>();

// Track terminals we created so we can identify them
const managedTerminals = new Set<vscode.Terminal>();

// Guard to prevent infinite loops between editor↔terminal sync
let isSyncing = false;

function isClaudeFile(fsPath: string): boolean {
    return fsPath.endsWith('.claude');
}

// ── Dashboard ────────────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'state');

interface HookState {
    type: string; // 'permission_prompt' | 'idle_prompt' | etc.
    timestamp: number;
    message: string;
}

interface SessionInfo {
    claudeFile: string;
    dir: string;
    sessionId: string | undefined;
    logPath: string | undefined;
    lastActive: Date | undefined;
    hookState: HookState | undefined;
}

function readHookState(claudeFile: string, sessionMtime?: Date): HookState | undefined {
    try {
        const stateFile = path.join(STATE_DIR, `${claudeFile}.json`);
        if (!fs.existsSync(stateFile)) { return undefined; }
        const state: HookState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        // Ignore stale states (> 30 min)
        if (Date.now() / 1000 - state.timestamp > 30 * 60) { return undefined; }
        // If session log was modified after the state file was written, agent has resumed
        if (sessionMtime && sessionMtime.getTime() / 1000 > state.timestamp + 2) { return undefined; }
        return state;
    } catch {
        return undefined;
    }
}

const statusColors: Record<string, string> = {
    'status-active': '#3bb44a',
    'status-permission': '#e5534b',
    'status-idle': '#d4a72c',
    'status-other': '#e09b13',
};

function statusLabel(state: HookState | undefined): { text: string; cssClass: string } {
    if (!state) { return { text: 'Active', cssClass: 'status-active' }; }
    switch (state.type) {
        case 'permission_prompt': return { text: 'Pending Permission', cssClass: 'status-permission' };
        case 'idle_prompt': return { text: 'Waiting on User', cssClass: 'status-idle' };
        default: return { text: state.type, cssClass: 'status-other' };
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function renderToggleSetting(label: string, description: string, settingKey: string, checked: boolean): string {
    return `<div class="setting-row">
                    <div>
                        <div class="setting-label">${escapeHtml(label)}</div>
                        <div class="setting-desc">${escapeHtml(description)}</div>
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" ${checked ? 'checked' : ''} onchange="vscode.postMessage({command:'setting', key:'${settingKey}', value:this.checked})">
                        <span class="toggle-slider"></span>
                    </label>
                </div>`;
}

function renderSelectSetting(label: string, description: string, settingKey: string, value: string, options: {value: string, label: string}[]): string {
    const optionsHtml = options.map(o =>
        `<option value="${escapeHtml(o.value)}" ${value === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    ).join('');
    return `<div class="setting-row">
                    <div>
                        <div class="setting-label">${escapeHtml(label)}</div>
                        <div class="setting-desc">${escapeHtml(description)}</div>
                    </div>
                    <div class="select-wrap">
                        <select onchange="vscode.postMessage({command:'setting', key:'${settingKey}', value:this.value})">
                            ${optionsHtml}
                        </select>
                    </div>
                </div>`;
}

/** Lightweight markdown → HTML for tail lines (inline elements + headers/lists) */
function renderMarkdown(escaped: string): string {
    return escaped
        // inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // bold
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // italic
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // headers (strip to bold)
        .replace(/^#{1,6}\s+(.+)/, '<strong>$1</strong>')
        // unordered list bullets
        .replace(/^[-*]\s+/, '&bull; ')
        // numbered list
        .replace(/^\d+\.\s+/, match => match);
}

function readTailChunk(logPath: string, chunkSize: number): string[] {
    const fileSize = fs.statSync(logPath).size;
    const readSize = Math.min(chunkSize, fileSize);
    const readOffset = fileSize - readSize;

    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, 'r');
    try {
        fs.readSync(fd, buf, 0, readSize, readOffset);
    } finally {
        fs.closeSync(fd);
    }

    let lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    // Skip first line if partial (reading from middle of file)
    if (readOffset > 0 && lines.length > 0) {
        lines = lines.slice(1);
    }
    return lines;
}

function parseLastMessages(jsonlLines: string[]): { lastUser: string; lastAssistant: string } {
    let lastUser = '';
    let lastAssistant = '';

    for (const line of jsonlLines) {
        try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
                const text = typeof entry.message.content === 'string'
                    ? entry.message.content : '';
                if (text) { lastUser = text; }
            } else if (entry.type === 'assistant' && entry.message?.content) {
                if (Array.isArray(entry.message.content)) {
                    const textParts = entry.message.content
                        .filter((c: any) => c.type === 'text')
                        .map((c: any) => c.text);
                    if (textParts.length) {
                        lastAssistant = textParts.join('\n');
                    }
                }
            }
        } catch {
            // skip
        }
    }
    return { lastUser, lastAssistant };
}

function tailSessionMessages(logPath: string, maxLines: number = 12): string[] {
    // Try 256KB tail first; fall back to full read if no messages found
    let lines = readTailChunk(logPath, 262144);
    let { lastUser, lastAssistant } = parseLastMessages(lines);

    // If tail chunk missed the messages (e.g. huge tool-use entries), read full file
    if (!lastUser && !lastAssistant) {
        const fileSize = fs.statSync(logPath).size;
        if (fileSize > 262144) {
            const content = fs.readFileSync(logPath, 'utf-8');
            lines = content.split('\n').filter(l => l.trim());
            ({ lastUser, lastAssistant } = parseLastMessages(lines));
        }
    }

    const result: string[] = [];
    if (lastUser) {
        const firstLine = lastUser.split('\n')[0].substring(0, 120);
        result.push(`> ${firstLine}`);
    }
    if (lastAssistant) {
        const asLines = lastAssistant.split('\n');
        const budget = maxLines - result.length;
        result.push(...asLines.slice(-budget));
    }
    return result;
}

/** Iterate all open .claude tabs (deduplicated by fsPath), invoking callback with the URI and fsPath. */
function forEachClaudeTab(callback: (uri: vscode.Uri, fsPath: string) => void): void {
    const seen = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && isClaudeFile(tab.input.uri.fsPath)) {
                const fsPath = tab.input.uri.fsPath;
                if (seen.has(fsPath)) { continue; }
                seen.add(fsPath);
                callback(tab.input.uri, fsPath);
            }
        }
    }
}

function getOpenClaudeFiles(): SessionInfo[] {
    const results: SessionInfo[] = [];

    forEachClaudeTab((_uri, fsPath) => {
        const name = path.basename(fsPath, '.claude');
        const dir = path.dirname(fsPath);
        const sessionId = findExistingSession(dir, name);

        let logPath: string | undefined;
        let lastActive: Date | undefined;
        if (sessionId) {
            const projectDir = dir.replace(/[/ ]/g, '-');
            logPath = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
            try { lastActive = fs.statSync(logPath).mtime; } catch {}
        }

        const hookState = readHookState(name, lastActive);
        results.push({ claudeFile: name, dir, sessionId, logPath, lastActive, hookState });
    });

    return results;
}

interface DashboardSettings {
    autoOpenTerminal: boolean;
    terminalLocation: string;
    autoSetupOnStart: boolean;
    confirmCloseClaudeFile: boolean;
}

function getDashboardHtml(sessions: SessionInfo[], summaries: Map<string, string>, settings: DashboardSettings): string {
    // Group sessions by immediate directory name
    const groups = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
        const list = groups.get(s.dir) ?? [];
        list.push(s);
        groups.set(s.dir, list);
    }

    function renderCard(s: SessionInfo, groupColor: string = ''): string {
        const tailLines = summaries.get(s.claudeFile) ?? '';
        const { text: statusText, cssClass } = statusLabel(s.hookState);
        const filePath = path.join(s.dir, `${s.claudeFile}.claude`);
        const escapedPath = escapeHtml(filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
        const tailHtml = tailLines
            ? tailLines.split('\n').map(l => {
                const isUser = l.startsWith('&gt;');
                const rendered = renderMarkdown(l);
                return `<div class="tail-line ${isUser ? 'tail-user' : ''}">${rendered}</div>`;
            }).join('')
            : '<div class="tail-line tail-empty">No messages</div>';
        return `
            <div class="card" style="${groupColor ? `border-left: 3px solid ${groupColor};` : ''}" onclick="vscode.postMessage({command:'open', path:'${escapedPath}'})" title="Open ${escapeHtml(s.claudeFile)}">
                <div class="card-header">
                    <div class="card-title">
                        <span class="status ${cssClass}"></span>
                        <h2>${escapeHtml(s.claudeFile)}</h2>
                    </div>
                    <div class="card-meta">
                        <span class="status-label ${cssClass}">${escapeHtml(statusText)}</span>
                        <span class="time">${s.lastActive ? timeAgo(s.lastActive) : ''}</span>
                        <button class="card-btn card-btn-close" onclick="event.stopPropagation(); vscode.postMessage({command:'close', path:'${escapedPath}'})" title="Close">&#x2715;</button>
                    </div>
                </div>
                <div class="tail">${tailHtml}</div>
            </div>`;
    }

    // Rotating color palette for group accents (works well on dark themes)
    const groupColors = [
        '#7eb4f0', // soft blue
        '#b89aed', // lavender
        '#6ec8a0', // mint green
        '#e0a36a', // warm amber
        '#e07a9a', // rose
        '#6ac4c4', // teal
        '#c4a95a', // gold
        '#a0a0d0', // periwinkle
    ];

    let body = '';
    let colorIndex = 0;
    for (const [dir, items] of groups) {
        const dirName = path.basename(dir);
        const color = groupColors[colorIndex % groupColors.length];
        colorIndex++;
        body += `<div class="group">
            <h2 class="group-header" style="color: ${color}; border-bottom-color: ${color};">${escapeHtml(dirName)}</h2>
            ${items.map(c => renderCard(c, color)).join('')}
        </div>`;
    }

    return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-panel-background); margin: 0; }
        .group { margin-bottom: 28px; }
        .group-header { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 10px 0; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
        .card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px; margin-bottom: 6px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
        .card:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .card-title { display: flex; align-items: center; gap: 8px; }
        .card-title h2 { margin: 0; font-size: 14px; font-weight: 600; }
        .card-meta { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .status { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        ${Object.entries(statusColors).map(([cls, color]) => `.${cls} { background: ${color}; }`).join('\n        ')}
        .status-label { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
        ${Object.entries(statusColors).map(([cls, color]) => `.status-label.${cls} { background: ${hexToRgba(color, 0.15)}; color: ${color}; }`).join('\n        ')}
        .card-btn { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 4px; opacity: 0; transition: opacity 0.15s; }
        .card:hover .card-btn { opacity: 1; }
        .card-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
        .card-btn-close:hover { color: #e5534b; }
        .time { color: var(--vscode-descriptionForeground); font-size: 11px; }
        .tail { font-size: 10px; font-family: var(--vscode-editor-font-family); line-height: 1.4; color: var(--vscode-descriptionForeground); max-height: 160px; overflow-y: auto; }
        .tail-line { white-space: pre-wrap; word-break: break-word; }
        .tail-line code { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); padding: 1px 4px; border-radius: 3px; font-size: 10px; }
        .tail-line strong { color: var(--vscode-foreground); }
        .tail-user { color: var(--vscode-foreground); }
        .tail-empty { font-style: italic; }
        .empty { color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 20px; }
        .settings-panel { margin-top: 32px; border-top: 1px solid var(--vscode-panel-border); }
        .settings-toggle { display: flex; align-items: center; gap: 6px; padding: 10px 0; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; user-select: none; }
        .settings-toggle:hover { color: var(--vscode-foreground); }
        .settings-toggle .arrow { font-size: 10px; transition: transform 0.15s; }
        .settings-toggle .arrow.open { transform: rotate(90deg); }
        .settings-body { display: none; padding: 0 0 12px 0; }
        .settings-body.open { display: block; }
        .settings-section { margin-bottom: 16px; }
        .settings-section h3 { font-size: 11px; font-weight: 600; color: var(--vscode-foreground); margin: 0 0 8px 0; }
        .setting-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; }
        .setting-label { font-size: 12px; color: var(--vscode-foreground); }
        .setting-desc { font-size: 10px; color: var(--vscode-descriptionForeground); }
        .toggle-switch { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .toggle-slider { position: absolute; inset: 0; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 10px; cursor: pointer; transition: background 0.2s; }
        .toggle-slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: var(--vscode-descriptionForeground); border-radius: 50%; transition: transform 0.2s; }
        .toggle-switch input:checked + .toggle-slider { background: #3bb44a; border-color: #3bb44a; }
        .toggle-switch input:checked + .toggle-slider::before { transform: translateX(16px); background: #fff; }
        .select-wrap { position: relative; }
        .select-wrap select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 8px; font-size: 12px; cursor: pointer; }
        .hotkeys { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
        .hotkey-key { font-family: var(--vscode-editor-font-family); font-size: 11px; background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); padding: 2px 6px; border-radius: 3px; text-align: right; white-space: nowrap; }
        .hotkey-desc { font-size: 12px; color: var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    ${body || '<p class="empty">No open .claude files found.</p>'}
    <div class="settings-panel">
        <div class="settings-toggle" onclick="toggleSettings()">
            <span class="arrow" id="settingsArrow">&#x25B6;</span>
            <span>Settings & Hotkeys</span>
        </div>
        <div class="settings-body" id="settingsBody">
            <div class="settings-section">
                <h3>Settings</h3>
                ${renderToggleSetting('Auto-open terminal', 'Open a paired terminal when switching to a .claude tab', 'tabTerminal.autoOpenTerminal', settings.autoOpenTerminal)}
                ${renderToggleSetting('Auto-setup on start', 'Close non-.claude files and open all terminals on startup', 'tabTerminal.autoSetupOnStart', settings.autoSetupOnStart)}
                ${renderToggleSetting('Confirm close', 'Ask before closing a .claude file with a running terminal', 'tabTerminal.confirmCloseClaudeFile', settings.confirmCloseClaudeFile)}
                ${renderSelectSetting('Terminal location', 'Where to place paired terminals', 'tabTerminal.terminalLocation', settings.terminalLocation, [
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
        function toggleSettings() {
            const body = document.getElementById('settingsBody');
            const arrow = document.getElementById('settingsArrow');
            body.classList.toggle('open');
            arrow.classList.toggle('open');
            const state = vscode.getState() || {};
            state.settingsOpen = body.classList.contains('open');
            vscode.setState(state);
        }
        // Restore state after refresh
        (function() {
            const state = vscode.getState() || {};
            if (state.settingsOpen) {
                document.getElementById('settingsBody').classList.add('open');
                document.getElementById('settingsArrow').classList.add('open');
            }
            if (state.scrollTop) {
                document.documentElement.scrollTop = state.scrollTop;
            }
            // Persist scroll position
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

function timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) { return `${seconds}s ago`; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

let dashboardPanel: vscode.WebviewPanel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let dashboardInterval: ReturnType<typeof setInterval> | undefined;
let globalStateWatcher: fs.FSWatcher | undefined;
let stateWatchDebounce: ReturnType<typeof setTimeout> | undefined;

// Track the last-navigated index for cycling through waiting agents
let goToNotificationIndex = 0;

// Status bar item for agent attention alerts
let statusBarItem: vscode.StatusBarItem | undefined;

function getOpenClaudeFileNames(): Set<string> {
    const names = new Set<string>();
    forEachClaudeTab((_uri, fsPath) => {
        names.add(path.basename(fsPath, '.claude'));
    });
    return names;
}

function getWaitingAgents(): { file: string; state: HookState }[] {
    // Build a map of claudeFile name -> session mtime from open tabs (single pass)
    const openSessions = new Map<string, Date | undefined>();
    forEachClaudeTab((_uri, fsPath) => {
        const name = path.basename(fsPath, '.claude');
        const dir = path.dirname(fsPath);
        const sessionId = findExistingSession(dir, name);
        let mtime: Date | undefined;
        if (sessionId) {
            const projectDir = dir.replace(/[/ ]/g, '-');
            const logPath = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
            try { mtime = fs.statSync(logPath).mtime; } catch {}
        }
        openSessions.set(name, mtime);
    });

    const waiting: { file: string; state: HookState }[] = [];
    try {
        if (!fs.existsSync(STATE_DIR)) { return waiting; }
        for (const file of fs.readdirSync(STATE_DIR)) {
            if (!file.endsWith('.json')) { continue; }
            const claudeFile = file.replace(/\.json$/, '');
            // Only count agents that have an open .claude tab
            if (!openSessions.has(claudeFile)) { continue; }
            const state = readHookState(claudeFile, openSessions.get(claudeFile));
            if (state) { waiting.push({ file: claudeFile, state }); }
        }
    } catch {
        // ignore
    }
    return waiting;
}

function updateStatusBar() {
    if (!statusBarItem) { return; }

    const waiting = getWaitingAgents();
    const permCount = waiting.filter(w => w.state.type === 'permission_prompt').length;
    const idleCount = waiting.filter(w => w.state.type === 'idle_prompt').length;

    if (waiting.length === 0) {
        statusBarItem.text = '$(check) Agents active';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'All agents are running — no attention needed';
    } else {
        const parts: string[] = [];
        if (permCount) { parts.push(`${permCount} permission`); }
        if (idleCount) { parts.push(`${idleCount} idle`); }
        const detail = parts.join(', ');

        statusBarItem.text = `$(bell) ${waiting.length} agent${waiting.length > 1 ? 's' : ''} waiting`;
        statusBarItem.tooltip = `${detail}\nClick to cycle (Cmd+Shift+D)`;
        statusBarItem.backgroundColor = permCount > 0
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

function onStateDirectoryChanged() {
    // Refresh dashboard if visible
    if (dashboardPanel?.visible) { refreshDashboard(); }

    // Update status bar
    updateStatusBar();
}

function startGlobalStateWatcher() {
    stopGlobalStateWatcher();

    try {
        if (!fs.existsSync(STATE_DIR)) { fs.mkdirSync(STATE_DIR, { recursive: true }); }
        globalStateWatcher = fs.watch(STATE_DIR, () => {
            if (stateWatchDebounce) { clearTimeout(stateWatchDebounce); }
            stateWatchDebounce = setTimeout(onStateDirectoryChanged, 500);
        });
    } catch {
        // state dir watch failed
    }
}

function stopGlobalStateWatcher() {
    if (globalStateWatcher) { globalStateWatcher.close(); globalStateWatcher = undefined; }
    if (stateWatchDebounce) { clearTimeout(stateWatchDebounce); stateWatchDebounce = undefined; }
}

function startDashboardAutoRefresh() {
    stopDashboardAutoRefresh();

    // Interval refresh every 10s
    dashboardInterval = setInterval(() => {
        if (dashboardPanel?.visible) { refreshDashboard(); }
    }, 10000);
}

function stopDashboardAutoRefresh() {
    if (dashboardInterval) { clearInterval(dashboardInterval); dashboardInterval = undefined; }
}

async function openDashboard() {
    if (dashboardPanel) {
        dashboardPanel.reveal();
    } else {
        dashboardPanel = vscode.window.createWebviewPanel(
            'claudeDashboard', 'Dashboard', vscode.ViewColumn.One,
            { enableScripts: true },
        );
        if (extensionContext) {
            dashboardPanel.iconPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'claude-icon.svg');
        }
        dashboardPanel.onDidDispose(() => {
            dashboardPanel = undefined;
            stopDashboardAutoRefresh();
        });
        dashboardPanel.onDidChangeViewState(() => {
            if (dashboardPanel?.visible) { refreshDashboard(); }
        });
        dashboardPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'refresh') { refreshDashboard(); }
            if (msg.command === 'open' && msg.path) {
                vscode.window.showTextDocument(vscode.Uri.file(msg.path));
            }
            if (msg.command === 'setting' && msg.key) {
                const config = vscode.workspace.getConfiguration('tabTerminal');
                const settingKey = (msg.key as string).replace('tabTerminal.', '');
                await config.update(settingKey, msg.value, vscode.ConfigurationTarget.Global);
            }
            if (msg.command === 'close' && msg.path) {
                const uri = vscode.Uri.file(msg.path).toString();
                closeTerminalForEditor(uri);
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri) {
                            await vscode.window.tabGroups.close(tab);
                        }
                    }
                }
                refreshDashboard();
            }
        });
        startDashboardAutoRefresh();
    }
    refreshDashboard();
}

function refreshDashboard() {
    if (!dashboardPanel) { return; }

    const sessions = getOpenClaudeFiles();
    const summaries = new Map<string, string>();

    for (const s of sessions) {
        if (!s.logPath) { continue; }
        try {
            const lines = tailSessionMessages(s.logPath, 12);
            summaries.set(s.claudeFile, lines.map(l => escapeHtml(l)).join('\n'));
        } catch {
            // skip
        }
    }

    const config = vscode.workspace.getConfiguration('tabTerminal');
    const settings: DashboardSettings = {
        autoOpenTerminal: config.get<boolean>('autoOpenTerminal', false),
        terminalLocation: config.get<string>('terminalLocation', 'right'),
        autoSetupOnStart: config.get<boolean>('autoSetupOnStart', true),
        confirmCloseClaudeFile: config.get<boolean>('confirmCloseClaudeFile', true),
    };

    dashboardPanel.webview.html = getDashboardHtml(sessions, summaries, settings);
}

// ── Extension Lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    console.log('Claude Developer extension is now active');
    extensionContext = context;

    // Create status bar item (left side, high priority to be visible)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'tabTerminal.goToNotification';
    statusBarItem.text = '$(check) Agents active';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

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
            const config = vscode.workspace.getConfiguration('tabTerminal');
            const current = config.get<boolean>('autoOpenTerminal', false);
            await config.update('autoOpenTerminal', !current, vscode.ConfigurationTarget.Global);
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

        const config = vscode.workspace.getConfiguration('tabTerminal');
        const autoOpen = config.get<boolean>('autoOpenTerminal', false);

        if (autoOpen) {
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
                    isSyncing = true;
                    terminal.show(true); // preserve focus on editor
                    setTimeout(() => { isSyncing = false; }, 100);
                }
            }
        }
    });

    // Listen for when a terminal becomes active — swap to its paired .claude file
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
                isSyncing = true;
                await vscode.window.showTextDocument(docUri, { preserveFocus: true });
                setTimeout(() => { isSyncing = false; }, 100);
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
                    const confirmClose = vscode.workspace.getConfiguration('tabTerminal').get<boolean>('confirmCloseClaudeFile', true);
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

    const autoSetup = vscode.workspace.getConfiguration('tabTerminal').get<boolean>('autoSetupOnStart', true);
    if (autoSetup) {
        setTimeout(() => { initializeWorkspace(); }, 500);
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
        closeNonClaudeCommand,
        dashboardCommand,
        goToNotificationCommand,
        editorChangeListener,
        terminalChangeListener,
        tabCloseListener,
        terminalCloseListener
    );
}

function findExistingSession(cwd: string, claudeFileName: string): string | undefined {
    const projectDir = cwd.replace(/[/ ]/g, '-');
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectDir);

    if (!fs.existsSync(sessionsDir)) {
        return undefined;
    }

    const needle = `Session renamed to: \\"${claudeFileName}\\"`;
    const matches: { sessionId: string; mtime: number }[] = [];

    for (const file of fs.readdirSync(sessionsDir)) {
        if (!file.endsWith('.jsonl')) {
            continue;
        }
        const filePath = path.join(sessionsDir, file);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.includes(needle)) {
                const stat = fs.statSync(filePath);
                matches.push({
                    sessionId: path.basename(file, '.jsonl'),
                    mtime: stat.mtimeMs,
                });
            }
        } catch {
            // skip unreadable files
        }
    }

    if (matches.length === 0) {
        return undefined;
    }

    // Return the most recently modified session
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0].sessionId;
}

function openTerminalForEditor(editor: vscode.TextEditor, context: vscode.ExtensionContext): void {
    const uri = editor.document.uri.toString();

    // Check if terminal already exists for this editor
    if (editorTerminalMap.has(uri)) {
        const existingTerminal = editorTerminalMap.get(uri);
        if (existingTerminal) {
            existingTerminal.show(true);
            return;
        }
    }

    const config = vscode.workspace.getConfiguration('tabTerminal');
    const location = config.get<string>('terminalLocation', 'right');

    // Get the directory of the current file
    const filePath = editor.document.uri.fsPath;
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const isClaudeDoc = isClaudeFile(filePath);
    const displayName = isClaudeDoc ? path.basename(filePath, '.claude') : fileName;

    // Use Claude icon for .claude files
    const iconPath = isClaudeDoc
        ? vscode.Uri.joinPath(context.extensionUri, 'claude-icon.svg')
        : undefined;

    const env = isClaudeDoc
        ? { CLAUDE_FILE: path.basename(filePath, '.claude') }
        : undefined;

    // Create a new terminal with a name based on the file
    const terminal = vscode.window.createTerminal({
        name: displayName,
        cwd: fileDir,
        iconPath,
        env,
        location: location === 'right'
            ? vscode.TerminalLocation.Editor
            : vscode.TerminalLocation.Panel
    });

    // Track this terminal
    editorTerminalMap.set(uri, terminal);
    managedTerminals.add(terminal);

    // If using editor location (right side), we need to move it to a split
    if (location === 'right') {
        // Show the terminal which will create it in the editor area
        terminal.show(true);

        // Move terminal to the side
        vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
    } else {
        terminal.show(true);
    }

    // Auto-start claude for .claude files
    if (isClaudeDoc) {
        const sessionId = findExistingSession(fileDir, displayName);
        if (sessionId) {
            terminal.sendText(`claude --resume "${sessionId}"`);
        } else {
            terminal.sendText(`{ echo '/rename "${displayName}"'; exec < /dev/tty; } | claude`);
        }
    }
}

/**
 * Remove a terminal from both tracking collections (editorTerminalMap and managedTerminals).
 * Does NOT dispose the terminal — callers that need disposal should call terminal.dispose() first.
 */
function cleanupTerminal(terminal: vscode.Terminal): void {
    managedTerminals.delete(terminal);
    for (const [uri, t] of editorTerminalMap.entries()) {
        if (t === terminal) {
            editorTerminalMap.delete(uri);
            break;
        }
    }
}

function closeTerminalForEditor(uri: string): void {
    const terminal = editorTerminalMap.get(uri);
    if (terminal) {
        terminal.dispose();
        cleanupTerminal(terminal);
    }
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
