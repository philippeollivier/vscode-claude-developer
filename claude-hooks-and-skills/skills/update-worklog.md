# /update-worklog — Update Worklog with Session Work

**Type:** Global custom command
**Location:** `~/.claude/commands/update-worklog.md`
**Scope:** All projects (designed for the Claude Developer VS Code extension workflow)

## Purpose

Reviews the current conversation history and adds all significant actions to the worklog in the linked `.claude` file. Unlike `/add-worklog` (which adds a single entry), this reviews the entire session and adds multiple entries for all work done since the last log.

## Usage

```
/update-worklog
```

## How it works

1. Reads the linked `.claude` file (via `$CLAUDE_FILE` env var)
2. Finds the `## Worklog ##` or `### Worklog` section (creates one if missing)
3. Reviews conversation history to identify actions since the last entry
4. Groups related actions into logical entries (not every individual command)
5. Appends multiple rows to the worklog table
6. Shows the user what was added

## Install

```bash
cp update-worklog.md ~/.claude/commands/update-worklog.md
```
