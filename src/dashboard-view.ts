import * as path from 'path';
import { SessionInfo, SubagentInfo, SetupStatus } from './types';
import { escapeHtml, renderMarkdown, timeAgo, getForkBase, escapePathForJs, isForkName } from './utils';
import { statusLabel } from './state';

export const groupColors = [
    '#7eb4f0', '#b89aed', '#6ec8a0', '#e0a36a',
    '#e07a9a', '#6ac4c4', '#c4a95a', '#a0a0d0',
];

/**
 * Render a session card. Handles both regular sessions and task sessions.
 * Task cards get: dashed border, "Task" pill, no ... menu, click reveals terminal.
 */
export function renderCard(s: SessionInfo, summaries: Map<string, string>, subagents: Map<string, SubagentInfo[]>, groupColor: string = ''): string {
    if (s.task) {
        return renderTaskCardInternal(s, groupColor);
    }
    return renderSessionCard(s, summaries, subagents, groupColor);
}

function renderSessionCard(s: SessionInfo, summaries: Map<string, string>, subagents: Map<string, SubagentInfo[]>, groupColor: string): string {
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
        const runningRows = runningAgents.map(a => {
            const escapedLogPath = a.logPath ? escapePathForJs(a.logPath) : '';
            const clickable = a.logPath ? ` agent-clickable" onclick="event.stopPropagation(); toggleAgent(this, '${escapedLogPath}')"` : '"';
            return `<div class="agent-row agent-running${clickable}><span class="agent-dot running"></span><span class="agent-desc">${escapeHtml(a.description)}</span><span class="agent-type">${escapeHtml(a.subagentType)}</span></div>`;
        }).join('');
        agentsHtml = `<div class="agents-section">
            <div class="agents-label">${runningAgents.length} agent${runningAgents.length > 1 ? 's' : ''} running</div>
            ${runningRows}
        </div>`;
    }

    const timeText = s.lastActive ? timeAgo(s.lastActive) : '';
    const labelText = timeText ? `${statusText} \u00b7 ${timeText}` : statusText;

    return `
            <div class="card" data-path="${escapedPath}" data-fork="${isFork ? '1' : ''}" style="${groupColor ? `border-left: 3px solid ${groupColor};` : ''}" onclick="vscode.postMessage({command: event.metaKey ? 'revealTerminal' : 'open', path:'${escapedPath}'})" title="Click to open \u00b7 \u2318+Click for terminal only">
                <div class="card-header">
                    <div class="card-title">
                        <span class="status-label ${cssClass}" ${s.hookState?.tool_input_summary ? `title="${escapeHtml(s.hookState.tool_input_summary)}"` : ''}>${escapeHtml(labelText)}</span>
                        <h2>${escapeHtml(s.claudeFile)}</h2>
                    </div>
                    <div class="card-meta">
                        <button class="card-btn card-btn-menu" onclick="event.stopPropagation(); showCardMenu(event, '${escapedPath}')" title="Actions">&hellip;</button>
                        <button class="card-btn card-btn-close" onclick="event.stopPropagation(); vscode.postMessage({command:'close', path:'${escapedPath}'})" title="Close">&#x2715;</button>
                    </div>
                </div>
                <div class="tail">${tailHtml}</div>
                ${agentsHtml}
            </div>`;
}

function renderTaskCardInternal(s: SessionInfo, groupColor: string): string {
    const taskId = s.task!.taskId;
    const escapedId = escapePathForJs(taskId);
    const timeText = s.task!.startedAt ? timeAgo(s.task!.startedAt) : '';
    const labelText = timeText ? `Task \u00b7 ${timeText}` : 'Task';

    return `
            <div class="card task-card" data-task-id="${escapedId}" style="${groupColor ? `border-left: 3px dashed ${groupColor};` : ''}" onclick="vscode.postMessage({command:'revealTaskTerminal', taskId:'${escapedId}'})" title="Click to reveal terminal">
                <div class="card-header">
                    <div class="card-title">
                        <span class="status-label status-task">${escapeHtml(labelText)}</span>
                        <h2>${escapeHtml(s.task!.skill)}</h2>
                    </div>
                    <div class="card-meta">
                        <button class="card-btn card-btn-close" onclick="event.stopPropagation(); vscode.postMessage({command:'closeTask', taskId:'${escapedId}'})" title="Close">&#x2715;</button>
                    </div>
                </div>
            </div>`;
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

/** Sort sessions so forks appear immediately after their parent. */
export function sortWithForks(items: SessionInfo[]): SessionInfo[] {
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

    const sortedDirs = [...groups.keys()].sort((a, b) =>
        path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase())
    );

    let body = '';
    let colorIndex = 0;
    for (const dir of sortedDirs) {
        const items = groups.get(dir)!;
        const dirName = path.basename(dir);
        const color = groupColors[colorIndex % groupColors.length];
        colorIndex++;
        const sorted = sortWithForks(items);
        const escapedDir = escapePathForJs(dir);
        const regularItems = sorted.filter(c => !c.task);
        const taskItems = sorted.filter(c => c.task);
        body += `<div class="group">
            <div class="group-header-row">
                <h2 class="group-header" style="color: ${color}; border-bottom-color: ${color};">${escapeHtml(dirName)}</h2>
                <div class="group-actions">
                    <button class="add-btn add-btn-task" style="color: ${color};" onclick="event.stopPropagation(); showTaskPicker(event, '${escapedDir}')" title="Run task"><svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="1,0 1,12 11,6"/></svg></button>
                    <button class="add-btn" style="color: ${color};" onclick="event.stopPropagation(); vscode.postMessage({command:'create', dir:'${escapedDir}'})" title="New .claude file">+</button>
                </div>
            </div>
            ${regularItems.map(c => {
                const isFork = isForkName(c.claudeFile);
                return isFork
                    ? `<div class="fork-child">${renderCard(c, summaries, subagents, color)}</div>`
                    : renderCard(c, summaries, subagents, color);
            }).join('')}
            ${taskItems.map(c => renderCard(c, summaries, subagents, color)).join('')}
        </div>`;
    }

    // "New Section" button at the bottom
    body += `<div class="new-section-row">
        <button class="new-section-btn" onclick="vscode.postMessage({command:'createSection'})">+ New Section</button>
    </div>`;

    return body || '<p class="empty">No open .claude files found.<br><button class="new-section-btn" onclick="vscode.postMessage({command:\'createSection\'})">+ New Section</button></p>';
}

export function renderHealthCheck(status: SetupStatus): string {
    const dot = (ok: boolean, optional: boolean) => {
        if (ok) {
            return '<span class="health-indicator health-ok">●</span>';
        }
        return optional
            ? '<span class="health-indicator health-warn">●</span>'
            : '<span class="health-indicator health-err">●</span>';
    };

    let html = '';
    html += `<div class="health-row">${dot(status.hooksInstalled, false)} Hook scripts installed</div>`;
    html += `<div class="health-row">${dot(status.settingsConfigured, false)} Settings.json configured</div>`;
    html += `<div class="health-row">${dot(status.dependencies.python3, false)} python3</div>`;
    html += `<div class="health-row">${dot(status.dependencies.jq, true)} jq <span style="opacity:0.6">(optional, for audit logging)</span></div>`;
    html += `<div class="health-row">${dot(status.dependencies.terminalNotifier, true)} terminal-notifier <span style="opacity:0.6">(optional, for click-to-navigate notifications)</span></div>`;

    const allOk = status.hooksInstalled && status.settingsConfigured && status.dependencies.python3;
    if (!allOk) {
        html += `<button class="configure-btn" onclick="vscode.postMessage({command:'configureHooks'})">Configure Hooks</button>`;
    }
    if (status.needsUpdate) {
        html += `<button class="configure-btn" onclick="vscode.postMessage({command:'configureHooks'})">Update Hooks</button>`;
    }

    return html;
}
