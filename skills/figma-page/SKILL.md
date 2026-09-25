---
name: figma-page
description: "Build a WordPress page from a Figma frame using the site's existing blocks, written through the site's MCP server (demanddrive/mcp-server), then check it against the design with figma-visual-diff. Use when asked to build, implement or post a page from a Figma URL. If a section has no matching block, build that block first with figma-block."
argument-hint: "<figma-frame-url> [more frame urls, one per breakpoint] [page title]"
---

# figma-page

Turn a Figma page frame into a page made of blocks the site already has, then measure how
close it came. The site's MCP server validates every write against the blocks actually
registered on that site, so its schema and its error messages decide what's valid. Don't
guess a block's fields from memory or from another theme.

## Requirements

- **Figma MCP** (`get_metadata`, `get_design_context`, `get_screenshot`, `use_figma`).
  If it's missing: `claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`, then `/mcp`.
- **The site's MCP server**: tools named `…mcps-post-blocks`, `…mcps-media-import`,
  `…mcps-post-search`. If they're missing, the site needs the mcp-server plugin and a
  connection: `claude mcp add --transport http <name> https://<site>/wp-json/mcp/mcp`, then
  `/mcp` to authorize. If several sites are connected, confirm which one before writing.
- **figma-visual-diff** (in this plugin) for the check at the end.

## 1. Read the design

- `get_metadata` on the frame lists its top-level sections. Navigation, header and footer
  are site chrome, not page content.
- `get_design_context` one section at a time (a whole page usually overflows). Take copy,
  text styles, images and visible layers from it. Hidden layers aren't content.

## 2. Read the site's blocks

Call `mcps-post-blocks` with `action: "discover"` once. It lists every block the site accepts:
names, allowed children, field names and enums, preset font sizes, which top-level blocks a
post type allows. That schema is the contract.

## 3. Map sections to blocks

Match each Figma section to one block by name first. Figma component names usually mirror
block titles, but not always ("Cover" can be `full-screen-image`). If names don't settle it,
match by layout. Show the user the mapping as a short table and go ahead. Ask only when two
blocks fit equally well or none fits. When none fits, that section needs **figma-block**.

When a Figma name differs from the block's slug, add it to the project's
`.figma-visual-diff.json` (`"sectionMap": { "Cover": "full-screen-image" }`) so the diff
pairs them.

## 4. Fill the blocks

The server enforces structure: allowed children, field types, markup of text blocks. It
can't know intent, so these are yours:

- **Copy is verbatim**, placeholder lorem included.
- **Text style → preset.** Figma's text style name maps to the schema's `fontSize` enum
  (`Title/T2` → `t2`, `Supertext/Large` → `supertext-large`). Heading *level* follows the page
  outline (one `h1`, in the hero), independent of its visual size.
- **Images:** import the design-context asset URLs with `mcps-media-import` (give them alt
  text that describes the image) and use the returned attachment IDs.
- **Links:** real site URLs when the target is obvious (`/contact/`), otherwise `#`.
- **Dynamic blocks** (post feeds, archives, forms): configure the query or form. Don't
  rebuild the mocked cards as static content. A different item count or form fields is site
  data; report it, don't fake it.

## 5. Write the page

`mcps-post-blocks` with `action: "set"`. If it returns issues, each one has a path and a code.
Fix those and resend.

- The diff loads the page as an anonymous visitor, so it must be viewable. On a local or dev
  site, publish. On a live site, ask first.
- If a page with that title or slug exists, ask before replacing it (unless the user already
  said to). Updating it by `post_id` keeps its URL and menu links. Deleting it doesn't.
- If the server refuses to replace it (e.g. the old page holds settings the schema can't
  carry over), don't publish a second page under the same title. Report the refusal and its
  reason. If you still need something to check, write a clearly named preview page
  (`Figma Preview: <Title>`, slug `figma-preview-<slug>`) and say it replaces nothing yet.

## 6. Check it

Run **figma-visual-diff** for every breakpoint frame the user gave. Fix page-side findings
(`structure`, `content`, `alignment`, page-setting `visual`) and re-run. Stop when only `layout`,
`dynamic` and developer-side `visual` findings remain.

If a JavaScript-rendered block is empty on the page, check the browser console before
touching content. It's usually the build (a development bundle mangled by a cache or minify
plugin), not the page.

## 7. Report

The page URL, the section → block table, and the remaining findings grouped by who fixes
them: page data (item counts, form setup), developer (padding, spacing, styles), design
differences between breakpoints.
