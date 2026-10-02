# figma-block

Codes a new block from a Figma section, puts it on a `Block Demo: <name>` page through the
site's MCP server, and scores the build against the section with
[`figma-visual-diff`](../figma-visual-diff/) (single-section mode, `--section`).

The diff measures how closely one filled-in instance matches the design at each breakpoint.
It does **not** check that the block works. Every run ends with a manual-review list:
interactions, editor fields, content states, hover/focus, widths between breakpoints and
accessibility.

The theme's own project instructions (`CLAUDE.md`, scaffolding commands, token rules) decide
how the block is written. The skill supplies the workflow around them.

## Requirements

Same as [`figma-page`](../figma-page/), plus a checkout of the theme to edit.
