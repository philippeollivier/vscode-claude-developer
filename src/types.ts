import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

/** State written by state-tracker.py to ~/.claude/hooks/state/{CLAUDE_FILE}.json */
export interface HookState {
    /** Status type — see StatusType in constants.ts for known values */
    type: string;
    /** Unix timestamp (seconds) when the hook fired */
    timestamp: number;
    /** Human-readable status message */
    message: string;
    /** Working directory of the Claude session */
    cwd?: string;
    /** CLAUDE_FILE env var value (basename of .claude file) */
    tab?: string;
    /** Tool name — present when type is 'executing_tool' or 'processing' (last tool) */
    tool_name?: string;
    /** Short summary of tool input (max 80 chars) — present when type is 'executing_tool' */
    tool_input_summary?: string;
    /** Which hook event wrote this entry (e.g., 'PreToolUse', 'Stop') */
    hook_event?: string;
    /** Error details — present when type is 'error' (max 200 chars) */
    stop_reason?: string;
    /** Session UUID — present when hook_event is 'SessionStart' */
    session_id?: string;
}

export interface SubagentInfo {
    id: string;
    description: string;
    subagentType: string;
    running: boolean;
    logPath?: string;
}

export interface TaskInfo {
    isTask: true;
    skill: string;
    taskId: string;
    startedAt: Date;
}

export interface SessionInfo {
    claudeFile: string;
    dir: string;
    sessionId: string | undefined;
    logPath: string | undefined;
    lastActive: Date | undefined;
    hookState: HookState | undefined;
    task?: TaskInfo;
}

export interface DashboardSettings {
    autoOpenTerminal: boolean;
    terminalLocation: string;
    autoSetupOnStart: boolean;
    confirmCloseClaudeFile: boolean;
    skills: string[];
}

export interface SessionEntry {
    filePath: string;
    claudeFile: string;
    dir: string;
    sessionId: string | undefined;
    terminal: vscode.Terminal | undefined;
    logPath: string | undefined;
    hookState: HookState | undefined;
    lastActive: Date | undefined;
    task?: TaskInfo;
}

export interface LogContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string | LogContentBlock[];
}

export interface LogEntry {
    type: 'human' | 'user' | 'assistant' | 'tool_result';
    tool_use_id?: string;
    message?: {
        role?: string;
        content: string | LogContentBlock[];
    };
}

export interface AgentUseEntry {
    id: string;
    description: string;
    subagentType: string;
    background: boolean;
}

export interface SubagentCacheEntry {
    mtimeMs: number;
    size: number;
    result: SubagentInfo[];
}

export interface ParsedAgentData {
    agentUses: AgentUseEntry[];
    resultIds: Set<string>;
    bgAgentIds: Map<string, string>;
}

export const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'state');

export interface SetupStatus {
    hooksInstalled: boolean;
    missingHookFiles: string[];
    settingsConfigured: boolean;
    hooksVersion: number | undefined;
    needsUpdate: boolean;
    dependencies: {
        python3: boolean;
        jq: boolean;
        terminalNotifier: boolean;
    };
}
