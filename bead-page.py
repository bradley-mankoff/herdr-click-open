#!/usr/bin/env python3
"""Builds the markdown page glow renders for a Ctrl-clicked Bead (herdr-click-open-df7).

bd show draws its own boxed layout around the description, and glow would show the box-drawing
characters as text. This script takes instead the JSON `bd show --json` prints and writes a
plain markdown page: one heading naming the Bead, a short list of its state, then the
description and the acceptance criteria as the markdown they already are. glow renders the
headings, lists and code fences; micro, in the fallback for a Mac without glow, shows the same
page as text.

Input: the JSON array `bd show --json` prints on stdin. Output: the page on stdout.
"""
import json
import sys


def text(issue: dict, name: str) -> str:
    """A field as text, where a field bd left out is empty."""
    value = issue.get(name)
    return "" if value is None else str(value)


def page(issue: dict) -> str:
    title = text(issue, "title")
    heading = f"{text(issue, 'id')}: {title}" if title else text(issue, "id")

    details = []
    status = text(issue, "status").replace("_", " ")
    if status:
        details.append(f"- Status: {status}")
    if text(issue, "issue_type"):
        details.append(f"- Type: {text(issue, 'issue_type')}")
    if issue.get("priority") is not None:
        details.append(f"- Priority: P{issue['priority']}")
    if text(issue, "assignee"):
        details.append(f"- Assignee: {text(issue, 'assignee')}")
    if text(issue, "created_at"):
        details.append(f"- Created: {text(issue, 'created_at')[:10]}")

    parts = [f"# {heading}"]
    if details:
        parts += ["", *details]
    for name, heading_text in (("description", "Description"), ("acceptance_criteria", "Acceptance criteria")):
        body = text(issue, name).strip()
        if body:
            parts += ["", f"## {heading_text}", "", body]
    return "\n".join(parts) + "\n"


def main() -> int:
    try:
        answer = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        print(f"bead-page: bd gave no JSON: {error}", file=sys.stderr)
        return 1
    if isinstance(answer, list):
        issue = answer[0] if answer else None
    else:
        issue = answer
    if not isinstance(issue, dict) or not text(issue, "id"):
        print("bead-page: bd's JSON names no Bead", file=sys.stderr)
        return 1
    sys.stdout.write(page(issue))
    return 0


if __name__ == "__main__":
    sys.exit(main())
