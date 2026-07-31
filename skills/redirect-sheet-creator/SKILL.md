---
name: redirect-sheet-creator
description: Build a 301 redirect sheet that maps every URL on a current/production website onto a new or staging version of that site
disable-model-invocation: true
---

# Redirect Sheet Creator

`scripts/build_redirect_sheet.py` owns everything deterministic — fetching sitemaps,
normalizing URLs, exact-matching, the safety rules, loop/chain validation, the workbook.
It runs in two passes and hands you the **leftovers**: the production URLs with no exact
match. Those are the only rows needing judgment, and they're your job.

You supply two things the script cannot:

1. **Vanity URLs** — ask the user; no crawl finds them.
2. **Semantic renames** — `/about-us` is the new `/company`. The script refuses to guess
   this, because character similarity is confidently wrong exactly here.

## Gather these

1. **Production URL** — the current live site.
2. **New/staging URL** — the new build to match against.
3. **Target base URL** — what destinations point at. Ask; default to the staging URL.

If a sitemap can't be fetched (gated, blocked, incomplete), ask for a URL list or
`sitemap.xml` file and use `--prod-file` / `--new-file`.

## Always ask about vanity URLs

A sitemap only lists pages the CMS knows about, never the hand-made shortlinks printed on
business cards, trade-show banners, and QR codes — where a 404 is most expensive and
slowest to discover. The user is the only source. **Ask before Pass 1:**

> Are there any vanity or campaign redirects I should worry about? These never show up in
> a sitemap, so I can't find them on my own — things like `/promo`, `/webinar`, `/qr`,
> print or email shortlinks, or redirects someone added by hand in your redirect plugin
> or server config. Paste whatever you've got and I'll fold them in.

Take whatever form the answer arrives in — inline paths, full URLs, a messy pasted list,
an exported plugin CSV, or "none." Normalization and dedup are handled, including
scheme-less input like `www.example.com/promo`. **You** turn the answer into arguments:
a handful go inline (`--vanity /promo /webinar`); a long list you write to a file yourself
and pass `--vanity-file ./vanity.txt`. Don't make the user create that file.

Nudge them to check the existing redirect plugin / `.htaccess` / server rules — redirects
already in place are the most commonly forgotten source and break silently at launch. If
they say there are none, note that in your summary so it's on the record.

## Pass 1 — exact match, emit leftovers

```bash
python3 scripts/build_redirect_sheet.py \
  --prod   https://www.example.com \
  --new    https://newsite.example.com \
  --target https://newsite.example.com \
  --out    ./redirects.xlsx \
  --emit-unmatched ./unmatched.json \
  --vanity /promo /webinar            # omit if none
```

Writes `unmatched.json`: the unmatched production URLs plus every new-site path as a
candidate, with page titles fetched for both sides. If there are **zero** unmatched URLs,
go straight to Pass 2.

## Your step — resolve renames by meaning

Read `unmatched.json`. For each unmatched source:

- **Renamed/moved page** → pick the best new-site path *by meaning*, using slug and title.
  `/about-us` ("Our Story") → `/company` ("About the Company").
- **Genuinely gone**, no replacement → `method: "gone"`. Becomes an **HTTP 410**, which
  tells Google the page was removed on purpose — better for SEO than bouncing users to the
  homepage. Prefer this over forcing a weak match.
- **Unsure** → leave `dest_path` empty and accept the fallback (nearest existing section,
  else 410).

Write `resolved.json`:

```json
{
  "/about-us":      {"dest_path": "/company", "method": "renamed", "note": "Our Story page, renamed to Company"},
  "/team-members":  {"dest_path": "/team",    "method": "renamed", "note": "slug changed"},
  "/retired-widget":{"method": "gone",        "note": "product discontinued, no replacement"},
  "/blog/gone":     {"dest_path": "",         "note": "unsure; accept fallback"}
}
```

Destinations must exist in the new-site candidate list; anything invented is rejected and
falls back. **Scaling up:** if the list is large (>150) and subagents are available, split
it into chunks, dispatch one per chunk, and merge the partial `resolved.json` files. Each
subagent needs only its slice plus the full `new_site_candidates` list.

## Pass 2 — fold in, validate, write

Same command plus `--resolved ./resolved.json`. **Keep the vanity flags on both passes** —
Pass 2 rebuilds the map from the sitemaps rather than reading Pass 1's output, so dropping
them here silently omits every vanity URL, and nothing downstream would flag it.

Produces `redirects.xlsx`, the single deliverable. Two sheets:

- **`Redirects`** — the whole map, one row per production URL, everything editable in one
  place. Two columns carry the weight:
  - **`Import?`** — `yes` rows are the redirect rules. `no` rows are pages that didn't move
    (source == destination), shown so every URL is visibly accounted for but excluded
    because importing one would be a server self-loop.
  - **`Review`** — `NEEDS JUDGMENT` (changed slug, section fallbacks, 410s) or
    `HIGH CONFIDENCE` (same-slug subtree moves), blank when no review is needed. Rows are
    sorted so judgment rows sit at the top. `Source Title`, `Destination Title`, and
    `Notes` sit on the same row, so confirming a call and fixing it happen in one spot.

  Optional **pattern suggestions** sit below the rows under their own heading — advisory
  only, with both wildcard and regex forms. Don't import a pattern *and* the 1:1 rows it
  covers; that installs duplicate rules.
- **`Validation`** — counts (including the two review tiers) plus the loop/chain report.

A pattern is only ever suggested for a subtree that **moved** (`/featured-industries/*` →
`/industry/*`). A subtree mapping to itself needs no rule, so no identity patterns appear.

## Report back

State the headline numbers: total prod URLs, vanity URLs added by hand, how many were
**unchanged** (no redirect needed — often the majority, and worth saying plainly since it
reassures them most pages didn't move), real redirects, 410s, rows needing review, and any
loops/chains.

Tell them to work the top of the **Redirects sheet** first — the `NEEDS JUDGMENT` rows are
sorted there — and to filter `Import? = yes` for the list to import. Note that destinations
point at whatever `--target` was set to (usually
staging); switching to production means re-running with a new `--target` — cheap, and it
reproduces the sheet if you keep the same `--resolved` and vanity URLs.

## Dependencies

`openpyxl` — `python3 -m pip install openpyxl`. Everything else is stdlib.
Run `./tests/test.sh` after changing the script.
