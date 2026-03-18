# Claude Hooks and Skills

Custom hooks and slash commands for Claude Code, designed for the Claude Developer VS Code extension workflow.

## Quick Install

### All hooks + skills (recommended)

```bash
# Create directories
mkdir -p ~/.claude/hooks/lib ~/.claude/hooks/state/compound-bash ~/.claude/hooks/logs ~/.claude/commands

# --- Hooks ---
# Copy from your installed ~/.claude/hooks/ or extract from the .md docs in hooks/

# Core extension hooks (required for dashboard status tracking):
#   notify.sh          → ~/.claude/hooks/notify.sh
#   clear-state.sh     → ~/.claude/hooks/clear-state.sh
#   log-approved.sh    → ~/.claude/hooks/log-approved.sh

# Compound command auto-approval (recommended):
#   compound-bash-allow.py      → ~/.claude/hooks/
#   compound-bash-learn.py      → ~/.claude/hooks/
#   compound-bash-config.json   → ~/.claude/hooks/
#   lib/*.py                    → ~/.claude/hooks/lib/

# Make executable
chmod +x ~/.claude/hooks/*.sh ~/.claude/hooks/*.py

# --- Skills ---
# Copy all skill .md files to global commands
cp skills/orchestrator.md ~/.claude/commands/
cp skills/summarize-and-move-to-archive.md ~/.claude/commands/
cp skills/add-worklog.md ~/.claude/commands/
cp skills/update-worklog.md ~/.claude/commands/
cp skills/add-summary.md ~/.claude/commands/
cp skills/update-skills-documentation.md ~/.claude/commands/
cp skills/split-branch-into-prs.md ~/.claude/commands/
cp skills/fix-dt-issue-and-pr.md ~/.claude/commands/
```

### Register hooks in settings

Add the following to `~/.claude/settings.json` under `"hooks"`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /Users/YOUR_USERNAME/.claude/hooks/compound-bash-allow.py"
          }
        ]
      }
    ],
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
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /Users/YOUR_USERNAME/.claude/hooks/compound-bash-learn.py"
          }
        ]
      }
    ]
  }
}
```

Replace `YOUR_USERNAME` with your macOS username.

## Hooks

| Hook | Type | Purpose |
|------|------|---------|
| [notify.sh](hooks/notify-sh.md) | Notification | Writes state files + sends macOS notifications when Claude needs attention |
| [clear-state.sh](hooks/clear-state-sh.md) | PostToolUse | Clears state files when Claude resumes work |
| [log-approved.sh](hooks/log-approved-sh.md) | PostToolUse | Audit log of every approved tool use |
| [Compound Bash Auto-Approval](hooks/compound-bash-auto-approval.md) | PreToolUse + PostToolUse | Auto-approves compound commands when all subcommands are individually permitted; learns new patterns from manual approvals |

### Hook dependencies

- **notify.sh** and **clear-state.sh** are required for the dashboard status indicators and in-editor notifications
- **log-approved.sh** is optional but recommended for auditing
- **Compound Bash** is optional but highly recommended — eliminates most permission dialogs for compound commands
- **Python 3.10+** is required for the compound bash hooks
- **jq** is required for log-approved.sh: `brew install jq`
- **terminal-notifier** is optional for click-to-navigate notifications: `brew install terminal-notifier`

## Skills (Slash Commands)

| Command | Purpose |
|---------|---------|
| [/orchestrator](skills/orchestrator.md) | Decompose complex tasks into parallel sub-agents |
| [/summarize-and-move-to-archive](skills/summarize-and-move-to-archive.md) | Archive completed `.claude` files with recovery summary |
| [/add-worklog](skills/add-worklog.md) | Add a worklog entry to the linked `.claude` file |
| [/update-worklog](skills/update-worklog.md) | Batch-update worklog with all session work |
| [/add-summary](skills/add-summary.md) | Add/replace the summary section in a `.claude` file |
| [/update-skills-documentation](skills/update-skills-documentation.md) | Scan and update the skills catalog |
| [/split-branch-into-prs](skills/split-branch-into-prs.md) | Split a feature branch into stacked PRs |
| [/fix-dt-issue-and-pr](skills/fix-dt-issue-and-pr.md) | End-to-end: fix issue, test, create PR (diseaseTools) |

### Skill dependencies

- Skills that reference `$CLAUDE_FILE` require the Claude Developer VS Code extension (which sets this env var on terminals)
- `/split-branch-into-prs` works best with [Graphite](https://graphite.dev/) installed (`gt` CLI)
- `/fix-dt-issue-and-pr` is specific to the diseaseTools project workflow
