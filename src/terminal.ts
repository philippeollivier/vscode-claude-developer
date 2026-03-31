import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { isClaudeFile, getForkBase, nextForkName } from './utils';
import { getConfig } from './config';
import { SYNC_GUARD_DELAY_MS } from './constants';
import { getRegistry } from './registry';

// ── Sync guard (unchanged) ──────────────────────────────────────────────────

/** Guard to prevent infinite loops between editor<->terminal sync */
export let isSyncing = false;

/** Depth counter for nested/overlapping withSyncGuard calls */
let syncDepth = 0;

/** Execute fn while holding the sync guard, releasing after a delay */
export function withSyncGuard(fn: () => void | PromiseLike<unknown>, delay: number = SYNC_GUARD_DELAY_MS): void {
    syncDepth++;
    isSyncing = true;

    const cleanup = () => {
        syncDepth--;
        if (syncDepth === 0) {
            setTimeout(() => {
                if (syncDepth === 0) { isSyncing = false; }
            }, delay);
        }
    };

    try {
        const result = fn();
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            (result as PromiseLike<unknown>).then(cleanup, cleanup);
        } else {
            cleanup();
        }
    } catch (err) {
        cleanup();
        throw err;
    }
}

// ── Terminal management ──────────────────────────────────────────────────────

export async function openTerminalForEditor(
    editor: vscode.TextEditor,
    context: vscode.ExtensionContext,
    forkFromSessionId?: string,
): Promise<void> {
    const filePath = editor.document.uri.fsPath;
    const registry = getRegistry();

    // Check if terminal already exists and is alive
    const existing = registry.get(filePath);
    if (existing?.terminal && registry.validateTerminal(filePath)) {
        existing.terminal.show(true);
        return;
    }

    const location = getConfig().terminalLocation;
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const isClaudeDoc = isClaudeFile(filePath);
    const displayName = isClaudeDoc ? path.basename(filePath, '.claude') : fileName;

    const iconPath = isClaudeDoc
        ? vscode.Uri.joinPath(context.extensionUri, 'claude-icon.svg')
        : undefined;

    const env = isClaudeDoc
        ? { CLAUDE_FILE: path.basename(filePath, '.claude') }
        : undefined;

    const terminal = vscode.window.createTerminal({
        name: displayName,
        cwd: fileDir,
        iconPath,
        env,
        location: location === 'right'
            ? vscode.TerminalLocation.Editor
            : vscode.TerminalLocation.Panel
    });

    // Register in the session registry
    await registry.register(filePath, terminal);

    if (location === 'right') {
        terminal.show(true);
        vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
    } else {
        terminal.show(true);
    }

    // Auto-start claude for .claude files
    if (isClaudeDoc) {
        if (forkFromSessionId) {
            terminal.sendText(`{ echo '/rename "${displayName}"'; exec < /dev/tty; } | claude --resume "${forkFromSessionId}" --fork-session`);
        } else {
            const sessionId = await registry.resolveSessionId(filePath);
            if (sessionId) {
                terminal.sendText(`claude --resume "${sessionId}"`);
            } else {
                terminal.sendText(`{ echo '/rename "${displayName}"'; exec < /dev/tty; } | claude`);
            }
        }
    }
}

/** Fork an existing .claude session: create a new .claude file and terminal branching from the parent */
export async function forkSession(
    sourceUri: string,
    context: vscode.ExtensionContext,
): Promise<void> {
    const sourcePath = vscode.Uri.parse(sourceUri).fsPath;
    const dir = path.dirname(sourcePath);
    const sourceName = path.basename(sourcePath, '.claude');
    const baseName = getForkBase(sourceName);
    const registry = getRegistry();

    const sessionId = await registry.resolveSessionId(sourcePath);
    if (!sessionId) {
        vscode.window.showWarningMessage(`No Claude session found for ${sourceName}`);
        return;
    }

    const forkName = nextForkName(dir, baseName);
    const forkPath = path.join(dir, `${forkName}.claude`);

    try {
        await fs.promises.writeFile(forkPath, `# Fork of ${sourceName}\n`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to create fork: ${err}`);
        return;
    }

    withSyncGuard(async () => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(forkPath));
        const editor = await vscode.window.showTextDocument(doc);
        await openTerminalForEditor(editor, context, sessionId);
    }, 200);
}

export function closeTerminalForEditor(filePath: string): void {
    const registry = getRegistry();
    // Support both fsPath and URI string for backward compat
    const entry = registry.get(filePath) ?? registry.getByUri(filePath);
    if (entry?.terminal) {
        entry.terminal.dispose();
        registry.clearTerminal(entry.filePath);
    }
}
