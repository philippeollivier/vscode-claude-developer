# /split-branch-into-prs — Split Branch Into Stacked PRs

**Type:** Global custom command
**Location:** `~/.claude/commands/split-branch-into-prs.md`
**Scope:** All git projects

## Purpose

Analyzes the diff between the current branch and develop, groups changes into logical stacked PRs ordered by dependency and risk, and creates them using Graphite (preferred) or git worktrees + gh (fallback).

## Usage

```
/split-branch-into-prs
/split-branch-into-prs "keep hparams and DAG config separate"
/split-branch-into-prs "3 PRs: infra fixes, training config, LR finder"
```

## How it works

### Phase 1: Analyze the diff
- Fetches latest develop, finds merge-base
- Reads the full diff (commits, files, stats, directory groupings)
- Loads context from linked `.claude` file if available

### Phase 2: Design PR groupings
- Groups changes by logical cohesion, dependency order, reviewability, test independence
- Categorizes risk: High (core logic), Medium (features with tests), Low (tests, docs, tooling)
- Targets 100-500 lines per PR
- Presents plan and waits for user approval

### Phase 3: Create stacked PRs (parallelized)
- **With Graphite:** Creates stack skeleton sequentially, then parallel agents handle each branch's content, finishes with `gt stack submit`
- **Without Graphite:** Each agent independently creates a worktree, cherry-picks files, pushes, and creates PR via `gh`
- All commits must pass pre-commit hooks (never uses `--no-verify`)

### Phase 4: Verification
- Lists all PRs with links, verifies diffs, confirms stack order

## Install

```bash
cp split-branch-into-prs.md ~/.claude/commands/split-branch-into-prs.md
```
