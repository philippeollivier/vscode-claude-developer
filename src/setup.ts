import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { SetupStatus } from './types';
import {
    HOOKS_VERSION,
    GLOBAL_STATE_HOOKS_VERSION_KEY,
    GLOBAL_STATE_SETUP_DISMISSED_KEY,
} from './constants';

const HOOK_FILES = [
    'state-tracker.py',
    'compound-bash-allow.py',
    'compound-bash-learn.py',
    'permission-request-allow.py',
    'notify.sh',
    'log-approved.sh',
    'clear-state.sh',
    'compound-bash-config.json',
    'lib/__init__.py',
    'lib/command_splitter.py',
    'lib/pattern_matcher.py',
    'lib/pattern_generator.py',
];

const EXECUTABLE_EXTENSIONS = ['.py', '.sh'];

function hooksDir(): string {
    return path.join(os.homedir(), '.claude', 'hooks');
}

function settingsPath(): string {
    return path.join(os.homedir(), '.claude', 'settings.json');
}

function commandExists(cmd: string): boolean {
    try {
        execSync(`which ${cmd}`, { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

// ── Check setup status ──────────────────────────────────────────────────────

export async function checkSetupStatus(context: vscode.ExtensionContext): Promise<SetupStatus> {
    const dest = hooksDir();
    const missingHookFiles: string[] = [];

    for (const file of HOOK_FILES) {
        const fullPath = path.join(dest, file);
        if (!fs.existsSync(fullPath)) {
            missingHookFiles.push(file);
        }
    }

    const hooksInstalled = missingHookFiles.length === 0;

    // Check settings.json has hooks configured
    let settingsConfigured = false;
    try {
        if (fs.existsSync(settingsPath())) {
            const raw = fs.readFileSync(settingsPath(), 'utf-8');
            const settings = JSON.parse(raw);
            settingsConfigured = !!(settings.hooks && settings.hooks.PreToolUse && settings.hooks.PostToolUse);
        }
    } catch {
        // settings unreadable
    }

    const storedVersion = context.globalState.get<number>(GLOBAL_STATE_HOOKS_VERSION_KEY);
    const needsUpdate = storedVersion === undefined || storedVersion < HOOKS_VERSION;

    return {
        hooksInstalled,
        missingHookFiles,
        settingsConfigured,
        hooksVersion: storedVersion,
        needsUpdate,
        dependencies: {
            python3: commandExists('python3'),
            jq: commandExists('jq'),
            terminalNotifier: commandExists('terminal-notifier'),
        },
    };
}

// ── Run setup ───────────────────────────────────────────────────────────────

export async function runSetup(
    context: vscode.ExtensionContext,
): Promise<{ success: boolean; message: string }> {
    try {
        const dest = hooksDir();
        const dirsToCreate = [
            dest,
            path.join(dest, 'lib'),
            path.join(dest, 'state'),
            path.join(dest, 'logs'),
        ];
        for (const dir of dirsToCreate) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const srcDir = path.join(context.extensionPath, 'hooks');

        for (const file of HOOK_FILES) {
            const srcFile = path.join(srcDir, file);
            const destFile = path.join(dest, file);

            // Skip compound-bash-config.json if user already has one
            if (file === 'compound-bash-config.json' && fs.existsSync(destFile)) {
                continue;
            }

            // Ensure parent directory exists (for lib/ files)
            const destDir = path.dirname(destFile);
            fs.mkdirSync(destDir, { recursive: true });

            fs.copyFileSync(srcFile, destFile);

            // Set executable permissions on .py and .sh files
            const ext = path.extname(file);
            if (EXECUTABLE_EXTENSIONS.includes(ext)) {
                fs.chmodSync(destFile, 0o755);
            }
        }

        // Merge hooks into settings.json
        await mergeHooksConfig();

        // Store version
        await context.globalState.update(GLOBAL_STATE_HOOKS_VERSION_KEY, HOOKS_VERSION);

        return { success: true, message: 'Hooks installed and settings.json updated.' };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Setup failed: ${message}` };
    }
}

// ── Merge hooks config ──────────────────────────────────────────────────────

interface HookEntry {
    type: string;
    command: string;
}

interface MatcherGroup {
    matcher: string;
    hooks: HookEntry[];
}

type HooksConfig = Record<string, MatcherGroup[]>;

function buildRequiredHooksConfig(): HooksConfig {
    const home = os.homedir();
    const hDir = path.join(home, '.claude', 'hooks');

    const py = (script: string, ...args: string[]) => ({
        type: 'command' as const,
        command: `python3 ${path.join(hDir, script)}${args.length ? ' ' + args.join(' ') : ''}`,
    });

    const sh = (script: string) => ({
        type: 'command' as const,
        command: path.join(hDir, script),
    });

    return {
        PreToolUse: [
            {
                matcher: '',
                hooks: [
                    py('compound-bash-allow.py'),
                    py('state-tracker.py', 'PreToolUse'),
                ],
            },
        ],
        PermissionRequest: [
            {
                matcher: '',
                hooks: [
                    py('permission-request-allow.py'),
                ],
            },
        ],
        Notification: [
            {
                matcher: '',
                hooks: [
                    sh('notify.sh'),
                    py('state-tracker.py', 'Notification'),
                ],
            },
        ],
        PostToolUse: [
            {
                matcher: '',
                hooks: [
                    py('state-tracker.py', 'PostToolUse'),
                    sh('log-approved.sh'),
                ],
            },
            {
                matcher: '',
                hooks: [
                    py('compound-bash-learn.py'),
                ],
            },
        ],
        Stop: [
            {
                matcher: '',
                hooks: [
                    py('state-tracker.py', 'Stop'),
                ],
            },
        ],
        StopFailure: [
            {
                matcher: '',
                hooks: [
                    py('state-tracker.py', 'StopFailure'),
                ],
            },
        ],
        UserPromptSubmit: [
            {
                matcher: '',
                hooks: [
                    py('state-tracker.py', 'UserPromptSubmit'),
                ],
            },
        ],
        SessionStart: [
            {
                matcher: '',
                hooks: [
                    py('state-tracker.py', 'SessionStart'),
                ],
            },
        ],
    };
}

/** Extract the script basename from a hook command string. */
function extractBasename(command: string): string {
    // Commands are either "python3 /path/to/script.py args" or "/path/to/script.sh"
    const parts = command.split(/\s+/);
    if (parts[0] === 'python3' && parts.length > 1) {
        return path.basename(parts[1]);
    }
    return path.basename(parts[0]);
}

export async function mergeHooksConfig(): Promise<void> {
    const filePath = settingsPath();

    let settings: Record<string, unknown>;
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            settings = JSON.parse(raw);
        } else {
            settings = {};
        }
    } catch {
        settings = {};
    }

    const existingHooks = (settings.hooks || {}) as HooksConfig;
    const requiredHooks = buildRequiredHooksConfig();

    for (const [eventType, requiredGroups] of Object.entries(requiredHooks)) {
        const existingGroups: MatcherGroup[] = existingHooks[eventType] || [];

        for (const reqGroup of requiredGroups) {
            for (const reqHook of reqGroup.hooks) {
                const reqBasename = extractBasename(reqHook.command);

                // Search across all existing groups for this event to find if this script is already present
                let found = false;
                for (const existGroup of existingGroups) {
                    for (let i = 0; i < existGroup.hooks.length; i++) {
                        const existBasename = extractBasename(existGroup.hooks[i].command);
                        if (existBasename === reqBasename) {
                            // Update the command path in place
                            existGroup.hooks[i] = { ...existGroup.hooks[i], command: reqHook.command };
                            found = true;
                            break;
                        }
                    }
                    if (found) { break; }
                }

                if (!found) {
                    // Find an existing group that already has hooks from the same required group
                    let targetGroup = existingGroups.find(
                        g => g.matcher === reqGroup.matcher &&
                            reqGroup.hooks.some(rh => {
                                const rb = extractBasename(rh.command);
                                return g.hooks.some(eh => extractBasename(eh.command) === rb);
                            }),
                    );

                    if (!targetGroup) {
                        // Create a new group
                        targetGroup = { matcher: reqGroup.matcher, hooks: [] };
                        existingGroups.push(targetGroup);
                    }

                    targetGroup.hooks.push(reqHook);
                }
            }
        }

        existingHooks[eventType] = existingGroups;
    }

    settings.hooks = existingHooks;
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

// ── Check and prompt ────────────────────────────────────────────────────────

export async function checkAndPromptSetup(context: vscode.ExtensionContext): Promise<void> {
    const status = await checkSetupStatus(context);

    // If fully installed and up to date, nothing to do
    if (status.hooksInstalled && status.settingsConfigured && !status.needsUpdate) {
        return;
    }

    // If user dismissed and no version update needed, respect that
    const dismissed = context.globalState.get<boolean>(GLOBAL_STATE_SETUP_DISMISSED_KEY);
    if (dismissed && !status.needsUpdate) {
        return;
    }

    const detail = status.needsUpdate
        ? 'Claude Developer hooks have an update available. Configure now?'
        : 'Claude Developer hooks are not fully configured. Set up now?';

    const choice = await vscode.window.showInformationMessage(
        detail,
        'Configure',
        'Later',
        "Don't Ask Again",
    );

    if (choice === 'Configure') {
        const result = await runSetup(context);
        if (result.success) {
            // Clear dismissed flag on successful setup
            await context.globalState.update(GLOBAL_STATE_SETUP_DISMISSED_KEY, undefined);
            vscode.window.showInformationMessage(`Claude Developer: ${result.message}`);
        } else {
            vscode.window.showErrorMessage(`Claude Developer: ${result.message}`);
        }
    } else if (choice === "Don't Ask Again") {
        await context.globalState.update(GLOBAL_STATE_SETUP_DISMISSED_KEY, true);
    }
    // "Later" or dismissed dialog: do nothing
}
