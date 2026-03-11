// ── Magic numbers extracted from across the codebase ─────────────────────────

/** Ignore hook states older than 30 minutes (state.ts) */
export const STATE_STALE_THRESHOLD_S = 30 * 60;

/** Debounce interval for the state directory watcher (state.ts) */
export const STATE_WATCHER_DEBOUNCE_MS = 500;

/** Byte size for tail-reading JSONL log files (session.ts) */
export const TAIL_CHUNK_SIZE = 262_144;

/** A background sub-agent is considered active if its file was written to within this window (session.ts) */
export const SUBAGENT_ACTIVE_THRESHOLD_MS = 30_000;

/** Dashboard auto-refresh interval (dashboard.ts) */
export const DASHBOARD_REFRESH_INTERVAL_MS = 10_000;

/** Delay before releasing the sync guard in terminal.ts */
export const SYNC_GUARD_DELAY_MS = 100;

/** VS Code configuration namespace used throughout the extension */
export const CONFIG_NAMESPACE = 'tabTerminal';
