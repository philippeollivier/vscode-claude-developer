# /update-skills-documentation — Update Skills Catalog

**Type:** Global custom command
**Location:** `~/.claude/commands/update-skills-documentation.md`
**Scope:** All projects

## Purpose

Scans all installed skills and commands across the user's system and updates the skills catalog in `General Notes/General.claude` to ensure it is accurate and complete.

## Usage

```
/update-skills-documentation
```

## How it works

1. Finds all `**/.claude/skills/*/SKILL.md` and `**/.claude/commands/*.md` files under `~`
2. Reads each to extract name and description (from YAML frontmatter or first sentences)
3. Reads the current `General Notes/General.claude` file
4. Compares and updates the `## Skills ##` section: adds new entries, removes deleted ones, updates changed descriptions
5. Groups entries by category
6. Reports what changed

## Install

```bash
cp update-skills-documentation.md ~/.claude/commands/update-skills-documentation.md
```
