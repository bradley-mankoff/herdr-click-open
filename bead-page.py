#!/usr/bin/env python3
"""Builds the markdown page glow renders for a Ctrl-clicked Bead (herdr-click-open-df7).

bd show draws its own boxed layout around the description, and glow would show the box-drawing
characters as text. This script takes instead the JSON `bd show --json` prints and writes a
plain markdown page: one heading naming the Bead, a short list of its state, then the
description and the acceptance criteria as the markdown they already are. glow renders the
headings, lists and code fences; micro, in the fallback for a Mac without glow, shows the same
page as text.

Input: the JSON array `bd show --json` prints on stdin. Output: the page on stdout. With
--for-glow, every '<' outside code is written as '\\<', because glow takes a Bead's
placeholders such as <id> for HTML tags and shows nothing for them; micro shows the page as
written, so the fallback goes without the flag and shows no backslash.
"""
import json
import re
import sys

# A fence line opens or closes a fenced code block; a run of backticks opens or closes a code span.
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
BACKTICKS = re.compile(r"`+")


def escape_tags_in_line(line: str) -> str:
    """The line with each '<' outside a code span escaped, so glow shows it instead of a tag."""
    out = []
    position = 0
    while position < len(line):
        opening = BACKTICKS.search(line, position)
        if not opening:
            out.append(line[position:].replace("<", "\\<"))
            break
        out.append(line[position:opening.start()].replace("<", "\\<"))
        # A code span closes at the next run of the same length; an opening run with no closing
        # one is plain text, so the text after it is escaped as well.
        closing = re.compile(r"(?<!`)" + re.escape(opening.group()) + r"(?!`)").search(line, opening.end())
        if not closing:
            out.append(opening.group())
            position = opening.end()
            continue
        out.append(line[opening.start():closing.end()])
        position = closing.end()
    return "".join(out)


def escape_tags(markdown: str) -> str:
    """The markdown with each '<' outside fenced code blocks and code spans escaped."""
    lines = []
    fence = None
    for line in markdown.split("\n"):
        match = FENCE.match(line)
        if fence:
            if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence):
                fence = None
            lines.append(line)
        elif match:
            fence = match.group(1)
            lines.append(line)
        else:
            lines.append(escape_tags_in_line(line))
    return "\n".join(lines)


def text(issue: dict, name: str) -> str:
    """A field as text, where a field bd left out is empty."""
    value = issue.get(name)
    return "" if value is None else str(value)


def page(issue: dict, for_glow: bool) -> str:
    issue_id = text(issue, "id")
    title = text(issue, "title")
    if for_glow:
        title = escape_tags_in_line(title)
    heading = f"{issue_id}: {title}" if title else issue_id

    # Each field is read once, so a field bd leaves out cannot be tested for and then missed in
    # the line that appends it.
    details = []
    status = text(issue, "status").replace("_", " ")
    if status:
        details.append(f"- Status: {status}")
    issue_type = text(issue, "issue_type")
    if issue_type:
        details.append(f"- Type: {issue_type}")
    priority = issue.get("priority")
    if priority is not None:
        details.append(f"- Priority: P{priority}")
    assignee = text(issue, "assignee")
    if assignee:
        details.append(f"- Assignee: {assignee}")
    created = text(issue, "created_at")
    if created:
        details.append(f"- Created: {created[:10]}")

    parts = [f"# {heading}"]
    if details:
        parts += ["", *details]
    for name, heading_text in (("description", "Description"), ("acceptance_criteria", "Acceptance criteria")):
        body = text(issue, name).strip()
        if for_glow:
            body = escape_tags(body)
        if body:
            parts += ["", f"## {heading_text}", "", body]
    return "\n".join(parts) + "\n"


def main() -> int:
    raw = sys.stdin.read()
    # A bd that failed printed nothing here, or an {"error": ...} object; board.sh shows bd's
    # own message from its stderr instead.
    if not raw.strip():
        return 1
    try:
        answer = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"bead-page: bd gave no JSON: {error}", file=sys.stderr)
        return 1
    if isinstance(answer, dict) and "error" in answer:
        return 1
    if isinstance(answer, list):
        issue = answer[0] if answer else None
    else:
        issue = answer
    if not isinstance(issue, dict) or not text(issue, "id"):
        print("bead-page: bd's JSON names no Bead", file=sys.stderr)
        return 1
    sys.stdout.write(page(issue, "--for-glow" in sys.argv[1:]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
