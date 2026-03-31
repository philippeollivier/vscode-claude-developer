import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export interface HookState {
    type: string;
    timestamp: number;
    message: string;
    cwd?: string;
    tab?: string;
    tool_name?: string;
    tool_input_summary?: string;
    hook_event?: string;
    stop_reason?: string;
}

export interface SubagentInfo {
    id: string;
    description: string;
    subagentType: string;
    running: boolean;
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

export type DashboardMessage =
    | { command: 'refresh' }
    | { command: 'open'; path: string }
    | { command: 'revealTerminal'; path: string }
    | { command: 'setting'; key: string; value: unknown }
    | { command: 'fork'; path: string }
    | { command: 'close'; path: string }
    | { command: 'create'; dir: string }
    | { command: 'sendMessage'; path: string }
    | { command: 'sendSkill'; path: string; skill: string }
    | { command: 'delete'; path: string }
    | { command: 'runTask'; dir: string; skill: string }
    | { command: 'addTaskCommand'; dir: string }
    | { command: 'revealTaskTerminal'; taskId: string }
    | { command: 'closeTask'; taskId: string };

export const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'state');
