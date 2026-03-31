import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionInfo, SubagentInfo, DashboardSettings } from './types';
import { escapeHtml, renderMarkdown, hexToRgba, timeAgo, getForkBase, escapePathForJs, isForkName } from './utils';
import { getOpenClaudeFiles, findTabsByUri } from './tabs';
import { getConfig } from './config';
import { tailSessionMessages, parseSubagents } from './session';
import { statusLabel, statusColors, setDashboardCallbacks } from './state';
import { closeTerminalForEditor, forkSession } from './terminal';
import { getRegistry } from './registry';
import { DASHBOARD_REFRESH_INTERVAL_MS, CONFIG_NAMESPACE } from './constants';

export let dashboardPanel: vscode.WebviewPanel | undefined;
export let extensionContext: vscode.ExtensionContext | undefined;

let dashboardInterval: ReturnType<typeof setInterval> | undefined;
let canPostMessage = false;
let panelDisposables: vscode.Disposable[] = [];

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

export function renderToggleSetting(label: string, description: string, settingKey: string, checked: boolean): string {
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

export function renderSelectSetting(label: string, description: string, settingKey: string, value: string, options: {value: string, label: string}[]): string {
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

export function renderCard(s: SessionInfo, summaries: Map<string, string>, subagents: Map<string, SubagentInfo[]>, groupColor: string = ''): string {
    const tailLines = summaries.get(s.claudeFile) ?? '';
    const agents = subagents.get(s.claudeFile) ?? [];
    const { text: statusText, cssClass } = statusLabel(s.hookState);
    const filePath = path.join(s.dir, `${s.claudeFile}.claude`);
    const escapedPath = escapePathForJs(filePath);
    const isFork = isForkName(s.claudeFile);
    const tailHtml = tailLines
        ? tailLines.split('\n').map(l => {
            const isUser = l.startsWith('&gt;');
            const rendered = renderMarkdown(l);
            return `<div class="tail-line ${isUser ? 'tail-user' : ''}">${rendered}</div>`;
        }).join('')
        : '<div class="tail-line tail-empty">No messages</div>';

    const runningAgents = agents.filter(a => a.running);
    let agentsHtml = '';
    if (runningAgents.length > 0) {
        const runningRows = runningAgents.map(a =>
            `<div class="agent-row agent-running"><span class="agent-dot running"></span><span class="agent-desc">${escapeHtml(a.description)}</span><span class="agent-type">${escapeHtml(a.subagentType)}</span></div>`
        ).join('');
        agentsHtml = `<div class="agents-section">
            <div class="agents-label">${runningAgents.length} agent${runningAgents.length > 1 ? 's' : ''} running</div>
            ${runningRows}
        </div>`;
    }

    const deleteBtn = isFork
        ? `<button class="card-btn card-btn-delete" onclick="event.stopPropagation(); vscode.postMessage({command:'delete', path:'${escapedPath}'})" title="Delete fork">&#x1F5D1;</button>`
        : '';

    const timeText = s.lastActive ? timeAgo(s.lastActive) : '';
    const labelText = timeText ? `${statusText} · ${timeText}` : statusText;

    return `
            <div class="card" data-path="${escapedPath}" style="${groupColor ? `border-left: 3px solid ${groupColor};` : ''}" onclick="vscode.postMessage({command:'open', path:'${escapedPath}'})" title="Open ${escapeHtml(s.claudeFile)}">
                <div class="card-header">
                    <div class="card-title">
                        <span class="status-label ${cssClass}">${escapeHtml(labelText)}</span>
                        <h2>${escapeHtml(s.claudeFile)}</h2>
                    </div>
                    <div class="card-meta">
                        <button class="card-btn card-btn-fork" onclick="event.stopPropagation(); vscode.postMessage({command:'fork', path:'${escapedPath}'})" title="Fork">&#x2387;</button>
                        ${deleteBtn}
                        <button class="card-btn card-btn-close" onclick="event.stopPropagation(); vscode.postMessage({command:'close', path:'${escapedPath}'})" title="Close">&#x2715;</button>
                    </div>
                </div>
                <div class="tail">${tailHtml}</div>
                ${agentsHtml}
            </div>`;
}

const groupColors = [
    '#7eb4f0', '#b89aed', '#6ec8a0', '#e0a36a',
    '#e07a9a', '#6ac4c4', '#c4a95a', '#a0a0d0',
];

/** Sort sessions so forks appear immediately after their parent. */
function sortWithForks(items: SessionInfo[]): SessionInfo[] {
    const byBase = new Map<string, SessionInfo[]>();
    for (const s of items) {
        const base = getForkBase(s.claudeFile);
        const list = byBase.get(base) ?? [];
        list.push(s);
        byBase.set(base, list);
    }
    const sorted: SessionInfo[] = [];
    for (const group of byBase.values()) {
        group.sort((a, b) => {
            const aHasFork = isForkName(a.claudeFile);
            const bHasFork = isForkName(b.claudeFile);
            if (!aHasFork && bHasFork) { return -1; }
            if (aHasFork && !bHasFork) { return 1; }
            return a.claudeFile.localeCompare(b.claudeFile);
        });
        sorted.push(...group);
    }
    return sorted;
}

export function getCardsHtml(sessions: SessionInfo[], summaries: Map<string, string>, subagents: Map<string, SubagentInfo[]> = new Map()): string {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
        const list = groups.get(s.dir) ?? [];
        list.push(s);
        groups.set(s.dir, list);
    }

    let body = '';
    let colorIndex = 0;
    for (const [dir, items] of groups) {
        const dirName = path.basename(dir);
        const color = groupColors[colorIndex % groupColors.length];
        colorIndex++;
        const sorted = sortWithForks(items);
        const escapedDir = escapePathForJs(dir);
        body += `<div class="group">
            <div class="group-header-row">
                <h2 class="group-header" style="color: ${color}; border-bottom-color: ${color};">${escapeHtml(dirName)}</h2>
                <button class="add-btn" style="color: ${color};" onclick="event.stopPropagation(); vscode.postMessage({command:'create', dir:'${escapedDir}'})" title="New .claude file">+</button>
            </div>
            ${sorted.map(c => {
                const isFork = isForkName(c.claudeFile);
                return isFork
                    ? `<div class="fork-child">${renderCard(c, summaries, subagents, color)}</div>`
                    : renderCard(c, summaries, subagents, color);
            }).join('')}
        </div>`;
    }

    return body || '<p class="empty">No open .claude files found.</p>';
}

export function getDashboardHtml(sessions: SessionInfo[], summaries: Map<string, string>, settings: DashboardSettings, subagents: Map<string, SubagentInfo[]> = new Map()): string {
    const body = getCardsHtml(sessions, summaries, subagents);

    return `<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        body { font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-panel-background); margin: 0; }
        .group { margin-bottom: 28px; }
        .group-header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
        .group-header { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; margin: 0; padding: 0; border: none; }
        .add-btn { background: none; border: none; font-size: 18px; font-weight: 600; cursor: pointer; padding: 0 4px; border-radius: 4px; line-height: 1; opacity: 0.6; transition: opacity 0.15s, background 0.15s; }
        .add-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
        .card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px; margin-bottom: 6px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
        .card:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .card-title { display: flex; align-items: center; gap: 8px; }
        .card-title h2 { margin: 0; font-size: 14px; font-weight: 600; }
        .card-meta { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .status-label { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; flex-shrink: 0; }
        ${Object.entries(statusColors).map(([cls, color]) => `.status-label.${cls} { background: ${hexToRgba(color, 0.15)}; color: ${color}; }`).join('\n        ')}
        .card-btn { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 4px; opacity: 0; transition: opacity 0.15s; }
        .card:hover .card-btn { opacity: 1; }
        .card-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
        .card-btn-fork:hover { color: #7eb4f0; }
        .card-btn-delete:hover { color: #e5534b; }
        .card-btn-close:hover { color: #e5534b; }
        .fork-child { margin-left: 20px; position: relative; }
        .fork-child::before { content: '⑂'; position: absolute; left: -16px; top: 14px; color: var(--vscode-descriptionForeground); font-size: 12px; }
        .tail { font-size: 10px; font-family: var(--vscode-editor-font-family); line-height: 1.4; color: var(--vscode-descriptionForeground); max-height: 160px; overflow-y: auto; }
        .tail-line { white-space: pre-wrap; word-break: break-word; }
        .tail-line code { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); padding: 1px 4px; border-radius: 3px; font-size: 10px; }
        .tail-line strong { color: var(--vscode-foreground); }
        .tail-user { color: var(--vscode-foreground); }
        .tail-empty { font-style: italic; }
        .agents-section { margin-top: 8px; border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; }
        .agents-label { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
        .agent-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 10px; }
        .agent-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .agent-dot.running { background: #4ec9b0; animation: pulse 1.5s ease-in-out infinite; }
        .agent-dot.done { background: var(--vscode-descriptionForeground); opacity: 0.4; }
        .agent-desc { color: var(--vscode-foreground); flex: 1; }
        .agent-done .agent-desc { color: var(--vscode-descriptionForeground); }
        .agent-type { color: var(--vscode-descriptionForeground); font-size: 9px; background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); padding: 1px 5px; border-radius: 3px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
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
        .context-menu { position: fixed; z-index: 1000; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 6px; padding: 4px 0; min-width: 180px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .context-menu-item { padding: 6px 14px; font-size: 12px; cursor: pointer; color: var(--vscode-menu-foreground, var(--vscode-foreground)); display: flex; align-items: center; gap: 8px; }
        .context-menu-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
        .context-menu-item .skill-slash { opacity: 0.5; }
        .context-menu-separator { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 4px 0; }
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

        function showContextMenu(e, cardPath) {
            e.preventDefault();
            e.stopPropagation();
            dismissContextMenu();
            if (skills.length === 0) return;

            const menu = document.createElement('div');
            menu.className = 'context-menu';

            skills.forEach(skill => {
                const item = document.createElement('div');
                item.className = 'context-menu-item';
                item.innerHTML = '<span class="skill-slash">/</span>' + skill.replace(/^\\//, '');
                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    vscode.postMessage({ command: 'sendSkill', path: cardPath, skill: skill });
                    dismissContextMenu();
                });
                menu.appendChild(item);
            });

            document.body.appendChild(menu);
            activeMenu = menu;

            const rect = menu.getBoundingClientRect();
            let x = e.clientX, y = e.clientY;
            if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
            if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
            if (x < 0) x = 4;
            if (y < 0) y = 4;
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
        }

        function dismissContextMenu() {
            if (activeMenu) {
                activeMenu.remove();
                activeMenu = null;
            }
        }

        document.addEventListener('click', dismissContextMenu);
        document.addEventListener('contextmenu', (e) => {
            const card = e.target.closest('.card');
            if (!card) { dismissContextMenu(); return; }
            const cardPath = card.dataset.path;
            if (cardPath) showContextMenu(e, cardPath);
        });

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
            const lines = await tailSessionMessages(s.logPath, 12);
            summaries.set(s.claudeFile, lines.map(l => escapeHtml(l)).join('\n'));
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
        }));
        startDashboardAutoRefresh();
    }
    refreshDashboard();
}

setDashboardCallbacks(
    () => refreshDashboard(),
    () => dashboardPanel?.visible ?? false,
);
