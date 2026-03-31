import * as vscode from 'vscode';
import * as path from 'path';
import { SessionInfo } from './types';
import { isClaudeFile } from './utils';
import { readHookState } from './state';
import { getRegistry } from './registry';

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
    const registry = getRegistry();
    const paths: string[] = [];

    forEachClaudeTab((_uri, fsPath) => { paths.push(fsPath); });

    await Promise.all(paths.map(async (fsPath) => {
        if (!registry.has(fsPath)) {
            await registry.register(fsPath);
        } else if (!registry.get(fsPath)!.sessionId) {
            await registry.resolveSessionId(fsPath);
        }
    }));

    await registry.refreshLastActive();

    for (const fsPath of paths) {
        const entry = registry.get(fsPath);
        if (entry) {
            const hookState = readHookState(entry.claudeFile, entry.lastActive);
            registry.updateHookState(fsPath, hookState);
        }
    }

    return registry.toSessionInfoArray().filter(s =>
        paths.includes(path.join(s.dir, s.claudeFile + '.claude'))
    );
}

export function getOpenClaudeFileNames(): Set<string> {
    const names = new Set<string>();
    forEachClaudeTab((_uri, fsPath) => {
        names.add(path.basename(fsPath, '.claude'));
    });
    return names;
}
