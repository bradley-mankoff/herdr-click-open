#!/usr/bin/env bash
# Opens a Ctrl-clicked web or file link in a split to the right (fac-qpv.7.2). A second
# herdr action, board.sh, takes the board links that herdr's manifest matches first.
#
# A file:// URL may end in #L42 or #L42C5 (file-links.ts writes those); micro takes them as
# +LINE:COL.
#
# micro rather than an Electron editor: micro is a small terminal editor that is
# ready as soon as the pane opens, where the earlier tode (terminal-code) needed
# seconds per file. micro has no folder view, so this plugin has no folder
# action: browse folders with the herdr-sidebar plugin (prefix+e), where pressing
# e in a text preview opens the sidebar's own editor.
#
# This script splits the pane and runs the tool there, rather than calling
# `terminal-browser open --split`. That tool's own split types the bare Electron
# binary into the new pane without the ELECTRON_RUN_AS_NODE=1 its launcher script
# sets, and in Herdr that Electron crashes (terminal-browser 2026-10-24).
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
. "$here/shared.sh"
pane=${HERDR_PANE_ID:?no pane}
url=${HERDR_PLUGIN_CLICKED_URL:-}

case $url in
"")
	# Only reachable if something invokes the action without a clicked link.
	echo "click-open: no link was clicked" >&2
	exit 2
	;;
file://*)
	path=${url#file://}
	path=${path#localhost}
	fragment=
	if [[ $path == *"#"* ]]; then
		fragment=${path#*#}
		path=${path%%#*}
	fi
	path=$(decode "$path")
	if [[ $fragment =~ ^L([0-9]+)(C([0-9]+))?$ ]]; then
		command=(micro "$path" "+${BASH_REMATCH[1]}:${BASH_REMATCH[3]:-1}")
	else
		command=(micro "$path")
	fi
	;;
*)
	command=(terminal-browser open "$url")
	;;
esac

# The pane closes when the tool exits, instead of leaving a shell behind.
new_pane=$("$herdr" pane split --pane "$pane" --direction right --focus |
	python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
"$herdr" pane run "$new_pane" "exec $(printf '%q ' "${command[@]}")"
