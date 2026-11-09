#!/usr/bin/env bash
# Opens the Bead of a Ctrl-clicked board link as rendered markdown, in a split to the right of
# the clicked pane (herdr-click-open-df7). The click parses the Bead and project out of the
# link, asks `bd show --json` in that project for the Bead, builds a markdown page from the
# answer (bead-page.py) and opens glow on the page in its pager. glow rather than micro, a text
# editor that cannot render markdown: bd show's own boxed layout would reach glow as text, so
# the page is built from bd's JSON instead.
#
# The page must reach the screen as formatted text, with none of markdown's symbols on it, so
# glow is handed the style in glow-style.json rather than its own default, and the pager is
# told to print neither its fill lines nor its end prompt. glow-style.json is glamour's dark
# style, the one glow uses on a dark terminal, with the '#' prefixes removed from its heading
# entries and checkbox glyphs in place of the dark style's '[ ]' task markers.
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

# glow takes a placeholder such as <id> for an HTML tag and shows nothing for it, so the page
# glow gets has each '<' outside code escaped; micro shows the page as written, so it gets the
# page unescaped.
page_option=
if command -v "$glow" >/dev/null 2>&1; then
	page_option=--for-glow
fi

if ! (unset BEADS_DIR; cd "$project" && bd show "$issue" --json) 2>"$bd_error" |
	python3 "$here/bead-page.py" ${page_option:+"$page_option"} >"$page_file"; then
	echo "click-open: could not read $issue in $project:" >&2
	sed 's/^/  /' "$bd_error" >&2
	fail
fi
rm -f "$bd_error"

# glow renders the page; a Mac without it opens the same page as text in micro below. The pane
# keeps the Bead in view until the viewer exits.
if [ -n "$page_option" ]; then
	direction=right
	# glow-style.json is glow's dark style (from glamour, the renderer behind glow) with two
	# changes: its heading entries carry no '#' prefix, because a rendered Bead must show a
	# heading as styled text, not as the markdown that makes it one, and its task entries draw
	# real checkboxes instead of dark style's '[ ]' brackets for the same reason.
	#
	# glow hands the rendered page to $PAGER, or to `less -r` when it is unset, and less fills
	# the pane below a short page with '~' lines and ends its prompt with '(END)'. The pager is
	# told to print neither: --tilde leaves the fill lines out, and a prompt of one space shows
	# nothing where less would print '(END)'. It travels in the pane's own command, so glow has
	# it however herdr starts the pane.
	pager="less -R --tilde -P ' '"
	viewer=(env "PAGER=$pager" "$glow" -s "$here/glow-style.json" -p "$page_file")
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
