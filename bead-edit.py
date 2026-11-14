#!/usr/bin/env python3
"""Edits a Bead's description in micro, for the edit key of the page mdd draws (herdr-click-open-bje).

board.sh gives the mdd pane an EDITOR pointing at this script, with the Bead, its project and
the page in the arguments. mddog runs `$EDITOR <page>` in the same pane when someone presses e
(or v), and draws the page again when the editor exits (mddog src/editor.rs, docs/behavior.md
row 37). The page is a temporary copy, so this script ignores the path mddog appends: it asks
bd for the Bead's current description, writes that to a temporary file, and runs micro on the
file. When micro exits, a changed description goes back to the Bead with
`bd update <id> --body-file <file>`, and the page is built again from bd so mddog's redraw
shows the new text. An unchanged description writes nothing. If bd cannot write, the edited
text stays in its temporary file, and both stderr and the redrawn page name that file.

The title, status and the other fields are not edited here: micro sees the description alone.
bd runs in the Bead's project with BEADS_DIR cleared, as board.sh's `bd show` does, so an
inherited BEADS_DIR cannot point it at another project's database.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.realpath(__file__))


class Failure(Exception):
    """A step this script could not take, with the message to show for it."""


def bd(project: str, *arguments: str) -> subprocess.CompletedProcess:
    """Run bd in the Bead's project, with no BEADS_DIR from the pane to point it elsewhere."""
    environment = dict(os.environ)
    environment.pop("BEADS_DIR", None)
    return subprocess.run(["bd", *arguments], cwd=project, env=environment, capture_output=True)


def bead_json(project: str, issue_id: str) -> bytes:
    """bd's JSON for the Bead, from `bd show --json` in the Bead's project."""
    answer = bd(project, "show", issue_id, "--json")
    if answer.returncode != 0:
        raise Failure(answer.stderr.decode().strip() or f"bd show {issue_id} failed")
    return answer.stdout


def bead(project: str, issue_id: str) -> dict:
    """The Bead bd's JSON describes, where a JSON that names no Bead is a Failure."""
    try:
        parsed = json.loads(bead_json(project, issue_id))
    except json.JSONDecodeError as error:
        raise Failure(f"bd gave no JSON: {error}") from error
    issue = parsed[0] if isinstance(parsed, list) and parsed else parsed
    if not isinstance(issue, dict) or not issue.get("id"):
        raise Failure("bd's JSON names no Bead")
    return issue


def description(project: str, issue_id: str) -> str:
    """The Bead's description as bd holds it, where a Bead without one is empty."""
    value = bead(project, issue_id).get("description")
    return "" if value is None else str(value)


def rebuild_page(project: str, issue_id: str, page_path: str, kept_text: str = "") -> None:
    """Write the page board.sh would build now, in place, for mddog to draw again.

    A kept_text path is where a failed save left the edited description: the page then opens
    with that, ahead of the Bead's own text, because mddog paints over anything printed while
    the editor was open.
    """
    raw = bead_json(project, issue_id)
    # The page is rebuilt for mdd, which, like glow, drops a placeholder such as <id> unless its
    # '<' is escaped; board.sh builds the first page with the same flag.
    built = subprocess.run(
        [sys.executable, os.path.join(HERE, "bead-page.py"), "--escape-tags"],
        input=raw,
        capture_output=True,
    )
    if built.returncode != 0:
        raise Failure(built.stderr.decode().strip() or "bead-page.py failed")
    note = ""
    if kept_text:
        note = (
            "# Save failed\n\n"
            f"Your edited description was not saved to {issue_id}. It is in `{kept_text}`.\n\n"
        )
    page = note.encode() + built.stdout
    directory = os.path.dirname(page_path) or "."
    handle, replacement = tempfile.mkstemp(dir=directory, prefix=".bead-page-")
    try:
        with os.fdopen(handle, "wb") as page_file:
            page_file.write(page)
        os.replace(replacement, page_path)
    except BaseException:
        os.unlink(replacement)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", required=True, help="the Bead whose description is edited")
    parser.add_argument("--project", required=True, help="the project bd reads the Bead in")
    parser.add_argument("--page", required=True, help="the page mddog draws and redraws")
    args, _ignored = parser.parse_known_args()
    # mddog appends the path of the page it draws, which this helper does not edit.

    try:
        current = description(args.project, args.id)
    except Failure as error:
        print(f"bead-edit: could not read {args.id}: {error}", file=sys.stderr)
        return 1

    handle, edited_path = tempfile.mkstemp(prefix=f"bead-edit-{args.id}-", suffix=".md")
    with os.fdopen(handle, "w") as edited_file:
        edited_file.write(current)
    try:
        subprocess.run(["micro", edited_path])
    except FileNotFoundError:
        print(f"bead-edit: micro is not installed; the description is in {edited_path}", file=sys.stderr)
        return 1

    with open(edited_path) as edited_file:
        edited = edited_file.read()
    if edited == current:
        os.unlink(edited_path)
        return 0

    update = bd(args.project, "update", args.id, "--body-file", edited_path, "--allow-empty-description")
    if update.returncode != 0:
        # Nothing typed is lost: the file stays, and the redrawn page names it.
        try:
            rebuild_page(args.project, args.id, args.page, edited_path)
        except Failure as error:
            print(f"bead-edit: could not redraw {args.id}'s page: {error}", file=sys.stderr)
        print(f"bead-edit: could not save {args.id}: {update.stderr.decode().strip()}", file=sys.stderr)
        print(f"bead-edit: your text is in {edited_path}", file=sys.stderr)
        return 1

    os.unlink(edited_path)
    try:
        rebuild_page(args.project, args.id, args.page)
    except Failure as error:
        # The Bead has the new text, so nothing is lost; only the redraw is behind.
        print(f"bead-edit: saved {args.id}, but could not redraw its page: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
