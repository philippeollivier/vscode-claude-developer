export const STATE_WATCHER_DEBOUNCE_MS = 500;

/** Status type values written by state-tracker.py and read by the extension. */
export const StatusType = {
    PERMISSION_PROMPT: 'permission_prompt',
    IDLE_PROMPT: 'idle_prompt',
    EXECUTING_TOOL: 'executing_tool',
    PROCESSING: 'processing',
    STOPPED: 'stopped',
    ERROR: 'error',
    IDLE: 'idle',
} as const;

export type StatusTypeValue = typeof StatusType[keyof typeof StatusType];
export const TAIL_CHUNK_SIZE = 262_144;
export const SUBAGENT_ACTIVE_THRESHOLD_MS = 30_000;
export const DASHBOARD_REFRESH_INTERVAL_MS = 30_000;
export const SYNC_GUARD_DELAY_MS = 100;
export const CONFIG_NAMESPACE = 'tabTerminal';
export const REGISTRY_PERSISTENCE_KEY = 'claudeDev.sessionMappings';
export const TASK_KEY_PREFIX = 'task://';
export const TASK_NAME_PREFIX = 'Task: ';
export const CLAUDE_ICON_FILE = 'claude-icon.svg';
export const HOOKS_VERSION = 1;
export const GLOBAL_STATE_HOOKS_VERSION_KEY = 'claudeDev.hooksVersion';
export const GLOBAL_STATE_SETUP_DISMISSED_KEY = 'claudeDev.setupDismissed';
