import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionEntry, SessionInfo, HookState } from './types';
import { dirToProjectName, getSessionLogPath, isClaudeFile } from './utils';
import { REGISTRY_PERSISTENCE_KEY } from './constants';

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

// ── Session scanning (moved from terminal.ts) ───────────────────────────────

async function scanForSession(cwd: string, claudeFileName: string): Promise<string | undefined> {
    const projectDir = dirToProjectName(cwd);
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectDir);

    try {
        await fs.promises.access(sessionsDir);
    } catch {
        return undefined;
    }

    const needle = `Session renamed to: \\"${claudeFileName}\\"`;
    const matches: { sessionId: string; mtime: number }[] = [];

    let files: string[];
    try {
        files = await fs.promises.readdir(sessionsDir);
    } catch {
        return undefined;
    }

    for (const file of files) {
        if (!file.endsWith('.jsonl')) {
            continue;
        }
        const filePath = path.join(sessionsDir, file);
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            if (content.includes(needle)) {
                const stat = await fs.promises.stat(filePath);
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
            return undefined;
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
        // Check globalState cache
        const persisted = this._globalState.get<Record<string, string>>(REGISTRY_PERSISTENCE_KEY, {});
        const cached = persisted[entry.filePath];
        if (cached) {
            const logPath = getSessionLogPath(entry.dir, cached);
            try {
                const stat = await fs.promises.stat(logPath);
                entry.sessionId = cached;
                entry.logPath = logPath;
                entry.lastActive = stat.mtime;
                return cached;
            } catch {
                // Cached JSONL no longer exists, fall through to scan
            }
        }

        // Expensive full scan
        const sessionId = await scanForSession(entry.dir, entry.claudeFile);
        if (sessionId) {
            entry.sessionId = sessionId;
            entry.logPath = getSessionLogPath(entry.dir, sessionId);
            try {
                entry.lastActive = (await fs.promises.stat(entry.logPath)).mtime;
            } catch {
                // file might not exist yet
            }
            await this.persist();
        }
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

    /** Refresh lastActive for all entries from disk. */
    async refreshLastActive(): Promise<void> {
        for (const entry of this._entries.values()) {
            if (!entry.logPath) { continue; }
            try {
                entry.lastActive = (await fs.promises.stat(entry.logPath)).mtime;
            } catch {
                // file may have been removed
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
