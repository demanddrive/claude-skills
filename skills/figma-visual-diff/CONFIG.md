# figma-visual-diff project config and flags

Back to the steps: [`SKILL.md`](SKILL.md).

## `.figma-visual-diff.json`

The defaults suit themes that give each top-level block a `block-{slug}` class, then fall back
to `wp-block-acf-{slug}` / `wp-block-{slug}`, then to the content area's children. A project
whose sections pair by position, or whose names don't line up, gets a `.figma-visual-diff.json`
at its root. Every key is optional:

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
- `mask` sections are checked for presence only (verdict `dynamic`).
- `live` sections (post feeds) show real posts, so only their template is compared: images,
  icons, surfaces without text, the spacing around them and the space to the section's edges.
  Text, anything sized by it (cards, tag pills, buttons), how many there are and the section
  height follow the posts.

## Flags

- `--viewport-height` (default 900): sections sized with `vh` render taller or shorter with it.
- `--config <file>` points at a config other than the nearest `.figma-visual-diff.json`.
- `--no-jev` skips the Jev diagnosis; `--jev-model <id>` pins another Jev model (e.g.
  `jev-1.13` on Zen).
- `triage.js --keep <n>` deletes all but the newest `n` runs for that page and breakpoint (each
  run is ~5 MB, mostly pixel images). Without it every run is kept.
- `triage.js` thresholds: `--wireframe-threshold 0.85`, `--pixel-threshold 0.7` (well-built
  sections score 75–88% on pixels because of font rendering).
- The two diffs also run alone: `wireframe-diff.js` (`--figma`) and `pixel-diff.js` (`--figma`
  plus `--figma-png`), with the same `--url`, `--width`, `--out` flags. Triage lines each pixel
  comparison up row by row at the elements the wireframe diff matched; run alone,
  `pixel-diff.js` lines sections up at their tops unless given `--align <wireframe report.json>`.
