#!/usr/bin/env bash
# What click-open's two actions share (fac-qpv.7.2): the tools herdr does not put on the PATH
# of the commands it runs, the herdr command itself, and the decoding of a clicked link's
# percent-encoded parts.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
herdr=${HERDR_BIN_PATH:-herdr}

# A URL component's text: bead-links.ts writes a link's values with encodeURIComponent, and a
# file link's path the same way.
decode() {
	printf '%b' "${1//%/\\x}"
}
