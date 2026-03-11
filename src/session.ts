import * as fs from 'fs';
import * as path from 'path';
import {
    SubagentInfo, LogEntry, LogContentBlock,
    AgentUseEntry, SubagentCacheEntry, ParsedAgentData,
} from './types';
import { TAIL_CHUNK_SIZE, SUBAGENT_ACTIVE_THRESHOLD_MS } from './constants';
import { safeJsonParse } from './utils';

// ── Async tail-reading ───────────────────────────────────────────────────────

export async function readTailChunk(logPath: string, chunkSize: number): Promise<string[]> {
    const fh = await fs.promises.open(logPath, 'r');
    try {
        const stat = await fh.stat();
        const fileSize = stat.size;
        const readSize = Math.min(chunkSize, fileSize);
        const readOffset = fileSize - readSize;

        const buf = Buffer.alloc(readSize);
        await fh.read(buf, 0, readSize, readOffset);

        let lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
        // Skip first line if partial (reading from middle of file)
        if (readOffset > 0 && lines.length > 0) {
            lines = lines.slice(1);
        }
        return lines;
    } finally {
        await fh.close();
    }
}

export function parseLastMessages(jsonlLines: string[]): { lastUser: string; lastAssistant: string } {
    let lastUser = '';
    let lastAssistant = '';

    for (const line of jsonlLines) {
        const entry = safeJsonParse<LogEntry>(line);
        if (!entry) { continue; }

        if (entry.type === 'user' && entry.message?.content) {
            const text = typeof entry.message.content === 'string'
                ? entry.message.content : '';
            if (text) { lastUser = text; }
        } else if (entry.type === 'assistant' && entry.message?.content) {
            if (Array.isArray(entry.message.content)) {
                const textParts = (entry.message.content as LogContentBlock[])
                    .filter(c => c.type === 'text')
                    .map(c => c.text ?? '');
                if (textParts.length) {
                    lastAssistant = textParts.join('\n');
                }
            }
        }
    }
    return { lastUser, lastAssistant };
}

export async function tailSessionMessages(logPath: string, maxLines: number = 12): Promise<string[]> {
    // Try tail chunk first; fall back to full read if no messages found
    let lines = await readTailChunk(logPath, TAIL_CHUNK_SIZE);
    let { lastUser, lastAssistant } = parseLastMessages(lines);

    // If tail chunk missed the messages (e.g. huge tool-use entries), read full file
    if (!lastUser && !lastAssistant) {
        const stat = await fs.promises.stat(logPath);
        if (stat.size > TAIL_CHUNK_SIZE) {
            const content = await fs.promises.readFile(logPath, 'utf-8');
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

// ── Subagent parsing ─────────────────────────────────────────────────────────

// Cache for subagent parsing — avoids re-reading large files every refresh.
// Keyed on logPath; validated against both mtimeMs and size.
const subagentCache = new Map<string, SubagentCacheEntry>();

/** Check the cache; return the cached result if still valid, or null to signal re-parse. */
function getCachedSubagents(logPath: string, mtimeMs: number, size: number): SubagentInfo[] | null {
    const cached = subagentCache.get(logPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.result;
    }
    return null;
}

/**
 * Extract text content from a tool_result block's content field,
 * which may be a plain string or an array of LogContentBlock.
 */
function extractToolResultText(block: LogContentBlock): string {
    if (typeof block.content === 'string') {
        return block.content;
    }
    if (Array.isArray(block.content)) {
        return (block.content as LogContentBlock[]).map(c => c.text ?? '').join('');
    }
    return '';
}

/** Parse JSONL content and extract Agent tool_use entries, result IDs, and background agent IDs. */
function extractAgentData(content: string): ParsedAgentData {
    const agentUses: AgentUseEntry[] = [];
    const resultIds = new Set<string>();
    const bgAgentIds = new Map<string, string>();

    for (const line of content.split('\n')) {
        if (!line.trim()) { continue; }
        const entry = safeJsonParse<LogEntry>(line);
        if (!entry) { continue; }

        // Collect tool_result IDs from top-level tool_result entries
        if (entry.type === 'tool_result' && entry.tool_use_id) {
            resultIds.add(entry.tool_use_id);
        }

        // Collect tool_result IDs and background agent launch confirmations from user messages
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
            for (const block of entry.message.content as LogContentBlock[]) {
                if (block?.type === 'tool_result' && block.tool_use_id) {
                    resultIds.add(block.tool_use_id);
                    // Extract agentId from "Async agent launched" confirmations
                    const text = extractToolResultText(block);
                    const match = text.match(/Async agent launched[\s\S]*?agentId: (\w+)/);
                    if (match) {
                        bgAgentIds.set(block.tool_use_id, match[1]);
                    }
                }
            }
        }

        // Collect Agent tool_use entries from assistant messages
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
            for (const block of entry.message.content as LogContentBlock[]) {
                if (block?.type === 'tool_use' && block.name === 'Agent') {
                    agentUses.push({
                        id: block.id ?? '',
                        description: (block.input?.description as string) ?? '',
                        subagentType: (block.input?.subagent_type as string) ?? 'general',
                        background: !!block.input?.run_in_background,
                    });
                }
            }
        }
    }

    return { agentUses, resultIds, bgAgentIds };
}

/** Determine whether a single agent entry is still running. */
async function isAgentRunning(
    agent: AgentUseEntry,
    resultIds: Set<string>,
    bgAgentIds: Map<string, string>,
    subagentsDir: string,
    now: number,
): Promise<boolean> {
    if (!agent.background) {
        // Foreground agent: running if no tool_result has been received
        return !resultIds.has(agent.id);
    }

    // Background agent: check whether its subagent JSONL is still being written to
    const agentId = bgAgentIds.get(agent.id);
    if (!agentId) {
        // No agentId found — shouldn't happen, but treat as done
        return false;
    }

    const subagentPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
    try {
        const stat = await fs.promises.stat(subagentPath);
        return (now - stat.mtimeMs) < SUBAGENT_ACTIVE_THRESHOLD_MS;
    } catch {
        // File doesn't exist yet — agent is still starting
        return true;
    }
}

/** Parse JSONL to find Agent tool_use entries and match with tool_results. */
export async function parseSubagents(logPath: string): Promise<SubagentInfo[]> {
    // Stat the file; bail on missing files
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(logPath);
    } catch {
        return [];
    }

    // Return cached result if file hasn't changed (check both mtime and size)
    const cached = getCachedSubagents(logPath, stat.mtimeMs, stat.size);
    if (cached) {
        return cached;
    }

    // Read and parse the file
    let content: string;
    try {
        content = await fs.promises.readFile(logPath, 'utf-8');
    } catch {
        return [];
    }

    const { agentUses, resultIds, bgAgentIds } = extractAgentData(content);

    // Resolve running state for each agent
    const sessionDir = logPath.replace(/\.jsonl$/, '');
    const subagentsDir = path.join(sessionDir, 'subagents');
    const now = Date.now();

    const result = await Promise.all(
        agentUses.map(async (a): Promise<SubagentInfo> => {
            const running = await isAgentRunning(a, resultIds, bgAgentIds, subagentsDir, now);
            return {
                id: a.id,
                description: a.description,
                subagentType: a.subagentType,
                running,
            };
        }),
    );

    subagentCache.set(logPath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
    return result;
}
