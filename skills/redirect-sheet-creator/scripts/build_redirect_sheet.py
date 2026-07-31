#!/usr/bin/env python3
"""Build a 301 redirect sheet mapping a production sitemap onto a new/staging site.

The goal: guarantee that every live production URL has a destination on the new site,
that the mapping is auditable by a human, and that the result contains no redirect loops
or chains.

This script owns the DETERMINISTIC work -- the parts a model should never eyeball:
  * fetch nested sitemaps (following sitemap-index files)
  * normalize URLs (ignore trailing slash; query params pass through, so they don't
    affect matching)
  * exact-match every production path against the new site
  * merge in user-supplied vanity/campaign URLs no sitemap lists (--vanity/--vanity-file),
    deduped against the sitemap and each other
  * fall back to nearest existing parent path when there's no match
  * detect redirect loops and chains via graph traversal
  * write the .xlsx workbook (one Redirects sheet, an Import? column marking the rules)

It deliberately does NOT try to guess renamed pages (e.g. /about-us -> /company). Naive
character similarity produces confident-but-wrong guesses on exactly those cases, which
is dangerous on a redirect sheet. Instead, the leftover unmatched URLs are written to
`unmatched.json` (with page titles fetched to aid judgment) for a model to reason about
semantically and confirm on the Review sheet. See SKILL.md.

Typical flow (two passes):
  # Pass 1: exact-match + validate, emit unmatched list for the model to work
  python build_redirect_sheet.py \
      --prod https://www.example.com \
      --new  https://example.wpenginepowered.com \
      --target https://example.wpenginepowered.com \
      --out ./redirects.xlsx --emit-unmatched ./unmatched.json

  # (model fills in ./resolved.json: {source_path: {dest_path, method, note}})
  # Pass 2: same command plus --resolved ./resolved.json to fold the decisions in.

Pass --vanity/--vanity-file on BOTH passes when used: pass 2 rebuilds the map from sitemaps
rather than from pass 1's output, so omitting it there drops those URLs silently.
"""

import argparse
import gzip
import json
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from urllib.parse import urlparse

# --- Fetching ----------------------------------------------------------------

UA = "Mozilla/5.0 (compatible; RedirectSheetCreator/1.0)"
SITEMAP_CANDIDATES = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap-index.xml"]


_CURL = shutil.which("curl")


class RateLimited(Exception):
    """Raised when a host returns HTTP 429. Carries the Retry-After seconds if given."""
    def __init__(self, retry_after=None):
        super().__init__("HTTP 429 Too Many Requests")
        self.retry_after = retry_after


def _get(url, timeout=30):
    """Fetch a URL, returning bytes (gunzipped if needed).

    Real WordPress/CDN hosts are often fussy about TLS negotiation -- Python's urllib
    trips over some of them with "TLSV1_ALERT_PROTOCOL_VERSION" while curl, which
    negotiates the way browsers do, succeeds. So we try curl first when available and
    fall back to urllib (with a relaxed SSL context as a last resort).

    Staging hosts frequently rate-limit; a 429 is surfaced as RateLimited so callers can
    back off politely instead of silently recording a broken "429 Too Many Requests" body.
    """
    if _CURL:
        try:
            # -w writes the final HTTP status after the body so we can detect a 429.
            proc = subprocess.run(
                [_CURL, "-sL", "--compressed", "-A", UA, "--max-time", str(timeout),
                 "-w", "\n__HTTP_STATUS__%{http_code}", url],
                capture_output=True, check=True,
            )
            data = proc.stdout
            status = None
            marker = b"\n__HTTP_STATUS__"
            idx = data.rfind(marker)
            if idx != -1:
                status = data[idx + len(marker):].strip().decode("ascii", "ignore")
                data = data[:idx]
            if status == "429":
                raise RateLimited()
            if data:
                if data[:2] == b"\x1f\x8b":
                    data = gzip.decompress(data)
                return data
        except subprocess.CalledProcessError:
            pass  # fall through to urllib

    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 429:
            ra = e.headers.get("Retry-After") if e.headers else None
            raise RateLimited(int(ra) if ra and ra.isdigit() else None) from e
        raise
    except (ssl.SSLError, urllib.error.URLError):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            data = r.read()
    if url.endswith(".gz") or data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return data


def _strip_ns(tag):
    return tag.split("}", 1)[-1] if "}" in tag else tag


def fetch_sitemap_urls(base, verbose=True):
    """Return all <loc> URLs for a site, following sitemap-index files recursively."""
    base = base.rstrip("/")
    seen_maps = set()
    urls = []

    def crawl(sitemap_url):
        if sitemap_url in seen_maps:
            return
        seen_maps.add(sitemap_url)
        try:
            data = _get(sitemap_url)
        except Exception as e:  # noqa: BLE001
            if verbose:
                print(f"  ! could not fetch {sitemap_url}: {e}", file=sys.stderr)
            return
        try:
            root = ET.fromstring(data)
        except ET.ParseError as e:
            if verbose:
                print(f"  ! could not parse {sitemap_url}: {e}", file=sys.stderr)
            return
        tag = _strip_ns(root.tag)
        locs = [el.text.strip() for el in root.iter() if _strip_ns(el.tag) == "loc" and el.text]
        if tag == "sitemapindex":
            if verbose:
                print(f"  index {sitemap_url} -> {len(locs)} child sitemaps")
            for child in locs:
                crawl(child)
        else:
            if verbose:
                print(f"  urlset {sitemap_url} -> {len(locs)} urls")
            urls.extend(locs)

    for cand in SITEMAP_CANDIDATES:
        crawl(base + cand)
        if urls:
            break
    return urls


# File extensions / path fragments that are never redirect targets -- images, documents,
# archives, feeds, and WordPress internals. Sitemaps (especially media sitemaps) list
# these, but a 301 sheet is about PAGES, so we drop them.
_ASSET_EXT = re.compile(
    r"\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|pdf|docx?|"
    r"xlsx?|pptx?|zip|gz|tar|rar|7z|css|js|json|xml|txt|woff2?|ttf|eot)$", re.IGNORECASE)
_ASSET_PATH = re.compile(r"/(wp-content|wp-json|wp-includes|feed|cdn-cgi)(/|$)", re.IGNORECASE)


def is_page_url(url):
    path = urlparse(url).path
    if _ASSET_EXT.search(path):
        return False
    if _ASSET_PATH.search(path):
        return False
    return True


def filter_pages(urls):
    """Keep only real page URLs; return (pages, dropped_count)."""
    pages = [u for u in urls if is_page_url(u)]
    return pages, len(urls) - len(pages)


def read_url_file(path):
    with open(path, "rb") as f:
        raw = f.read()
    if raw.lstrip()[:1] == b"<":
        root = ET.fromstring(raw)
        return [el.text.strip() for el in root.iter() if _strip_ns(el.tag) == "loc" and el.text]
    return [ln.strip() for ln in raw.decode("utf-8", "replace").splitlines() if ln.strip()]


class _TitleParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_title = False
        self.title = None
        self.h1 = None
        self._in_h1 = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        elif tag == "h1" and self.h1 is None:
            self._in_h1 = True

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        elif tag == "h1":
            self._in_h1 = False

    def handle_data(self, data):
        if self.in_title and self.title is None:
            self.title = data.strip()
        elif self._in_h1 and self.h1 is None and data.strip():
            self.h1 = data.strip()


def fetch_title(url, timeout=15, retries=4):
    """Best-effort <title>/<h1> for a page. Returns '' on any failure -- titles are a
    convenience for rename judgment, never required.

    On a 429 we back off and retry (respecting Retry-After when the host sends it) so a
    rate-limited staging host yields a real title on a later attempt instead of the string
    "429 Too Many Requests" leaking into the sheet.
    """
    delay = 1.0
    for attempt in range(retries + 1):
        try:
            data = _get(url, timeout=timeout)[:200_000]
            p = _TitleParser()
            p.feed(data.decode("utf-8", "replace"))
            title = (p.title or p.h1 or "").strip()
            # Guard against error-page bodies served with a 200 leaking in as a "title".
            if re.search(r"\b(429|too many requests|rate limit|403 forbidden|"
                         r"service unavailable)\b", title, re.IGNORECASE):
                return ""
            return title
        except RateLimited as e:
            if attempt == retries:
                return ""
            wait = e.retry_after if e.retry_after else delay
            # Jitter avoids a thundering herd of worker threads retrying in lockstep.
            time.sleep(min(wait, 10) + (attempt * 0.13) % 0.5)
            delay *= 2
        except Exception:  # noqa: BLE001
            return ""
    return ""


def fetch_titles(urls, workers=6, pace=0.05):
    """Fetch many titles concurrently but politely. Returns {url: title}.

    Concurrency is deliberately modest (staging boxes are small and rate-limit fast) and
    each task is nudged apart by a tiny stagger so we don't hammer the host with a burst.
    Individual 429s are handled by fetch_title's backoff.
    """
    urls = list(urls)
    out = {}

    def worker(item):
        i, u = item
        time.sleep((i % workers) * pace)  # stagger the initial burst
        return u, fetch_title(u)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for u, t in ex.map(worker, enumerate(urls)):
            out[u] = t
    return out


# --- Normalization -----------------------------------------------------------

def to_path(url):
    """Normalized path for matching: trailing slash ignored, query/fragment dropped.

    Also tolerates scheme-less input like `www.example.com/promo`, which users paste
    routinely when asked for vanity URLs. urlparse() reads that as an all-path relative
    URL, which would otherwise become the literal source path `www.example.com/promo`
    instead of `/promo`, so a leading host segment is stripped before parsing.
    """
    url = url.strip()
    if not url.startswith("/") and "://" not in url:
        # Bare host prefix (no scheme): drop it, keeping whatever path follows.
        head = url.split("/", 1)
        if "." in head[0] and " " not in head[0]:
            url = "/" + head[1] if len(head) > 1 else "/"
    p = urlparse(url)
    path = p.path or "/"
    if len(path) > 1:
        path = path.rstrip("/")
    return path or "/"


def slug(path):
    segs = [s for s in path.split("/") if s]
    return segs[-1] if segs else ""


# --- Matching ----------------------------------------------------------------

def build_new_index(new_urls):
    return {to_path(u): u for u in new_urls}


def nearest_parent(path, new_index):
    """Return (parent_path, found) where found is True only if a real ancestor path (not
    the bare homepage) exists on the new site. When nothing above the page exists, we
    return ("/", False) so the caller can suggest 410 Gone instead of dumping the URL on
    the homepage -- a homepage redirect for a genuinely-removed page is poor for SEO and
    confusing for users."""
    segs = [s for s in path.split("/") if s]
    while segs:
        segs.pop()
        candidate = "/" + "/".join(segs) if segs else "/"
        if candidate in new_index and candidate != "/":
            return candidate, True
    return "/", False


def match_exact(prod_urls, new_index):
    """First pass: exact path matches only. Returns (rows, unmatched_paths)."""
    rows, unmatched = [], []
    for src in prod_urls:
        spath = to_path(src)
        if spath in new_index:
            rows.append({"source": src, "source_path": spath, "dest_path": spath,
                         "method": "exact", "review": False,
                         "note": ""})
        else:
            unmatched.append((src, spath))
    return rows, unmatched


# --- Provably-safe patterns --------------------------------------------------

def find_safe_patterns(rows):
    """Find subtree MOVES that a single prefix rule could express: every URL under
    /old-prefix/ lands at the same suffix under a DIFFERENT /new-prefix/.

    Only a move is worth a pattern. A subtree that maps to itself (/products/* ->
    /products/*) needs no rule at all -- those pages didn't move, and emitting an identity
    pattern would express the very self-redirect the export excludes. So source prefix ==
    destination prefix is skipped.

    Safety: a rule is emitted only when EVERY row under the prefix agrees on the same
    destination prefix and preserves its suffix exactly, and no other row outside the group
    shares the source prefix. One non-conforming URL disqualifies the whole prefix, because
    a blanket rule would silently send it somewhere wrong.

    Patterns are advisory -- the 1:1 rows remain the authoritative import. Returns dicts
    carrying both a readable wildcard form and a ready-to-paste regex pair.
    """
    # Group by source prefix depth-first: try the deepest shared prefix first so
    # /featured-industries/* wins over a shallower coincidence.
    candidates = defaultdict(list)
    for r in rows:
        segs = [s for s in r["source_path"].split("/") if s]
        # A prefix needs at least one segment above the leaf to be a subtree.
        for depth in range(1, len(segs)):
            candidates["/" + "/".join(segs[:depth])].append(r)

    patterns = []
    claimed = set()  # source paths already covered by an emitted (deeper) pattern
    for prefix in sorted(candidates, key=lambda p: (-p.count("/"), p)):
        group = candidates[prefix]
        if len(group) < 2 or any(r["source_path"] in claimed for r in group):
            continue
        # Every row whose source lives under this prefix must be in the group -- otherwise
        # a blanket rule would also catch the ones we didn't check.
        under = [r for r in rows if r["source_path"].startswith(prefix + "/")]
        if len(under) != len(group):
            continue
        # A 410 or a fallback has no suffix-preserving destination, so it can't pattern.
        if any(r["method"] in ("gone", "parent-fallback") for r in group):
            continue

        dest_prefixes = set()
        conforms = True
        for r in group:
            suffix = r["source_path"][len(prefix):]          # includes the leading "/"
            if not r["dest_path"].endswith(suffix):
                conforms = False
                break
            dest_prefixes.add(r["dest_path"][: -len(suffix)] or "/")
        if not conforms or len(dest_prefixes) != 1:
            continue

        dest_prefix = dest_prefixes.pop()
        if dest_prefix == prefix:
            continue  # identity: these pages didn't move, so no rule is needed

        patterns.append({
            "source_pattern": prefix + "/*",
            "dest_pattern": dest_prefix + "/*",
            "source_regex": f"^{prefix}/(.*)$",
            "dest_regex": f"{dest_prefix}/$1",
            "count": len(group),
            "notes": f"All {len(group)} URLs under {prefix}/ move to {dest_prefix}/ keeping "
                     f"their slug. One rule could replace those {len(group)} 1:1 rows.",
        })
        claimed.update(r["source_path"] for r in group)
    return patterns


# --- Loop / chain validation -------------------------------------------------

def validate(rows, same_domain=False):
    """Detect redirect loops and chains among the PATHS.

    Note on "identical path": prod /about -> new /about is the correct, desired 301 when
    prod and the new site are DIFFERENT domains (the usual case) -- the server sends the
    browser from the old host to the new host at the same path. It is only a useless
    self-redirect when source and target share a domain, so we only flag src==dst when
    ``same_domain`` is true.

    A chain (A->B, B->C) or loop (A->B->A) is always a problem: the browser would be
    bounced more than once. We build a source-path -> dest-path map and walk it; if a
    destination path is itself a source that redirects onward, that's a chain.
    """
    dest_by_source = {r["source_path"]: r["dest_path"] for r in rows}
    issues = []
    for r in rows:
        src, dst = r["source_path"], r["dest_path"]
        if src == dst:
            if same_domain:
                issues.append({"type": "self-redirect", "source": src,
                               "detail": "source path == destination path on the same domain (no-op)"})
            continue  # cross-domain identical path is the intended behavior
        visited = [src]
        cur, hops = dst, 0
        while cur in dest_by_source and dest_by_source[cur] != cur and hops < 50:
            if cur in visited:
                issues.append({"type": "loop", "source": src, "detail": " -> ".join(visited + [cur])})
                break
            visited.append(cur)
            cur = dest_by_source[cur]
            hops += 1
        else:
            # Reached a terminal destination. If we passed through >1 hop, it's a chain.
            if len(visited) >= 2 and dst in dest_by_source and dest_by_source[dst] != dst:
                issues.append({"type": "chain", "source": src, "detail": " -> ".join(visited + [cur])})
    return issues


# --- Workbook output ---------------------------------------------------------

def write_workbook(rows, patterns, issues, prod_urls, new_urls, target_base, out_path,
                   vanity_added=0):
    import openpyxl
    from openpyxl.styles import Font, PatternFill

    # An identical source/destination path means the page lives at the same URL on the
    # new site -- writing a redirect rule for it would create a real self-loop on the
    # server, so it's shown on the reasoning sheet but EXCLUDED from the final export.
    for r in rows:
        r["no_redirect"] = (r["source_path"] == r["dest_path"])

    wb = openpyxl.Workbook()
    hdr = Font(bold=True)
    warn = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")
    grey = PatternFill(start_color="EFEFEF", end_color="EFEFEF", fill_type="solid")

    # ONE sheet carries the whole map: every row, with an Import? column saying which are
    # rules and which aren't. Splitting 1:1 from Export meant maintaining two views of the
    # same data and inviting a double-import; a single filterable sheet says it once.
    #
    # Import? is the operative column:
    #   yes  -- a real redirect (or a 410). Import these.
    #   no   -- source == destination: the page didn't move. Shown so every production URL
    #           is visibly accounted for, but importing it would be a server self-loop.
    # Review status is a COLUMN, not a separate sheet: the old Review sheet was a filtered
    # view of these same rows, so a reviewer editing a destination had to remember to fix it
    # in two places. Sort so the rows needing attention float to the top -- that's what the
    # separate sheet was really buying, and a sort achieves it without duplicating data.
    def review_tier(r):
        if not r["review"]:
            return ""
        # A rename that KEEPS ITS SLUG (/featured-industries/marine -> /industry/marine) is a
        # mechanical subtree move: quick sanity check. A changed slug, a section fallback, or
        # a 410 is a real judgment call.
        if r["method"] == "renamed" and slug(r["source_path"]) == slug(r["dest_path"]):
            return "HIGH CONFIDENCE"
        return "NEEDS JUDGMENT"

    order = {"NEEDS JUDGMENT": 0, "HIGH CONFIDENCE": 1, "": 2}
    rows = sorted(rows, key=lambda r: (order[review_tier(r)], r["source_path"]))

    ws = wb.active
    ws.title = "Redirects"
    # No "Confidence" column: it was a constant per method (renamed=0.9, fallback=0.3,
    # gone=0.0), so it restated Match Method as a number that LOOKED computed. A reviewer
    # reading 0.9 would reasonably infer this particular rename scored well, when every
    # rename got the same value. Match Method carries the real signal; Review carries the
    # priority; Notes carries the reasoning.
    cols = ["Source Path", "Destination URL / Status", "Import?", "Review", "Match Method",
            "Source Title", "Destination Title", "Notes"]
    for j, name in enumerate(cols):
        ws.cell(row=1, column=j + 1, value=name).font = hdr
    ws.freeze_panes = "A2"
    base = target_base.rstrip("/")
    export_pairs = []
    ncols = len(cols)
    i = 2
    for r in rows:
        gone = r["method"] == "gone"
        dest = "410 Gone" if gone else base + r["dest_path"]
        importable = not r["no_redirect"]
        tier = review_tier(r)
        vals = [
            r["source_path"],
            dest,
            "yes" if importable else "no",
            tier,
            "unchanged (no redirect needed)" if r["no_redirect"] else r["method"],
            r.get("source_title", ""),
            r.get("dest_title", ""),
            r.get("note", ""),
        ]
        for j, v in enumerate(vals):
            ws.cell(row=i, column=j + 1, value=v)
        if r["no_redirect"]:
            for j in range(1, ncols + 1):
                ws.cell(row=i, column=j).fill = grey
        elif tier:
            for j in range(1, ncols + 1):
                ws.cell(row=i, column=j).fill = warn
        if importable:
            export_pairs.append((r["source_path"], dest))
        i += 1

    # Optional pattern suggestions live BELOW the 1:1 rows, separated by a blank row and a
    # heading, so the sheet reads top-to-bottom: authoritative rules first, then advice.
    # They are NOT marked importable -- the 1:1 rows above already cover the same URLs, and
    # importing both would install duplicate rules for one page.
    i += 1
    ws.cell(row=i, column=1,
            value=f"OPTIONAL PATTERN SUGGESTIONS ({len(patterns)})").font = Font(bold=True, size=12)
    i += 1
    ws.cell(row=i, column=1, value=(
        "Advisory only — do NOT import these alongside the rows above; each pattern would "
        "duplicate the 1:1 rules it covers. Swap one in by hand only if you'd rather "
        "maintain a single rule, and verify no URL under the prefix needs different "
        "treatment. Only subtree MOVES appear here; a subtree that maps to itself needs no "
        "rule at all."))
    i += 1
    pat_cols = ["Source Pattern", "Destination Pattern", "Source Regex", "Destination Regex",
                "URLs Covered", "Notes"]
    for j, name in enumerate(pat_cols):
        ws.cell(row=i, column=j + 1, value=name).font = hdr
    i += 1
    if patterns:
        for p in patterns:
            vals = [p["source_pattern"], p["dest_pattern"], p["source_regex"],
                    p["dest_regex"], p["count"], p["notes"]]
            for j, v in enumerate(vals):
                ws.cell(row=i, column=j + 1, value=v)
            i += 1
    else:
        ws.cell(row=i, column=1,
                value="No safe subtree moves found — the 1:1 rows above are the whole map.")

    needs_judgment = sum(1 for r in rows if review_tier(r) == "NEEDS JUDGMENT")
    high_conf = sum(1 for r in rows if review_tier(r) == "HIGH CONFIDENCE")

    val = wb.create_sheet("Validation")
    counts = defaultdict(int)
    for r in rows:
        counts[r["method"]] += 1
    unchanged = sum(1 for r in rows if r["no_redirect"])
    val["A1"] = "Validation Report"
    val["A1"].font = Font(bold=True, size=13)
    summary = [
        ("Production URLs", len(prod_urls)),
        ("  of which vanity/campaign URLs added by hand", vanity_added),
        ("New-site URLs", len(new_urls)),
        ("Exact matches", counts["exact"]),
        ("  of which unchanged (no redirect needed, excluded from export)", unchanged),
        ("Renamed (model, review)", counts["renamed"]),
        ("Parent-fallback (review)", counts["parent-fallback"]),
        ("Gone / 410 suggested (review)", counts["gone"]),
        ('Rows marked Import? = yes (redirects + 410s)', len(export_pairs)),
        ("Optional pattern suggestions (advisory, not imported)", len(patterns)),
        ("Review = NEEDS JUDGMENT (changed slug, fallbacks, 410s)", needs_judgment),
        ("Review = HIGH CONFIDENCE (same-slug subtree moves)", high_conf),
    ]
    row = 3
    for k, v in summary:
        val[f"A{row}"], val[f"B{row}"] = k, v
        row += 1
    row += 1
    val[f"A{row}"], val[f"B{row}"] = "Loop/chain issues", len(issues)
    val[f"A{row}"].font = hdr
    row += 2
    if issues:
        val[f"A{row}"], val[f"B{row}"], val[f"C{row}"] = "Type", "Source", "Detail"
        for c in "ABC":
            val[f"{c}{row}"].font = hdr
        row += 1
        for iss in issues:
            val[f"A{row}"], val[f"B{row}"], val[f"C{row}"] = iss["type"], iss["source"], iss["detail"]
            for c in "ABC":
                val[f"{c}{row}"].fill = warn
            row += 1
    else:
        val[f"A{row}"] = "No redirect loops or chains detected among the exported redirects."

    for sheet in wb.worksheets:
        for col in sheet.columns:
            width = max((len(str(c.value)) for c in col if c.value is not None), default=10)
            sheet.column_dimensions[col[0].column_letter].width = min(max(width + 2, 12), 70)

    wb.save(out_path)
    return len(export_pairs)


# --- Unmatched export (for model to resolve) ---------------------------------

def emit_unmatched(unmatched, new_index, path, with_titles=True):
    """Write a compact JSON the model can reason over. Includes titles for the leftover
    prod URLs and for every new-site candidate, so renames can be judged by meaning.

    Also writes a sibling `<path>.titles.json` mapping path->title so pass 2 can put the
    titles into the Review sheet for human confirmation without re-fetching.
    """
    title_map = {}  # path -> title
    if with_titles:
        prod_titles = fetch_titles([src for src, _ in unmatched])
        new_titles = fetch_titles(list(new_index.values()))
        for (src, spath) in unmatched:
            title_map[spath] = prod_titles.get(src, "")
        for npath, nurl in new_index.items():
            title_map[npath] = new_titles.get(nurl, "")

    new_candidates = []
    for npath in sorted(new_index):
        entry = {"path": npath}
        if title_map.get(npath):
            entry["title"] = title_map[npath]
        new_candidates.append(entry)

    unmatched_out = []
    for src, spath in unmatched:
        entry = {"source": src, "source_path": spath, "slug": slug(spath)}
        if title_map.get(spath):
            entry["title"] = title_map[spath]
        unmatched_out.append(entry)

    payload = {
        "instructions": (
            "For each unmatched source, choose ONE: (a) a real replacement page -- set "
            "dest_path to the best new_site_candidates PATH by MEANING (a renamed page); "
            "(b) the page is genuinely gone with no good replacement -- set "
            "method='gone' (it will be suggested as HTTP 410, better for SEO than a "
            "homepage redirect); or (c) leave dest_path empty to accept the deterministic "
            "fallback (nearest existing section, or 410 if no section exists). Prefer a "
            "confident replacement; use 'gone' rather than forcing a weak match. Write "
            "resolved.json as {source_path: {dest_path?, method?, note}}."),
        "unmatched": unmatched_out,
        "new_site_candidates": new_candidates,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    if with_titles:
        with open(re.sub(r"\.json$", "", path) + ".titles.json", "w", encoding="utf-8") as f:
            json.dump(title_map, f, indent=2, ensure_ascii=False)


def apply_resolved(unmatched, new_index, resolved_path, title_map=None):
    """Fold the model's resolved.json decisions in. Attaches source/destination titles
    (when known) so the Review sheet can show them.

    Resolution priority per unmatched URL:
      1. Model picked a valid new-site dest_path  -> `renamed` (needs review)
      2. Model explicitly marked it gone           -> `gone` (suggest HTTP 410)
      3. A real ancestor path exists on the new site -> `parent-fallback` (needs review)
      4. Nothing above it exists                    -> `gone` (suggest HTTP 410, not a
         homepage dump -- a removed page should tell Google it's gone, not bounce users
         to the front page)
    """
    title_map = title_map or {}
    resolved = {}
    if resolved_path:
        with open(resolved_path, encoding="utf-8") as f:
            resolved = json.load(f)
    rows = []
    for src, spath in unmatched:
        r = resolved.get(spath) or {}
        dest = (r.get("dest_path") or "").strip()
        method_hint = (r.get("method") or "").strip().lower()
        if dest and dest in new_index:
            row = {"source": src, "source_path": spath, "dest_path": dest,
                   "method": "renamed", "review": True,
                   "note": r.get("note", "Model-proposed rename; confirm.")}
        elif method_hint == "gone":
            row = {"source": src, "source_path": spath, "dest_path": "410 Gone",
                   "method": "gone", "review": True,
                   "note": r.get("note", "No equivalent page; serve HTTP 410 Gone.")}
        else:
            parent, found = nearest_parent(spath, new_index)
            if found:
                row = {"source": src, "source_path": spath, "dest_path": parent,
                       "method": "parent-fallback", "review": True,
                       "note": r.get("note", "No exact page; redirect to nearest existing section.")}
            else:
                row = {"source": src, "source_path": spath, "dest_path": "410 Gone",
                       "method": "gone", "review": True,
                       "note": r.get("note", "No matching page and no matching parent section; "
                                             "suggest HTTP 410 Gone rather than a homepage redirect.")}
        row["source_title"] = title_map.get(spath, "")
        row["dest_title"] = title_map.get(row["dest_path"], "")
        rows.append(row)
    return rows


# --- CLI ---------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prod")
    ap.add_argument("--new")
    ap.add_argument("--prod-file")
    ap.add_argument("--new-file")
    ap.add_argument("--target", required=True, help="Target base URL written into the sheet (usually staging)")
    ap.add_argument("--out", default="redirects.xlsx")
    ap.add_argument("--emit-unmatched", help="Write unmatched URLs (with titles) to this JSON for model resolution")
    ap.add_argument("--resolved", help="Read the model's rename decisions from this JSON")
    ap.add_argument("--no-titles", action="store_true", help="Skip fetching page titles (faster, offline)")
    ap.add_argument("--vanity", nargs="+", metavar="URL", default=[],
                    help="Vanity/campaign source URLs or paths absent from the sitemap, passed "
                         "inline (e.g. --vanity /promo /webinar). Use this for the handful a "
                         "user names in conversation; --vanity-file for a long list.")
    ap.add_argument("--vanity-file", help="Same as --vanity but read from a file, one URL/path "
                                         "per line. For long lists or an exported plugin dump.")
    args = ap.parse_args()

    if args.prod_file:
        prod_urls = read_url_file(args.prod_file)
    elif args.prod:
        print(f"Fetching production sitemap from {args.prod} ...")
        prod_urls = fetch_sitemap_urls(args.prod)
    else:
        ap.error("provide --prod or --prod-file")

    if args.new_file:
        new_urls = read_url_file(args.new_file)
    elif args.new:
        print(f"Fetching new-site sitemap from {args.new} ...")
        new_urls = fetch_sitemap_urls(args.new)
    else:
        ap.error("provide --new or --new-file")

    # Vanity/campaign URLs are not in any sitemap (no inbound crawl path, often print- or
    # QR-only), so nothing above can discover them -- yet they 404 just as loudly at launch.
    # They join the production set here and then match, validate, and export like any other
    # source URL.
    vanity_added = 0
    vanity = list(args.vanity)
    if args.vanity_file:
        vanity += read_url_file(args.vanity_file)
    if vanity:
        # Dedupe against the sitemap AND against the rest of the pasted list -- a user
        # listing the same page twice in different forms (/promo and
        # https://www.example.com/promo) must not yield two rows for one page.
        known = {to_path(u) for u in prod_urls}
        extra = []
        for u in vanity:
            p = to_path(u)
            if p in known:
                continue
            known.add(p)
            extra.append(u)
        vanity_added = len(extra)
        prod_urls = list(prod_urls) + extra
        print(f"Vanity URLs: {len(vanity)} supplied, {vanity_added} added "
              f"({len(vanity) - vanity_added} skipped as duplicates of the sitemap or "
              f"of each other)")

    prod_urls, prod_dropped = filter_pages(sorted(set(prod_urls)))
    new_urls, new_dropped = filter_pages(sorted(set(new_urls)))
    print(f"Production pages: {len(prod_urls)} (dropped {prod_dropped} assets)   "
          f"New-site pages: {len(new_urls)} (dropped {new_dropped} assets)")
    if not prod_urls:
        ap.error("No production page URLs found. Check the sitemap URL or pass --prod-file "
                 "with a list. (If the site blocks automated fetches, provide a URL list.)")

    new_index = build_new_index(new_urls)
    exact_rows, unmatched = match_exact(prod_urls, new_index)
    print(f"Exact matches: {len(exact_rows)}   Unmatched: {len(unmatched)}")

    if args.emit_unmatched and not args.resolved:
        # Pass 1: stop here so the model can resolve renames on the short unmatched list.
        emit_unmatched(unmatched, new_index, args.emit_unmatched, with_titles=not args.no_titles)
        print(f"\nWrote {args.emit_unmatched} ({len(unmatched)} unmatched URLs) for model resolution.")
        print("Have the model produce resolved.json, then re-run with --resolved resolved.json.")
        return

    title_map = {}
    if args.emit_unmatched:
        titles_file = re.sub(r"\.json$", "", args.emit_unmatched) + ".titles.json"
        try:
            with open(titles_file, encoding="utf-8") as f:
                title_map = json.load(f)
        except OSError:
            pass
    resolved_rows = apply_resolved(unmatched, new_index, args.resolved, title_map)
    rows = sorted(exact_rows + resolved_rows, key=lambda r: r["source_path"])
    patterns = find_safe_patterns(rows)
    # Validate only rows that become real URL redirects. Unchanged same-path rows aren't
    # written, and 410 rows have no URL destination, so neither can form a loop or chain.
    redirect_rows = [r for r in rows
                     if r["source_path"] != r["dest_path"] and r.get("method") != "gone"]
    issues = validate(redirect_rows)
    export_count = write_workbook(rows, patterns, issues, prod_urls, new_urls, args.target,
                                  args.out, vanity_added=vanity_added)

    exact = sum(1 for r in rows if r["method"] == "exact")
    review = sum(1 for r in rows if r["review"])
    print(f"\nWrote {args.out}")
    print(f"  {len(rows)} redirects: {exact} exact, {review} need review")
    print(f"  {len(patterns)} optional pattern suggestion(s), {len(issues)} loop/chain issue(s)")
    print(f"  {export_count} row(s) marked Import? = yes on the Redirects sheet")
    if issues:
        print("  ! Loop/chain issues found -- see the Validation sheet before using.")


if __name__ == "__main__":
    main()
