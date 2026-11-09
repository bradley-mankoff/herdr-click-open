-- Shows a Bead in a Safari tab, for click-open's board action (fac-qpv.7.2).
--
--   osascript safari.applescript Safari list
--   osascript safari.applescript Safari run <window> <tab> <javascript>
--   osascript safari.applescript Safari open <board base> <javascript>
--
-- `list` prints one "window<TAB>tab<TAB>url" line per tab of the browser if it is running,
-- for the plugin to choose a board tab from; `run` runs the javascript in a tab it chose; `open` opens the board in a
-- new tab and runs the javascript in it, so the page's saved project is set before the page
-- moves to the Bead.
--
-- The browser is named at the call, so the plugin names it once for both Macs; `using
-- terms from` tells the compiler whose words these are, since a named variable carries no
-- dictionary of its own.
--
-- Safari runs script from AppleScript only after the Human turns on Develop > Allow
-- JavaScript from Apple Events, once per Mac. Until then `list` works and `run` and `open`
-- fail, and the plugin falls back to opening the link in a new tab.
on run argv
	set appName to item 1 of argv
	set mode to item 2 of argv
	using terms from application "Safari"
		tell application appName
			if mode is "list" then
				-- Listing must not start the browser, so a Mac that keeps it closed is left quiet.
				if application appName is not running then return ""
				set found to ""
				repeat with w from 1 to count of windows
					repeat with t from 1 to count of tabs of window w
						set boardUrl to URL of tab t of window w
						if boardUrl is not missing value then
							set found to found & w & tab & t & tab & boardUrl & linefeed
						end if
					end repeat
				end repeat
				return found
			else if mode is "run" then
				set w to (item 3 of argv) as integer
				set t to (item 4 of argv) as integer
				do JavaScript (item 5 of argv) in tab t of window w
				return "shown"
			else
				set boardBase to item 3 of argv
				if (count of windows) is 0 then
					set target to make new document with properties {URL:boardBase}
				else
					set target to make new tab at end of tabs of window 1 with properties {URL:boardBase}
				end if
				repeat with n from 1 to 100
					try
						if (URL of target) starts with boardBase then exit repeat
					end try
					delay 0.1
				end repeat
				do JavaScript (item 4 of argv) in target
				return "shown"
			end if
		end tell
	end using terms from
end run
