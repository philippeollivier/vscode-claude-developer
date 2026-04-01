#!/usr/bin/env python3
"""PermissionRequest hook: Auto-approve permission dialogs when aggregated rules allow it.

This hook fires when Claude Code is about to show a permission dialog — including
built-in safety checks like "compound commands with cd and git" that PreToolUse hooks
cannot override. It checks the same aggregated permission rules and auto-approves
if all checks pass.
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


def _log_debug(config: dict, msg: str) -> None:
    if not config.get('debug'):
        return
    log_dir = os.path.expanduser('~/.claude/hooks/logs')
    os.makedirs(log_dir, exist_ok=True)
    with open(os.path.join(log_dir, 'auto-approve.log'), 'a') as f:
        ts = time.strftime('%Y-%m-%d %H:%M:%S')
        f.write(f'{ts} | PERM-REQ | {msg}\n')


def _respond_allow() -> None:
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PermissionRequest',
            'decision': {
                'behavior': 'allow',
            }
        }
    }))


def _respond_ask() -> None:
    """Fall through to normal dialog."""
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PermissionRequest',
            'decision': {
                'behavior': 'ask',
            }
        }
    }))


def _write_learn_state(tool_use_id: str, tool_name: str, tool_input: dict,
                       missing_patterns: list[str]) -> None:
    """Write state file for the PostToolUse learn hook."""
    state_dir = os.path.expanduser('~/.claude/hooks/state/compound-bash')
    os.makedirs(state_dir, exist_ok=True)
    summary = ''
    if tool_name == 'Bash':
        summary = tool_input.get('command', '')[:200]
    elif tool_name in ('Write', 'Edit', 'Read'):
        summary = tool_input.get('file_path', '')
    else:
        summary = str(tool_input)[:200]
    state = {
        'tool_use_id': tool_use_id,
        'tool_name': tool_name,
        'tool_input_summary': summary,
        'missing_patterns': [p for p in missing_patterns if p],
        'timestamp': int(time.time()),
    }
    try:
        with open(os.path.join(state_dir, f'{tool_use_id}.json'), 'w') as f:
            json.dump(state, f)
    except OSError:
        pass


def _check_bash(input_data: dict, config: dict, allow_pats: list[str],
                deny_pats: list[str]) -> bool:
    """Check a Bash command. Returns True if should be allowed."""
    tool_input = input_data.get('tool_input', {})
    command = tool_input.get('command', '')
    if not command:
        return False

    parts = split_compound_command(command)

    if len(parts) <= 1:
        # Single command
        if matches_tool('Bash', tool_input, deny_pats):
            return False
        return matches_tool('Bash', tool_input, allow_pats)

    # Compound command
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

    for subcmd in subcmds_to_check:
        if subcmd.lstrip().startswith('#'):
            continue
        sub_input = {'command': subcmd}
        # Bare variable assignments (VAR=value with no command) are harmless
        stripped = subcmd.strip()
        if '=' in stripped and not ' ' in stripped.split('=', 1)[0]:
            # Looks like VAR=value
            after_eq = stripped.split('=', 1)[1] if '=' in stripped else ''
            if ' ' not in stripped or stripped.index('=') < stripped.index(' '):
                # Pure assignment or assignment with value, no command follows
                parts_check = stripped.split()
                if len(parts_check) == 1 or '=' in parts_check[0]:
                    # Just VAR=value, skip
                    continue
        if matches_tool('Bash', sub_input, deny_pats):
            return False
        if not matches_tool('Bash', sub_input, allow_pats):
            return False

    return True


def main() -> None:
    input_data = json.loads(sys.stdin.read())

    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})
    if not tool_name:
        _respond_ask()
        return

    config = _load_config()
    allow_pats, deny_pats, _ask_pats = load_all_rules(config)

    allowed = False

    if tool_name == 'Bash':
        allowed = _check_bash(input_data, config, allow_pats, deny_pats)
    else:
        if matches_tool(tool_name, tool_input, deny_pats):
            allowed = False
        elif matches_tool(tool_name, tool_input, allow_pats):
            allowed = True

    if allowed:
        _log_debug(config, f'ALLOW {tool_name}: {str(tool_input)[:100]}')
        _respond_allow()
    else:
        # Write learn state so PostToolUse can add the pattern if user approves
        tool_use_id = input_data.get('tool_use_id', f'unknown-{int(time.time())}')
        if tool_name == 'Bash':
            command = tool_input.get('command', '')
            parts = split_compound_command(command)
            missing = []
            for subcmd, _op in parts:
                if not subcmd or subcmd.lstrip().startswith('#'):
                    continue
                sub_input = {'command': subcmd}
                if not matches_tool('Bash', sub_input, allow_pats):
                    p = generalize_bash_command(subcmd)
                    if p:
                        missing.append(p)
            if missing:
                _write_learn_state(tool_use_id, tool_name, tool_input, missing)
        else:
            pattern = generalize_tool(tool_name, tool_input)
            if pattern:
                _write_learn_state(tool_use_id, tool_name, tool_input, [pattern])

        _log_debug(config, f'ASK {tool_name}: {str(tool_input)[:100]}')
        _respond_ask()


if __name__ == '__main__':
    main()
