# herdr-click-open

Ctrl-click a web link, a file link or a Beads board link in a herdr pane to open it beside the conversation. A web link opens in terminal-browser, a file link in micro, and a board link opens that Bead rendered as markdown by [glow](https://github.com/charmbracelet/glow) in a split to the right of the clicked pane.

A board link needs neither the board nor a browser: the click takes the Bead and project out of the link, asks `bd show --json` in that project, and builds a markdown page from the answer (heading, status, description, acceptance criteria) for glow to render. The pane shows a temporary copy, so nothing typed there reaches the Bead.

## Requirements

Both Macs install the same tools:

```sh
brew install glow     # renders a board link's Bead as markdown
brew install micro    # opens file links, and a board link's page on a Mac without glow
```

glow is the only new requirement for rendering. A Mac without glow still opens the Bead: the click falls back to micro with the same page as raw text, in a split below the clicked pane so the text gets the pane's full width, opened read-only.

Copied from `~/Developer/herdr/click-open` on 2026-11-08 into a repo of its own, so both Macs install the same plugin and it can take the Beads-board click handler built under the Factory's Bead fac-qpv.7.2. It is a tool of the Human's own setup, not part of the Factory.
