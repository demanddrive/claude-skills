---
name: figma-visual-diff
description: "Compare a built web page against its Figma frame, per breakpoint, and triage every section: structure, content, alignment, layout or visual. Combines a wireframe diff (elements, positions, copy) with a pixel diff (colour, theme, type). Works on any site; project conventions live in an optional .figma-visual-diff.json. Use after building a page from Figma, or when asked to QA, verify or diff a page against the design."
argument-hint: "<page-url> <figma-frame-url> [more frame urls, one per breakpoint]"
---

# figma-visual-diff

Scripts do the comparing, so the verdicts are the same every run. Don't judge screenshots
yourself; read the triage report and act on it.

The scripts are in this skill's base directory (Claude Code shows it when the skill loads);
below, `<skill-dir>` is that path. Run them by that absolute path **from the project's
directory**, without `cd`: the project's directory name is what groups its runs.

## Setup (once per machine)

The Figma MCP tools (`use_figma`, `get_screenshot`) must be available. If they aren't, stop
and tell the user to add the server at user scope:
`claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`, then `/mcp`.


If a script can't find `playwright` or reports that no Chromium was found, run:

```bash
node <skill-dir>/scripts/config.js setup
```

It installs the npm dependencies when they're missing (an installed plugin gets them
automatically) and downloads Playwright's Chromium.

## Project conventions

The defaults suit themes that give each top-level block a `block-{slug}` class, then fall
back to `wp-block-acf-{slug}` / `wp-block-{slug}`, then to the content area's children. If
a run warns that sections were paired by position, or names don't line up, add
`.figma-visual-diff.json` at the project root. Every key is optional:

```json
{
  "contentRoot": "main",
  "sectionSelector": null,
  "slugPatterns": ["^block-([a-z0-9-]+)$"],
  "sectionMap": { "Hero Banner": "interior-header" },
  "figmaIgnore": "^(Navigation|Footer|Header)\\b",
  "mask": [],
  "live": ["post-slider"],
  "iconClassPattern": "(^|\\s)icon-"
}
```

- `sectionSelector` names the page sections outright; `slugPatterns` derive a slug from a class.
- `sectionMap` maps a Figma section name (without its `/ Desktop` suffix) to the page slug.
- `figmaIgnore` lists Figma top-level layers that aren't page sections (navigation, overlays).
- `mask` sections are checked for presence only; `live` sections (post feeds) skip the copy check.

## Per breakpoint

Run each breakpoint the user gave a frame for; the viewport width is the frame's width.
Parse `fileKey` and `nodeId` from the Figma URL (`node-id=16233-18647` → `16233:18647`).
Get this page and breakpoint's folder (it lives in the plugin's persistent data, grouped by
project, and survives plugin updates):

```bash
node <skill-dir>/scripts/config.js runs-dir <page-url> <frame-width> ${CLAUDE_PLUGIN_DATA}/runs
```

It prints the folder; use that path wherever `$OUT` appears below.

The Figma files go there once; each triage run writes a dated subfolder
(`2026-09-25_014512/`) so every iteration is kept, `latest` links to the newest, and triage
prints what changed since the previous run.

**If `FIGMA_TOKEN` is set** (a read-only Figma personal access token), skip steps 1–2: pass
`--file-key <key> --node-id <id>` to triage instead of `--figma`/`--figma-png`, and it fetches
the frame itself through the Figma REST API on the first run (`--refresh-figma` re-fetches
after the design changes). Otherwise use the Figma MCP:

1. **Figma boxes.** Print the extractor for this project and frame:

   ```bash
   node <skill-dir>/scripts/config.js figma-boxes <node-id>
   ```

   Load the figma-use guidance the Figma MCP requires, run the printed code through
   `use_figma` unchanged (it is read-only), and save the returned string **verbatim** to
   `$OUT/figma-boxes.txt`.
2. **Frame render.** Call `get_screenshot` with `maxDimension` set to the frame height (the
   `F|width|height` line) rounded up, then download it to `$OUT/figma.png` with the returned curl.
3. **Triage.**

   ```bash
   node <skill-dir>/scripts/triage.js --url <page-url> --width <frame-width> \
     --figma $OUT/figma-boxes.txt --figma-png $OUT/figma.png --runs-root ${CLAUDE_PLUGIN_DATA}/runs
   ```

   Exit 0 means every section is ok or dynamic; 1 means there is work; 2 is an error.

## Acting on `$OUT/latest/triage.json`

Each section has a headline `verdict` and a `findings` list; act on every finding.

| finding | meaning | who fixes it |
|---|---|---|
| `structure` | section missing, extra or out of Figma's order | you: add, remove or reorder blocks |
| `content` | elements missing or extra, or copy differs from Figma | you: match Figma's elements and copy it verbatim |
| `alignment` | an element or the whole section shifted sideways | you: the block's or element's alignment setting |
| `layout` | everything present, sizes or spacing differ | developer: styles; report it, don't fake it with content |
| `visual` | geometry matches, pixels don't | you: theme/colour/size settings; if right, developer |
| `dynamic` | section in `mask`, only presence checked | nobody |

Findings name overlay images. Open only the images of sections you are fixing.

- `wireframe/<n>-<slug>.png`: Figma boxes red, page boxes blue; thick boxes are unmatched.
  Padding bands are tinted the same way (purple where both agree), and a line in each colour
  marks that side's section bottom. Padding values and deltas are in the wireframe report
  under `padding`; a side off by more than the tolerance becomes a `layout` finding.
- `pixel/<n>-<slug>.png`: Figma | page | diff. Magenta areas are images present on both
  sides, masked so placeholder photos don't count as differences.

Fix page-side findings, then re-run triage for that breakpoint. Stop when only `layout`,
`dynamic` and developer-side `visual` findings remain, and report those with their `why`.
Different breakpoints can legitimately disagree (a mobile frame may drop a section); report
those as design differences rather than forcing one breakpoint to match the other.

Sliders are compared too: before measuring, the scripts interact once (so scripts delayed
until interaction, e.g. by caching plugins, run), stop autoplay and park Swiper sliders on
their first real slide.

## Tuning

- `--viewport-height` (default 900): sections sized with `vh` render taller or shorter with it.
- `--config <file>` points at a config other than the nearest `.figma-visual-diff.json`.
- `triage.js --keep <n>` deletes all but the newest `n` runs for that page and breakpoint
  (each run is ~5 MB, mostly pixel images). Without it every run is kept.
- `triage.js` thresholds: `--wireframe-threshold 0.85`, `--pixel-threshold 0.7` (well-built
  sections score 75–88% on pixels because of font rendering).
- The two diffs also run alone: `wireframe-diff.js` (`--figma`) and `pixel-diff.js`
  (`--figma` plus `--figma-png`), with the same `--url`, `--width`, `--out` flags.
