# Compound Bash Auto-Approval System

**Hook types:** `PreToolUse` + `PostToolUse`
**Location:** `~/.claude/hooks/compound-bash-allow.py`, `compound-bash-learn.py`, `compound-bash-config.json`, `lib/`
**Trigger:** Every Bash command execution

## Problem

Claude Code blocks compound commands (`cd ~/project && git status`) even when each individual subcommand is allowed by permission rules. This forces manual approval of safe command chains.

## How it works

### PreToolUse: compound-bash-allow.py

When Claude runs a compound Bash command:
1. Splits the command into subcommands on `&&`, `||`, `;`, `|` (respecting quotes and subshells)
2. Loads allow rules from ALL `.claude/settings*.json` files across configured directories
3. Loads deny/ask rules from global `~/.claude/settings.json` only (project deny rules are project-specific)
4. Checks each subcommand:
   - If any match a deny rule → fall through to normal Claude Code handling
   - If any match an ask rule → fall through to dialog
   - If ALL match allow rules → auto-approve without dialog
   - If some have no matching rule → write state file, fall through to dialog

### PostToolUse: compound-bash-learn.py

When the user manually approves a compound command that had unknown subcommands:
1. Reads the state file left by the PreToolUse hook
2. Generates generalized patterns (e.g., `git worktree remove .claude/worktrees/foo` → `Bash(git worktree *)`)
3. Adds the patterns to the target settings file
4. Logs to `~/.claude/hooks/logs/compound-bash.log`

## Files

| File | Purpose |
|------|---------|
| `compound-bash-allow.py` | PreToolUse hook — main logic |
| `compound-bash-learn.py` | PostToolUse hook — auto-add patterns |
| `compound-bash-config.json` | Configuration |
| `lib/command_splitter.py` | Tokenizer for compound commands |
| `lib/pattern_matcher.py` | Settings file aggregation and fnmatch |
| `lib/pattern_generator.py` | Command-to-pattern generalization |

## Configuration (`compound-bash-config.json`)

```json
{
  "scan_directories": ["~/Todo", "~/diseaseTools"],
  "auto_add_target": "~/.claude/settings.json",
  "max_scan_depth": 5,
  "pipe_commands_require_rules": false,
  "debug": false
}
```

| Key | Description |
|-----|-------------|
| `scan_directories` | Directories to recursively scan for `.claude/settings*.json` files |
| `auto_add_target` | Settings file where learned patterns are auto-added |
| `max_scan_depth` | Max directory depth for scanning |
| `pipe_commands_require_rules` | If `false` (default), only the first command in a pipe chain needs a rule |
| `debug` | Write debug logs to `~/.claude/hooks/logs/compound-bash.log` |

## compound-bash-allow.py

```python
#!/usr/bin/env python3
"""PreToolUse hook: Auto-allow compound Bash commands when all subcommands are permitted."""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

from command_splitter import split_compound_command
from pattern_generator import generalize_command
from pattern_matcher import load_all_rules, matches_any


def _load_config() -> dict:
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compound-bash-config.json')
    try:
        with open(config_path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _cleanup_old_state_files(state_dir: str, max_age_s: int = 3600) -> None:
    if not os.path.isdir(state_dir):
        return
    now = time.time()
    try:
        for name in os.listdir(state_dir):
            fpath = os.path.join(state_dir, name)
            if os.path.isfile(fpath) and now - os.path.getmtime(fpath) > max_age_s:
                os.remove(fpath)
    except OSError:
        pass


def _log_debug(config: dict, msg: str) -> None:
    if not config.get('debug'):
        return
    log_dir = os.path.expanduser('~/.claude/hooks/logs')
    os.makedirs(log_dir, exist_ok=True)
    with open(os.path.join(log_dir, 'compound-bash.log'), 'a') as f:
        ts = time.strftime('%Y-%m-%d %H:%M:%S')
        f.write(f'{ts} | DEBUG | {msg}\n')


def main() -> None:
    input_data = json.loads(sys.stdin.read())

    if input_data.get('tool_name') != 'Bash':
        return

    command = input_data.get('tool_input', {}).get('command', '')
    if not command:
        return

    parts = split_compound_command(command)
    if len(parts) <= 1:
        return

    config = _load_config()
    _log_debug(config, f'Compound command: {command[:200]}')

    pipe_requires_rules = config.get('pipe_commands_require_rules', False)
    subcmds_to_check: list[str] = []

    pipe_chain: list[str] = []
    for subcmd, op in parts:
        if not subcmd:
            continue
        pipe_chain.append(subcmd)
        if op != '|':
            if pipe_requires_rules:
                subcmds_to_check.extend(pipe_chain)
            else:
                subcmds_to_check.append(pipe_chain[0])
            pipe_chain = []

    allow_pats, deny_pats, ask_pats = load_all_rules(config)

    state_dir = os.path.expanduser('~/.claude/hooks/state/compound-bash')
    _cleanup_old_state_files(state_dir)

    missing: list[str] = []

    for subcmd in subcmds_to_check:
        if subcmd.lstrip().startswith('#'):
            continue
        if matches_any(subcmd, deny_pats):
            _log_debug(config, f'Denied by global deny rule: {subcmd}')
            return
        if matches_any(subcmd, ask_pats):
            _log_debug(config, f'Matched ask rule: {subcmd}')
            return
        if not matches_any(subcmd, allow_pats):
            _log_debug(config, f'No allow rule for: {subcmd}')
            missing.append(subcmd)

    if not missing:
        _log_debug(config, 'All subcommands allowed, auto-approving')
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'allow',
            }
        }))
        return

    tool_use_id = input_data.get('tool_use_id', f'unknown-{int(time.time())}')
    state = {
        'tool_use_id': tool_use_id,
        'command': command[:1000],
        'missing_commands': missing,
        'missing_patterns': [p for cmd in missing if (p := generalize_command(cmd))],
        'timestamp': int(time.time()),
    }
    os.makedirs(state_dir, exist_ok=True)
    state_file = os.path.join(state_dir, f'{tool_use_id}.json')
    try:
        with open(state_file, 'w') as f:
            json.dump(state, f)
    except OSError:
        pass


if __name__ == '__main__':
    main()
```

## compound-bash-learn.py

```python
#!/usr/bin/env python3
"""PostToolUse hook: Auto-add permission patterns for manually approved compound commands."""

import json
import os
import sys
import time


def _load_config() -> dict:
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compound-bash-config.json')
    try:
        with open(config_path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def main() -> None:
    input_data = json.loads(sys.stdin.read())

    if input_data.get('tool_name') != 'Bash':
        return

    tool_use_id = input_data.get('tool_use_id', '')
    state_dir = os.path.expanduser('~/.claude/hooks/state/compound-bash')
    state_file = os.path.join(state_dir, f'{tool_use_id}.json')

    if not os.path.exists(state_file):
        return

    try:
        with open(state_file) as f:
            state = json.load(f)
        os.remove(state_file)
    except (OSError, json.JSONDecodeError):
        return

    config = _load_config()
    target = os.path.expanduser(config.get('auto_add_target', '~/.claude/settings.json'))

    try:
        with open(target) as f:
            settings = json.load(f)
    except (OSError, json.JSONDecodeError):
        return

    allow_list = settings.setdefault('permissions', {}).setdefault('allow', [])

    added = []
    for pattern in state.get('missing_patterns', []):
        if pattern and pattern not in allow_list:
            allow_list.append(pattern)
            added.append(pattern)

    if added:
        try:
            with open(target, 'w') as f:
                json.dump(settings, f, indent=2)
                f.write('\n')
        except OSError:
            return

        log_dir = os.path.expanduser('~/.claude/hooks/logs')
        os.makedirs(log_dir, exist_ok=True)
        try:
            with open(os.path.join(log_dir, 'compound-bash.log'), 'a') as f:
                ts = time.strftime('%Y-%m-%d %H:%M:%S')
                cmd_preview = state.get('command', '')[:200]
                f.write(f'{ts} | AUTO-ADD | {", ".join(added)} | from: {cmd_preview}\n')
        except OSError:
            pass


if __name__ == '__main__':
    main()
```

## lib/command_splitter.py

```python
"""Split compound shell commands on &&, ||, ;, | while respecting quotes and subshells."""


def split_compound_command(cmd: str) -> list[tuple[str, str | None]]:
    """Split a compound command into (subcommand, operator) tuples.

    Respects single/double quotes, $() subshells, and () grouping.
    """
    results: list[tuple[str, str | None]] = []
    current: list[str] = []
    i = 0
    n = len(cmd)
    in_single_quote = False
    in_double_quote = False
    paren_depth = 0

    while i < n:
        c = cmd[i]

        if in_double_quote and c == '\\' and i + 1 < n:
            current.append(c)
            current.append(cmd[i + 1])
            i += 2
            continue

        if c == "'" and not in_double_quote and paren_depth == 0:
            in_single_quote = not in_single_quote
            current.append(c)
            i += 1
            continue

        if c == '"' and not in_single_quote and paren_depth == 0:
            in_double_quote = not in_double_quote
            current.append(c)
            i += 1
            continue

        if in_single_quote or in_double_quote:
            current.append(c)
            i += 1
            continue

        if c == '(' or (c == '$' and i + 1 < n and cmd[i + 1] == '('):
            if c == '$':
                current.append(c)
                i += 1
                c = cmd[i]
            paren_depth += 1
            current.append(c)
            i += 1
            continue

        if c == ')' and paren_depth > 0:
            paren_depth -= 1
            current.append(c)
            i += 1
            continue

        if paren_depth > 0:
            current.append(c)
            i += 1
            continue

        if c in ('&', '|') and i + 1 < n and cmd[i + 1] == c:
            op = c + c
            subcmd = ''.join(current).strip()
            if subcmd:
                results.append((subcmd, op))
            current = []
            i += 2
            continue

        if c == ';':
            subcmd = ''.join(current).strip()
            if subcmd:
                results.append((subcmd, ';'))
            current = []
            i += 1
            continue

        if c == '|' and (i + 1 >= n or cmd[i + 1] != '|'):
            subcmd = ''.join(current).strip()
            if subcmd:
                results.append((subcmd, '|'))
            current = []
            i += 1
            continue

        current.append(c)
        i += 1

    subcmd = ''.join(current).strip()
    if subcmd:
        results.append((subcmd, None))

    return results


def is_compound(cmd: str) -> bool:
    return len(split_compound_command(cmd)) > 1
```

## lib/pattern_matcher.py

```python
"""Load permission rules from all settings files and match commands against them."""

import json
import os
from fnmatch import fnmatch
from pathlib import Path


def _extract_bash_patterns(patterns: list[str]) -> list[str]:
    result = []
    for p in patterns:
        if p.startswith('Bash(') and p.endswith(')'):
            inner = p[5:-1]
            if ':' in inner:
                idx = inner.index(':')
                inner = inner[:idx] + ' ' + inner[idx + 1:]
            result.append(inner)
    return result


def _load_settings_file(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _find_settings_files(scan_dirs: list[str], max_depth: int = 5) -> list[str]:
    files = []
    for scan_dir in scan_dirs:
        scan_dir = os.path.expanduser(scan_dir)
        if not os.path.isdir(scan_dir):
            continue
        claude_dir = os.path.join(scan_dir, '.claude')
        if os.path.isdir(claude_dir):
            for name in ('settings.json', 'settings.local.json'):
                p = os.path.join(claude_dir, name)
                if os.path.isfile(p):
                    files.append(p)
        for root, dirs, _filenames in os.walk(scan_dir):
            depth = root[len(scan_dir):].count(os.sep)
            if depth >= max_depth:
                dirs.clear()
                continue
            dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules', '__pycache__', '.venv', 'venv')]
            if '.claude' in dirs:
                claude_path = os.path.join(root, '.claude')
                for name in ('settings.json', 'settings.local.json'):
                    p = os.path.join(claude_path, name)
                    if os.path.isfile(p):
                        files.append(p)
    return list(set(files))


def load_all_rules(config: dict) -> tuple[list[str], list[str], list[str]]:
    """Load aggregated rules. Allow from ALL files, deny/ask from global only."""
    scan_dirs = config.get('scan_directories', ['~/Todo'])
    max_depth = config.get('max_scan_depth', 5)

    all_allow: list[str] = []
    global_deny: list[str] = []
    global_ask: list[str] = []

    global_path = os.path.expanduser('~/.claude/settings.json')
    global_settings = _load_settings_file(global_path)
    perms = global_settings.get('permissions', {})
    all_allow.extend(_extract_bash_patterns(perms.get('allow', [])))
    global_deny.extend(_extract_bash_patterns(perms.get('deny', [])))
    global_ask.extend(_extract_bash_patterns(perms.get('ask', [])))

    project_files = _find_settings_files(scan_dirs, max_depth)
    for fpath in project_files:
        settings = _load_settings_file(fpath)
        perms = settings.get('permissions', {})
        all_allow.extend(_extract_bash_patterns(perms.get('allow', [])))

    seen = set()
    deduped_allow = []
    for p in all_allow:
        if p not in seen:
            seen.add(p)
            deduped_allow.append(p)

    return deduped_allow, global_deny, global_ask


def matches_any(command: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if fnmatch(command, pattern):
            return True
    return False
```

## lib/pattern_generator.py

```python
"""Generate generalized Bash(...) permission patterns from specific commands."""

import re

MULTI_WORD_COMMANDS = {
    'git', 'docker', 'npm', 'npx', 'gh', 'gcloud', 'kubectl',
    'brew', 'cargo', 'pip', 'uv', 'pre-commit', 'python3', 'python',
    'dkp', 'gt', 'pants',
}

_REDIRECT_RE = re.compile(r'\s*(?:2>&1|>&2|2>/dev/null|>/dev/null|2>\s*\S+|>\s*\S+)\s*')


def generalize_command(cmd: str) -> str | None:
    """Convert a specific command into a generalized Bash(...) permission pattern.
    Returns None for commands that shouldn't be added (comments, empty).
    """
    cleaned = _REDIRECT_RE.sub(' ', cmd).strip()
    if not cleaned:
        return None
    if cleaned.startswith('#'):
        return None

    parts = cleaned.split()
    if not parts:
        return None

    prefix_parts: list[str] = []
    while parts and '=' in parts[0] and not parts[0].startswith('-'):
        prefix_parts.append(parts.pop(0))

    if not parts:
        return f'Bash({cleaned})'

    base_cmd = parts[0]
    remaining = parts[1:]

    if base_cmd in MULTI_WORD_COMMANDS and remaining:
        subcmd = remaining[0]
        if not subcmd.startswith('-'):
            rest = remaining[1:]
            prefix = ' '.join(prefix_parts + [base_cmd, subcmd])
            if rest:
                return f'Bash({prefix} *)'
            return f'Bash({prefix})'

    prefix = ' '.join(prefix_parts + [base_cmd])
    if remaining:
        return f'Bash({prefix} *)'
    return f'Bash({prefix})'
```

## Install

```bash
# Create directories
mkdir -p ~/.claude/hooks/lib ~/.claude/hooks/state/compound-bash

# Copy all files (from this doc, or from an existing installation)
# Main hooks:
cp compound-bash-allow.py ~/.claude/hooks/
cp compound-bash-learn.py ~/.claude/hooks/
cp compound-bash-config.json ~/.claude/hooks/

# Library:
cp lib/__init__.py ~/.claude/hooks/lib/
cp lib/command_splitter.py ~/.claude/hooks/lib/
cp lib/pattern_matcher.py ~/.claude/hooks/lib/
cp lib/pattern_generator.py ~/.claude/hooks/lib/

# Make executable
chmod +x ~/.claude/hooks/compound-bash-allow.py ~/.claude/hooks/compound-bash-learn.py
```

Edit `compound-bash-config.json` to set your `scan_directories` and `auto_add_target`.

## Settings registration

Add to `~/.claude/settings.json`:

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
    "PostToolUse": [
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
