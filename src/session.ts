import * as fs from 'fs';
import * as path from 'path';
import { SubagentInfo } from './types';

export function readTailChunk(logPath: string, chunkSize: number): string[] {
    const fileSize = fs.statSync(logPath).size;
    const readSize = Math.min(chunkSize, fileSize);
    const readOffset = fileSize - readSize;

    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, 'r');
    try {
        fs.readSync(fd, buf, 0, readSize, readOffset);
    } finally {
        fs.closeSync(fd);
    }

    let lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    // Skip first line if partial (reading from middle of file)
    if (readOffset > 0 && lines.length > 0) {
        lines = lines.slice(1);
    }
    return lines;
}

export function parseLastMessages(jsonlLines: string[]): { lastUser: string; lastAssistant: string } {
    let lastUser = '';
    let lastAssistant = '';

    for (const line of jsonlLines) {
        try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
                const text = typeof entry.message.content === 'string'
                    ? entry.message.content : '';
                if (text) { lastUser = text; }
            } else if (entry.type === 'assistant' && entry.message?.content) {
                if (Array.isArray(entry.message.content)) {
                    const textParts = entry.message.content
                        .filter((c: any) => c.type === 'text')
                        .map((c: any) => c.text);
                    if (textParts.length) {
                        lastAssistant = textParts.join('\n');
                    }
                }
            }
        } catch {
            // skip
        }
    }
    return { lastUser, lastAssistant };
}

export function tailSessionMessages(logPath: string, maxLines: number = 12): string[] {
    // Try 256KB tail first; fall back to full read if no messages found
    let lines = readTailChunk(logPath, 262144);
    let { lastUser, lastAssistant } = parseLastMessages(lines);

    // If tail chunk missed the messages (e.g. huge tool-use entries), read full file
    if (!lastUser && !lastAssistant) {
        const fileSize = fs.statSync(logPath).size;
        if (fileSize > 262144) {
            const content = fs.readFileSync(logPath, 'utf-8');
            lines = content.split('\n').filter(l => l.trim());
            ({ lastUser, lastAssistant } = parseLastMessages(lines));
        }
    }

    const result: string[] = [];
    if (lastUser) {
        const firstLine = lastUser.split('\n')[0].substring(0, 120);
        result.push(`> ${firstLine}`);
    }
    if (lastAssistant) {
        const asLines = lastAssistant.split('\n');
        const budget = maxLines - result.length;
        result.push(...asLines.slice(-budget));
    }
    return result;
}

// Cache for subagent parsing — avoids re-reading large files every refresh
const subagentCache = new Map<string, { size: number; result: SubagentInfo[] }>();

/** Parse JSONL to find Agent tool_use entries and match with tool_results */
export function parseSubagents(logPath: string): SubagentInfo[] {
    let fileSize: number;
    try {
        fileSize = fs.statSync(logPath).size;
    } catch {
        return [];
    }

    // Return cached result if file hasn't grown
    const cached = subagentCache.get(logPath);
    if (cached && cached.size === fileSize) {
        return cached.result;
    }

    let content: string;
    try {
        content = fs.readFileSync(logPath, 'utf-8');
    } catch {
        return [];
    }

    const agentUses: { id: string; description: string; subagentType: string; background: boolean }[] = [];
    const resultIds = new Set<string>();
    // For background agents: map tool_use_id → agentId (from launch confirmation)
    const bgAgentIds = new Map<string, string>();

    for (const line of content.split('\n')) {
        if (!line.trim()) { continue; }
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }

        // Collect tool_result IDs from user messages and top-level
        if (entry.type === 'tool_result' && entry.tool_use_id) {
            resultIds.add(entry.tool_use_id);
        }
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
            for (const block of entry.message.content) {
                if (block?.type === 'tool_result' && block.tool_use_id) {
                    resultIds.add(block.tool_use_id);
                    // Extract agentId from "Async agent launched" confirmations
                    let text = '';
                    if (typeof block.content === 'string') { text = block.content; }
                    else if (Array.isArray(block.content)) {
                        text = block.content.map((c: any) => c?.text ?? '').join('');
                    }
                    const match = text.match(/Async agent launched[\s\S]*?agentId: (\w+)/);
                    if (match) {
                        bgAgentIds.set(block.tool_use_id, match[1]);
                    }
                }
            }
        }

        // Collect Agent tool_use entries from assistant messages
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
            for (const block of entry.message.content) {
                if (block?.type === 'tool_use' && block.name === 'Agent') {
                    agentUses.push({
                        id: block.id,
                        description: block.input?.description ?? '',
                        subagentType: block.input?.subagent_type ?? 'general',
                        background: !!block.input?.run_in_background,
                    });
                }
            }
        }
    }

    // For background agents, check if the subagent JSONL is still being written to
    const sessionDir = logPath.replace(/\.jsonl$/, '');
    const subagentsDir = path.join(sessionDir, 'subagents');
    const now = Date.now();
    const ACTIVE_THRESHOLD_MS = 30_000; // 30 seconds

    const result = agentUses.map(a => {
        if (a.background) {
            // Background agent: check subagent file activity
            const agentId = bgAgentIds.get(a.id);
            if (agentId) {
                const subagentPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
                try {
                    const mtime = fs.statSync(subagentPath).mtimeMs;
                    const isActive = (now - mtime) < ACTIVE_THRESHOLD_MS;
                    return { id: a.id, description: a.description, subagentType: a.subagentType, running: isActive };
                } catch {
                    // file doesn't exist yet — agent is still starting
                    return { id: a.id, description: a.description, subagentType: a.subagentType, running: true };
                }
            }
            // No agentId found — shouldn't happen, but treat as done
            return { id: a.id, description: a.description, subagentType: a.subagentType, running: false };
        }
        // Foreground agent: simple tool_result check
        return { id: a.id, description: a.description, subagentType: a.subagentType, running: !resultIds.has(a.id) };
    });

    subagentCache.set(logPath, { size: fileSize, result });
    return result;
}
