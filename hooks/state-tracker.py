#!/usr/bin/env python3
"""Unified state tracker for Claude Code hooks.

Writes agent status to ~/.claude/hooks/state/{CLAUDE_FILE}.json
on every relevant hook event, enabling the VS Code extension to
show accurate real-time status (processing, executing tool, done, error, etc.).

Usage: python3 state-tracker.py <EventName>
  where EventName is one of: PreToolUse, PostToolUse, Notification,
  Stop, StopFailure, UserPromptSubmit
"""

import json
import os
import sys
import time


def _summarize(tool_name: str, tool_input: dict) -> str:
    """Short summary of what a tool is doing, for dashboard display."""
    if tool_name == 'Bash':
        cmd = tool_input.get('command', '')
        return cmd.split('\n')[0][:80]
    if tool_name in ('Write', 'Edit', 'Read'):
        fp = tool_input.get('file_path', '')
        return os.path.basename(fp) if fp else ''
    if tool_name == 'Agent':
        return str(tool_input.get('description', ''))[:80]
    if tool_name in ('Grep', 'Glob'):
        return str(tool_input.get('pattern', ''))[:80]
    if tool_name == 'WebSearch':
        return str(tool_input.get('query', ''))[:80]
    if tool_name == 'WebFetch':
        return str(tool_input.get('url', ''))[:80]
    return ''


def main() -> None:
    event = sys.argv[1] if len(sys.argv) > 1 else ''
    claude_file = os.environ.get('CLAUDE_FILE', '')
    if not claude_file:
        return

    input_data = json.loads(sys.stdin.read())

    state: dict = {
        'timestamp': int(time.time()),
        'cwd': input_data.get('cwd', os.getcwd()),
        'tab': claude_file,
        'hook_event': event,
    }

    if event == 'UserPromptSubmit':
        state['type'] = 'processing'
        state['message'] = 'Processing'

    elif event == 'PreToolUse':
        tool_name = input_data.get('tool_name', 'Tool')
        state['type'] = 'executing_tool'
        state['tool_name'] = tool_name
        state['tool_input_summary'] = _summarize(tool_name, input_data.get('tool_input', {}))
        state['message'] = f'Running {tool_name}'

    elif event == 'PostToolUse':
        state['type'] = 'processing'
        state['message'] = 'Processing'
        tool_name = input_data.get('tool_name', '')
        if tool_name:
            state['tool_name'] = tool_name

    elif event == 'Notification':
        ntype = input_data.get('notification_type', 'unknown')
        state['type'] = ntype
        state['message'] = {
            'permission_prompt': 'Needs permission to proceed',
            'idle_prompt': 'Finished and waiting for input',
        }.get(ntype, 'Waiting for input')

    elif event == 'SessionStart':
        session_id = input_data.get('session_id', '')
        state['type'] = 'idle'
        state['message'] = 'Idle'
        if session_id:
            state['session_id'] = session_id

    elif event == 'Stop':
        state['type'] = 'stopped'
        state['message'] = 'Done'

    elif event == 'StopFailure':
        state['type'] = 'error'
        reason = str(input_data.get('error', input_data.get('reason', 'Unknown error')))[:200]
        state['message'] = reason
        state['stop_reason'] = reason

    else:
        return

    state_dir = os.path.expanduser('~/.claude/hooks/state')
    os.makedirs(state_dir, exist_ok=True)
    state_file = os.path.join(state_dir, f'{claude_file}.json')

    # Preserve session_id from previous state so it's always available
    if 'session_id' not in state:
        try:
            with open(state_file) as f:
                prev = json.load(f)
            if 'session_id' in prev:
                state['session_id'] = prev['session_id']
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

    with open(state_file, 'w') as f:
        json.dump(state, f)


if __name__ == '__main__':
    main()
