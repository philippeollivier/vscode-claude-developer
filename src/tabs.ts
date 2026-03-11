import * as vscode from 'vscode';
import * as path from 'path';
import { SessionInfo } from './types';
import { isClaudeFile, getSessionLogPath } from './utils';
import { readHookState } from './state';
import { findExistingSession } from './terminal';
import * as fs from 'fs';

/** Find all open tabs whose document URI matches the given string. */
export function findTabsByUri(targetUri: string): vscode.Tab[] {
    const found: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === targetUri) {
                found.push(tab);
            }
        }
    }
    return found;
}

/** Iterate all open .claude tabs (deduplicated by fsPath), invoking callback with the URI and fsPath. */
export function forEachClaudeTab(callback: (uri: vscode.Uri, fsPath: string) => void): void {
    const seen = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && isClaudeFile(tab.input.uri.fsPath)) {
                const fsPath = tab.input.uri.fsPath;
                if (seen.has(fsPath)) { continue; }
                seen.add(fsPath);
                callback(tab.input.uri, fsPath);
            }
        }
    }
}

export async function getOpenClaudeFiles(): Promise<SessionInfo[]> {
    const entries: { name: string; dir: string }[] = [];

    forEachClaudeTab((_uri, fsPath) => {
        entries.push({
            name: path.basename(fsPath, '.claude'),
            dir: path.dirname(fsPath),
        });
    });

    const results = await Promise.all(entries.map(async ({ name, dir }) => {
        const sessionId = await findExistingSession(dir, name);

        let logPath: string | undefined;
        let lastActive: Date | undefined;
        if (sessionId) {
            logPath = getSessionLogPath(dir, sessionId);
            try { lastActive = (await fs.promises.stat(logPath)).mtime; } catch {}
        }

        const hookState = readHookState(name, lastActive);
        return { claudeFile: name, dir, sessionId, logPath, lastActive, hookState } as SessionInfo;
    }));

    return results;
}

export function getOpenClaudeFileNames(): Set<string> {
    const names = new Set<string>();
    forEachClaudeTab((_uri, fsPath) => {
        names.add(path.basename(fsPath, '.claude'));
    });
    return names;
}
