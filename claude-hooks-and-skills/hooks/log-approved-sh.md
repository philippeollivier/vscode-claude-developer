# log-approved.sh — Audit Log Hook

**Hook type:** `PostToolUse`
**Location:** `~/.claude/hooks/log-approved.sh`
**Trigger:** Fires after every tool execution

## What it does

Logs every approved tool use to `~/.claude/hooks/logs/approved-operations.log` for tracking common permission requests and auditing agent behavior.

Each log line includes: timestamp, agent tab name, tool name, and a concise summary (command, file path, pattern, etc.).

## Dependencies

- **jq**: `brew install jq`

## Script

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

## Install

```bash
cp log-approved.sh ~/.claude/hooks/log-approved.sh
chmod +x ~/.claude/hooks/log-approved.sh
```

## Settings registration

Add alongside `clear-state.sh` in the PostToolUse hooks array:

```json
{
  "hooks": {
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
