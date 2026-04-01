import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { dirToProjectName } from './utils';
import { logError } from './log';

/** Scan the Claude projects directory for a session matching the given claude file name. */
export async function scanForSession(cwd: string, claudeFileName: string): Promise<string | undefined> {
    const projectDir = dirToProjectName(cwd);
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectDir);

    try {
        await fs.promises.access(sessionsDir);
    } catch {
        return undefined; /* expected: project dir may not exist */
    }

    // Use the <local-command-stdout> wrapper to avoid false positives from
    // assistant messages that discuss/quote the rename pattern in code snippets.
    const needle = `<local-command-stdout>Session renamed to: \\"${claudeFileName}\\"</local-command-stdout>`;
    const matches: { sessionId: string; mtime: number }[] = [];

    let files: string[];
    try {
        files = await fs.promises.readdir(sessionsDir);
    } catch {
        return undefined; /* expected: dir may not be readable */
    }

    for (const file of files) {
        if (!file.endsWith('.jsonl')) {
            continue;
        }
        const filePath = path.join(sessionsDir, file);
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            if (content.includes(needle)) {
                const stat = await fs.promises.stat(filePath);
                matches.push({
                    sessionId: path.basename(file, '.jsonl'),
                    mtime: stat.mtimeMs,
                });
            }
        } catch (err) {
            logError(`scanForSession: reading ${file}`, err);
        }
    }

    if (matches.length === 0) {
        return undefined;
    }

    // Return the most recently modified session
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0].sessionId;
}
