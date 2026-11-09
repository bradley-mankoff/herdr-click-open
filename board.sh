#!/usr/bin/env bash
# Shows the Bead of a Ctrl-clicked board link in the nearest board tab (fac-qpv.7.2).
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
#   2. shows the Bead in a board tab of this herdr workspace: a terminal-browser pane
#      already showing the board, else a tab of the Mac's default browser, else a new tab.
#
# The nearest tab is the alternative passed over: always opening a new tab piles up tabs,
# and a Bead read once is not worth one.
set -uo pipefail
here=$(dirname "$(readlink -f "$0")")
. "$here/shared.sh"

# A JavaScript string literal, for the page to read back the project and the Bead.
js_string() {
	local value=${1//\\/\\\\}
	value=${value//\"/\\\"}
	printf '"%s"' "$value"
}

# The app this Mac opens web links with, as a "<family><TAB><app name>" pair: the family is
# the AppleScript file that can run script in that browser, the app name the one AppleScript
# knows it by. LaunchServices' handler for https is what the Human sets in System Settings.
# Prints nothing when the setting cannot be read or names a browser this plugin has no
# script for.
scriptable_default_browser() {
	local plist=$HOME/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist
	[ -f "$plist" ] || return 0
	plutil -convert json -o - "$plist" 2>/dev/null | python3 -c '
import json, sys
browsers = {
    "com.apple.safari": ("safari", "Safari"),
    "com.google.chrome": ("chromium", "Google Chrome"),
    "com.brave.browser": ("chromium", "Brave Browser"),
    "com.microsoft.edgemac": ("chromium", "Microsoft Edge"),
    "com.vivaldi.vivaldi": ("chromium", "Vivaldi"),
    "org.chromium.chromium": ("chromium", "Chromium"),
    "company.thebrowser.browser": ("chromium", "Arc"),
}
try:
    handlers = json.load(sys.stdin).get("LSHandlers") or []
except ValueError:
    handlers = []
for field, value in (
    ("LSHandlerURLScheme", "https"),
    ("LSHandlerURLScheme", "http"),
    ("LSHandlerContentType", "com.apple.default-app.web-browser"),
):
    for handler in handlers:
        if handler.get(field) == value and handler.get("LSHandlerRoleAll") in browsers:
            print("%s\t%s" % browsers[handler["LSHandlerRoleAll"]])
            sys.exit(0)
'
}

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

# The board's own addresses: one place names the hostnames a board tab may show.
base="http://127.0.0.1:$port/"
localhost_base="http://localhost:$port/"
page="$base#/board?issue=$issue"

# The page's saved project and the Bead, set in that order: a page that restores its saved
# project after the server switch would otherwise put the board back on the old project.
js=$(printf 'localStorage.setItem("beads-ui.workspace", %s); location.href = %s;' "$(js_string "$project")" "$(js_string "$page")")

# The board server, so the Bead is found whatever project the board showed. A board that
# is not running is no reason to refuse the click: the tab below still opens the link.
node "$here/board.mjs" "$port" "$project" || echo "click-open: the board did not switch to $project" >&2

# A terminal-browser pane of this herdr workspace already showing the board is the nearest
# tab of all: the page beside the conversation moves to the Bead.
board_tab=
if [ -n "${HERDR_PANE_ID:-}" ] && command -v terminal-browser >/dev/null 2>&1; then
	workspace=${HERDR_WORKSPACE_ID:-${HERDR_PANE_ID%%:*}}
	board_tab=$(
		python3 -c '
import json, sys
base, local_base, panes, browsers = sys.argv[1:5]
def load(text):
    try:
        return json.loads(text)
    except ValueError:
        return None
running = ((load(panes) or {}).get("result") or {}).get("panes") or []
ids = {pane.get("pane_id") for pane in running if isinstance(pane, dict)}
for browser in (load(browsers) or {}).get("browsers") or []:
    if ((browser.get("pane") or {}).get("pane")) not in ids:
        continue
    tabs = [tab for tab in browser.get("tabs") or [] if str(tab.get("url", "")).startswith((base, local_base))]
    if not tabs:
        continue
    tab = next((tab for tab in tabs if tab.get("active")), tabs[0])
    print("%s\t%s" % (browser.get("key"), tab.get("id")))
    break
' "$base" "$localhost_base" "$("$herdr" pane list --workspace "$workspace" 2>/dev/null)" "$(terminal-browser ls --all --json 2>/dev/null)"
	)
fi
if [ -n "$board_tab" ]; then
	browser=${board_tab%%$'\t'*}
	tab=${board_tab#*$'\t'}
	terminal-browser action --browser "$browser" --tab "$tab" --follow -- eval "$js" && exit 0
fi

# The Mac's default browser, when it is one this plugin can run script in (Safari or a
# Chromium browser). Any other browser takes the link as it is: the board server was
# switched, but no page there can be told to save the project.
target=$(scriptable_default_browser)
family=${target%%$'\t'*}
app=${target#*$'\t'}
if [ -n "$family" ]; then
	# The browser lists its own tabs, because only it knows them; the click shows the Bead in
	# the first tab showing the board, and opens a tab when there is none.
	tabs=$(osascript "$here/$family.applescript" "$app" list 2>/dev/null) || tabs=
	window=
	tab=
	while IFS=$'\t' read -r w t address; do
		case $address in
		"$base"* | "$localhost_base"*) window=$w; tab=$t; break ;;
		esac
	done <<<"$tabs"
	if [ -n "$window" ]; then
		osascript "$here/$family.applescript" "$app" run "$window" "$tab" "$js" && exit 0
	else
		osascript "$here/$family.applescript" "$app" open "$base" "$js" && exit 0
	fi
fi

# No browser this plugin can run script in, or none whose tab could be told: the clicked
# link opens as it is, which is all a browser without AppleScript can take. It names the
# project but the page reads only its own saved one, so this is the one case that can come
# back "not found" until mantoni/beads-ui#122 ships a URL parameter that chooses it.
open "$url"
