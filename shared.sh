#!/usr/bin/env bash
# What click-open's scripts share (fac-qpv.7.2): the tools herdr does not put on the PATH of the
# commands it runs, the herdr command itself, the decoding of a clicked link's percent-encoded
# parts, and the choice of the viewer that draws a markdown file (herdr-click-open-3aq).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
herdr=${HERDR_BIN_PATH:-herdr}
plugin_dir=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

# A URL component's text: bead-links.ts writes a link's values with encodeURIComponent, and a
# file link's path the same way.
decode() {
	printf '%b' "${1//%/\\x}"
}

# Like herdr, a stand-in can name a tool, and the tests name one nothing provides to exercise a
# fallback. installed answers whether this Mac has the tool it is given, by name or by path.
installed() {
	command -v "$1" >/dev/null 2>&1
}
mdd=${MDD_BIN_PATH:-mdd}
glow=${GLOW_BIN_PATH:-glow}

# rendered_viewer FILE EDITOR sets viewer to the command that draws the markdown FILE, and returns
# 1 when this Mac has neither mdd nor glow, so the caller falls back to micro. mdd (mddog) comes
# first: it draws the file as images through the terminal's kitty graphics protocol, with real
# fonts and heading sizes, and scrolls, searches and quits on its own keys, so it is handed the
# file alone, with no pager and no style. Its edit key runs EDITOR on the file it draws, so the
# caller says what that is (the page's bead-edit.py, or micro on the file itself).
#
# glow is the fallback. glow hands the rendered file to $PAGER, or to `less -r` when it is unset,
# and less fills the pane below a short file with '~' lines and ends its prompt with '(END)'. The
# pager is told to print neither: --tilde leaves the fill lines out, and a prompt of one space
# shows nothing where less would print '(END)'. It travels in the pane's own command, so glow has
# it however herdr starts the pane. glow is given the plugin's style, glow-style.json, rather
# than its own default, so no markdown symbol reaches the screen.
rendered_viewer() {
	if installed "$mdd"; then
		viewer=(env "EDITOR=$2" "$mdd" "$1")
	elif installed "$glow"; then
		local pager="less -R --tilde -P ' '"
		viewer=(env "PAGER=$pager" "$glow" -s "$plugin_dir/glow-style.json" -p "$1")
	else
		return 1
	fi
}
