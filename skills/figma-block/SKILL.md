---
name: figma-block
description: "Code a new block (e.g. an ACF block in a WordPress theme) from a Figma section or component, put it on a demo page through the site's MCP server, and measure how closely it matches the design with figma-visual-diff. Use when a Figma section has no matching block, or when asked to build a block from Figma. The diff checks visual accuracy only; the block's behaviour still needs a person's review."
argument-hint: "<figma-section-url> [mobile section url] [block name]"
---

# figma-block

Build the block, show it on a demo page, and let figma-visual-diff score how close the
build is. The diff measures the **look** of one filled-in instance at each Figma breakpoint.
It says nothing about whether the block **works**. Every report from this skill ends with
the manual-review list in step 7.

## Requirements

Same as **figma-page**: the Figma MCP, the site's MCP server (`…mcps-post-blocks`,
`…mcps-media-import`) and figma-visual-diff. Work inside the theme's repository. Its project
instructions (`CLAUDE.md` and similar) define how blocks are built there, and they take
precedence over anything general here.

## 1. Make sure it's needed

Call `mcps-post-blocks` with `action: "discover"`. If an existing block covers the section,
possibly with a field or style variation, say so and ask before creating a new one. Extending
a block is usually better than adding a near-duplicate.

## 2. Read the design

- `get_design_context` on the section node, once per breakpoint (desktop and mobile frames).
- `get_variable_defs` for the tokens it uses. Map every Figma variable to the theme's own
  tokens (spacing, colours, type styles). Use a raw value only when the theme has no token
  for it, and list those in the report.
- Decide what an editor must be able to change (copy, images, links, repeated items) and
  what is fixed design. Model it the way the theme's most similar existing block does. Read
  that block first.

## 3. Build it

Scaffold with the project's generator if it has one (e.g. `npm run block-add`), then write
the markup, fields, styles and any script, following that similar block. Build and lint with
the project's commands. If the site runs a cache or minify plugin, make a production build
too; development bundles often break under minification.

## 4. Confirm the site sees it

Run `discover` again. The schema is generated from the registered blocks, so the new block
and its fields must appear with the types you intended. If they don't, the block isn't
registered or its field group isn't synced. A block that takes inner blocks must declare which
ones (e.g. `allowed_blocks` in an ACF block's `block.json`); without that the schema treats it
as a leaf. Fix any of these before building the demo page.

## 5. Demo page

Create or update a page titled `Block Demo: <Block Title>` that holds only the new block,
filled with the Figma copy and imported images (`mcps-media-import`). Publish it: the diff
loads the page anonymously, so use a dev site for this. On later runs, find the page with
`mcps-post-search` and update it by `post_id`.

## 6. Diff and iterate

Run **figma-visual-diff** on the demo page against the *section* node, once per breakpoint,
in single-section mode. Pass `--section` to `config.js figma-boxes <node-id>`, or to
`triage.js` when fetching with `FIGMA_TOKEN`. Use `sectionMap` in `.figma-visual-diff.json` if
the Figma name doesn't match the block's slug.

Unlike on a page build, **`layout` findings are yours here**: you wrote the styles. Fix
padding, spacing and sizes in the stylesheet (never by adding content) and re-run until the
section passes or what remains has a reason (font rendering, placeholder photos).

## 7. Report

- Files added or changed, the demo page URL, and the final wireframe and pixel scores for
  each breakpoint, with the triage verdict.
- Raw values used where the theme had no token.
- **Manual review needed.** The diff can't check these, so list them for a person:
  - Behaviour: sliders, tabs, accordions, video, forms, anything interactive.
  - The editor: field labels and order, InnerBlocks rules, block preview.
  - Content states: empty or optional fields, long copy, many or few items.
  - Hover and focus states.
  - Widths between the Figma breakpoints.
  - Accessibility: keyboard use, focus order, contrast, semantic markup.

State it plainly, e.g. "Visual match: 1440 px passes (wire 91%, px 84%), 375 px passes;
functionality not verified."
