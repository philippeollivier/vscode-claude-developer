import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SessionInfo } from './types';
import { isClaudeFile } from './utils';
import { readHookState } from './state';
import { findExistingSession } from './terminal';
import * as fs from 'fs';

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

export function getOpenClaudeFiles(): SessionInfo[] {
    const results: SessionInfo[] = [];

    forEachClaudeTab((_uri, fsPath) => {
        const name = path.basename(fsPath, '.claude');
        const dir = path.dirname(fsPath);
        const sessionId = findExistingSession(dir, name);

        let logPath: string | undefined;
        let lastActive: Date | undefined;
        if (sessionId) {
            const projectDir = dir.replace(/[/ ]/g, '-');
            logPath = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
            try { lastActive = fs.statSync(logPath).mtime; } catch {}
        }

        const hookState = readHookState(name, lastActive);
        results.push({ claudeFile: name, dir, sessionId, logPath, lastActive, hookState });
    });

    return results;
}

export function getOpenClaudeFileNames(): Set<string> {
    const names = new Set<string>();
    forEachClaudeTab((_uri, fsPath) => {
        names.add(path.basename(fsPath, '.claude'));
    });
    return names;
}
