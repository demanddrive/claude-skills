# figma-pages

Builds several pages at once: `/figma-pages <figma-link> <figma-link> …` (3–5 pages is the
sweet spot; more run in waves of five). A link is a Figma section holding a page's desktop and
mobile frames, or a single frame; frames of the same page are grouped into one.

1. Checks once that the Figma MCP and the site's MCP server are connected, which site to write
   to, and groups the links into pages.
2. Starts one agent per page, in parallel. Each runs [`figma-page`](../figma-page/): builds
   the page from existing blocks, runs [`figma-visual-diff`](../figma-visual-diff/) and fixes
   content until only developer defects remain. Agents never change code.
3. Merges the reports: a table of pages with their correctness and `report.html`, one
   developer task list (the same defect on the same block across pages is one task), and
   what needs a decision.

It's user-invoked only (`disable-model-invocation`), so it costs no context until you call it.

## Requirements

Same as [`figma-page`](../figma-page/).
