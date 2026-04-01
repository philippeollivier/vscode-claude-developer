import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HookState, STATE_DIR } from './types';
import { STATE_WATCHER_DEBOUNCE_MS } from './constants';
import { safeJsonParse, ensureDirectoryExists } from './utils';
import { getRegistry } from './registry';

// ── Mutable shared state ─────────────────────────────────────────────────────

export let statusBarItem: vscode.StatusBarItem | undefined;

export function setStatusBarItem(item: vscode.StatusBarItem): void {
    statusBarItem = item;
}

let globalStateWatcher: fs.FSWatcher | undefined;
let stateWatchDebounce: ReturnType<typeof setTimeout> | undefined;

let _refreshDashboardFn: (() => void) | undefined;
let _isDashboardVisible: (() => boolean) | undefined;
let _openDashboardFn: (() => void) | undefined;
let _openFileFn: ((claudeFile: string) => void) | undefined;

export function setDashboardCallbacks(
    refreshFn: () => void,
    isVisibleFn: () => boolean,
    openDashboardFn?: () => void,
    openFileFn?: (claudeFile: string) => void,
): void {
    _refreshDashboardFn = refreshFn;
    _isDashboardVisible = isVisibleFn;
    _openDashboardFn = openDashboardFn;
    _openFileFn = openFileFn;
}

// ── Hook state helpers ───────────────────────────────────────────────────────

const ATTENTION_TYPES = new Set(['permission_prompt', 'idle_prompt', 'error']);

export function readHookState(claudeFile: string, sessionMtime?: Date): HookState | undefined {
    try {
        const stateFile = path.join(STATE_DIR, `${claudeFile}.json`);
        if (!fs.existsSync(stateFile)) { return undefined; }
        const state = safeJsonParse<HookState>(fs.readFileSync(stateFile, 'utf-8'));
        if (!state) { return undefined; }
        // For notification states, if the session log was modified after the notification,
        // the agent resumed and the notification is stale.
        const NOTIFICATION_TYPES = ['permission_prompt', 'idle_prompt'];
        if (NOTIFICATION_TYPES.includes(state.type) && sessionMtime && sessionMtime.getTime() / 1000 > state.timestamp + 2) { return undefined; }
        return state;
    } catch {
        return undefined;
    }
}

export const statusColors: Record<string, string> = {
    'status-unknown': '#888888',
    'status-permission': '#e5534b',
    'status-error': '#e5534b',
    'status-executing': '#4a9eff',
    'status-processing': '#4a9eff',
    'status-idle': '#3bb44a',
    'status-done': '#3bb44a',
    'status-other': '#e09b13',
};

export function statusLabel(state: HookState | undefined): { text: string; cssClass: string } {
    if (!state) { return { text: 'Unknown', cssClass: 'status-unknown' }; }
    switch (state.type) {
        case 'permission_prompt': return { text: 'Pending Permission', cssClass: 'status-permission' };
        case 'idle_prompt': return { text: 'Waiting on User', cssClass: 'status-idle' };
        case 'error': return { text: 'Error', cssClass: 'status-error' };
        case 'executing_tool': {
            const label = state.tool_name ? `Running ${state.tool_name}` : 'Executing';
            return { text: label, cssClass: 'status-executing' };
        }
        case 'processing': return { text: 'Processing', cssClass: 'status-processing' };
        case 'stopped': return { text: 'Done', cssClass: 'status-done' };
        case 'idle': return { text: 'Idle', cssClass: 'status-done' };
        default: return { text: state.type, cssClass: 'status-other' };
    }
}

// ── Waiting agents ───────────────────────────────────────────────────────────

export async function getWaitingAgents(): Promise<{ file: string; state: HookState }[]> {
    const registry = getRegistry();
    await registry.refreshLastActive();
    const waiting: { file: string; state: HookState }[] = [];

    try {
        await fs.promises.access(STATE_DIR);
        const files = await fs.promises.readdir(STATE_DIR);
        for (const file of files) {
            if (!file.endsWith('.json')) { continue; }
            const claudeFile = file.replace(/\.json$/, '');
            const entry = registry.getByClaudeFile(claudeFile);
            if (!entry) { continue; }
            const state = readHookState(claudeFile, entry.lastActive);
            if (state && ATTENTION_TYPES.has(state.type)) {
                waiting.push({ file: claudeFile, state });
            }
        }
    } catch {
        // state dir not accessible
    }

    return waiting;
}

// ── Status bar ───────────────────────────────────────────────────────────────

export async function updateStatusBar(): Promise<void> {
    if (!statusBarItem) { return; }

    const waiting = await getWaitingAgents();
    const permCount = waiting.filter(w => w.state.type === 'permission_prompt').length;
    const idleCount = waiting.filter(w => w.state.type === 'idle_prompt').length;
    const errorCount = waiting.filter(w => w.state.type === 'error').length;

    if (waiting.length === 0) {
        statusBarItem.text = '$(check) Agents active';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'All agents are running';
    } else {
        const parts: string[] = [];
        if (permCount) { parts.push(`${permCount} permission`); }
        if (idleCount) { parts.push(`${idleCount} idle`); }
        if (errorCount) { parts.push(`${errorCount} error`); }
        const detail = parts.join(', ');

        statusBarItem.text = `$(bell) ${waiting.length} agent${waiting.length > 1 ? 's' : ''} waiting`;
        statusBarItem.tooltip = `${detail}\nClick to cycle (Cmd+Shift+D)`;
        statusBarItem.backgroundColor = (permCount > 0 || errorCount > 0)
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

// ── In-editor notifications ─────────────────────────────────────────────────

const notifiedTimestamps = new Map<string, number>();

async function showInEditorNotifications(): Promise<void> {
    const waiting = await getWaitingAgents();
    for (const w of waiting) {
        const prev = notifiedTimestamps.get(w.file);
        if (prev && prev >= w.state.timestamp) { continue; }
        notifiedTimestamps.set(w.file, w.state.timestamp);

        const label = w.state.type === 'error' ? 'Error' : w.state.message;
        const action = await vscode.window.showWarningMessage(
            `${w.file}: ${label}`,
            'Go to File',
            'Open Dashboard',
        );
        if (action === 'Go to File' && _openFileFn) {
            _openFileFn(w.file);
        } else if (action === 'Open Dashboard' && _openDashboardFn) {
            _openDashboardFn();
        }
    }
}

// ── State directory watcher ──────────────────────────────────────────────────

function onStateDirectoryChanged(): void {
    if (_isDashboardVisible?.() && _refreshDashboardFn) { _refreshDashboardFn(); }
    updateStatusBar();
    showInEditorNotifications();
}

export function startGlobalStateWatcher(): void {
    stopGlobalStateWatcher();

    try {
        ensureDirectoryExists(STATE_DIR);
        globalStateWatcher = fs.watch(STATE_DIR, () => {
            if (stateWatchDebounce) { clearTimeout(stateWatchDebounce); }
            stateWatchDebounce = setTimeout(onStateDirectoryChanged, STATE_WATCHER_DEBOUNCE_MS);
        });
    } catch {
        // state dir watch failed
    }
}

export function stopGlobalStateWatcher(): void {
    if (globalStateWatcher) { globalStateWatcher.close(); globalStateWatcher = undefined; }
    if (stateWatchDebounce) { clearTimeout(stateWatchDebounce); stateWatchDebounce = undefined; }
}
