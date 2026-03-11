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

// ── Constants ────────────────────────────────────────────────────────────────

export const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'state');
