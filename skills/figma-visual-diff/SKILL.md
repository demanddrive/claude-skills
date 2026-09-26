---
name: figma-visual-diff
description: "Diff a built web page against its Figma frame, per breakpoint, and triage every section's defects (structure, content, alignment, layout, visual) with who fixes each. Use after building a page or block from Figma, or when asked to QA, verify or compare a page with its design."
argument-hint: "<page-url> <figma-frame-url> [more frame urls, one per breakpoint]"
---

# figma-visual-diff

Scripts do the comparing, so the verdicts are the same every run: `triage.json` is the source
of truth for what differs, read instead of screenshots.

`<skill-dir>` below is this skill's base directory (shown when the skill loads). Run the
scripts by that absolute path **from the project's directory**: the directory's name groups
the project's runs.

Read [`SETUP.md`](SETUP.md) when a script can't find `playwright` or Chromium, the Figma MCP
is missing, or triage says no Jev key is set. Read [`CONFIG.md`](CONFIG.md) when a run warns
that sections were paired by position, section names don't line up, a section shows live
posts, or you need a flag. Read [`DEFECTS.md`](DEFECTS.md) to judge a defect: what it
compares, what's left out, Jev's `matters`, the metrics and `report.html`.

## 1. Figma inputs

Run each breakpoint frame: a frame link is one, and a Figma section node's frames are one each
(its notes and header aren't; check with `get_metadata`). The viewport width is the frame's
width. Parse `fileKey` and `nodeId` from the URL (`node-id=16233-18647` → `16233:18647`).

With `FIGMA_TOKEN` set (a read-only personal access token), pass `--file-key <key> --node-id
<id>` to triage instead: it fetches the frame through the REST API on the first run
(`--refresh-figma` after a design change, `--section` for a single block). Otherwise:

1. Print the extractor for this project and frame (`--section` for a single block's node):

   ```bash
   node <skill-dir>/scripts/config.js figma-boxes <node-id>
   ```

   Load the figma-use guidance the Figma MCP requires, run the printed code through
   `use_figma` unchanged (it is read-only), and save the returned string **verbatim** to a
   temp file, e.g. `/tmp/figma-boxes-<width>.txt`: exactly as returned, however long.
2. `get_screenshot` with `maxDimension` set to the frame height (the `F|width|height` line)
   rounded up. Keep the returned image URL.

Done when the boxes file is saved and you have the screenshot URL (or `FIGMA_TOKEN` is set).

## 2. Triage

```bash
node <skill-dir>/scripts/triage.js --url <page-url> --width <frame-width> \
  --figma /tmp/figma-boxes-<width>.txt --figma-png-url '<screenshot-url>' \
  --runs-root ${CLAUDE_PLUGIN_DATA}/runs
```

Exit 0: every section is ok or dynamic. 1: there are defects. 2: an error. Triage stores the
Figma inputs and a dated folder per run (with `latest`) in the plugin's data, and prints where
it wrote `triage.json` and `report.html` and what changed since the previous run; pass inputs
from anywhere and let it store them. Re-runs for the same page and width reuse the stored
inputs, so drop `--figma` and `--figma-png-url` unless the design changed. The screenshot URL
is short-lived: take a new one if the download fails.

Done when triage exits 0 or 1.

## 3. Fix what you own

| kind | issues | owner | fix |
|---|---|---|---|
| `structure` | `missing`, `extra` | page | add, remove or reorder blocks |
| `content` | `missing`, `extra`, `copy` | page | match Figma's elements, copy verbatim |
| `alignment` | `shifted`, `content-shifted` | page | the block's or element's alignment setting |
| `layout` | `height`, `resized`, `aspect`, `spacing`, `overlap` | developer | a block setting (a column style, spacing) if one gives it, else styles |
| `visual` | `style`, `pixels` | page-or-developer | theme, colour and size settings; if right, styles |

`owner` is who usually fixes a defect. A defect any block setting or content change fixes is
the page's, whatever its kind; only what needs code is the developer's. A page build owns the
page's defects; a block build also owns the code. Work through yours in
order of `matters` when Jev ran, then re-run triage for that breakpoint. Open an overlay image
(`wireframe/` or `pixel/` in the run folder) only for a section you are fixing. Breakpoints can
legitimately disagree (a mobile frame may drop a section): report that as a design
difference.

Done when a run shows only defects you don't own and `dynamic` sections.

## 4. Report

Per breakpoint: the final `metrics` (`correctness` and its change), every remaining defect by
`id` and `summary` per section, and the paths of `triage.json` and, when Jev ran,
`report.html`.
