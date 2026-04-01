#!/usr/bin/env bash
# Logs every approved tool use so we can track what's commonly requested
# and tighten permissions accordingly.

LOG_DIR="$HOME/.claude/hooks/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/approved-operations.log"

INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL" ] && exit 0

TS=$(date '+%Y-%m-%d %H:%M:%S')
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"' | head -c 12)
TAB="${CLAUDE_FILE:-unknown}"

# Build a concise summary depending on the tool
case "$TOOL" in
  Bash)
    CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 200)
    SUMMARY="$CMD"
    ;;
  Edit|Write|Read)
    FP=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    SUMMARY="$FP"
    ;;
  Grep)
    PAT=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')
    SUMMARY="pattern=$PAT"
    ;;
  Glob)
    PAT=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')
    SUMMARY="glob=$PAT"
    ;;
  WebFetch)
    URL=$(echo "$INPUT" | jq -r '.tool_input.url // empty')
    SUMMARY="$URL"
    ;;
  WebSearch)
    Q=$(echo "$INPUT" | jq -r '.tool_input.query // empty')
    SUMMARY="$Q"
    ;;
  Agent)
    DESC=$(echo "$INPUT" | jq -r '.tool_input.description // empty')
    SUMMARY="$DESC"
    ;;
  *)
    SUMMARY=$(echo "$INPUT" | jq -c '.tool_input // {}' | head -c 200)
    ;;
esac

echo "$TS | $TAB | $TOOL | $SUMMARY" >> "$LOG_FILE"
