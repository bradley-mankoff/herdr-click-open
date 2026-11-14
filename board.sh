#!/usr/bin/env bash
# Opens the Bead of a Ctrl-clicked board link as a drawn page, in a split to the right of the
# clicked pane (herdr-click-open-df7, herdr-click-open-g2j). The click parses the Bead and
# project out of the link, asks `bd show --json` in that project for the Bead, builds a
# markdown page from the answer (bead-page.py) and opens mdd on the page. mdd (mddog) draws
# the page as images through the terminal's kitty graphics protocol, with real fonts and
# heading sizes, the way GitHub draws it, and scrolls, searches and quits on its own keys, so
# it is handed the page file alone: no pager and no style. A Mac without mdd renders the same
# page with glow; a Mac with neither gets the page as raw text in micro. A renderer rather than
# micro, a text editor that cannot draw markdown: bd show's own boxed layout would reach any
# viewer as text, so the page is built from bd's JSON instead. It never asks the board,
# terminal-browser, the default browser or AppleScript, so a link opens even when the board
# would show an error, and both Macs behave the same.
#
# The glow fallback keeps markdown's symbols off the screen, so glow is handed the style in
# glow-style.json rather than its own default, and the pager is told to print neither its fill
# lines nor its end prompt. glow-style.json is glamour's dark style, the one glow uses on a
# dark terminal, with the '#' prefixes removed from its heading entries and checkbox glyphs in
# place of the dark style's '[ ]' task markers.
#
# The page is a copy that glow and micro only read. In the mdd pane, mdd's edit key ('e' or
# 'v') runs the pane's $EDITOR, which board.sh points at this repo's bead-edit.py: it opens the
# Bead's description in micro, writes a change back to the Bead and rebuilds the page for
# mdd's redraw (herdr-click-open-bje).
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

# Like herdr, a stand-in can name the page's viewer, and the tests name one nothing provides
# to exercise the fallback for a Mac without it. installed answers whether this Mac has the
# tool it is given, by name or by path.
installed() {
	command -v "$1" >/dev/null 2>&1
}
mdd=${MDD_BIN_PATH:-mdd}
have_mdd=
if installed "$mdd"; then have_mdd=1; fi
glow=${GLOW_BIN_PATH:-glow}
have_glow=
if installed "$glow"; then have_glow=1; fi

# mdd and glow both take a placeholder such as <id> for an HTML tag and draw nothing for it, so
# a viewer that draws the page is handed one with each '<' outside code escaped; micro shows
# the page as written, so it gets the page unescaped. mdd was checked by drawing a page with
# `mdd --headless`: the page written plain draws "Run bd show in .", the escaped one draws
# "Run bd show <id> in <project>".
hides_tags=
if [ -n "$have_mdd" ] || [ -n "$have_glow" ]; then
	hides_tags=1
fi
if ! (unset BEADS_DIR; cd "$project" && bd show "$issue" --json) 2>"$bd_error" |
	python3 "$here/bead-page.py" ${hides_tags:+--escape-tags} >"$page_file"; then
	echo "click-open: could not read $issue in $project:" >&2
	sed 's/^/  /' "$bd_error" >&2
	fail
fi
rm -f "$bd_error"

# mdd draws the page itself, so it is handed no style and no pager. A Mac without it renders
# the same page with glow, which needs the plugin's style and a pager told to print neither
# fill lines nor its end prompt. A Mac with neither gets the page as text in micro, in a split
# below the clicked pane, so the text uses the pane's full width instead of a pane that opens
# empty. The pane keeps the Bead in view until the viewer exits.
direction=right
if [ -n "$have_mdd" ]; then
	# mdd's edit key runs $EDITOR on the page it draws and then draws the page again. The page
	# is a throwaway copy, so the pane hands mdd this repo's bead-edit.py as its EDITOR: the
	# helper opens the Bead's own description in micro and writes a change back to the Bead,
	# then rebuilds the page (herdr-click-open-bje). mddog gives the editor the page path as its
	# last argument, a path the helper ignores, so the Bead, its project and the page travel in
	# the helper's own arguments.
	editor="$(printf '%q' "$here/bead-edit.py") --id $(printf '%q' "$issue") --project $(printf '%q' "$project") --page $(printf '%q' "$page_file")"
	viewer=(env "EDITOR=$editor" "$mdd" "$page_file")
elif [ -n "$have_glow" ]; then
	# glow hands the rendered page to $PAGER, or to `less -r` when it is unset, and less fills
	# the pane below a short page with '~' lines and ends its prompt with '(END)'. The pager is
	# told to print neither: --tilde leaves the fill lines out, and a prompt of one space shows
	# nothing where less would print '(END)'. It travels in the pane's own command, so glow has
	# it however herdr starts the pane.
	pager="less -R --tilde -P ' '"
	viewer=(env "PAGER=$pager" "$glow" -s "$here/glow-style.json" -p "$page_file")
else
	# micro's text takes the pane's full width below the click rather than a narrow pane right.
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
