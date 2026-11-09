#!/usr/bin/env bash
# Opens the Bead of a Ctrl-clicked board link in micro, in a split to the right of the clicked
# pane (herdr-click-open-0h4). The click parses the Bead and project out of the link, renders
# the Bead with `bd show` in that project, and hands micro the rendering as a temporary file.
# It never asks the board, terminal-browser, the default browser or AppleScript, so a link
# opens even when the board would show an error, and both Macs behave the same.
#
# A board link is what bead-links.ts writes in a Project Manager's reply:
#   http://127.0.0.1:3917/#/board?issue=fac-qpv.7.2&workspace=/path/to/repo
# The query follows the hash, so it is cut out of the whole URL rather than parsed as a URL's
# query. The port belongs to the board, which this action does not use.
#
# The rendering is a copy, so an edit in the pane is saved, if at all, to the temporary file,
# never to the Bead. micro opens it read-only to say so.
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
page=$(mktemp "${TMPDIR:-/tmp}/click-open-bead.XXXXXX")
error="${page}.err"
if ! (unset BEADS_DIR; cd "$project" && bd show "$issue") >"$page" 2>"$error"; then
	echo "click-open: bd show $issue in $project failed:" >&2
	sed 's/^/  /' "$error" "$page" >&2
	rm -f "$page" "$error"
	exit 1
fi
rm -f "$error"

# The pane is herdr's, split the way open.sh splits it for a web link; the pane closes when
# micro exits because the command replaces the pane's shell.
if ! new_pane=$("$herdr" pane split --pane "$pane" --direction right --focus |
	python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])'); then
	echo "click-open: herdr opened no pane" >&2
	rm -f "$page"
	exit 1
fi
[ -n "$new_pane" ] || { echo "click-open: herdr opened no pane" >&2; rm -f "$page"; exit 1; }

if ! "$herdr" pane run "$new_pane" "exec micro -readonly true $(printf '%q' "$page")"; then
	echo "click-open: herdr could not start micro in the new pane" >&2
	rm -f "$page"
	exit 1
fi
