# clear-state.sh — Post Tool Use Hook

**Hook type:** `PostToolUse`
**Location:** `~/.claude/hooks/clear-state.sh`
**Trigger:** Fires after every tool execution (meaning Claude resumed work)

## What it does

Deletes the state file created by `notify.sh`, signaling to the dashboard and notification system that Claude is no longer waiting for input.

## Script

```bash
#!/usr/bin/env bash
if [ -n "$CLAUDE_FILE" ]; then
    STATE_FILE="$HOME/.claude/hooks/state/$CLAUDE_FILE.json"
    [ -f "$STATE_FILE" ] && rm -f "$STATE_FILE"
fi
```

## Install

```bash
cp clear-state.sh ~/.claude/hooks/clear-state.sh
chmod +x ~/.claude/hooks/clear-state.sh
```

## Settings registration

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
          }
        ]
      }
    ]
  }
}
```
