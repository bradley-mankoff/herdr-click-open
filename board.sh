#!/usr/bin/env bash
# Opens the Bead of a Ctrl-clicked board link as a drawn page, in a split to the right of the
# clicked pane (herdr-click-open-df7, herdr-click-open-g2j). The click parses the Bead and
# project out of the link, asks `bd show --json` in that project for the Bead, builds a
# markdown page from the answer (bead-page.py) and opens the viewer on the page. The viewer is
# chosen the way open.sh chooses one for a Markdown file (shared.sh's rendered_viewer): mdd
# (mddog) first, which draws the page as images through the terminal's kitty graphics protocol,
# with real fonts and heading sizes, the way GitHub draws it; then glow, with the plugin's style
# and a quiet pager; then micro, which shows the page as raw text. A renderer rather than micro,
# a text editor that cannot draw markdown: bd show's own boxed layout would reach any viewer as
# text, so the page is built from bd's JSON instead. It never asks the board, terminal-browser,
# the default browser or AppleScript, so a link opens even when the board would show an error,
# and both Macs behave the same.
#
# The page is a copy that the viewers only read. In the mdd pane, mdd's edit key ('e' or 'v')
# runs the pane's $EDITOR, which board.sh points at this repo's bead-edit.py: it opens the
# Bead's description in micro, writes a change back to the Bead and rebuilds the page for mdd's
# redraw (herdr-click-open-bje).
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
# page gets a folder of its own rather than mktemp's suffix-less name. The page keeps the .md
# name for mdd too.
page_dir=$(mktemp -d "${TMPDIR:-/tmp}/click-open-bead.XXXXXX")
page_file="$page_dir/bead.md"
# bd's own error output, named for the tool that writes it so the message below can point at it.
bd_error="$page_dir/bd.err"

# Ends a click that will show nothing, taking the page with it: only a pane that took the page
# still needs it once this script exits. A caller that has printed the details itself passes no
# message.
fail() {
	[ $# -eq 0 ] || echo "click-open: $*" >&2
	rm -rf "$page_dir"
	exit 1
}

# mdd and glow both take a placeholder such as <id> for an HTML tag and draw nothing for it, so
# a viewer that draws the page is handed one with each '<' outside code escaped; micro shows
# the page as written, so it gets the page unescaped. mdd was checked by drawing a page with
# `mdd --headless`: the page written plain draws "Run bd show in .", the escaped one draws
# "Run bd show <id> in <project>". The viewer is chosen before bd is asked, because the choice
# says whether the page is escaped.
#
# mdd's edit key runs $EDITOR on the page it draws, so the pane hands mdd this repo's
# bead-edit.py, with mddog's own page-path argument ignored: the helper opens the Bead's
# description in micro and writes a change back to the Bead (herdr-click-open-bje).
editor_args=("$here/bead-edit.py" --id "$issue" --project "$project" --page "$page_file")
editor=$(printf '%q ' "${editor_args[@]}")
direction=right
hides_tags=
if rendered_viewer "$page_file" "${editor% }"; then
	hides_tags=1
else
	# micro's text takes the pane's full width below the click rather than a narrow pane right,
	# and the pane keeps the Bead in view until the viewer exits.
	direction=down
	viewer=(micro -readonly true "$page_file")
fi

if ! (unset BEADS_DIR; cd "$project" && bd show "$issue" --json) 2>"$bd_error" |
	python3 "$here/bead-page.py" ${hides_tags:+--escape-tags} >"$page_file"; then
	echo "click-open: could not read $issue in $project:" >&2
	sed 's/^/  /' "$bd_error" >&2
	fail
fi
rm -f "$bd_error"

# The pane is herdr's, split the way open.sh splits it for a web link; the pane closes when the
# viewer exits because the command replaces the pane's shell. A split that fails and a split
# that answers without a pane id are the same failure, so both leave new_pane empty.
new_pane=$("$herdr" pane split --pane "$pane" --direction "$direction" --focus |
	python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])') || new_pane=
[ -n "$new_pane" ] || fail "herdr opened no pane"

pane_command=$(printf '%q ' "${viewer[@]}")
"$herdr" pane run "$new_pane" "exec ${pane_command% }" ||
	fail "herdr could not start the Bead's viewer in the new pane"
