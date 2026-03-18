# notify.sh — Notification Hook

**Hook type:** `Notification`
**Location:** `~/.claude/hooks/notify.sh`
**Trigger:** Fires when Claude is waiting for user input (permission prompt, idle, etc.)

## What it does

1. Reads the hook JSON payload to get `notification_type` and `cwd`
2. Uses `CLAUDE_FILE` env var (set by the VS Code extension's terminal) to identify which agent
3. Writes a JSON state file to `~/.claude/hooks/state/$CLAUDE_FILE.json`
4. Sends a macOS notification via `terminal-notifier` (with click-to-navigate) or falls back to `osascript`
5. The extension's global state watcher detects the new file and shows an in-editor VS Code notification

## Dependencies

- **terminal-notifier** (optional, for click-to-navigate): `brew install terminal-notifier`
- Falls back to `osascript` if terminal-notifier is not installed

## Script

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

## Install

```bash
cp notify.sh ~/.claude/hooks/notify.sh
chmod +x ~/.claude/hooks/notify.sh
mkdir -p ~/.claude/hooks/state
```

## Settings registration

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
    ]
  }
}
```
