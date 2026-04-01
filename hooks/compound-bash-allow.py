#!/usr/bin/env python3
"""PreToolUse hook: Auto-allow tool invocations that match aggregated permission rules.

Handles ALL tool types:
- Bash compound commands: splits into subcommands, checks each
- Bash single commands: checks against cross-project rules
- Write/Edit/Read: checks file_path against aggregated rules
- WebFetch: checks domain against aggregated rules
- Any other tool: checks against aggregated rules

Aggregates allow rules from ALL .claude/settings*.json files across configured
directories. Deny/ask rules come from global settings only.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

from command_splitter import split_compound_command
from pattern_generator import generalize_bash_command, generalize_tool
from pattern_matcher import load_all_rules, matches_tool


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
    with open(os.path.join(log_dir, 'auto-approve.log'), 'a') as f:
        ts = time.strftime('%Y-%m-%d %H:%M:%S')
        f.write(f'{ts} | DEBUG | {msg}\n')


def _write_learn_state(tool_use_id: str, tool_name: str, tool_input: dict,
                       missing_patterns: list[str]) -> None:
    """Write state file for the PostToolUse learn hook."""
    state_dir = os.path.expanduser('~/.claude/hooks/state/compound-bash')
    os.makedirs(state_dir, exist_ok=True)
    state = {
        'tool_use_id': tool_use_id,
        'tool_name': tool_name,
        'tool_input_summary': _summarize_input(tool_name, tool_input),
        'missing_patterns': [p for p in missing_patterns if p],
        'timestamp': int(time.time()),
    }
    try:
        with open(os.path.join(state_dir, f'{tool_use_id}.json'), 'w') as f:
            json.dump(state, f)
    except OSError:
        pass


def _summarize_input(tool_name: str, tool_input: dict) -> str:
    """Create a short summary of the tool input for logging."""
    if tool_name == 'Bash':
        return tool_input.get('command', '')[:200]
    if tool_name in ('Write', 'Edit', 'Read', 'NotebookEdit'):
        return tool_input.get('file_path', '')
    if tool_name == 'WebFetch':
        return tool_input.get('url', '')[:200]
    if tool_name == 'WebSearch':
        return tool_input.get('query', '')[:200]
    if tool_name == 'Grep':
        return f"pattern={tool_input.get('pattern', '')}"
    if tool_name == 'Glob':
        return f"glob={tool_input.get('pattern', '')}"
    return str(tool_input)[:200]


def _auto_allow() -> None:
    """Print the auto-allow JSON response."""
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
        }
    }))


def _handle_bash(input_data: dict, config: dict, allow_pats: list[str],
                 deny_pats: list[str], ask_pats: list[str]) -> None:
    """Handle Bash commands — both single and compound."""
    tool_input = input_data.get('tool_input', {})
    command = tool_input.get('command', '')
    if not command:
        return

    parts = split_compound_command(command)

    if len(parts) <= 1:
        # Single command — check cross-project rules
        if matches_tool('Bash', tool_input, deny_pats):
            return  # Fall through
        if matches_tool('Bash', tool_input, ask_pats):
            return  # Fall through
        if matches_tool('Bash', tool_input, allow_pats):
            _log_debug(config, f'Bash single auto-approve: {command[:100]}')
            _auto_allow()
            return
        # Not matched — write learn state and fall through
        pattern = generalize_bash_command(command)
        if pattern:
            tool_use_id = input_data.get('tool_use_id', f'unknown-{int(time.time())}')
            _write_learn_state(tool_use_id, 'Bash', tool_input, [pattern])
        return

    # Compound command
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

    missing: list[str] = []

    for subcmd in subcmds_to_check:
        if subcmd.lstrip().startswith('#'):
            continue

        sub_input = {'command': subcmd}
        if matches_tool('Bash', sub_input, deny_pats):
            _log_debug(config, f'Denied by global deny rule: {subcmd}')
            return
        if matches_tool('Bash', sub_input, ask_pats):
            _log_debug(config, f'Matched ask rule: {subcmd}')
            return
        if not matches_tool('Bash', sub_input, allow_pats):
            _log_debug(config, f'No allow rule for: {subcmd}')
            missing.append(subcmd)

    if not missing:
        _log_debug(config, 'All subcommands allowed, auto-approving')
        _auto_allow()
        return

    # Write learn state for missing patterns
    tool_use_id = input_data.get('tool_use_id', f'unknown-{int(time.time())}')
    missing_patterns = [p for cmd in missing if (p := generalize_bash_command(cmd))]
    _write_learn_state(tool_use_id, 'Bash', tool_input, missing_patterns)


def _handle_generic_tool(input_data: dict, config: dict, allow_pats: list[str],
                         deny_pats: list[str], ask_pats: list[str]) -> None:
    """Handle any non-Bash tool."""
    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})

    if matches_tool(tool_name, tool_input, deny_pats):
        return
    if matches_tool(tool_name, tool_input, ask_pats):
        return
    if matches_tool(tool_name, tool_input, allow_pats):
        _log_debug(config, f'{tool_name} auto-approve: {_summarize_input(tool_name, tool_input)[:100]}')
        _auto_allow()
        return

    # Not matched — write learn state
    pattern = generalize_tool(tool_name, tool_input)
    if pattern:
        tool_use_id = input_data.get('tool_use_id', f'unknown-{int(time.time())}')
        _write_learn_state(tool_use_id, tool_name, tool_input, [pattern])


def main() -> None:
    input_data = json.loads(sys.stdin.read())

    tool_name = input_data.get('tool_name', '')
    if not tool_name:
        return

    config = _load_config()

    state_dir = os.path.expanduser('~/.claude/hooks/state/compound-bash')
    _cleanup_old_state_files(state_dir)

    allow_pats, deny_pats, ask_pats = load_all_rules(config)

    if tool_name == 'Bash':
        _handle_bash(input_data, config, allow_pats, deny_pats, ask_pats)
    else:
        _handle_generic_tool(input_data, config, allow_pats, deny_pats, ask_pats)


if __name__ == '__main__':
    main()
