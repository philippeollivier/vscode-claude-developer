# /summarize-and-move-to-archive — Archive Completed Tasks

**Type:** Global custom command
**Location:** `~/.claude/commands/summarize-and-move-to-archive.md`
**Scope:** All projects (designed for the Claude Developer VS Code extension workflow)

## Purpose

Archives a completed `.claude` task file by generating a comprehensive recovery summary and moving it from `Current Queue/` to `Archived Work/`. The summary is self-contained so anyone can understand and resume the work months later.

## Usage

```
/summarize-and-move-to-archive
```

No arguments needed — it reads the linked `.claude` file from the `$CLAUDE_FILE` environment variable.

## How it works

1. Reads the linked `.claude` file (via `$CLAUDE_FILE` env var set by the VS Code extension)
2. Finds the current session UUID from `~/.claude/projects/`
3. Generates an archive summary with: context, what was done, key decisions, current state, and how to resume
4. Presents summary for user approval (with option to revise)
5. Suggests an archive destination folder under `~/Todo/Archived Work/`
6. Moves the file (last step, since it triggers the VS Code extension to close the terminal)

## Archive summary format

```markdown
---

## Archive Summary ##

**Archived:** YYYY-MM-DD
**Session UUID:** `<session-uuid>`
**Resume command:** `claude --resume <session-uuid>`

### Context
<overview of task and motivation>

### What Was Done
<bulleted list with file names, branch names, PR numbers>

### Key Decisions
<decisions and WHY they were made, alternatives considered>

### Current State
<where things stand, loose ends>

### How to Resume
<step-by-step instructions, repos, branches, commands, env setup>
```

## Install

```bash
cp summarize-and-move-to-archive.md ~/.claude/commands/summarize-and-move-to-archive.md
```
