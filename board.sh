#!/usr/bin/env bash
# Opens the Bead of a Ctrl-clicked board link as rendered markdown, in a split to the right of
# the clicked pane (herdr-click-open-df7). The click parses the Bead and project out of the
# link, asks `bd show --json` in that project for the Bead, builds a markdown page from the
# answer (bead-page.py) and opens glow on the page in its pager. glow rather than micro, a text
# editor that cannot render markdown: bd show's own boxed layout would reach glow as text, so
# the page is built from bd's JSON instead.
#
# The rendering is a copy, so an edit cannot reach the Bead; glow only reads it. A Mac without
# glow gets the page as raw text in micro, in a split below the clicked pane, so the text uses
# the pane's full width instead of a pane that opens empty. micro opens it read-only.
#
# A board link is what bead-links.ts writes in a Project Manager's reply:
#   http://127.0.0.1:3917/#/board?issue=fac-qpv.7.2&workspace=/path/to/repo
# The query follows the hash, so it is cut out of the whole URL rather than parsed as a URL's
# query. The port belongs to the board, which this action does not use.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
. "$here/shared.sh"
pane=${HERDR_PANE_ID:?no pane}
url=${HERDR_PLUGIN_CLICKED_URL:-}

case $url in
"") echo "click-open: no link was clicked" >&2; exit 2 ;;
https://*|http://*) ;;
*) echo "click-open: not a web link: $url" >&2; exit 2 ;;
esac

issue=
project=
IFS='&' read -r -a pairs <<<"${url#*\?}"
for pair in "${pairs[@]}"; do
	case $pair in
	issue=*) issue=$(decode "${pair#issue=}") ;;
	workspace=*) project=$(decode "${pair#workspace=}") ;;
	esac
done
[ -n "$issue" ] && [ -n "$project" ] || { echo "click-open: the link names no Bead or project: $url" >&2; exit 2; }

# The Bead is rendered from the project the link names, not from whichever project this pane
# happens to be in. An inherited BEADS_DIR would point bd at another database, so it is
# cleared inside the subshell.
# glow renders only a file whose name ends in .md and shows any other as plain text, so the
# page gets a folder of its own rather than mktemp's suffix-less name.
page_dir=$(mktemp -d "${TMPDIR:-/tmp}/click-open-bead.XXXXXX")
page_file="$page_dir/bead.md"
bead_error="$page_dir/bd.err"

# Ends a click that will show nothing, taking the page with it: only a pane that took the page
# still needs it once this script exits. A caller that has printed the details itself passes no
# message.
fail() {
	[ $# -eq 0 ] || echo "click-open: $*" >&2
	rm -rf "$page_dir"
	exit 1
}

if ! (unset BEADS_DIR; cd "$project" && bd show "$issue" --json) 2>"$bead_error" |
	python3 "$here/bead-page.py" >"$page_file"; then
	echo "click-open: could not read $issue in $project:" >&2
	sed 's/^/  /' "$bead_error" >&2
	fail
fi
rm -f "$bead_error"

# glow renders the page; a Mac without it opens the same page as text in micro below. The pane
# keeps the Bead in view until the viewer exits.
if command -v "$glow" >/dev/null 2>&1; then
	direction=right
	viewer=("$glow" -p "$page_file")
else
	direction=down
	viewer=(micro -readonly true "$page_file")
fi

# The pane is herdr's, split the way open.sh splits it for a web link; the pane closes when the
# viewer exits because the command replaces the pane's shell. A split that fails and a split
# that answers without a pane id are the same failure, so both leave new_pane empty.
new_pane=$("$herdr" pane split --pane "$pane" --direction "$direction" --focus |
	python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])') || new_pane=
[ -n "$new_pane" ] || fail "herdr opened no pane"

pane_command=$(printf '%q ' "${viewer[@]}")
"$herdr" pane run "$new_pane" "exec ${pane_command% }" ||
	fail "herdr could not start the Bead's viewer in the new pane"
