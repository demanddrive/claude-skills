# redirect-sheet-creator

Builds a **301 redirect sheet** that maps every URL on a current/production website onto a
new or staging version of that site — so nothing 404s when the new site launches.

Use it for any website migration, relaunch, or replatform. Trigger phrases include "build
a redirect sheet", "301 map", "make sure our old URLs don't break on staging", or even
indirect ones like "compare the old sitemap to the new one and point every page
somewhere sensible."

## What it produces

An Excel workbook (`.xlsx`) plus a flat, import-ready CSV. The workbook has five sheets:

- **1 to 1 Redirects** — the working/reasoning sheet: every production URL with its match
  method (`exact`, `renamed`, `parent-fallback`, `gone`, or `unchanged`) and live formulas
  that build the destination from an editable target base URL in cell `F1`.
- **Export** — the clean list you actually import: `Source Path` → destination URL (or
  `410 Gone`). Unchanged same-path URLs are excluded so you never import a self-loop.
- **Pattern Redirects** — prefix rules that are *provably* safe, if any.
- **Review** — rows needing a human eye, tiered into **Needs Judgment** (slug-changed
  renames, fallbacks, 410s) and **High Confidence** (same-slug subtree moves), with source
  and destination page titles side by side.
- **Validation** — counts by method plus a redirect loop/chain report.

## How it works

A two-pass workflow that splits deterministic work from judgment:

1. **Pass 1** (`scripts/build_redirect_sheet.py --emit-unmatched`) fetches both sitemaps
   (following sitemap-index files, filtering out assets), exact-matches paths, and writes
   the leftovers to `unmatched.json` with fetched page titles.
2. **Semantic step** — Claude resolves the leftovers by *meaning* (renamed pages, or 410
   for genuinely-removed ones), writing decisions to `resolved.json`.
3. **Pass 2** (`--resolved`) folds those in, validates for loops/chains, and writes the
   workbook + CSV.

See [`SKILL.md`](SKILL.md) for the full instructions Claude follows, and
[`docs/PROMPT.md`](docs/PROMPT.md) for the original design brief.

## Running the script directly

```bash
python3 scripts/build_redirect_sheet.py \
  --prod   https://www.example.com \
  --new    https://newsite.example.com \
  --target https://newsite.example.com \
  --out    ./redirects.xlsx \
  --emit-unmatched ./unmatched.json      # pass 1

# ...resolve renames into resolved.json, then:

python3 scripts/build_redirect_sheet.py \
  --prod ... --new ... --target ... --out ./redirects.xlsx \
  --emit-unmatched ./unmatched.json --resolved ./resolved.json   # pass 2
```

You can substitute `--prod-file` / `--new-file` (a URL list or `sitemap.xml`) when a live
sitemap can't be fetched.

**Dependency:** `openpyxl` (`python3 -m pip install openpyxl`). Everything else is stdlib.

## Tests

`evals/evals.json` holds the test prompts. `evals/fixtures/` has an offline prod/new URL
pair with known-correct expected output (renames, a parent fallback, a provably-safe
`/products/*` pattern) so the matching and validation logic can be checked without hitting
a live site.
