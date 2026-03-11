import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { isClaudeFile, getForkBase, nextForkName, dirToProjectName } from './utils';
import { getConfig } from './config';
import { SYNC_GUARD_DELAY_MS } from './constants';

// ── Mutable shared state ─────────────────────────────────────────────────────

/** Map to track which terminal belongs to which editor (by document URI) */
export const editorTerminalMap = new Map<string, vscode.Terminal>();

/** Track terminals we created so we can identify them */
export const managedTerminals = new Set<vscode.Terminal>();

/** Guard to prevent infinite loops between editor<->terminal sync */
export let isSyncing = false;

/** Depth counter for nested/overlapping withSyncGuard calls */
let syncDepth = 0;

export function setIsSyncing(value: boolean): void {
    isSyncing = value;
}

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
    const uri = editor.document.uri.toString();

    // Check if terminal already exists for this editor
    if (editorTerminalMap.has(uri)) {
        const existingTerminal = editorTerminalMap.get(uri);
        if (existingTerminal) {
            existingTerminal.show(true);
            return;
        }
    }

    const location = getConfig().terminalLocation;

    // Get the directory of the current file
    const filePath = editor.document.uri.fsPath;
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const isClaudeDoc = isClaudeFile(filePath);
    const displayName = isClaudeDoc ? path.basename(filePath, '.claude') : fileName;

    // Use Claude icon for .claude files
    const iconPath = isClaudeDoc
        ? vscode.Uri.joinPath(context.extensionUri, 'claude-icon.svg')
        : undefined;

    const env = isClaudeDoc
        ? { CLAUDE_FILE: path.basename(filePath, '.claude') }
        : undefined;

    // Create a new terminal with a name based on the file
    const terminal = vscode.window.createTerminal({
        name: displayName,
        cwd: fileDir,
        iconPath,
        env,
        location: location === 'right'
            ? vscode.TerminalLocation.Editor
            : vscode.TerminalLocation.Panel
    });

    // Track this terminal
    editorTerminalMap.set(uri, terminal);
    managedTerminals.add(terminal);

    // If using editor location (right side), we need to move it to a split
    if (location === 'right') {
        // Show the terminal which will create it in the editor area
        terminal.show(true);

        // Move terminal to the side
        vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
    } else {
        terminal.show(true);
    }

    // Auto-start claude for .claude files
    if (isClaudeDoc) {
        if (forkFromSessionId) {
            // Fork: create new session branching from the parent, then rename
            terminal.sendText(`{ echo '/rename "${displayName}"'; exec < /dev/tty; } | claude --resume "${forkFromSessionId}" --fork-session`);
        } else {
            const sessionId = await findExistingSession(fileDir, displayName);
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

    // Find the parent session ID
    const sessionId = await findExistingSession(dir, sourceName);
    if (!sessionId) {
        vscode.window.showWarningMessage(`No Claude session found for ${sourceName}`);
        return;
    }

    // Determine the fork name
    const forkName = nextForkName(dir, baseName);
    const forkPath = path.join(dir, `${forkName}.claude`);

    // Create the fork .claude file
    try {
        await fs.promises.writeFile(forkPath, `# Fork of ${sourceName}\n`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to create fork: ${err}`);
        return;
    }

    // Suppress the auto-terminal listener so it doesn't race us with a non-forked session
    withSyncGuard(async () => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(forkPath));
        const editor = await vscode.window.showTextDocument(doc);
        await openTerminalForEditor(editor, context, sessionId);
    }, 200);
}

/**
 * Remove a terminal from both tracking collections (editorTerminalMap and managedTerminals).
 * Does NOT dispose the terminal -- callers that need disposal should call terminal.dispose() first.
 */
export function cleanupTerminal(terminal: vscode.Terminal): void {
    managedTerminals.delete(terminal);
    for (const [uri, t] of editorTerminalMap.entries()) {
        if (t === terminal) {
            editorTerminalMap.delete(uri);
            break;
        }
    }
}

export function closeTerminalForEditor(uri: string): void {
    const terminal = editorTerminalMap.get(uri);
    if (terminal) {
        terminal.dispose();
        cleanupTerminal(terminal);
    }
}

export async function findExistingSession(cwd: string, claudeFileName: string): Promise<string | undefined> {
    const projectDir = dirToProjectName(cwd);
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectDir);

    try {
        await fs.promises.access(sessionsDir);
    } catch {
        return undefined;
    }

    const needle = `Session renamed to: \\"${claudeFileName}\\"`;
    const matches: { sessionId: string; mtime: number }[] = [];

    let files: string[];
    try {
        files = await fs.promises.readdir(sessionsDir);
    } catch {
        return undefined;
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
        } catch {
            // skip unreadable files
        }
    }

    if (matches.length === 0) {
        return undefined;
    }

    // Return the most recently modified session
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0].sessionId;
}
