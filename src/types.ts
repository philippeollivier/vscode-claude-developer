import * as path from 'path';
import * as os from 'os';

// ── Shared interfaces ────────────────────────────────────────────────────────

export interface HookState {
    type: string; // 'permission_prompt' | 'idle_prompt' | etc.
    timestamp: number;
    message: string;
}

export interface SubagentInfo {
    id: string;
    description: string;
    subagentType: string; // 'Explore', 'Plan', 'general', etc.
    running: boolean;
}

export interface SessionInfo {
    claudeFile: string;
    dir: string;
    sessionId: string | undefined;
    logPath: string | undefined;
    lastActive: Date | undefined;
    hookState: HookState | undefined;
}

export interface DashboardSettings {
    autoOpenTerminal: boolean;
    terminalLocation: string;
    autoSetupOnStart: boolean;
    confirmCloseClaudeFile: boolean;
}

// ── JSONL log entry types ────────────────────────────────────────────────────

export interface LogContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    /** Present on tool_result blocks inside user message content arrays */
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

// ── Session parsing helper types ─────────────────────────────────────────────

/** Raw agent tool_use data extracted from JSONL before running-state resolution */
export interface AgentUseEntry {
    id: string;
    description: string;
    subagentType: string;
    background: boolean;
}

/** Cache entry for subagent parsing — keyed on both mtime and size for reliability */
export interface SubagentCacheEntry {
    mtimeMs: number;
    size: number;
    result: SubagentInfo[];
}

/** Parsed data extracted from JSONL content for subagent resolution */
export interface ParsedAgentData {
    agentUses: AgentUseEntry[];
    resultIds: Set<string>;
    bgAgentIds: Map<string, string>;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'state');
