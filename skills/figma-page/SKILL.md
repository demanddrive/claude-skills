---
name: figma-page
description: "Build a WordPress page from a Figma design out of the site's existing blocks, through the site's MCP server, then diff it against the design and fix its content. Use when asked to build, implement or post a page from a Figma URL."
argument-hint: "<figma-section-url | figma-frame-url [frame url per breakpoint]> [page title]"
---

# figma-page

A page build is **content work**: blocks, their settings, copy and images. A **developer
defect** is one no setting or content of its block can fix; it needs code (theme CSS, block
PHP and JS, a new block), which is a separate task the figma-visual-diff report already
explains. Every other defect is yours to fix, whatever kind or owner the diff gives it.

The site's MCP server validates every write against the blocks registered on that site. Its
schema and its error messages are the contract for what a block accepts.

## Requirements

- **Figma MCP** (`get_metadata`, `get_design_context`, `get_screenshot`, `use_figma`). If
  missing: `claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`,
  then `/mcp`.
- **The site's MCP server**: tools ending in `mcps-post-blocks`, `mcps-media-import`,
  `mcps-post-search`. If missing, the site needs the mcp-server plugin and a connection:
  `claude mcp add --transport http <name> https://<site>/wp-json/mcp/mcp`, then `/mcp`. If
  several sites are connected, confirm which one before writing.
- **figma-visual-diff** for the check.

## 1. Read the design

Resolve the links to **breakpoint frames** with `get_metadata`:

- A Figma section node (`<section>`) groups a page's breakpoints: each frame directly inside
  it is one (`Homepage - Desktop`, `Homepage - Mobile`). Its notes are design notes to read;
  its header is a label.
- A frame link is exactly that breakpoint. Several frame links are the same page at several
  breakpoints.

Each breakpoint's width is its viewport. Build from the widest; every breakpoint gets diffed.

`get_metadata` on the widest frame lists its top-level sections; navigation, header and footer
are site chrome. Then `get_design_context` one section at a time (a whole page overflows):
copy, text styles, images.

**Hidden states.** Sliders, tabs, accordions and sticky media splits keep their other states
(slides 2 to N, each step's media) as hidden layers, which `get_design_context` leaves out. In
each such section, list the hidden layers with a `use_figma` script that only reads
(`section.findAll(n => !n.visible)`). A hidden layer is a **proven** state when it is both:

- a state: a sibling of a visible item with the same structure (layer types and size), or a
  named state (a variant like `Slide=2`, a frame named for the state);
- filled: it holds text or an image.

Take each proven state's copy and images from `get_design_context` on its node id, ordered by
its name or its place in the layers panel. A section's items are exactly its visible items and
its proven states. Every other hidden layer, and a proven state that returns no image, goes to
the report with its node id and name; unhiding a layer is the designer's call.

Done when every breakpoint frame is known, every content section has its copy, text styles
and image URLs, and every hidden layer in an interactive section is proven or listed.

## 2. Map sections to blocks

Call `mcps-post-blocks` with `action: "discover"` once: every block the site accepts, its
children, fields, enums and font-size presets. Match each section to one block by name, then
by layout when names differ ("Cover" can be `full-screen-image`). Ask only when two blocks fit
equally well. A section no block fits is a developer task for figma-block: build the rest of
the page without it.

Where a Figma name differs from the block's slug, add the pair to the project's
`.figma-visual-diff.json` (`"sectionMap": { "Cover": "full-screen-image" }`) so the diff pairs
them.

Done when every section has a block or is listed as needing one.

## 3. Fill and write

The server enforces structure; intent is yours:

- **Copy is verbatim**, placeholder lorem included.
- **Text style → preset**: `Title/T2` → `t2`, `Supertext/Large` → `supertext-large`. Heading
  *level* follows the page outline (one `h1`, in the hero), whatever its visual size.
- **Images**: import the design-context asset URLs with `mcps-media-import`, with alt text
  describing each image, and use the returned attachment IDs.
- **Links**: the real site URL when the target is obvious (`/contact/`), otherwise `#`.
- **Dynamic blocks** (post feeds, archives, forms): configure the query or form. Their items
  and fields are site data, reported as they are.

Write with `mcps-post-blocks` `action: "set"`; each returned issue has a path and a code to fix
before resending. The diff loads the page as an anonymous visitor, so publish it on a local
or dev site and ask first on a live one. A page with the same title or slug is replaced only
with the user's go-ahead, updated by `post_id` so its URL and menu links survive. If the server
refuses to replace it, report the refusal; to still have something to check, write
`Figma Preview: <Title>` (slug `figma-preview-<slug>`) and say it replaces nothing yet.

Done when the server accepts the page and it loads at its URL.

## 4. Diff and fix content

Run **figma-visual-diff** for every breakpoint frame. The diff's `owner` is who usually
fixes a defect, not a verdict: for every defect, `layout` and `visual` included, look for a
setting or content change of that block that gives the Figma result, and make it through the
MCP server:

- **Settings**: a block style (`is-style-<name>` in `className`, e.g. `three-columns`), theme,
  alignment, spacing, font-size preset, any field in the block's schema.
- **Content**: the number of items or cards, copy, images, links.

Several defects in one section often share one setting: cards resized, shifted and a doubled
section height are a column count. Fix the cause and re-run. An empty JavaScript-rendered
block is usually the build (a bundle mangled by a cache or minify plugin): check the browser
console and report it.

Done when a run shows only developer defects and `dynamic` sections, each developer defect
with the setting you ruled out.

## 5. Report

- Page title, URL and each breakpoint's `correctness`, with the paths of its `triage.json` and
  `report.html`.
- The section → block table.
- Developer tasks: each developer defect as `id`, block slug, `summary` and why no setting
  fixes it, plus sections needing a new block.
- Interactive sections: each block's item count and the node id behind every item, e.g.
  `image-slider: 4 — 12:301 (visible), 12:302, 12:303, 12:304 (hidden)`. The diff sees only a
  slider's first slide, so these ids are the check on the rest.
- Needs a decision: refused replacements, site data (item counts, form setup), design
  differences between breakpoints, hidden layers that aren't proven states.
