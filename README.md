# Claude Developer

A VS Code extension that turns VS Code into a management hub for multiple concurrent Claude Code agents. Each `.claude` file acts as a control surface for one agent session, with automatic terminal pairing, session persistence, real-time status monitoring, session forking, subagent tracking, and a unified dashboard.

## Prerequisites

- **VS Code** 1.85.0+
- **Claude CLI** installed and in PATH (`npm install -g @anthropic-ai/claude-code`)
- **terminal-notifier** (optional, for click-to-navigate macOS notifications): `brew install terminal-notifier`
- **jq** (required by the audit log hook): `brew install jq`

## Installation

```bash
cd "/path/to/vscode-claude-developer"
npm install
npm run compile
```

Then reload VS Code (`Cmd+Shift+P` > "Reload Window"). The extension activates automatically on startup.

## Setup

The extension reads hook state files to track agent status. You need to configure Claude Code hooks and place the hook scripts.

### 1. Create hook scripts

Create the directory and scripts:

```bash
mkdir -p ~/.claude/hooks/state
```

#### `~/.claude/hooks/notify.sh`

Triggered when Claude is waiting for user input. Writes a state file and sends a macOS notification.

```bash
#!/usr/bin/env bash
INPUT=$(cat)

TYPE=$(echo "$INPUT" | grep -o '"notification_type":"[^"]*"' | cut -d'"' -f4)
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | cut -d'"' -f4)

if [ -n "$CLAUDE_FILE" ]; then
    TAB_NAME="$CLAUDE_FILE"
    CLAUDE_FILE_PATH="$CWD/$CLAUDE_FILE.claude"
else
    TAB_NAME=$(basename "$CWD")
fi

case "$TYPE" in
  permission_prompt) MSG="Needs permission to proceed" ;;
  idle_prompt)       MSG="Finished and waiting for input" ;;
  *)                 MSG="Waiting for your input" ;;
esac

STATE_DIR="$HOME/.claude/hooks/state"
mkdir -p "$STATE_DIR"
if [ -n "$CLAUDE_FILE" ]; then
    echo "{\"type\":\"$TYPE\",\"timestamp\":$(date +%s),\"message\":\"$MSG\",\"cwd\":\"$CWD\",\"tab\":\"$TAB_NAME\"}" > "$STATE_DIR/$CLAUDE_FILE.json"
fi

if command -v terminal-notifier &>/dev/null; then
    ARGS=(
        -title "Claude Code — $TAB_NAME"
        -message "$MSG"
        -sound Glass
        -group "claude-$TAB_NAME"
    )
    if [ -n "$CLAUDE_FILE_PATH" ] && [ -f "$CLAUDE_FILE_PATH" ]; then
        ARGS+=(-execute "open -a 'Visual Studio Code' '$CLAUDE_FILE_PATH'")
    else
        ARGS+=(-activate com.microsoft.VSCode)
    fi
    terminal-notifier "${ARGS[@]}"
else
    osascript -e "display notification \"$MSG\" with title \"Claude Code — $TAB_NAME\" sound name \"Glass\""
fi
```

#### `~/.claude/hooks/clear-state.sh`

Triggered after every tool execution. Removes the state file so the dashboard knows Claude resumed work.

```bash
#!/usr/bin/env bash
if [ -n "$CLAUDE_FILE" ]; then
    STATE_FILE="$HOME/.claude/hooks/state/$CLAUDE_FILE.json"
    [ -f "$STATE_FILE" ] && rm -f "$STATE_FILE"
fi
```

#### `~/.claude/hooks/log-approved.sh` (optional)

Audit log of every approved tool use for tracking common permission requests.

```bash
#!/usr/bin/env bash
LOG_DIR="$HOME/.claude/hooks/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/approved-operations.log"

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL" ] && exit 0

TS=$(date '+%Y-%m-%d %H:%M:%S')
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"' | head -c 12)
TAB="${CLAUDE_FILE:-unknown}"

case "$TOOL" in
  Bash)     SUMMARY=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 200) ;;
  Edit|Write|Read) SUMMARY=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty') ;;
  Grep)     SUMMARY="pattern=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')" ;;
  Glob)     SUMMARY="glob=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')" ;;
  WebFetch) SUMMARY=$(echo "$INPUT" | jq -r '.tool_input.url // empty') ;;
  WebSearch) SUMMARY=$(echo "$INPUT" | jq -r '.tool_input.query // empty') ;;
  Agent)    SUMMARY=$(echo "$INPUT" | jq -r '.tool_input.description // empty') ;;
  *)        SUMMARY=$(echo "$INPUT" | jq -c '.tool_input // {}' | head -c 200) ;;
esac

echo "$TS | $TAB | $TOOL | $SUMMARY" >> "$LOG_FILE"
```

Make them executable:

```bash
chmod +x ~/.claude/hooks/notify.sh ~/.claude/hooks/clear-state.sh ~/.claude/hooks/log-approved.sh
```

### 2. Configure Claude Code hooks

Add the following to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/YOUR_USERNAME/.claude/hooks/notify.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/YOUR_USERNAME/.claude/hooks/clear-state.sh"
          },
          {
            "type": "command",
            "command": "/Users/YOUR_USERNAME/.claude/hooks/log-approved.sh"
          }
        ]
      }
    ]
  }
}
```

Replace `YOUR_USERNAME` with your macOS username.

### 3. Auto-approve `.claude` file edits (optional)

Add these to the `permissions` array in `~/.claude/settings.json` so agents can freely update their linked `.claude` files:

```json
"permissions": {
  "allow": [
    "Edit(file_path:*.claude)",
    "Write(file_path:*.claude)"
  ]
}
```

## Usage

### Creating sessions

Create a `.claude` file in any project directory. The extension automatically pairs it with a terminal running Claude Code. You can also use the **+** button on each directory header in the dashboard.

### Dashboard (`Cmd+D`)

The dashboard shows all open `.claude` files as cards, grouped by directory:

- **Status pill** — Active (green), Pending Permission (amber), Waiting on User (blue)
- **Timestamps** — Relative time since last session activity
- **Message tail** — Last N messages from the session log, markdown-rendered
- **Running subagents** — Pulsing green dots showing active Agent tool calls
- **Controls** — Fork (⌇), Delete (forks only), Close (✕)
- **+ button** — Create new `.claude` files per directory

The dashboard auto-refreshes every 10 seconds and instantly on hook state changes.

### Forking sessions

Fork any session to run parallel agents on the same context:

1. Click the ⌇ button on a card, or run "Fork Current Session" from the command palette
2. A new file `name~2.claude` is created with its own terminal
3. The fork starts from the parent session's full conversation history
4. Forks appear indented under their parent in the dashboard

### Notifications

When Claude is waiting for input, you'll receive:
- A macOS notification (click to navigate to the file)
- A VS Code warning notification with "Go to File" action
- A status change on the dashboard card

Use `Cmd+Shift+D` to jump to the most recent waiting agent.

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Open Dashboard | `Cmd+D` | Show the dashboard WebView |
| Go to Latest Notification | `Cmd+Shift+D` | Jump to the most recent waiting agent |
| Fork Current Session | — | Fork the active `.claude` session |
| Open Terminal for Current Tab | — | Manually open a paired terminal |
| Close Terminal for Current Tab | — | Close the paired terminal |
| Toggle Auto Terminal | — | Toggle automatic terminal pairing |
| Close All Non-Claude Files | — | Close non-`.claude` tabs and unmanaged terminals |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tabTerminal.autoOpenTerminal` | `false` | Auto-open terminal when switching to a `.claude` tab |
| `tabTerminal.terminalLocation` | `"right"` | Terminal placement: `"right"` or `"below"` |
| `tabTerminal.autoSetupOnStart` | `true` | On startup, close clutter and open all terminals |
| `tabTerminal.confirmCloseClaudeFile` | `true` | Confirm before closing a `.claude` file with a running terminal |

Settings are also accessible from the dashboard's collapsible settings panel.

## How it works

### Session persistence

- Each `.claude` file maps to a Claude Code session via `/rename`
- Sessions are stored as JSONL at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
- The extension scans these files for `Session renamed to: "<name>"` to match files to sessions
- Reopening a `.claude` file automatically resumes the previous session

### Hook state lifecycle

1. Claude finishes a task and waits → `Notification` hook fires → `notify.sh` writes `~/.claude/hooks/state/<name>.json`
2. Extension's `fs.watch` detects the new file within 500ms → dashboard refreshes, VS Code notification appears
3. User responds → Claude executes a tool → `PostToolUse` hook fires → `clear-state.sh` deletes the state file
4. State files older than 30 minutes are automatically ignored

### Subagent tracking

When a session spawns agents via the `Agent` tool:
- **Foreground agents**: Tracked by checking for a matching `tool_result` in the JSONL
- **Background agents**: The extension reads `<session>/subagents/agent-<id>.jsonl` and checks if it was modified within the last 30 seconds
- Only running agents are shown in the dashboard; completed agents are hidden
- Results are cached by file mtime + size to avoid re-reading large logs

## Project structure

```
src/
  extension.ts    Entry point: commands, event listeners, lifecycle
  dashboard.ts    Dashboard WebView: HTML/CSS, message handling, auto-refresh
  session.ts      JSONL log parsing: tail messages, subagent tracking
  terminal.ts     Terminal lifecycle: create, find session, fork, sync guard
  state.ts        Hook state watcher, status bar, waiting agent detection
  utils.ts        Shared utilities: path helpers, escaping, markdown
  types.ts        TypeScript interfaces
  tabs.ts         Tab iteration helpers
  config.ts       Configuration reader
  constants.ts    Named constants (thresholds, intervals)
```
