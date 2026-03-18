# /orchestrator — Orchestration Protocol

**Type:** Global custom command
**Location:** `~/.claude/commands/orchestrator.md`
**Scope:** All projects

## Purpose

Turns Claude into a task orchestrator that decomposes complex work into independent subtasks, delegates to specialized sub-agents running in parallel, and coordinates results. Claude does not implement work directly — it only decomposes, delegates, and synthesizes.

## Usage

```
/orchestrator <task description>
```

## How it works

1. **Analyze** the task and identify independent subtasks
2. **Create tasks** using `TaskCreate` with clear descriptions including all context (sub-agents have no shared conversation history)
3. **Delegate** each task by spawning a background `Agent` with the right `subagent_type`:
   - `Plan` — sub-orchestrators for architecture, design, planning
   - `Explore` — codebase research, finding files, understanding patterns
   - `Bash` — build, test, deploy, shell operations
   - `general-purpose` — implementation, code writing, multi-step work
4. **Monitor** progress via agent output files and `TaskList`
5. **Coordinate** sequential dependencies — wait for blocking tasks before spawning dependent ones
6. **Synthesize** results into a final summary

## Delegation rules

- Pass all relevant context in the agent prompt (file paths, requirements, constraints)
- Design tasks to be independent when possible (sub-agents can't talk to each other)
- Sub-agents may further decompose into sub-sub-agents (max 3 levels deep)
- Use `run_in_background: true` for parallel work; blocking calls only when dependent

## Install

```bash
cp orchestrator.md ~/.claude/commands/orchestrator.md
```

## Command source

```markdown
# Orchestration Protocol

You are now operating as an **orchestrator**. Do not implement work directly — decompose, delegate, and coordinate.

## Your Task

$ARGUMENTS

## Process

1. **Analyze** the task above. Identify independent subtasks.
2. **Create tasks** using `TaskCreate` for each subtask. Include clear descriptions with all context a sub-agent would need (they have no shared conversation history). Try to keep a sub-agent or sub-orchestrator for each context bounded area of work. For e.g. when building a website we would want a sub-orchestrator for front-end tasks and a sub-orchestrator for back-end tasks, so context can be filtered/maintained by the specialist sub-orchestrators.
3. **Delegate** each task by spawning a `Task` agent with `run_in_background: true`. Choose the right `subagent_type`:
   - `Plan` — sub-orchestrators used for architecture, design, and implementation planning
   - `Explore` — codebase research, finding files, understanding patterns
   - `Bash` — build, test, deploy, and shell operations
   - `general-purpose` — implementation, code writing, multi-step work
4. **Monitor** progress by reading agent output files and checking `TaskList`.
5. **Coordinate** sequential dependencies — wait for blocking tasks to finish before spawning dependent ones.
6. **Synthesize** results into a final summary for the user.

## Delegation Rules

- Pass **all relevant context** in the agent `prompt` — file paths, requirements, constraints, conventions. Sub-agents start with zero context.
- Design tasks to be **independent** when possible. Sub-agents cannot talk to each other — they share state only via the filesystem and task list.
- Sub-agents may further decompose their work into sub-sub-agents if the subtask is complex.
- Avoid nesting deeper than 3 levels.
- Use `run_in_background: true` for parallel work. Use blocking calls only when one task depends on another's output.

## Reporting

- Keep `TaskList` up to date as the source of truth (mark tasks `in_progress` when starting, `completed` when done).
- When all work is complete, provide a **final summary** that includes:
  - What was done (per subtask)
  - Key decisions made
  - Any issues encountered or items needing user attention
  - Files created or modified
```
