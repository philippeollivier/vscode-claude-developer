import * as fs from 'fs';
import * as path from 'path';
import {
    SubagentInfo, LogEntry, LogContentBlock,
    AgentUseEntry, SubagentCacheEntry, ParsedAgentData,
} from './types';
import { TAIL_CHUNK_SIZE, SUBAGENT_ACTIVE_THRESHOLD_MS } from './constants';
import { safeJsonParse } from './utils';

const subagentCache = new Map<string, SubagentCacheEntry>();

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
        } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
            const textParts = (entry.message.content as LogContentBlock[])
                .filter(c => c.type === 'text')
                .map(c => c.text ?? '');
            if (textParts.length) {
                lastAssistant = textParts.join('\n');
            }
        }
    }
    return { lastUser, lastAssistant };
}

export async function tailSessionMessages(logPath: string, maxLines: number = 12): Promise<string[]> {
    let lines = await readTailChunk(logPath, TAIL_CHUNK_SIZE);
    let { lastUser, lastAssistant } = parseLastMessages(lines);

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

function getCachedSubagents(logPath: string, mtimeMs: number, size: number): SubagentInfo[] | null {
    const cached = subagentCache.get(logPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.result;
    }
    return null;
}

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

        if (entry.type === 'tool_result' && entry.tool_use_id) {
            resultIds.add(entry.tool_use_id);
        }

        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
            for (const block of entry.message.content as LogContentBlock[]) {
                if (block?.type === 'tool_result' && block.tool_use_id) {
                    resultIds.add(block.tool_use_id);
                    const text = extractToolResultText(block);
                    const match = text.match(/Async agent launched[\s\S]*?agentId: (\w+)/);
                    if (match) {
                        bgAgentIds.set(block.tool_use_id, match[1]);
                    }
                }
            }
        }

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

async function isAgentRunning(
    agent: AgentUseEntry,
    resultIds: Set<string>,
    bgAgentIds: Map<string, string>,
    subagentsDir: string,
    now: number,
): Promise<boolean> {
    if (!agent.background) {
        return !resultIds.has(agent.id);
    }

    const agentId = bgAgentIds.get(agent.id);
    if (!agentId) {
        return false;
    }

    const subagentPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
    try {
        const stat = await fs.promises.stat(subagentPath);
        return (now - stat.mtimeMs) < SUBAGENT_ACTIVE_THRESHOLD_MS;
    } catch {
        return true;
    }
}

export async function parseSubagents(logPath: string): Promise<SubagentInfo[]> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(logPath);
    } catch {
        return [];
    }

    const cached = getCachedSubagents(logPath, stat.mtimeMs, stat.size);
    if (cached) {
        return cached;
    }

    let content: string;
    try {
        const lines = await readTailChunk(logPath, TAIL_CHUNK_SIZE);
        content = lines.join('\n');
    } catch {
        return [];
    }

    const { agentUses, resultIds, bgAgentIds } = extractAgentData(content);

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
