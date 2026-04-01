"""Load permission rules from all settings files and match tool invocations against them."""

import json
import os
import re
from fnmatch import fnmatch
from urllib.parse import urlparse


def _load_settings_file(path: str) -> dict:
    """Load a JSON settings file, returning empty dict on error."""
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _find_settings_files(scan_dirs: list[str], max_depth: int = 5) -> list[str]:
    """Find all .claude/settings*.json files under the given directories."""
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


def _collect_raw_patterns(config: dict) -> tuple[list[str], list[str], list[str]]:
    """Collect raw permission strings from all settings files.

    Returns (allow, deny, ask) where each is a list of raw permission strings
    like 'Bash(git status *)', 'Write(file_path:*.py)', 'Read', etc.

    allow: aggregated from ALL settings files
    deny/ask: from global settings ONLY
    """
    scan_dirs = config.get('scan_directories', ['~/Todo'])
    max_depth = config.get('max_scan_depth', 5)

    all_allow: list[str] = []
    global_deny: list[str] = []
    global_ask: list[str] = []

    # Global settings
    global_path = os.path.expanduser('~/.claude/settings.json')
    global_settings = _load_settings_file(global_path)
    perms = global_settings.get('permissions', {})
    all_allow.extend(perms.get('allow', []))
    global_deny.extend(perms.get('deny', []))
    global_ask.extend(perms.get('ask', []))

    # Project settings (allow only)
    project_files = _find_settings_files(scan_dirs, max_depth)
    for fpath in project_files:
        settings = _load_settings_file(fpath)
        perms = settings.get('permissions', {})
        all_allow.extend(perms.get('allow', []))

    # Deduplicate
    seen = set()
    deduped = []
    for p in all_allow:
        if p not in seen:
            seen.add(p)
            deduped.append(p)

    return deduped, global_deny, global_ask


# --- Pattern parsing ---

_TOOL_PATTERN_RE = re.compile(r'^(\w+)\((.+)\)$')


def _parse_permission(perm: str) -> tuple[str, str | None, str | None]:
    """Parse a permission string into (tool_name, qualifier, pattern).

    Examples:
        'Read'                          -> ('Read', None, None)
        'Bash(git status *)'            -> ('Bash', None, 'git status *')
        'Write(file_path:*.py)'         -> ('Write', 'file_path', '*.py')
        'WebFetch(domain:github.com)'   -> ('WebFetch', 'domain', 'github.com')
        'Read(//Users/philippe/**)'     -> ('Read', 'file_path', '/Users/philippe/**')
        'Bash(git commit:*)'            -> ('Bash', None, 'git commit *')  # legacy colon normalization
        'Skill(find-session)'           -> ('Skill', None, 'find-session')
    """
    m = _TOOL_PATTERN_RE.match(perm)
    if not m:
        # Bare tool name like 'Read', 'Grep', 'WebSearch'
        return (perm.strip(), None, None)

    tool_name = m.group(1)
    inner = m.group(2)

    # Check for qualifier:pattern format (file_path:, domain:)
    if tool_name in ('Write', 'Edit', 'NotebookEdit') and inner.startswith('file_path:'):
        return (tool_name, 'file_path', inner[len('file_path:'):])

    if tool_name == 'WebFetch' and inner.startswith('domain:'):
        return (tool_name, 'domain', inner[len('domain:'):])

    if tool_name in ('Read',) and inner.startswith('/'):
        # Read(//path/**) — double slash prefix, first / is separator
        path_pattern = inner[1:] if inner.startswith('//') else inner
        return (tool_name, 'file_path', path_pattern)

    if tool_name == 'Bash':
        # Normalize legacy colon syntax: "git commit:*" -> "git commit *"
        if ':' in inner:
            idx = inner.index(':')
            inner = inner[:idx] + ' ' + inner[idx + 1:]
        return ('Bash', None, inner)

    # Generic: Skill(name), Agent(description), etc.
    return (tool_name, None, inner)


# --- Matching ---

def _extract_domain(url: str) -> str:
    """Extract domain from a URL."""
    try:
        parsed = urlparse(url)
        return parsed.hostname or ''
    except Exception:
        return ''


def matches_tool(tool_name: str, tool_input: dict, patterns: list[str]) -> bool:
    """Check if a tool invocation matches any of the given permission patterns."""
    for perm in patterns:
        p_tool, p_qual, p_pattern = _parse_permission(perm)

        if p_tool != tool_name:
            continue

        # Bare permission — matches all invocations of this tool
        if p_pattern is None:
            return True

        # Tool-specific matching
        if tool_name == 'Bash':
            command = tool_input.get('command', '')
            if fnmatch(command, p_pattern):
                return True

        elif tool_name in ('Write', 'Edit', 'Read', 'NotebookEdit'):
            file_path = tool_input.get('file_path', '')
            if p_qual == 'file_path' and fnmatch(file_path, p_pattern):
                return True
            # Also try matching the pattern directly against file_path
            # for patterns like Read(//path/**)
            if p_qual == 'file_path' and fnmatch(file_path, p_pattern):
                return True

        elif tool_name == 'WebFetch':
            if p_qual == 'domain':
                url = tool_input.get('url', '')
                domain = _extract_domain(url)
                if fnmatch(domain, p_pattern):
                    return True
            else:
                # Generic pattern match against URL
                url = tool_input.get('url', '')
                if fnmatch(url, p_pattern):
                    return True

        elif tool_name == 'Grep':
            # Grep permissions are usually bare. If qualified, match pattern.
            pattern = tool_input.get('pattern', '')
            if fnmatch(pattern, p_pattern):
                return True

        elif tool_name == 'Glob':
            pattern = tool_input.get('pattern', '')
            if fnmatch(pattern, p_pattern):
                return True

        else:
            # Generic: match the first string value in tool_input
            for v in tool_input.values():
                if isinstance(v, str) and fnmatch(v, p_pattern):
                    return True

    return False


# --- Convenience for compound bash (backward compat) ---

def load_all_rules(config: dict) -> tuple[list[str], list[str], list[str]]:
    """Load all raw permission patterns. Returns (allow, deny, ask)."""
    return _collect_raw_patterns(config)


def matches_any(command: str, patterns: list[str]) -> bool:
    """Check if a bash command matches any Bash(...) pattern. Backward compat."""
    return matches_tool('Bash', {'command': command}, patterns)
