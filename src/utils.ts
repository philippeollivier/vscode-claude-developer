import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export function isClaudeFile(fsPath: string): boolean {
    return fsPath.endsWith('.claude');
}

export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Lightweight markdown -> HTML for tail lines (inline elements + headers/lists). */
export function renderMarkdown(escaped: string): string {
    return escaped
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^#{1,6}\s+(.+)/, '<strong>$1</strong>')
        .replace(/^[-*]\s+/, '&bull; ')
        .replace(/^\d+\.\s+/, match => match);
}

export function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

export function timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) { return `${seconds}s ago`; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

/** Parse "hugh~2" -> { base: "hugh", forkNum: 2 }, "hugh" -> { base: "hugh", forkNum: undefined }. */
export function parseForkName(claudeFile: string): { base: string; forkNum: number | undefined } {
    const match = claudeFile.match(/^(.+)~(\d+)$/);
    if (match) {
        return { base: match[1], forkNum: parseInt(match[2], 10) };
    }
    return { base: claudeFile, forkNum: undefined };
}

export function getForkBase(claudeFile: string): string {
    return parseForkName(claudeFile).base;
}

/** Find the next available fork name by scanning the directory for existing ~N suffixes. */
export function nextForkName(dir: string, baseName: string): string {
    let maxNum = 1;
    try {
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.claude')) { continue; }
            const name = file.slice(0, -7);
            const { base, forkNum } = parseForkName(name);
            if (base === baseName && forkNum !== undefined && forkNum > maxNum) {
                maxNum = forkNum;
            }
        }
    } catch {
        // directory unreadable
    }
    return `${baseName}~${maxNum + 1}`;
}

export function dirToProjectName(dir: string): string {
    return dir.replace(/[/ ]/g, '-');
}

export function getSessionLogPath(dir: string, sessionId: string): string {
    const projectDir = dirToProjectName(dir);
    return path.join(os.homedir(), '.claude', 'projects', projectDir, sessionId + '.jsonl');
}

export function escapePathForJs(filePath: string): string {
    return escapeHtml(filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

export function isForkName(name: string): boolean {
    return name.includes('~');
}

export function safeJsonParse<T>(str: string): T | null {
    try {
        return JSON.parse(str) as T;
    } catch {
        return null;
    }
}

export function ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}
