#!/usr/bin/env bash
# Clears the notification state file when Claude resumes work (tool use granted)
if [ -n "$CLAUDE_FILE" ]; then
    STATE_FILE="$HOME/.claude/hooks/state/$CLAUDE_FILE.json"
    [ -f "$STATE_FILE" ] && rm -f "$STATE_FILE"
fi
