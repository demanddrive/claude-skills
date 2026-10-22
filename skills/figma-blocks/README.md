# figma-blocks

Codes blocks from Figma: `/figma-blocks <figma-section-link> [mobile section link] [name] …`.

1. Checks once that the Figma MCP, the site's MCP server and a theme checkout are there, and
   whether an existing block already covers each section.
2. Starts one `figma-block-builder` agent per block, one at a time (they share the theme's
   build). The agent is pinned to **sonnet** (`agents/figma-block-builder.md`) with
   [`figma-block`](../figma-block/) preloaded: it codes the block, shows it on a demo page and
   scores it with [`figma-visual-diff`](../figma-visual-diff/).
3. Reviews each block on the session's model (opus): the code against figma-block's build
   rules and the theme's instructions, plus the triage and side-by-side section images, then
   one fix list back to the agent.
4. Reports per block: files, demo URL, scores, raw values, the manual-review list, and the
   reminder to run `/cost` for the bill per model.

## Requirements

Same as [`figma-block`](../figma-block/), plus the `figma-block-builder` agent: installed
with the plugin, or symlinked from `agents/` (see the repo README).
