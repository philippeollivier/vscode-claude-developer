#!/usr/bin/env python3
"""PostToolUse hook: Auto-add permission patterns for manually approved tool invocations.

When a tool invocation was shown the permission dialog (because it had no matching
allow rule) and the user approved it, this hook reads the state file left by
compound-bash-allow.py and adds the generalized patterns to the target settings file.

Handles all tool types: Bash, Write, Edit, Read, WebFetch, etc.
"""

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

    tool_use_id = input_data.get('tool_use_id', '')
    state_dir = os.path.expanduser('~/.claude/hooks/state/compound-bash')
    state_file = os.path.join(state_dir, f'{tool_use_id}.json')

    if not os.path.exists(state_file):
        return

    # Read and remove state file
    try:
        with open(state_file) as f:
            state = json.load(f)
        os.remove(state_file)
    except (OSError, json.JSONDecodeError):
        return

    config = _load_config()
    target = os.path.expanduser(config.get('auto_add_target', '~/.claude/settings.json'))

    # Read current settings
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

        # Log what was added
        log_dir = os.path.expanduser('~/.claude/hooks/logs')
        os.makedirs(log_dir, exist_ok=True)
        try:
            with open(os.path.join(log_dir, 'auto-approve.log'), 'a') as f:
                ts = time.strftime('%Y-%m-%d %H:%M:%S')
                tool_name = state.get('tool_name', 'unknown')
                summary = state.get('tool_input_summary', '')[:200]
                f.write(f'{ts} | AUTO-ADD | {tool_name} | {", ".join(added)} | from: {summary}\n')
        except OSError:
            pass

        # Tell Claude what was auto-added
        patterns_str = ', '.join(added)
        print(json.dumps({
            'systemMessage': f'Auto-added permission rules: {patterns_str}',
            'hookSpecificOutput': {
                'hookEventName': 'PostToolUse',
                'additionalContext': f'The compound-bash-learn hook auto-added these permission patterns to settings.json: {patterns_str}. These will be auto-approved in future sessions.'
            }
        }))


if __name__ == '__main__':
    main()
