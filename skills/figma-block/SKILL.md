---
name: figma-block
description: "Code a new block from a Figma section, show it on a demo page through the site's MCP server, and score its look with figma-visual-diff. Use when a Figma section has no matching block, or when asked to build a block from Figma."
argument-hint: "<figma-section-url> [mobile section url] [block name]"
---

# figma-block

This is the developer side of a Figma build: you write the block's code and styles. The diff
scores the **look** of one filled-in instance at each breakpoint; whether the block **works**
is for a person, so every report ends with the manual-review list in step 6.

Requirements are figma-page's (Figma MCP, the site's MCP server, figma-visual-diff), plus a
checkout of the theme. The theme's project instructions (`CLAUDE.md` and similar) decide how
blocks are built there and outrank anything general here.

## 1. Confirm it's needed

`mcps-post-blocks` `action: "discover"` lists the site's blocks. If one covers the section,
perhaps with a field or style variation, ask before creating another: extending a block beats
a near-duplicate.

Done when the user has agreed a new block is needed, or no existing block fits.

## 2. Read the design

- `get_design_context` on the section node, once per breakpoint frame.
- `get_variable_defs` for its tokens. Map each Figma variable to the theme's own token
  (spacing, colour, type style); a raw value is for a variable the theme has no token for,
  and goes in the report.
- Read the theme's most similar block and model the fields on it: what an editor changes
  (copy, images, links, repeated items) versus fixed design.

Done when every Figma variable has a theme token or is listed as raw.

## 3. Build

Scaffold with the project's generator if it has one (e.g. `npm run block-add`), then write the
markup, fields, styles and script after that similar block. Build and lint with the project's
commands, and make a production build too if the site runs a cache or minify plugin
(development bundles break under minification).

Then `discover` again: the schema comes from the registered blocks, so the block and its
fields must appear with the intended types. A block that takes inner blocks declares which
(e.g. `allowed_blocks` in an ACF block's `block.json`); otherwise the schema treats it as a
leaf.

Done when the build and lint pass and `discover` shows the block with its fields.

## 4. Demo page

A page titled `Block Demo: <Block Title>` holding only the new block, filled with the Figma
copy and images imported with `mcps-media-import`. Publish it on a dev site (the diff loads it
anonymously). On later runs, find it with `mcps-post-search` and update it by `post_id`.

Done when the demo page loads at its URL.

## 5. Diff and fix styles

Run **figma-visual-diff** on the demo page against the *section* node, once per breakpoint, in
single-section mode (`--section`). Here `layout` defects are yours: fix padding, spacing and
sizes in the stylesheet, and re-run.

Done when each breakpoint passes, or every remaining defect has a stated reason (font
rendering, placeholder photos).

## 6. Report

- Files added or changed, the demo page URL, and per breakpoint the wireframe and pixel scores
  and the verdict.
- Raw values used where the theme had no token.
- **Manual review needed**, since the diff can't check these:
  - Behaviour: sliders, tabs, accordions, video, forms, anything interactive.
  - The editor: field labels and order, InnerBlocks rules, block preview.
  - Content states: empty or optional fields, long copy, many or few items.
  - Hover and focus states.
  - Widths between the Figma breakpoints.
  - Accessibility: keyboard use, focus order, contrast, semantic markup.

State it plainly, e.g. "Visual match: 1440 px passes (wire 91%, px 84%), 375 px passes;
functionality not verified."
