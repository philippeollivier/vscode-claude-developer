import * as vscode from 'vscode';

export interface ExtensionConfig {
    autoOpenTerminal: boolean;
    terminalLocation: string;
    autoSetupOnStart: boolean;
    confirmCloseClaudeFile: boolean;
}

let cachedConfig: ExtensionConfig | undefined;

function readConfig(): ExtensionConfig {
    const cfg = vscode.workspace.getConfiguration('tabTerminal');
    return {
        autoOpenTerminal: cfg.get<boolean>('autoOpenTerminal', false),
        terminalLocation: cfg.get<string>('terminalLocation', 'right'),
        autoSetupOnStart: cfg.get<boolean>('autoSetupOnStart', true),
        confirmCloseClaudeFile: cfg.get<boolean>('confirmCloseClaudeFile', true),
    };
}

export function getConfig(): ExtensionConfig {
    if (!cachedConfig) {
        cachedConfig = readConfig();
    }
    return cachedConfig;
}

export function initConfig(context: vscode.ExtensionContext): void {
    cachedConfig = readConfig();
    const listener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tabTerminal')) {
            cachedConfig = undefined;
        }
    });
    context.subscriptions.push(listener);
}
