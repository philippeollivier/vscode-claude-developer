import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionEntry, SessionInfo, HookState, TaskInfo, STATE_DIR } from './types';
import { getSessionLogPath, safeJsonParse } from './utils';
import { REGISTRY_PERSISTENCE_KEY, TASK_KEY_PREFIX, TASK_NAME_PREFIX } from './constants';
import { logError } from './log';
import { scanForSession } from './session-resolver';

// ── Singleton ───────────────────────────────────────────────────────────────

let _registry: SessionRegistry | undefined;

export function setRegistry(r: SessionRegistry): void {
    _registry = r;
}

export function getRegistry(): SessionRegistry {
    if (!_registry) {
        throw new Error('SessionRegistry not initialized -- call setRegistry() in activate()');
    }
    return _registry;
}

// ── SessionRegistry ─────────────────────────────────────────────────────────

export class SessionRegistry {
    private _entries = new Map<string, SessionEntry>();
    private _terminalIndex = new Map<vscode.Terminal, string>();
    private _globalState: vscode.Memento;
    /** In-flight resolveSessionId promises to deduplicate concurrent calls */
    private _resolving = new Map<string, Promise<string | undefined>>();

    constructor(globalState: vscode.Memento) {
        this._globalState = globalState;
    }

    // ── Core CRUD ───────────────────────────────────────────────────────

    /** Register a .claude file path. Creates an entry if none exists. */
    async register(filePath: string, terminal?: vscode.Terminal): Promise<SessionEntry> {
        let entry = this._entries.get(filePath);
        if (!entry) {
            const claudeFile = path.basename(filePath, '.claude');
            const dir = path.dirname(filePath);
            entry = {
                filePath,
                claudeFile,
                dir,
                sessionId: undefined,
                terminal: undefined,
                logPath: undefined,
                hookState: undefined,
                lastActive: undefined,
            };
            this._entries.set(filePath, entry);
        }

        if (terminal) {
            this._setTerminalInternal(entry, terminal);
        }

        // Resolve session ID (uses cache, fast on subsequent calls)
        await this.resolveSessionId(filePath);

        return entry;
    }

    /** Register a task terminal (no .claude file). Returns the entry. */
    registerTask(dir: string, skill: string, terminal: vscode.Terminal): SessionEntry {
        const taskId = `${TASK_KEY_PREFIX}${dir}/${Date.now()}-${skill.replace(/^\//, '')}`;
        const displayName = skill.replace(/^\//, '');
        const entry: SessionEntry = {
            filePath: taskId,
            claudeFile: displayName,
            dir,
            sessionId: undefined,
            terminal: undefined,
            logPath: undefined,
            hookState: undefined,
            lastActive: new Date(),
            task: { isTask: true, skill, taskId, startedAt: new Date() },
        };
        this._entries.set(taskId, entry);
        this._setTerminalInternal(entry, terminal);
        return entry;
    }

    /** Get all task terminal entries. */
    getTaskEntries(): SessionEntry[] {
        return [...this._entries.values()].filter(e => e.task);
    }

    /** Check if a key is a task terminal key. */
    static isTaskKey(key: string): boolean {
        return key.startsWith(TASK_KEY_PREFIX);
    }

    /** Remove an entry entirely. */
    unregister(filePath: string): void {
        const entry = this._entries.get(filePath);
        if (!entry) { return; }
        if (entry.terminal) {
            this._terminalIndex.delete(entry.terminal);
        }
        this._entries.delete(filePath);
        this.persist();
    }

    get(filePath: string): SessionEntry | undefined {
        return this._entries.get(filePath);
    }

    getByUri(uriString: string): SessionEntry | undefined {
        try {
            const fsPath = vscode.Uri.parse(uriString).fsPath;
            return this._entries.get(fsPath);
        } catch {
            return undefined; /* expected: invalid URI string */
        }
    }

    getByTerminal(terminal: vscode.Terminal): SessionEntry | undefined {
        const filePath = this._terminalIndex.get(terminal);
        return filePath ? this._entries.get(filePath) : undefined;
    }

    getByClaudeFile(claudeFile: string): SessionEntry | undefined {
        for (const entry of this._entries.values()) {
            if (entry.claudeFile === claudeFile) {
                return entry;
            }
        }
        return undefined;
    }

    entries(): IterableIterator<SessionEntry> {
        return this._entries.values();
    }

    has(filePath: string): boolean {
        return this._entries.has(filePath);
    }

    get size(): number {
        return this._entries.size;
    }

    // ── Terminal management ──────────────────────────────────────────────

    setTerminal(filePath: string, terminal: vscode.Terminal): void {
        const entry = this._entries.get(filePath);
        if (entry) {
            this._setTerminalInternal(entry, terminal);
        }
    }

    clearTerminal(filePath: string): void {
        const entry = this._entries.get(filePath);
        if (!entry) { return; }
        if (entry.terminal) {
            this._terminalIndex.delete(entry.terminal);
            entry.terminal = undefined;
        }
    }

    clearTerminalByRef(terminal: vscode.Terminal): void {
        const filePath = this._terminalIndex.get(terminal);
        if (filePath) {
            this._terminalIndex.delete(terminal);
            const entry = this._entries.get(filePath);
            if (entry) { entry.terminal = undefined; }
        }
    }

    isManaged(terminal: vscode.Terminal): boolean {
        return this._terminalIndex.has(terminal);
    }

    private _setTerminalInternal(entry: SessionEntry, terminal: vscode.Terminal): void {
        // Remove old terminal from index if replaced
        if (entry.terminal && entry.terminal !== terminal) {
            this._terminalIndex.delete(entry.terminal);
        }
        entry.terminal = terminal;
        this._terminalIndex.set(terminal, entry.filePath);
    }

    // ── Session resolution ──────────────────────────────────────────────

    /** Resolve the sessionId for a file path. Uses globalState cache, then falls back to JSONL scan. */
    async resolveSessionId(filePath: string): Promise<string | undefined> {
        const entry = this._entries.get(filePath);
        if (!entry) { return undefined; }

        // Already resolved
        if (entry.sessionId) {
            return entry.sessionId;
        }

        // Deduplicate concurrent calls
        const inflight = this._resolving.get(filePath);
        if (inflight) { return inflight; }

        const promise = this._resolveSessionIdImpl(entry);
        this._resolving.set(filePath, promise);
        try {
            return await promise;
        } finally {
            this._resolving.delete(filePath);
        }
    }

    private async _resolveSessionIdImpl(entry: SessionEntry): Promise<string | undefined> {
        if (entry.task) { return undefined; }
        return await this._resolveFromStateFile(entry)
            ?? await this._resolveFromCache(entry)
            ?? await this._resolveFromScan(entry);
    }

    private async _resolveFromStateFile(entry: SessionEntry): Promise<string | undefined> {
        try {
            const stateFile = path.join(STATE_DIR, `${entry.claudeFile}.json`);
            const raw = await fs.promises.readFile(stateFile, 'utf-8');
            const state = safeJsonParse<{ session_id?: string }>(raw);
            if (!state?.session_id) { return undefined; }
            const logPath = getSessionLogPath(entry.dir, state.session_id);
            const stat = await fs.promises.stat(logPath);
            entry.sessionId = state.session_id;
            entry.logPath = logPath;
            entry.lastActive = stat.mtime;
            await this.persist();
            return state.session_id;
        } catch {
            return undefined; /* expected: state file or JSONL doesn't exist */
        }
    }

    private async _resolveFromCache(entry: SessionEntry): Promise<string | undefined> {
        const persisted = this._globalState.get<Record<string, string>>(REGISTRY_PERSISTENCE_KEY, {});
        const cached = persisted[entry.filePath];
        if (!cached) { return undefined; }
        try {
            const logPath = getSessionLogPath(entry.dir, cached);
            const stat = await fs.promises.stat(logPath);
            entry.sessionId = cached;
            entry.logPath = logPath;
            entry.lastActive = stat.mtime;
            return cached;
        } catch {
            return undefined; /* expected: cached JSONL no longer exists */
        }
    }

    private async _resolveFromScan(entry: SessionEntry): Promise<string | undefined> {
        const sessionId = await scanForSession(entry.dir, entry.claudeFile);
        if (!sessionId) { return undefined; }
        entry.sessionId = sessionId;
        entry.logPath = getSessionLogPath(entry.dir, sessionId);
        try {
            entry.lastActive = (await fs.promises.stat(entry.logPath)).mtime;
        } catch {
            /* expected: log file might not exist yet */
        }
        await this.persist();
        return sessionId;
    }

    // ── Liveness ────────────────────────────────────────────────────────

    /** Returns true if the terminal is still alive. Cleans up dead terminals. */
    validateTerminal(filePath: string): boolean {
        const entry = this._entries.get(filePath);
        if (!entry?.terminal) { return false; }
        const alive = vscode.window.terminals.includes(entry.terminal);
        if (!alive) {
            this._terminalIndex.delete(entry.terminal);
            entry.terminal = undefined;
        }
        return alive;
    }

    /** Validate all terminals and remove dead references. */
    validateAllTerminals(): void {
        const liveTerminals = new Set(vscode.window.terminals);
        for (const entry of this._entries.values()) {
            if (entry.terminal && !liveTerminals.has(entry.terminal)) {
                this._terminalIndex.delete(entry.terminal);
                entry.terminal = undefined;
            }
        }
    }

    // ── Hook state ──────────────────────────────────────────────────────

    updateHookState(filePath: string, state: HookState | undefined): void {
        const entry = this._entries.get(filePath);
        if (entry) {
            entry.hookState = state;
        }
    }

    /** Refresh lastActive for all entries from disk (log file + state file). */
    async refreshLastActive(): Promise<void> {
        for (const entry of this._entries.values()) {
            if (entry.task) { continue; }

            // Check state file — updated on every hook event, even across session restarts
            try {
                const stateFile = path.join(STATE_DIR, `${entry.claudeFile}.json`);
                const stateRaw = await fs.promises.readFile(stateFile, 'utf-8');
                const state = safeJsonParse<{ session_id?: string; timestamp?: number }>(stateRaw);

                // If state file has a different session_id, re-resolve the session
                if (state?.session_id && state.session_id !== entry.sessionId) {
                    const logPath = getSessionLogPath(entry.dir, state.session_id);
                    try {
                        const stat = await fs.promises.stat(logPath);
                        entry.sessionId = state.session_id;
                        entry.logPath = logPath;
                        entry.lastActive = stat.mtime;
                        await this.persist();
                    } catch { /* new log file doesn't exist yet */ }
                }

                // Use state file mtime as a lower bound for lastActive
                const stateStat = await fs.promises.stat(stateFile);
                if (!entry.lastActive || stateStat.mtime > entry.lastActive) {
                    entry.lastActive = stateStat.mtime;
                }
            } catch { /* no state file */ }

            // Check log file mtime
            if (!entry.logPath) { continue; }
            try {
                const logMtime = (await fs.promises.stat(entry.logPath)).mtime;
                if (!entry.lastActive || logMtime > entry.lastActive) {
                    entry.lastActive = logMtime;
                }
            } catch {
                /* expected: log file may have been removed */
            }
        }
    }

    // ── Snapshot for dashboard ──────────────────────────────────────────

    toSessionInfoArray(): SessionInfo[] {
        const result: SessionInfo[] = [];
        for (const entry of this._entries.values()) {
            result.push({
                claudeFile: entry.claudeFile,
                dir: entry.dir,
                sessionId: entry.sessionId,
                logPath: entry.logPath,
                lastActive: entry.lastActive,
                hookState: entry.hookState,
                task: entry.task,
            });
        }
        return result;
    }

    // ── Persistence ─────────────────────────────────────────────────────

    async persist(): Promise<void> {
        const mappings: Record<string, string> = {};
        for (const entry of this._entries.values()) {
            if (entry.sessionId) {
                mappings[entry.filePath] = entry.sessionId;
            }
        }
        await this._globalState.update(REGISTRY_PERSISTENCE_KEY, mappings);
    }

    // ── Task reconnection ────────────────────────────────────────────────

    /** Reconnect orphaned task terminals after extension reload. */
    reconnectTaskTerminals(): void {
        for (const terminal of vscode.window.terminals) {
            if (!terminal.name.startsWith(TASK_NAME_PREFIX)) { continue; }
            if (this._terminalIndex.has(terminal)) { continue; }
            const skill = '/' + terminal.name.slice(TASK_NAME_PREFIX.length);
            // Use the terminal's creationOptions.cwd if available, otherwise fallback
            const opts = terminal.creationOptions as { cwd?: string | vscode.Uri };
            const dir = opts?.cwd
                ? (typeof opts.cwd === 'string' ? opts.cwd : opts.cwd.fsPath)
                : '';
            if (dir) {
                this.registerTask(dir, skill, terminal);
            }
        }
    }

    // ── Cleanup ─────────────────────────────────────────────────────────

    dispose(): void {
        for (const entry of this._entries.values()) {
            if (entry.terminal) {
                entry.terminal.dispose();
            }
        }
        this._entries.clear();
        this._terminalIndex.clear();
    }
}
