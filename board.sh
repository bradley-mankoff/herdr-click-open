#!/usr/bin/env bash
# Shows the Bead of a Ctrl-clicked board link in a terminal-browser pane of this herdr
# workspace (fac-qpv.7.2): the board's own pane when the workspace has one, else a new pane
# split to the right, the way open.sh opens a web link.
#
# A board link is what bead-links.ts writes in a Project Manager's reply:
#   http://127.0.0.1:3917/#/board?issue=fac-qpv.7.2&workspace=/path/to/repo
# It names the Bead, the project the board should show, and the board's own port.
#
# An open board page restores the project it saved in its own window (localStorage
# "beads-ui.workspace") within seconds of an outside switch, so the click does two things
# in order:
#   1. switches the board server to the link's project with beads-ui's own set-workspace
#      message, so the Bead is found whatever project the board showed before;
#   2. shows the Bead in a board tab of this herdr workspace: the terminal-browser pane
#      already showing the board, else a split to the right with a new terminal-browser
#      there.
#
# The default browser is the alternative passed over: it differs between Macs, it is not
# beside the conversation, and reaching its tabs took one AppleScript per browser family.
set -uo pipefail
here=$(dirname "$(readlink -f "$0")")
. "$here/shared.sh"
pane=${HERDR_PANE_ID:?no pane}
url=${HERDR_PLUGIN_CLICKED_URL:-}

case $url in
"") echo "click-open: no link was clicked" >&2; exit 2 ;;
https://*|http://*) ;;
*) echo "click-open: not a web link: $url" >&2; exit 2 ;;
esac

# The link's Bead, project and board port. The query follows the hash, so it is cut out of
# the whole URL rather than parsed as a URL's query.
port=${url#*://}
port=${port%%/*}
port=${port##*:}
[[ $port =~ ^[0-9]+$ ]] || { echo "click-open: the link names no board port: $url" >&2; exit 2; }
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
command -v terminal-browser >/dev/null 2>&1 || { echo "click-open: terminal-browser is not installed" >&2; exit 1; }

# A JavaScript string literal, for the page to read back the project and the Bead.
js_string() {
	local value=${1//\\/\\\\}
	value=${value//\"/\\\"}
	printf '"%s"' "$value"
}

# The board's own addresses: one place names the hostnames a board tab may show.
base="http://127.0.0.1:$port/"
localhost_base="http://localhost:$port/"
page="$base#/board?issue=$issue"

# The page's saved project and the Bead, set in that order: a page that restores its saved
# project after the server switch would otherwise put the board back on the old project.
js=$(printf 'localStorage.setItem("beads-ui.workspace", %s); location.href = %s;' "$(js_string "$project")" "$(js_string "$page")")

# The board server, so the Bead is found whatever project the board showed. A board that
# is not running is no reason to refuse the click: the pane below still opens the link.
node "$here/board.mjs" "$port" "$project"
case $? in
0) ;;
2) exit 2 ;; # board.mjs says why: the folder has no Beads database
esac

# A herdr workspace's panes, one id a line.
workspace_panes() {
	"$herdr" pane list --workspace "$1" 2>/dev/null | python3 -c '
import json, sys
try:
	panes = (json.load(sys.stdin).get("result") or {}).get("panes") or []
except ValueError:
	panes = []
for pane in panes:
	if isinstance(pane, dict) and pane.get("pane_id"):
		print(pane["pane_id"])
'
}

# The terminal-browser tab showing the board in one of these panes, as a
# "<browser key><TAB><tab id>" pair; nothing when none does.
board_tab_in() {
	python3 -c '
import json, sys
base, local_base, panes, browsers = sys.argv[1:5]
def load(text):
	try:
		return json.loads(text)
	except ValueError:
		return None
ids = set(panes.split())
for browser in (load(browsers) or {}).get("browsers") or []:
	if (browser.get("pane") or {}).get("pane") not in ids:
		continue
	tabs = [tab for tab in browser.get("tabs") or [] if str(tab.get("url", "")).startswith((base, local_base))]
	if not tabs:
		continue
	tab = next((tab for tab in tabs if tab.get("active")), tabs[0])
	print("%s\t%s" % (browser.get("key"), tab.get("id")))
	break
' "$base" "$localhost_base" "$1" "$(terminal-browser ls --all --json 2>/dev/null)"
}

# Shows the Bead in a tab, given as board_tab_in prints it.
show_bead() {
	local browser=${1%%$'\t'*}
	local tab=${1#*$'\t'}
	terminal-browser action --browser "$browser" --tab "$tab" --follow -- eval "$js"
}

# A terminal-browser pane of this herdr workspace already showing the board is the nearest
# tab of all: the page beside the conversation moves to the Bead.
workspace=${HERDR_WORKSPACE_ID:-${pane%%:*}}
board_tab=$(board_tab_in "$(workspace_panes "$workspace")")
[ -n "$board_tab" ] && show_bead "$board_tab" && exit 0

# No board tab here: open one in a split to the right, as open.sh opens a web link. The
# split is herdr's, not `terminal-browser open --split`, whose bare Electron crashes in
# herdr (open.sh has the details).
new_pane=$("$herdr" pane split --pane "$pane" --direction right --focus |
	python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
[ -n "$new_pane" ] || { echo "click-open: herdr opened no pane" >&2; exit 1; }
"$herdr" pane run "$new_pane" "exec terminal-browser open $(printf '%q' "$base")"

# The new browser takes a moment to register; once its tab shows in that pane, show the
# Bead in it. Ten seconds is far longer than terminal-browser takes to start, and keeps a
# stuck start from leaving the click hanging.
board_tab=
for _ in $(seq 1 50); do
	board_tab=$(board_tab_in "$new_pane")
	[ -n "$board_tab" ] && break
	sleep 0.2
done
[ -n "$board_tab" ] && show_bead "$board_tab" && exit 0
echo "click-open: the board did not open in the new pane" >&2
exit 1
