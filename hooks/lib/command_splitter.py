"""Split compound shell commands on &&, ||, ;, | while respecting quotes and subshells."""


def split_compound_command(cmd: str) -> list[tuple[str, str | None]]:
    """Split a compound command into (subcommand, operator) tuples.

    Respects single/double quotes, $() subshells, and () grouping.
    Returns [(cmd1, '&&'), (cmd2, '||'), (cmd3, None)] etc.
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

        # Handle escapes inside double quotes
        if in_double_quote and c == '\\' and i + 1 < n:
            current.append(c)
            current.append(cmd[i + 1])
            i += 2
            continue

        # Single quote toggle (not inside double quotes)
        if c == "'" and not in_double_quote and paren_depth == 0:
            in_single_quote = not in_single_quote
            current.append(c)
            i += 1
            continue

        # Double quote toggle (not inside single quotes)
        if c == '"' and not in_single_quote and paren_depth == 0:
            in_double_quote = not in_double_quote
            current.append(c)
            i += 1
            continue

        # Inside quotes, just accumulate
        if in_single_quote or in_double_quote:
            current.append(c)
            i += 1
            continue

        # Track $() and () subshell depth
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

        # Inside subshell, just accumulate
        if paren_depth > 0:
            current.append(c)
            i += 1
            continue

        # Check for operators at top level
        # && and ||
        if c in ('&', '|') and i + 1 < n and cmd[i + 1] == c:
            op = c + c
            subcmd = ''.join(current).strip()
            if subcmd:
                results.append((subcmd, op))
            current = []
            i += 2
            continue

        # ; (semicolon)
        if c == ';':
            subcmd = ''.join(current).strip()
            if subcmd:
                results.append((subcmd, ';'))
            current = []
            i += 1
            continue

        # Single | (pipe) - but not ||
        if c == '|' and (i + 1 >= n or cmd[i + 1] != '|'):
            subcmd = ''.join(current).strip()
            if subcmd:
                results.append((subcmd, '|'))
            current = []
            i += 1
            continue

        current.append(c)
        i += 1

    # Last command
    subcmd = ''.join(current).strip()
    if subcmd:
        results.append((subcmd, None))

    return results


def is_compound(cmd: str) -> bool:
    """Check if a command is compound (has >1 subcommand at top level)."""
    return len(split_compound_command(cmd)) > 1
