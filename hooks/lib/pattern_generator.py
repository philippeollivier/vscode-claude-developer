"""Generate generalized permission patterns from specific tool invocations."""

import os
import re
from urllib.parse import urlparse

# Commands that have meaningful subcommands (second word matters)
MULTI_WORD_COMMANDS = {
    'git', 'docker', 'npm', 'npx', 'gh', 'gcloud', 'kubectl',
    'brew', 'cargo', 'pip', 'uv', 'pre-commit', 'python3', 'python',
    'dkp', 'gt', 'pants',
}

# IO redirections to strip before generalizing
_REDIRECT_RE = re.compile(r'\s*(?:2>&1|>&2|2>/dev/null|>/dev/null|2>\s*\S+|>\s*\S+)\s*')



# Shell keywords that shouldn't become standalone permission rules.
# These appear as subcommands when the compound splitter breaks apart
# if/then/else/fi, for/do/done, while/do/done, case/esac blocks.
_SHELL_KEYWORDS = {
    'if', 'then', 'else', 'elif', 'fi',
    'do', 'done', 'while', 'until',
    'case', 'esac', '{', '}',
}


def _validate_pattern(pattern: str) -> str | None:
    """Validate that a generated Bash(...) pattern has balanced parentheses.
    Returns the pattern if valid, None otherwise."""
    # Count parens inside the Bash(...) wrapper — the outer pair is ours,
    # so content inside must have balanced parens on its own.
    inner = pattern[5:-1]  # strip 'Bash(' and ')'
    depth = 0
    for ch in inner:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if depth < 0:
            return None
    if depth != 0:
        return None
    return pattern


def generalize_bash_command(cmd: str) -> str | None:
    """Convert a specific command into a generalized Bash(...) permission pattern.

    Returns None for commands that shouldn't be added (comments, empty,
    shell keywords, or patterns with unbalanced parentheses).
    """
    cleaned = _REDIRECT_RE.sub(' ', cmd).strip()
    if not cleaned:
        return None
    if cleaned.startswith('#'):
        return None

    parts = cleaned.split()
    if not parts:
        return None

    # Handle VAR=value prefixes
    prefix_parts: list[str] = []
    while parts and '=' in parts[0] and not parts[0].startswith('-'):
        # Skip VAR=value where the value contains subshells like $(...)
        if '$(' in parts[0]:
            return None
        prefix_parts.append(parts.pop(0))

    if not parts:
        return _validate_pattern(f'Bash({cleaned})')

    base_cmd = parts[0]
    remaining = parts[1:]

    # Reject shell keywords
    if base_cmd in _SHELL_KEYWORDS:
        return None

    # For multi-word commands, keep the subcommand too
    if base_cmd in MULTI_WORD_COMMANDS and remaining:
        subcmd = remaining[0]
        if not subcmd.startswith('-'):
            rest = remaining[1:]
            prefix = ' '.join(prefix_parts + [base_cmd, subcmd])
            if rest:
                return _validate_pattern(f'Bash({prefix} *)')
            return _validate_pattern(f'Bash({prefix})')

    prefix = ' '.join(prefix_parts + [base_cmd])
    if remaining:
        return _validate_pattern(f'Bash({prefix} *)')
    return _validate_pattern(f'Bash({prefix})')


def generalize_tool(tool_name: str, tool_input: dict) -> str | None:
    """Generate a generalized permission pattern for any tool invocation.

    Returns a pattern string like 'Bash(git branch *)', 'Write', 'WebFetch(domain:github.com)',
    or None if no pattern should be generated.
    """
    if tool_name == 'Bash':
        cmd = tool_input.get('command', '')
        return generalize_bash_command(cmd)

    if tool_name in ('Write', 'Edit', 'NotebookEdit'):
        file_path = tool_input.get('file_path', '')
        ext = os.path.splitext(file_path)[1]  # e.g. '.py'
        if ext:
            return f'{tool_name}(*{ext})'
        # No extension — allow bare
        return tool_name

    if tool_name == 'Read':
        # Read is generally safe, just allow all
        return 'Read'

    if tool_name == 'WebFetch':
        url = tool_input.get('url', '')
        try:
            domain = urlparse(url).hostname or ''
        except Exception:
            domain = ''
        if domain:
            return f'WebFetch(domain:{domain})'
        return 'WebFetch'

    if tool_name in ('Grep', 'Glob', 'WebSearch'):
        # These are usually safe, allow bare
        return tool_name

    if tool_name == 'Agent':
        # Agent calls are generally safe
        return 'Agent'

    # For unknown tools, return bare tool name
    return tool_name


# Backward compat alias
generalize_command = generalize_bash_command
