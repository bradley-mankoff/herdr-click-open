# herdr-click-open

Ctrl-click a web link, a file link or a Beads board link in a herdr pane to open it beside the conversation. A web link opens in terminal-browser, a file link in micro, and a board link opens that Bead's page drawn by [mddog](https://github.com/qu8n/mddog) (`mdd`) in a split to the right of the clicked pane.

A board link needs neither the board nor a browser: the click takes the Bead and project out of the link, asks `bd show --json` in that project, and builds a markdown page from the answer (heading, status, description, acceptance criteria) for mdd to draw. The pane shows a temporary copy, so nothing typed there reaches the Bead.

mdd draws the page as images through the terminal's kitty graphics protocol, with real fonts and heading sizes, like GitHub, and scrolls, searches and quits on its own keys. It is handed the page file alone: no pager and no style.

A Mac without mdd still opens the Bead: the click renders the same page with [glow](https://github.com/charmbracelet/glow) in a split to the right. The page holds no markdown symbols. glow renders it with the plugin's own style, `glow-style.json`: glamour's dark style (`styles/dark.json` in the glamour repo), which glow itself uses on a dark terminal, with the `#` prefixes taken off its heading entries so a heading reads as styled text, and with real checkbox glyphs (`☐`, `☑`) where the dark style would print `[ ]`, and a drawn line where it would print a rule as `--------`. glow hands the page to less with `--tilde` and a blank prompt, so the pane shows neither less's `~` fill lines nor its `(END)` prompt.

mdd and glow both take a placeholder such as `<id>` for an HTML tag and draw nothing for it, so the page they get has each `<` outside code escaped; micro's fallback shows the page as bd holds it.

A Mac with neither viewer still opens the Bead: the click falls back to micro with the same page as raw text, in a split below the clicked pane so the text gets the pane's full width, opened read-only. That fallback shows the page rather than an empty pane.

## Requirements

```sh
brew install qu8n/tap/mddog   # draws a board link's Bead page; needs a terminal with kitty graphics support
brew install glow             # renders the same page on a Mac without mdd
brew install micro            # opens file links, and a board link's page on a Mac with neither viewer
```

mdd is the new requirement for rendering. It needs a terminal that speaks the kitty graphics protocol (Ghostty, kitty, WezTerm, iTerm2 or Rex); the herdr config on this Mac has `kitty_graphics = true`. The page comes from `bd show --json` through `python3`, which macOS provides, and `bd` itself must be on PATH. less ships with macOS; micro does not, so the micro fallback needs its own install.

Copied from `~/Developer/herdr/click-open` on 2026-11-08 into a repo of its own, so both Macs install the same plugin and it can take the Beads-board click handler built under the Factory's Bead fac-qpv.7.2. It is a tool of the Human's own setup, not part of the Factory.
