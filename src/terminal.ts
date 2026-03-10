import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { isClaudeFile } from './utils';
import { getConfig } from './config';

// ── Mutable shared state ─────────────────────────────────────────────────────

/** Map to track which terminal belongs to which editor (by document URI) */
export const editorTerminalMap = new Map<string, vscode.Terminal>();

/** Track terminals we created so we can identify them */
export const managedTerminals = new Set<vscode.Terminal>();

/** Guard to prevent infinite loops between editor<->terminal sync */
export let isSyncing = false;

export function setIsSyncing(value: boolean): void {
    isSyncing = value;
}

/** Execute fn while holding the sync guard, releasing after a delay */
export function withSyncGuard(fn: () => void | PromiseLike<unknown>, delay: number = 100): void {
    isSyncing = true;
    const result = fn();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as PromiseLike<unknown>).then(
            () => setTimeout(() => { isSyncing = false; }, delay),
            () => setTimeout(() => { isSyncing = false; }, delay),
        );
    } else {
        setTimeout(() => { isSyncing = false; }, delay);
    }
}

// ── Terminal management ──────────────────────────────────────────────────────

export function openTerminalForEditor(editor: vscode.TextEditor, context: vscode.ExtensionContext): void {
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
        const sessionId = findExistingSession(fileDir, displayName);
        if (sessionId) {
            terminal.sendText(`claude --resume "${sessionId}"`);
        } else {
            terminal.sendText(`{ echo '/rename "${displayName}"'; exec < /dev/tty; } | claude`);
        }
    }
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

export function findExistingSession(cwd: string, claudeFileName: string): string | undefined {
    const projectDir = cwd.replace(/[/ ]/g, '-');
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectDir);

    if (!fs.existsSync(sessionsDir)) {
        return undefined;
    }

    const needle = `Session renamed to: \\"${claudeFileName}\\"`;
    const matches: { sessionId: string; mtime: number }[] = [];

    for (const file of fs.readdirSync(sessionsDir)) {
        if (!file.endsWith('.jsonl')) {
            continue;
        }
        const filePath = path.join(sessionsDir, file);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.includes(needle)) {
                const stat = fs.statSync(filePath);
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
