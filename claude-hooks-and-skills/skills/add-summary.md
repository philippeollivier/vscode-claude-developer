# /add-summary — Add High-Level Overview

**Type:** Global custom command
**Location:** `~/.claude/commands/add-summary.md`
**Scope:** All projects (designed for the Claude Developer VS Code extension workflow)

## Purpose

Adds or replaces the `## Summary ##` section in the linked `.claude` file with a high-level overview of the task.

## Usage

```
/add-summary <overview text>
```

If no text is provided, prompts the user for input.

## How it works

1. Reads the linked `.claude` file (via `$CLAUDE_FILE` env var)
2. If a `## Summary ##` section already exists, replaces its contents
3. If no summary section exists, inserts one after the main title, before other `##` sections

## Install

```bash
cp add-summary.md ~/.claude/commands/add-summary.md
```
