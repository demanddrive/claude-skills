# redirect-sheet-creator

Builds a **301 redirect sheet** that maps every URL on a current/production website onto a
new or staging version of that site — so nothing 404s when the new site launches.

Use it for any website migration, relaunch, or replatform. Trigger phrases include "build
a redirect sheet", "301 map", "make sure our old URLs don't break on staging", or even
indirect ones like "compare the old sitemap to the new one and point every page
somewhere sensible."

## What it produces

A single Excel workbook (`.xlsx`) with two sheets:

- **Redirects** — the whole map in one editable place: `Source Path`,
  `Destination URL / Status`, `Import?`, `Review`, `Match Method`, `Source Title`,
  `Destination Title`, `Notes`. Filter to `Import? = yes` for the list to import; `no` rows
  are pages that didn't move, kept visible for accounting but excluded so you never import
  a self-loop. `Review` tiers the rows needing a human eye — `NEEDS JUDGMENT` (changed slug,
  fallbacks, 410s) or `HIGH CONFIDENCE` (same-slug subtree moves) — and they're sorted to
  the top, with titles and notes on the same row. Plain resolved values, no formulas.

  **Optional pattern suggestions** sit below the rows: subtree *moves* only
  (`/featured-industries/* → /industry/*`), with both wildcard and pasteable regex forms
  (`^/featured-industries/(.*)$ → /industry/$1`). Advisory — importing a pattern *and* the
  1:1 rows it covers would install duplicate rules. A subtree that maps to itself needs no
  rule, so no identity patterns are emitted.
- **Validation** — counts by method (including both review tiers) plus a redirect
  loop/chain report.

## How it works

A two-pass workflow that splits deterministic work from judgment:

0. **Ask about vanity URLs** — sitemaps never list hand-made shortlinks (`/promo`, QR and
   print campaign URLs, existing redirect-plugin rules), so Claude just asks in
   conversation, takes whatever you paste back in any format, and merges them in. Nothing
   else can discover them.
1. **Pass 1** (`scripts/build_redirect_sheet.py --emit-unmatched`) fetches both sitemaps
   (following sitemap-index files, filtering out assets), exact-matches paths, and writes
   the leftovers to `unmatched.json` with fetched page titles.
2. **Semantic step** — Claude resolves the leftovers by *meaning* (renamed pages, or 410
   for genuinely-removed ones), writing decisions to `resolved.json`.
3. **Pass 2** (`--resolved`) folds those in, validates for loops/chains, and writes the
   workbook.

See [`SKILL.md`](SKILL.md) for the full instructions Claude follows, and
[`docs/PROMPT.md`](docs/PROMPT.md) for the original design brief.

## Running the script directly

```bash
python3 scripts/build_redirect_sheet.py \
  --prod   https://www.example.com \
  --new    https://newsite.example.com \
  --target https://newsite.example.com \
  --out    ./redirects.xlsx \
  --emit-unmatched ./unmatched.json \
  --vanity /promo /webinar               # pass 1; --vanity optional

# ...resolve renames into resolved.json, then:

python3 scripts/build_redirect_sheet.py \
  --prod ... --new ... --target ... --out ./redirects.xlsx \
  --emit-unmatched ./unmatched.json --resolved ./resolved.json \
  --vanity /promo /webinar                                       # pass 2
```

Vanity/campaign URLs (absent from every sitemap) go in via `--vanity` inline, or
`--vanity-file` for a long list. Pass them on **both** passes — pass 2 rebuilds the map from
the sitemaps, so omitting them there silently drops them from the final sheet.

You can substitute `--prod-file` / `--new-file` (a URL list or `sitemap.xml`) when a live
sitemap can't be fetched.

**Dependency:** `openpyxl` (`python3 -m pip install openpyxl`). Everything else is stdlib.

## Tests

```bash
./tests/test.sh     # exits nonzero on regression
```

40 assertions run both passes against offline fixtures in `tests/fixtures/` — no network,
no live sites. They cover the guarantees that matter: unchanged rows are marked
`Import? = no`, review tiers land on the right rows and sort to the top, renames and the
nearest-section fallback resolve correctly, 410s are suggested instead of homepage dumps,
only genuine subtree moves become patterns (never
identity no-ops, never a prefix with a non-conforming URL under it), vanity URLs dedupe
across forms, invented destinations are rejected, and `validate()` catches loops and chains.

Each check is mutation-tested — deliberately breaking a guard in the script makes the
corresponding assertion fail, so a passing run means something.
