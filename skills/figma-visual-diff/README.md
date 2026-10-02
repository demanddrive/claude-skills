# figma-visual-diff

Compares a built web page against its Figma frame, one breakpoint at a time, and lists every
defect in every section (module), each with who fixes it:

| kind | means | fixed by |
|---|---|---|
| `structure` | a section is missing, extra or out of order | the page |
| `content` | elements missing or extra, or copy differs | the page |
| `alignment` | an element or section is shifted sideways | the page |
| `layout` | everything's there, but sizes or spacing differ | a developer (styles) |
| `visual` | geometry matches, pixels don't (theme, colour, type) | the page, else a developer |

It runs two comparisons and combines them:

- **Wireframe diff**: both the Figma frame and the rendered page are reduced to typed boxes
  (text, image, icon, surface) per section, then paired by type, text and position. Reports
  missing/extra elements, copy mismatches (via text hashes), offsets and resizes, and
  compares design tokens (typography, colours, radii, borders) read from Figma and from
  computed CSS. Images and font rendering don't affect it.
- **Pixel diff**: compares the Figma render and a page screenshot section by section, for
  what boxes can't see: colour, theme, type weight. Each section is lined up row by row at
  the elements the wireframe diff matched, like a side-by-side text diff: both sections show
  whole, rows only one side has show as gaps, and a page crop never includes a neighbouring
  section.

Each run writes `triage.json`, validated against [`triage.schema.json`](triage.schema.json):
one entry per defect per module with the Figma and page values and who fixes it, and metrics
of how correct the build is (share of sections correct, defects by kind and owner, scores)
with their change since the previous run. The metrics also accumulate in `metrics.jsonl`,
one line per run, to track a build over time.

With a Jev provider key set (`OPENCODE_API_KEY` for the default, [OpenCode Zen](https://opencode.ai/docs/zen/),
where it's free; other providers are configured under `jev`, see [SETUP.md](SETUP.md)),
[Jev](https://docs.typesafe.ai/), a System One model that answers
typed questions with calibrated probabilities, judges from the measurements what rules can't:
which defects a reviewer would ask to fix (`matters`, per defect) and whether they'd accept each
module. Its answers rank the defects, feed `expectedCorrectness` and `expectedFixes`, and
`report.html` lays them out for review next to the defects and overlays, flagging where Jev
and the measurements disagree.

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
`.figma-visual-diff.json` (see [CONFIG.md](CONFIG.md)).

## How it's built

Scripts do all the comparing; the model only moves data. Every run goes through triage:

```
figma-boxes.txt + figma.png ─┐
                             ├─ wireframe-diff.js ─→ wireframe/report.json ─┐
page (loaded in Chromium) ───┤                          │ (sync points)       ├─ triage.js ─→ triage.json
                             └─ pixel-diff.js ─────────→ pixel/report.json ──┘
```

1. **Figma side.** `lib/figma.js` `extractBoxes()` reduces the frame to typed boxes. It is one
   function with two routes: `figma-rest.js` runs it on REST data (with `FIGMA_TOKEN`), and
   `config.js figma-boxes` prints it for the Figma MCP's `use_figma` to run inside Figma.
2. **Page side.** `lib/browser.js` loads the page with caches skipped and settles it (delayed
   scripts, lazy images, sliders); `lib/page.js` runs in the page to find sections and boxes.
3. **Wireframe diff.** `lib/boxes.js` pairs sections by name, then boxes by type, text and
   position, and measures what's missing, extra, reworded, shifted or resized.
4. **Pixel diff.** `lib/align.js` lines each section's rows up at the elements the wireframe
   matched (unique ones first, as patience diff does); `lib/pixels.js` compares the rows
   (refined by ±3px, never leaving the section) and scores the content pixels, counting
   content in rows only one side has against the section.
5. **Triage.** `lib/defects.js` turns each section's differences into defects with an owner;
   `lib/jev.js` asks Jev which defects matter; `lib/metrics.js` measures the build; `triage.js` validates the report against
   `triage.schema.json` and keeps each run in a dated folder.

```
SKILL.md              the workflow Claude follows
SETUP.md              once per machine: Figma MCP, Chromium, Jev key
CONFIG.md             .figma-visual-diff.json and flags
DEFECTS.md            what each defect measures, Jev, metrics, report.html
triage.schema.json    the shape of triage.json
scripts/
  triage.js           runs both diffs, writes triage.json and report.html, keeps run and metrics history
  wireframe-diff.js   compares boxes; writes report.json and red/blue overlays
  pixel-diff.js       compares pixels; writes report.json and Figma | page | diff images
  figma-rest.js       fetches a frame with FIGMA_TOKEN
  config.js           project config, runs folder; setup, runs-dir and figma-boxes commands
  deps.js             loads npm dependencies from wherever the plugin is installed
  lib/
    cli.js            argument parsing and console formatting
    figma.js          the Figma extractor, text hashing, figma-boxes.txt parsing
    browser.js        Chromium, page loading and settling
    page.js           code that runs in the page (serialised, so self-contained)
    boxes.js          section pairing, box matching, scoring, padding
    defects.js        one defect per difference: kind, owner, Figma and page values
    jev.js            Jev: which defects matter, and would a reviewer accept each module
    metrics.js        build correctness metrics, their change and history
    report-html.js    report.html, for reviewing Jev's diagnoses
    pixels.js         section crops, alignment, pixel scoring, media masks
    png.js            crop, draw and colour helpers
tests/                offline tests (./tests/test.sh); browser.test.js needs Chromium
```

Two kinds of code are serialised and run elsewhere, so they can't import anything:
`extractBoxes()` (inside Figma) and everything in `lib/page.js` (inside the page). Their tests
run them the same way.
