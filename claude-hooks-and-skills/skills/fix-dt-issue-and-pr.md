# /fix-dt-issue-and-pr — Fix diseaseTools Issue and Create PR

**Type:** Global custom command
**Location:** `~/.claude/commands/fix-dt-issue-and-pr.md`
**Scope:** diseaseTools project (but installed globally for cross-project access)

## Purpose

End-to-end workflow to fix an issue in diseaseTools: creates a worktree, implements the fix, runs tests, creates a PR, and cleans up. Follows the full PR lifecycle workflow.

## Usage

```
/fix-dt-issue-and-pr <asana_link> <issue_description>
/fix-dt-issue-and-pr <asana_link> <issue_description> --manual-review
```

### Review modes

- **Default (no flag):** Automatic — skips code review, runs straight through, only stops on failures
- **--manual-review:** Full code review, pauses between phases for user confirmation

## How it works

### Phase 1: Setup
- Fetches latest develop
- Creates worktree: `git worktree add -b <branch> .claude/worktrees/<branch> origin/develop`
- Investigates the issue from Asana link and description

### Phase 2: Implement
- Reads relevant source files and tests in the worktree
- Implements the fix with TDD approach
- Runs tests: `py_test <test_files> -x -q` (Docker-based test runner)

### Phase 3: PR Lifecycle
- Code review (manual mode only, uses `/review-code`)
- Static analysis: `FAST_LINTER=1 pre-commit run --files <files>`
- Stage, commit, push
- Check for merge conflicts with develop
- Create PR (uses `/build-pr-for-develop` template)
- Adds `merge-when-ready` label
- Addresses CI/CR issues if needed

### Phase 4: Cleanup
- Removes worktree: `git worktree remove .claude/worktrees/<branch>`

## Install

```bash
cp fix-dt-issue-and-pr.md ~/.claude/commands/fix-dt-issue-and-pr.md
```
