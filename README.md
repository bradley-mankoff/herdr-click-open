# herdr-click-open

Ctrl-click a web link, a file link or a Beads board link in a herdr pane to open it beside the conversation. A web link opens in terminal-browser, a file link in micro, and a board link opens that Bead rendered as markdown by [glow](https://github.com/charmbracelet/glow) in a split to the right of the clicked pane.

A board link needs neither the board nor a browser: the click takes the Bead and project out of the link, asks `bd show --json` in that project, and builds a markdown page from the answer (heading, status, description, acceptance criteria) for glow to render. The pane shows a temporary copy, so nothing typed there reaches the Bead.

The rendered page holds no markdown symbols. glow renders it with the plugin's own style, `glow-style.json`: glamour's dark style (`styles/dark.json` in the glamour repo), which glow itself uses on a dark terminal, with the `#` prefixes taken off its heading entries so a heading reads as styled text, and with real checkbox glyphs (`☐`, `☑`) where the dark style would print `[ ]`, and a drawn line where it would print a rule as `--------`. glow would take a placeholder such as `<id>` for an HTML tag and show nothing for it, so the page glow gets has each `<` outside code escaped; micro's fallback shows the page as bd holds it. glow hands the page to less with `--tilde` and a blank prompt, so the pane shows neither less's `~` fill lines nor its `(END)` prompt.

A Mac without glow still opens the Bead: the click falls back to micro with the same page as raw text, in a split below the clicked pane so the text gets the pane's full width, opened read-only. That fallback shows the page rather than an empty pane.

## Requirements

Both Macs install the same tools:

```sh
brew install glow     # renders a board link's Bead as markdown
brew install micro    # opens file links, and a board link's page on a Mac without glow
```

glow is the only new requirement for rendering. The page comes from `bd show --json` through `python3`, which macOS provides, and `bd` itself must be on PATH. less, which macOS also ships, shows the rendered page in the pane.

Copied from `~/Developer/herdr/click-open` on 2026-11-08 into a repo of its own, so both Macs install the same plugin and it can take the Beads-board click handler built under the Factory's Bead fac-qpv.7.2. It is a tool of the Human's own setup, not part of the Factory.
