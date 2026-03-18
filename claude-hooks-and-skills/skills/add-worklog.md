# /add-worklog — Add Worklog Entry

**Type:** Global custom command
**Location:** `~/.claude/commands/add-worklog.md`
**Scope:** All projects (designed for the Claude Developer VS Code extension workflow)

## Purpose

Adds a worklog entry to the linked `.claude` file, tracking what was done in the current session. Supports multi-section files by asking which section(s) the entry belongs to.

## Usage

```
/add-worklog
```

No arguments needed — it reads the linked `.claude` file and composes entries from the conversation history.

## How it works

1. Reads the linked `.claude` file (via `$CLAUDE_FILE` env var)
2. Detects `##` sections in the file (excludes meta-sections like Worklog, Summary, Ask)
3. If multiple sections exist, asks which section(s) the entry should be added to
4. Creates a `### Worklog` table under the target section if one doesn't exist
5. Composes a worklog row: short step summary + 1-3 sentence details
6. Appends the row to the worklog table

## Worklog table format

```markdown
### Worklog

| Step | Details |
|------|---------|
| Fixed login bug | Updated auth middleware to handle expired tokens. Changed `auth.ts:42`. |
```

## Install

```bash
cp add-worklog.md ~/.claude/commands/add-worklog.md
```
