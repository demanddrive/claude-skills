---
name: redirect-sheet-creator
description: >-
  Build a 301 redirect sheet that maps every URL on a current/production website onto a
  new or staging version of that site, so nothing 404s at launch. Use this whenever the
  user is doing a website migration, relaunch, or replatform and mentions redirects, a
  redirect sheet/map/plan, 301s, matching an old sitemap to a new one, or making sure
  production URLs don't break on a staging site. Trigger it even when they don't say
  "301" — phrases like "map the old site to the new site", "we're relaunching and need to
  point the old pages somewhere", "compare two sitemaps", or "make sure our URLs redirect
  to staging" all mean this skill. Produces an Excel workbook plus a flat source→target
  CSV, and validates in code that there are no redirect loops or chains.
---

# Redirect Sheet Creator

## What this does and why

When a site is relaunched on a new platform (or a staging build becomes the new
production), every URL that currently ranks in Google or is linked from elsewhere must
land somewhere sensible on the new site. Missing even a handful causes 404s, lost SEO,
and broken inbound links. This skill builds the redirect map that prevents that.

The work splits cleanly into two kinds:

- **Deterministic, must-never-be-eyeballed** — fetching sitemaps, normalizing URLs,
  exact-matching paths, detecting redirect loops/chains, building the workbook. A human
  or a model glancing at 800 URLs *will* make mistakes here. So a Python script owns it:
  `scripts/build_redirect_sheet.py`.
- **Judgment** — figuring out that `/about-us` on the old site is the `/company` page on
  the new one (a *renamed* page). Character-matching gets this wrong confidently, which
  is dangerous on a redirect sheet. So the script hands you *only the leftovers* — the
  URLs with no exact match — and you reason about them semantically, using page titles.

Every judgment call lands on a **Review sheet** flagged for a human to confirm. The skill
never silently guesses its way into the authoritative redirect list.

## Before you start — gather these

1. **Production URL** — the current live site (e.g. `https://www.yalecordage.com/`).
2. **New/staging URL** — the new build whose sitemap you'll match against
   (e.g. `https://yalecordage.wpenginepowered.com/`).
3. **Target base URL** — what the redirect destinations should point at. Usually the
   staging URL (redirects are tested on staging before go-live). Ask the user; default to
   the staging URL they gave.

If either sitemap can't be fetched (gated, blocked, incomplete), ask the user for a URL
list or a `sitemap.xml` file and use `--prod-file` / `--new-file` instead.

## Workflow

The script runs in **two passes** with your semantic matching in between.

### Pass 1 — exact match + emit the leftovers

```bash
python scripts/build_redirect_sheet.py \
  --prod   https://www.example.com \
  --new    https://newsite.example.com \
  --target https://newsite.example.com \
  --out    ./redirects.xlsx \
  --emit-unmatched ./unmatched.json
```

This fetches both sitemaps (following sitemap-index files), exact-matches every
production path against the new site (ignoring trailing slashes; query params are
passthrough and don't affect matching), and writes `unmatched.json` — the production URLs
with **no** exact match, plus every new-site path as a candidate. Page `<title>`s are
fetched (in parallel) for both sides so you can judge renames by meaning, and cached in
`unmatched.titles.json`.

If there are **zero** unmatched URLs, skip to Pass 2 directly (no resolution needed).

### Your step — resolve renames semantically

Read `unmatched.json`. For each unmatched source, decide its destination:

- **It's a renamed/moved page** → pick the best new-site path *by meaning*, using the
  slug and title. `/about-us` (title "Our Story") → `/company` (title "About the
  Company"). Prefer a confident semantic match over a superficial string match.
- **The page is genuinely gone** with no good replacement → set `method: "gone"`. It will
  be suggested as an **HTTP 410 Gone** rather than a redirect. This is the right signal
  for intentionally-removed pages (retired products, expired campaigns): it tells Google
  the page is gone on purpose, which is better for SEO than bouncing users to the
  homepage. Prefer `gone` over forcing a weak match.
- **Unsure / no obvious equivalent** → leave `dest_path` empty. The script falls back to
  the nearest existing *section* path (e.g. `/blog/gone-post` → `/blog`); if no section
  above it exists either, it suggests `410 Gone` instead of the homepage. Don't force a
  weak match — the fallback is the safer default and it's flagged for review anyway.

Write your decisions to `resolved.json`:

```json
{
  "/about-us":      {"dest_path": "/company", "method": "renamed", "note": "Our Story page, renamed to Company"},
  "/team-members":  {"dest_path": "/team",    "method": "renamed", "note": "slug changed"},
  "/retired-widget":{"method": "gone",        "note": "product discontinued, no replacement"},
  "/blog/gone":     {"dest_path": "",          "note": "unsure; accept fallback"}
}
```

Only paths that exist in the new-site candidate list are accepted as `renamed`
destinations; anything else falls back (a guard against hallucinated destinations).

**Scaling up:** if the unmatched list is large (say >150 URLs) and subagents are
available, split it into chunks and dispatch a subagent per chunk to produce partial
`resolved.json` files, then merge them. Each subagent only needs its slice of `unmatched`
plus the full `new_site_candidates` list. For typical migrations the list is small enough
to resolve inline.

### Pass 2 — fold decisions in, validate, write the workbook

```bash
python scripts/build_redirect_sheet.py \
  --prod   https://www.example.com \
  --new    https://newsite.example.com \
  --target https://newsite.example.com \
  --out    ./redirects.xlsx \
  --emit-unmatched ./unmatched.json \
  --resolved ./resolved.json
```

Same command as Pass 1 plus `--resolved`. This produces `redirects.xlsx` and a flat
`redirects.export.csv`.

## What the output contains

The workbook has five sheets, mirroring the team's existing template:

- **`1 to 1 Redirects`** — the working/reasoning sheet. Every production URL, its raw
  destination path, and live Excel formulas that strip the domain off the source and
  prepend the target base URL (kept in the editable `F1` cell — change `F1` to swap the
  target domain without re-running). The `Match Method` column says how each row was
  derived: `exact`, `renamed`, `parent-fallback`, or `unchanged (no redirect needed)`.
- **`Export`** — the clean, flat, import-ready list: `Source Path` → full
  `Destination URL`. **This is the file you actually import into the redirect plugin.**
- **`Pattern Redirects`** — prefix rules that are *provably* safe (see below), or empty.
- **`Review`** — the rows that need a human eye, split into two tiers so attention goes
  where it matters: **NEEDS JUDGMENT** (renames whose slug changed, section fallbacks, and
  410s — read these carefully) and **HIGH CONFIDENCE** (same-slug subtree moves like
  `/featured-industries/marine` → `/industry/marine` — a quick sanity check). Source and
  destination **page titles** are shown side by side so confirmation is a glance, not a
  click-through.
- **`Validation`** — counts by method and the loop/chain report.

### The critical rule: unchanged URLs are NOT redirects

If a production path is *identical* to its new-site path (`/about` → `/about`), the page
lives at the same URL on the new site. Writing a redirect rule for it would create a real
self-loop on the server (`/about` → `/about` forever). So these rows are **shown on the
reasoning sheet** (marked `unchanged (no redirect needed)`) but **excluded from the Export
sheet and CSV**. Only genuine moves — renamed, relocated, fallback — become redirect
rules. Tell the user this count explicitly; it's often the majority of URLs and reassures
them that "most pages didn't move."

### Validation: loops and chains

The script walks the redirect graph over the *exported* redirects and flags:

- **Loop** — `A → B → A`. The browser bounces forever.
- **Chain** — `A → B → C`. The browser is redirected twice; each hop loses SEO value and
  slows the page. Chains should be flattened so `A → C` directly.

In a normal prod→new-site migration these are rare (destinations are new-site paths;
sources are prod paths, so they seldom overlap), but the check is a cheap safety net. If
any appear, surface them to the user before they import anything — the Validation sheet
lists each one with its full path.

## Pattern redirects — safe only

Blanket prefix rules (`/blog/* → /articles/*`) are tempting but risky: one URL under the
prefix that *doesn't* follow the pattern gets silently broken. The script therefore emits
a pattern **only when it's provably safe** — i.e. *every* production URL under that prefix
exact-maps to the same suffix under the same prefix, with no exceptions. Those go on the
`Pattern Redirects` sheet as an optional optimization that would replace the individual
1:1 rows they cover. If you want to propose a riskier pattern (e.g. a rename that applies
to a whole subtree), describe it in that sheet's Notes and leave it for the user to
approve — never fold an unproven pattern into the Export automatically.

## Finishing up

1. Report the headline numbers: total prod URLs, how many were unchanged (no redirect),
   how many real redirects, how many were suggested as 410 Gone, how many need review,
   and whether any loops/chains were found.
2. Point the user at the **Review sheet** for the rows needing confirmation and the
   **Export CSV** as the import-ready artifact.
3. Remind them the redirects target the **staging** URL (via `F1`); for go-live they
   either edit `F1` and re-export, or re-run with `--target` set to the production domain.

## Dependencies

`openpyxl` (Excel output). Install with `python3 -m pip install openpyxl` if missing.
Everything else uses the Python standard library.
