import * as fs from 'fs';

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
