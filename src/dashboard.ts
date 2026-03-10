import * as vscode from 'vscode';
import * as path from 'path';
import { SessionInfo, DashboardSettings } from './types';
import { escapeHtml, renderMarkdown, hexToRgba, timeAgo } from './utils';
import { getOpenClaudeFiles } from './tabs';
import { getConfig } from './config';
import { tailSessionMessages } from './session';
import { statusLabel, statusColors, setDashboardCallbacks } from './state';
import { closeTerminalForEditor } from './terminal';

// ── Mutable shared state ─────────────────────────────────────────────────────

export let dashboardPanel: vscode.WebviewPanel | undefined;
export let extensionContext: vscode.ExtensionContext | undefined;

let dashboardInterval: ReturnType<typeof setInterval> | undefined;

export function setExtensionContext(ctx: vscode.ExtensionContext): void {
    extensionContext = ctx;
}

// ── Setting renderers ────────────────────────────────────────────────────────

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

// ── Card renderer ────────────────────────────────────────────────────────────

export function renderCard(s: SessionInfo, summaries: Map<string, string>, groupColor: string = ''): string {
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

// ── Dashboard HTML ───────────────────────────────────────────────────────────

export function getDashboardHtml(sessions: SessionInfo[], summaries: Map<string, string>, settings: DashboardSettings): string {
    // Group sessions by immediate directory name
    const groups = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
        const list = groups.get(s.dir) ?? [];
        list.push(s);
        groups.set(s.dir, list);
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
            ${items.map(c => renderCard(c, summaries, color)).join('')}
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

// ── Dashboard lifecycle ──────────────────────────────────────────────────────

export function refreshDashboard(): void {
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

    dashboardPanel.webview.html = getDashboardHtml(sessions, summaries, getConfig());
}

export function startDashboardAutoRefresh(): void {
    stopDashboardAutoRefresh();

    // Interval refresh every 10s
    dashboardInterval = setInterval(() => {
        if (dashboardPanel?.visible) { refreshDashboard(); }
    }, 10000);
}

export function stopDashboardAutoRefresh(): void {
    if (dashboardInterval) { clearInterval(dashboardInterval); dashboardInterval = undefined; }
}

export async function openDashboard(): Promise<void> {
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

// Register callbacks with state module (called at import time to wire up the dependency)
setDashboardCallbacks(
    () => refreshDashboard(),
    () => dashboardPanel?.visible ?? false,
);
