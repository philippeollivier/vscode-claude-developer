import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { HookState, STATE_DIR } from './types';
import { forEachClaudeTab } from './tabs';
import { findExistingSession } from './terminal';

// ── Mutable shared state ─────────────────────────────────────────────────────

/** Status bar item for agent attention alerts */
export let statusBarItem: vscode.StatusBarItem | undefined;

export function setStatusBarItem(item: vscode.StatusBarItem): void {
    statusBarItem = item;
}

let globalStateWatcher: fs.FSWatcher | undefined;
let stateWatchDebounce: ReturnType<typeof setTimeout> | undefined;

// Forward reference: set by dashboard module to avoid circular imports
let _refreshDashboardFn: (() => void) | undefined;
let _isDashboardVisible: (() => boolean) | undefined;

export function setDashboardCallbacks(
    refreshFn: () => void,
    isVisibleFn: () => boolean,
): void {
    _refreshDashboardFn = refreshFn;
    _isDashboardVisible = isVisibleFn;
}

// ── Hook state helpers ───────────────────────────────────────────────────────

export function readHookState(claudeFile: string, sessionMtime?: Date): HookState | undefined {
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

export const statusColors: Record<string, string> = {
    'status-active': '#3bb44a',
    'status-permission': '#e5534b',
    'status-idle': '#d4a72c',
    'status-other': '#e09b13',
};

export function statusLabel(state: HookState | undefined): { text: string; cssClass: string } {
    if (!state) { return { text: 'Active', cssClass: 'status-active' }; }
    switch (state.type) {
        case 'permission_prompt': return { text: 'Pending Permission', cssClass: 'status-permission' };
        case 'idle_prompt': return { text: 'Waiting on User', cssClass: 'status-idle' };
        default: return { text: state.type, cssClass: 'status-other' };
    }
}

// ── Waiting agents ───────────────────────────────────────────────────────────

export function getWaitingAgents(): { file: string; state: HookState }[] {
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

// ── Status bar ───────────────────────────────────────────────────────────────

export function updateStatusBar(): void {
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

// ── State directory watcher ──────────────────────────────────────────────────

function onStateDirectoryChanged(): void {
    // Refresh dashboard if visible
    if (_isDashboardVisible?.() && _refreshDashboardFn) { _refreshDashboardFn(); }

    // Update status bar
    updateStatusBar();
}

export function startGlobalStateWatcher(): void {
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

export function stopGlobalStateWatcher(): void {
    if (globalStateWatcher) { globalStateWatcher.close(); globalStateWatcher = undefined; }
    if (stateWatchDebounce) { clearTimeout(stateWatchDebounce); stateWatchDebounce = undefined; }
}
