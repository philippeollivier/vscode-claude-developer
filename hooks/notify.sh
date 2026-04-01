#!/usr/bin/env bash
# Claude Code Hook: notification with click-to-navigate to the .claude file
# Triggered when Claude Code is waiting for user input.

INPUT=$(cat)

# Extract fields from the hook JSON payload
TYPE=$(echo "$INPUT" | grep -o '"notification_type":"[^"]*"' | cut -d'"' -f4)
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | cut -d'"' -f4)

# Determine the tab name from CLAUDE_FILE env var (set by Tab Terminal extension)
if [ -n "$CLAUDE_FILE" ]; then
    TAB_NAME="$CLAUDE_FILE"
    CLAUDE_FILE_PATH="$CWD/$CLAUDE_FILE.claude"
else
    # Fallback to VS Code window title
    TAB_NAME=$(osascript -e '
      tell application "System Events"
        set codeProcs to every process whose name is "Code"
        if (count of codeProcs) > 0 then
          set wins to every window of (item 1 of codeProcs)
          if (count of wins) > 0 then
            return name of item 1 of wins
          end if
        end if
      end tell' 2>/dev/null)

    # Fallback to project directory name
    if [ -z "$TAB_NAME" ]; then
        TAB_NAME=$(basename "$CWD")
    fi
fi

case "$TYPE" in
  permission_prompt)
    MSG="Needs permission to proceed"
    ;;
  idle_prompt)
    MSG="Finished and waiting for input"
    ;;
  *)
    MSG="Waiting for your input"
    ;;
esac

# State file is now written by state-tracker.py via the Notification hook

# Use terminal-notifier if available (supports click-to-navigate)
if command -v terminal-notifier &>/dev/null; then
    ARGS=(
        -title "Claude Code — $TAB_NAME"
        -message "$MSG"
        -sound Glass
        -group "claude-$TAB_NAME"
    )

    # If we know the .claude file path, clicking opens it in VS Code
    if [ -n "$CLAUDE_FILE_PATH" ] && [ -f "$CLAUDE_FILE_PATH" ]; then
        ARGS+=(-execute "open -a 'Visual Studio Code' '$CLAUDE_FILE_PATH'")
    else
        ARGS+=(-activate com.microsoft.VSCode)
    fi

    terminal-notifier "${ARGS[@]}"
else
    # Fallback to osascript
    osascript -e "display notification \"$MSG\" with title \"Claude Code — $TAB_NAME\" sound name \"Glass\""
fi
