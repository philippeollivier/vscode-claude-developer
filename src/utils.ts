export function isClaudeFile(fsPath: string): boolean {
    return fsPath.endsWith('.claude');
}

export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Lightweight markdown -> HTML for tail lines (inline elements + headers/lists) */
export function renderMarkdown(escaped: string): string {
    return escaped
        // inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // bold
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // italic
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // headers (strip to bold)
        .replace(/^#{1,6}\s+(.+)/, '<strong>$1</strong>')
        // unordered list bullets
        .replace(/^[-*]\s+/, '&bull; ')
        // numbered list
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

// ── Fork naming utilities ───────────────────────────────────────────────────

/** Parse "hugh~2" → { base: "hugh", forkNum: 2 }, "hugh" → { base: "hugh", forkNum: undefined } */
export function parseForkName(claudeFile: string): { base: string; forkNum: number | undefined } {
    const match = claudeFile.match(/^(.+)~(\d+)$/);
    if (match) {
        return { base: match[1], forkNum: parseInt(match[2], 10) };
    }
    return { base: claudeFile, forkNum: undefined };
}

/** Get the base (parent) name, stripping any ~N suffix */
export function getForkBase(claudeFile: string): string {
    return parseForkName(claudeFile).base;
}

/** Find the next available fork name (e.g., "hugh~2", "hugh~3") by scanning the directory */
export function nextForkName(dir: string, baseName: string): string {
    const fs = require('fs');
    let maxNum = 1; // original is implicitly fork 1
    try {
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.claude')) { continue; }
            const name = file.slice(0, -7); // strip .claude
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
