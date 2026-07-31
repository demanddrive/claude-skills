#!/usr/bin/env bash
# Regression test for build_redirect_sheet.py. Runs both passes against the offline
# fixtures and asserts the known-correct workbook. No live sites, no network.
#
#   ./tests/test.sh          # exits 0 if all checks pass, 1 otherwise
set -uo pipefail

cd "$(dirname "$0")/.."
SCRIPT=scripts/build_redirect_sheet.py
FIX=tests/fixtures
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TARGET=https://acmegear.wpenginepowered.com
pass=0
fail=0

check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf '  \033[32m✓\033[0m %s\n' "$1"; ((pass++))
  else
    printf '  \033[31m✗\033[0m %s\n      expected: %s\n      actual:   %s\n' "$1" "$2" "$3"; ((fail++))
  fi
}

python3 -c 'import openpyxl' 2>/dev/null || {
  echo "openpyxl is required: python3 -m pip install openpyxl" >&2; exit 1; }

# --- Pass 1: exact match, emit the leftovers --------------------------------
python3 "$SCRIPT" \
  --prod-file "$FIX/prod_urls.txt" --new-file "$FIX/new_urls.txt" \
  --target "$TARGET" --out "$WORK/r.xlsx" \
  --emit-unmatched "$WORK/unmatched.json" --no-titles >"$WORK/pass1.log" 2>&1 || {
    echo "pass 1 failed:" >&2; cat "$WORK/pass1.log" >&2; exit 1; }

echo "Pass 1 — exact match + leftovers"
check "5 URLs left unmatched for semantic resolution" \
  "5" "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["unmatched"]))' "$WORK/unmatched.json")"

# --- Pass 2: fold in decisions, validate, write the workbook ----------------
python3 "$SCRIPT" \
  --prod-file "$FIX/prod_urls.txt" --new-file "$FIX/new_urls.txt" \
  --target "$TARGET" --out "$WORK/r.xlsx" \
  --emit-unmatched "$WORK/unmatched.json" --resolved "$FIX/resolved.json" \
  --no-titles >"$WORK/pass2.log" 2>&1 || {
    echo "pass 2 failed:" >&2; cat "$WORK/pass2.log" >&2; exit 1; }

# Dump the workbook as "sheet|colA|colB" lines so bash can grep it.
dump() { python3 - "$1" <<'PY'
import sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
for ws in wb.worksheets:
    for row in ws.iter_rows(values_only=True):
        cells = ["" if c is None else str(c) for c in row]
        if any(cells):
            print(ws.title + "|" + "|".join(cells))
PY
}
dump "$WORK/r.xlsx" > "$WORK/dump.txt"
# An importable row on the single Redirects sheet: source | destination | yes | ...
exp() { grep -c "^Redirects|$1|$2|yes|" "$WORK/dump.txt"; }

echo
echo "Pass 2 — the workbook"
check "one consolidated Redirects sheet (1:1 + review + patterns merged)" \
  "Redirects Validation" "$(python3 -c 'import openpyxl,sys; print(" ".join(openpyxl.load_workbook(sys.argv[1]).sheetnames))' "$WORK/r.xlsx")"
check "no Confidence column (it restated Match Method as a fake score)" \
  "0" "$(python3 -c 'import openpyxl,sys
ws = openpyxl.load_workbook(sys.argv[1])["Redirects"]
print(sum(1 for c in next(ws.iter_rows(max_row=1, values_only=True)) if c == "Confidence"))' "$WORK/r.xlsx")"
check "5 rows marked Import? = yes" \
  "5" "$(grep -cE '^Redirects\|/[^|]*\|[^|]*\|yes\|' "$WORK/dump.txt")"
# The Validation sheet's count must equal the rows actually labelled yes -- otherwise the
# summary and the sheet disagree about what gets imported.
check "Validation count agrees with the Import? = yes rows" \
  "5" "$(grep -oE '^Validation\|Rows marked Import\? = yes \(redirects \+ 410s\)\|[0-9]+' "$WORK/dump.txt" | grep -oE '[0-9]+$')"
check "6 unchanged rows marked Import? = no, not dropped" \
  "6" "$(grep -c '^Redirects|.*|no||unchanged (no redirect needed)' "$WORK/dump.txt")"
check "no importable row is a self-redirect" \
  "0" "$(python3 - "$WORK/dump.txt" <<'PY'
import sys
n = 0
for line in open(sys.argv[1]):
    p = line.rstrip("\n").split("|")
    if p[0] == "Redirects" and len(p) > 3 and p[3] == "yes" and p[2].endswith(p[1]):
        n += 1
print(n)
PY
)"

check "/about-us -> /company (rename, slug changed)" \
  "1" "$(exp /about-us "$TARGET/company")"
check "/team-members -> /team (rename, slug changed)" \
  "1" "$(exp /team-members "$TARGET/team")"
check "/featured-industries/marine -> /industry/marine (subtree move)" \
  "1" "$(exp /featured-industries/marine "$TARGET/industry/marine")"
check "/blog/2019/discontinued-post -> /blog (nearest-section fallback)" \
  "1" "$(exp /blog/2019/discontinued-post "$TARGET/blog")"
check "/support/legacy-rma -> 410 Gone (retired, no replacement)" \
  "1" "$(exp /support/legacy-rma "410 Gone")"

# An identity pattern (/products/* -> /products/*) is a no-op: those pages didn't move, so
# no rule is needed and emitting one would express the self-redirect the sheet excludes.
# These fixtures contain no multi-URL subtree MOVE, so the correct answer is zero patterns.
check "no identity pattern emitted (/products/* -> /products/*)" \
  "0" "$(grep -c '^Redirects|/products/\*' "$WORK/dump.txt")"
check "no pattern rows at all for these fixtures" \
  "0" "$(grep -cE '^Redirects\|/[^|]*\*\|' "$WORK/dump.txt")"
check "the empty-pattern case says so explicitly" \
  "1" "$(grep -c 'No safe subtree moves found' "$WORK/dump.txt")"
check "zero loops and chains reported" \
  "1" "$(grep -c '^Validation|No redirect loops or chains detected' "$WORK/dump.txt")"
# Review is now a column on the one sheet, tiered so attention goes where it matters.
check "exactly the 5 judgment rows carry a Review tier" \
  "5" "$(grep -cE '^Redirects\|/[^|]*\|[^|]*\|yes\|(NEEDS JUDGMENT|HIGH CONFIDENCE)\|' "$WORK/dump.txt")"
check "the same-slug subtree move is tiered HIGH CONFIDENCE" \
  "1" "$(grep -c '^Redirects|/featured-industries/marine|.*|HIGH CONFIDENCE|' "$WORK/dump.txt")"
check "changed-slug renames, fallbacks and 410s are NEEDS JUDGMENT" \
  "4" "$(grep -c '^Redirects|.*|NEEDS JUDGMENT|' "$WORK/dump.txt")"
check "unchanged rows carry no Review tier" \
  "6" "$(grep -cE '^Redirects\|[^|]*\|[^|]*\|no\|\|unchanged' "$WORK/dump.txt")"
# Sorting is what the separate sheet was really buying: judgment rows first.
check "judgment rows sort above the unchanged ones" \
  "NEEDS JUDGMENT" "$(python3 -c 'import openpyxl,sys
ws = openpyxl.load_workbook(sys.argv[1])["Redirects"]
print(list(ws.iter_rows(min_row=2, max_row=2, values_only=True))[0][3])' "$WORK/r.xlsx")"
check "notes travel inline with the row they explain" \
  "1" "$(grep -c '^Redirects|/support/legacy-rma|410 Gone|yes|NEEDS JUDGMENT|gone|||RMA process retired, no replacement' "$WORK/dump.txt")"

# --- Vanity URLs: absent from every sitemap, deduped across forms -----------
python3 "$SCRIPT" \
  --prod-file "$FIX/prod_urls.txt" --new-file "$FIX/new_urls.txt" \
  --target "$TARGET" --out "$WORK/v.xlsx" \
  --emit-unmatched "$WORK/vu.json" --resolved "$FIX/resolved.json" --no-titles \
  --vanity /promo www.acmegear.com/promo https://www.acmegear.com/contact /qr-fall \
  >"$WORK/vanity.log" 2>&1 || {
    echo "vanity pass failed:" >&2; cat "$WORK/vanity.log" >&2; exit 1; }
dump "$WORK/v.xlsx" > "$WORK/vdump.txt"

echo
echo "Vanity URLs"
check "/promo and www.acmegear.com/promo collapse to one row" \
  "1" "$(grep -cE '^Redirects\|/promo\|[^|]*\|yes\|' "$WORK/vdump.txt")"
check "/contact recognized as already in the sitemap, not re-added" \
  "0" "$(grep -cE '^Redirects\|/contact\|[^|]*\|yes\|' "$WORK/vdump.txt")"
check "2 of 4 supplied vanity URLs added, 2 deduped" \
  "1" "$(grep -c '4 supplied, 2 added' "$WORK/vanity.log")"
check "unmatched vanity URL becomes 410 Gone, not a homepage dump" \
  "1" "$(grep -c '^Redirects|/qr-fall|410 Gone|yes|' "$WORK/vdump.txt")"

# --- Hallucinated destinations are rejected, not written -------------------
# The whole skill rests on the model choosing rename destinations. If it invents a path
# that doesn't exist on the new site, the script must refuse it and fall back -- otherwise
# the sheet ships a redirect to a 404. resolved_bad.json sends /team-members to a path
# absent from the new site.
python3 "$SCRIPT" \
  --prod-file "$FIX/prod_urls.txt" --new-file "$FIX/new_urls.txt" \
  --target "$TARGET" --out "$WORK/b.xlsx" \
  --emit-unmatched "$WORK/bu.json" --resolved "$FIX/resolved_bad.json" --no-titles \
  >"$WORK/bad.log" 2>&1 || {
    echo "hallucination pass failed:" >&2; cat "$WORK/bad.log" >&2; exit 1; }
dump "$WORK/b.xlsx" > "$WORK/bdump.txt"

echo
echo "Hallucinated destination guard"
check "invented /does-not-exist never reaches the sheet" \
  "0" "$(grep -c 'does-not-exist' "$WORK/bdump.txt")"
# /team-members has no ancestor on the new site (only /), so the fallback correctly
# suggests 410 rather than dumping the URL on the homepage.
check "/team-members degrades to 410 Gone, not a homepage dump" \
  "1" "$(grep -c '^Redirects|/team-members|410 Gone|yes|' "$WORK/bdump.txt")"
check "valid siblings still resolve normally" \
  "1" "$(grep -c "^Redirects|/about-us|$TARGET/company|yes|" "$WORK/bdump.txt")"

# --- Pattern suggestions: real subtree moves only ---------------------------
# A pattern is only worth suggesting when a whole subtree MOVED. Here /featured-industries/
# -> /industry/ moves 3 URLs and should be offered with a pasteable regex, while /docs/
# must be refused: /docs/a -> /guides/a conforms but /docs/b -> /elsewhere/b does not, so a
# blanket /docs/* rule would silently send /docs/b to the wrong page.
printf 'https://o.com/featured-industries/marine/\nhttps://o.com/featured-industries/oil/\nhttps://o.com/featured-industries/wind/\nhttps://o.com/docs/a/\nhttps://o.com/docs/b/\n' > "$WORK/mp.txt"
printf 'https://n.com/industry/marine/\nhttps://n.com/industry/oil/\nhttps://n.com/industry/wind/\nhttps://n.com/guides/a/\nhttps://n.com/elsewhere/b/\n' > "$WORK/mn.txt"
cat > "$WORK/mr.json" <<'EOF'
{"/featured-industries/marine": {"dest_path": "/industry/marine", "method": "renamed"},
 "/featured-industries/oil":    {"dest_path": "/industry/oil",    "method": "renamed"},
 "/featured-industries/wind":   {"dest_path": "/industry/wind",   "method": "renamed"},
 "/docs/a":                     {"dest_path": "/guides/a",        "method": "renamed"},
 "/docs/b":                     {"dest_path": "/elsewhere/b",     "method": "renamed"}}
EOF
python3 "$SCRIPT" \
  --prod-file "$WORK/mp.txt" --new-file "$WORK/mn.txt" \
  --target https://n.com --out "$WORK/m.xlsx" \
  --resolved "$WORK/mr.json" --no-titles >"$WORK/move.log" 2>&1 || {
    echo "pattern pass failed:" >&2; cat "$WORK/move.log" >&2; exit 1; }
dump "$WORK/m.xlsx" > "$WORK/mdump.txt"

echo
echo "Pattern suggestions"
check "a real subtree move is offered as a pattern" \
  "1" "$(grep -c '^Redirects|/featured-industries/\*|/industry/\*|' "$WORK/mdump.txt")"
check "the pattern carries a pasteable regex pair" \
  "1" "$(grep -cF '^/featured-industries/(.*)$|/industry/$1|3|' "$WORK/mdump.txt")"
check "a non-conforming subtree (/docs/) is refused" \
  "0" "$(grep -c '^Redirects|/docs/\*' "$WORK/mdump.txt")"
check "exactly one pattern suggested" \
  "1" "$(grep -cE '^Redirects\|/[^|]*\*\|/[^|]*\*\|' "$WORK/mdump.txt")"
check "the moved URLs remain importable as 1:1 rows" \
  "3" "$(grep -cE '^Redirects\|/featured-industries/[a-z]+\|[^|]*\|yes\|' "$WORK/mdump.txt")"

# Two refusal cases the CLI fixtures don't naturally construct, checked directly against
# find_safe_patterns: a pattern must preserve each URL's suffix, and it must account for
# EVERY row under the prefix (including deeper ones) or a blanket rule would catch a URL
# nobody verified.
#
# Note: these assert the OUTCOME, not one line each. The suffix and single-dest-prefix
# guards overlap -- a slug-changed subtree slices to two different destination prefixes, so
# either guard alone would refuse it. Disabling just one still yields the right answer.
patres=$(python3 - <<'PY'
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("brs", pathlib.Path("scripts/build_redirect_sheet.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
R = lambda s, d: {"source_path": s, "dest_path": d, "method": "renamed"}
# Slugs change inside the subtree -> not a clean move, no pattern.
slug_changed = m.find_safe_patterns([R("/docs/a", "/guides/alpha"), R("/docs/b", "/guides/beta")])
# A deeper URL under /docs/ goes elsewhere -> /docs/* would silently catch it.
deeper = m.find_safe_patterns([R("/docs/a", "/guides/a"), R("/docs/b", "/guides/b"),
                               R("/docs/sub/c", "/elsewhere/c")])
# The clean case still works.
ok = m.find_safe_patterns([R("/old/a", "/new/a"), R("/old/b", "/new/b")])
print(f"{len(slug_changed)}|{len(deeper)}|{len(ok)}")
PY
)
check "a subtree whose slugs also change gets no pattern" "0" "$(cut -d'|' -f1 <<<"$patres")"
check "a deeper non-conforming URL disqualifies the prefix" "0" "$(cut -d'|' -f2 <<<"$patres")"
check "a clean two-URL subtree move still patterns" "1" "$(cut -d'|' -f3 <<<"$patres")"

# --- Loop / chain detection (unit-level) ------------------------------------
# validate() is a defensive net that the two-pass CLI cannot actually trigger: a rename
# destination must exist on the new site, and any prod path that also exists there
# exact-matches to itself and is dropped as `unchanged` -- so no exported destination is
# ever also an exported source. That makes loops/chains unreachable end-to-end, which is a
# property worth keeping true. We exercise validate() directly so the net is known to work
# if a future change (extra sources, hand-edited rows) ever does make one reachable.
echo
echo "Loop / chain detection (unit)"
loopres=$(python3 - <<'PY'
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("brs", pathlib.Path("scripts/build_redirect_sheet.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
row = lambda s, d: {"source_path": s, "dest_path": d, "method": "renamed"}
loop  = [t["type"] for t in m.validate([row("/x", "/y"), row("/y", "/x")])]
chain = [t["type"] for t in m.validate([row("/a", "/b"), row("/b", "/c")])]
clean = [t["type"] for t in m.validate([row("/p", "/q"), row("/r", "/s")])]
print(f"{'loop' in loop}|{'chain' in chain}|{len(clean)}")
PY
)
check "/x -> /y -> /x is reported as a loop" "True" "$(cut -d'|' -f1 <<<"$loopres")"
check "/a -> /b -> /c is reported as a chain" "True" "$(cut -d'|' -f2 <<<"$loopres")"
check "an acyclic map reports no issues" "0" "$(cut -d'|' -f3 <<<"$loopres")"

echo
if (( fail )); then
  printf '\033[31m%d of %d checks failed.\033[0m\n' "$fail" "$((pass + fail))"; exit 1
fi
printf '\033[32mAll %d checks passed.\033[0m\n' "$pass"
