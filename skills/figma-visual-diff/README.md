# figma-visual-diff

Compares a built web page against its Figma frame, one breakpoint at a time, and triages every
section by what fixes it:

| finding | means | fixed by |
|---|---|---|
| `structure` | a section is missing, extra or out of order | the page |
| `content` | elements missing or extra, or copy differs | the page |
| `alignment` | an element or section is shifted sideways | the page |
| `layout` | everything's there, but sizes or spacing differ | a developer (styles) |
| `visual` | geometry matches, pixels don't (theme, colour, type) | the page, else a developer |

It runs two comparisons and combines them:

- **Wireframe diff**: both the Figma frame and the rendered page are reduced to typed boxes
  (text, image, icon, surface) per section, then paired by type, text and position. Reports
  missing/extra elements, copy mismatches (via text hashes), offsets and resizes. Images and
  font rendering don't affect it.
- **Pixel diff**: compares the Figma render and a page screenshot section by section, for
  what boxes can't see: colour, theme, type weight.

The model only moves data (runs a read-only extractor in Figma, downloads the render); scripts
do all the comparing, so the verdicts are the same every run. Each run is saved with a
timestamp and reports what changed since the previous one.

## Requirements

- The Figma MCP server available in whatever project you run it from. Add it once at user
  scope so every project has it: `claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`
  (then authenticate with `/mcp`). A server listed only in one repo's `.mcp.json` isn't
  available in other repos.
- Optional: `FIGMA_TOKEN`, a read-only Figma personal access token (Figma → Settings →
  Security). With it, the scripts fetch Figma data themselves (`scripts/figma-rest.js`)
  instead of the model relaying it through the MCP, which is faster and uses no context.
- Node 18+. Dependencies install automatically with the plugin; from a clone, or if Chromium
  is missing, run `node scripts/config.js setup`.

## Other projects

Nothing is specific to one theme. Defaults find sections by `block-{slug}` classes, then
WordPress block classes, then the content area's children. Projects that differ add a
`.figma-visual-diff.json` (see `SKILL.md`).

## Layout

```
SKILL.md           the workflow Claude follows
scripts/
  figma-boxes.js   read-only Figma extractor (run via use_figma)
  figma-rest.js    the same extraction over the REST API, with FIGMA_TOKEN
  config.js        project config, run folders, setup
  wireframe-diff.js, pixel-diff.js, triage.js
tests/             offline tests for pairing, matching and triage (./tests/test.sh)
```
