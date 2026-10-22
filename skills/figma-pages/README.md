# figma-pages

Builds pages from Figma: `/figma-pages <figma-link> <figma-link> …` (one link is fine; 3–5
pages is the sweet spot; more run in waves of five). A link is a Figma section holding a
page's desktop and mobile frames, or a single frame; frames of the same page are grouped into
one.

1. Checks once that the Figma MCP and the site's MCP server are connected, which site to write
   to, and groups the links into pages.
2. Starts one `figma-page-builder` agent per page, in parallel. The agent is pinned to
   **sonnet** (`agents/figma-page-builder.md`) with [`figma-page`](../figma-page/) preloaded:
   it builds the page from existing blocks, runs [`figma-visual-diff`](../figma-visual-diff/)
   and fixes content until only developer defects remain. Agents never change code.
3. Reviews each build on the session's model (opus): the triage and the side-by-side section
   images, then a fix list back to the same agent, two rounds at most.
4. Merges the reports: a table of pages with their correctness and `report.html`, one
   developer task list (the same defect on the same block across pages is one task), what
   needs a decision, and a reminder to run `/cost`: Claude Code prices its own calls per
   model, so the sonnet line is the builders and the opus line is the review.

Measured on wp-theme-charter pages built from scratch, by Claude Code's own `/cost`: nine
pages on sonnet cost $9.90 ($1.10 a page) with the same defects left over as opus, which
cost $31.59 for four of the same pages. With the opus review, three pages cost $5.84
($1.26 a page to build, $0.69 to review). Haiku built the nine for $4.81 (twice the turns)
and missed block settings on a third of them.

## Requirements

Same as [`figma-page`](../figma-page/), plus the `figma-page-builder` agent: installed with
the plugin, or symlinked from `agents/` (see the repo README).
