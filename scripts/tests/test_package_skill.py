#!/usr/bin/env python3
"""Regression tests for scripts/package_skill.py. Exits nonzero on failure.

Each test builds a throwaway skill tree in a temp dir and packages it, so nothing
here depends on the real skills/ contents or touches the network.
"""

import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import package_skill as ps

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
results = []


def check(label, condition):
    results.append(bool(condition))
    print(f"  {PASS if condition else FAIL} {label}")


def group(name):
    """Run a group of checks, recording a failure if it raises.

    Without this, one unexpected exception (e.g. a missing zip member after a
    regression) aborts the whole run before the summary prints -- which looks
    like "no failures" to any caller reading the summary line.
    """
    def wrap(fn):
        print(f"\n{name}")
        try:
            fn()
        except Exception as e:
            results.append(False)
            print(f"  {FAIL} {name}: unexpected {type(e).__name__}: {e}")
        return fn
    return wrap


def make_skill(root, name, frontmatter, body="\n# Body\n", extra=()):
    """Write a minimal skill tree, returning its path."""
    d = root / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\n{frontmatter}\n---\n{body}")
    for rel, content in extra:
        f = d / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(content if isinstance(content, bytes) else content.encode())
    return d


def package_in(root, name, **kw):
    """Point the module at a temp repo and package one skill there.

    Each call writes to its own dist/<name>/ so a later test can never leave a
    stale zip that an earlier assertion then re-reads -- that masked a real
    structural regression once.
    """
    orig_skills, orig_repo = ps.SKILLS_DIR, ps.REPO
    ps.SKILLS_DIR, ps.REPO = root / "skills", root
    try:
        return ps.package(name, root / "dist" / name, quiet=True, **kw)
    finally:
        ps.SKILLS_DIR, ps.REPO = orig_skills, orig_repo


def names_in(zip_path):
    with zipfile.ZipFile(zip_path) as zf:
        return sorted(zf.namelist())


def read_in(zip_path, member):
    with zipfile.ZipFile(zip_path) as zf:
        return zf.read(member).decode()


def run():
    root = Path(tempfile.mkdtemp())
    try:
        # --- structure -------------------------------------------------------
        @group("Zip structure")
        def _structure():
            make_skill(root, "my-skill", "name: my-skill\ndescription: Does a thing. Use when thing.",
                       extra=[("scripts/go.py", "print(1)"), ("assets/t.xlsx", b"\x50\x4b\x03\x04")])
            zp, _ = package_in(root, "my-skill")
            members = names_in(zp)
            check("every entry sits under a single top-level skill dir",
                  members and all(m.startswith("my-skill/") for m in members)
                  and all("/" in m for m in members))
            check("SKILL.md is nested in the skill dir, not at the zip root",
                  "my-skill/SKILL.md" in members and "SKILL.md" not in members)
            check("scripts/ and assets/ are included",
                  "my-skill/scripts/go.py" in members and "my-skill/assets/t.xlsx" in members)
            check("zip is named after the skill", zp.name == "my-skill.zip")

            # --- exclusions ------------------------------------------------------
        @group("Dev-only file exclusion")
        def _exclusion():
            make_skill(root, "ex-skill", "name: ex-skill\ndescription: Excludes things. Use when excluding.",
                       extra=[("tests/test.sh", "#!/bin/sh"), ("tests/fixtures/a.txt", "x"),
                              ("evals/evals.json", "{}"), (".DS_Store", "junk"),
                              ("scripts/__pycache__/m.pyc", b"\x00"), ("scripts/keep.py", "ok")])
            zp, _ = package_in(root, "ex-skill")
            members = names_in(zp)
            check("tests/ is excluded", not any("tests/" in m for m in members))
            check("evals/ is excluded", not any("evals/" in m for m in members))
            check(".DS_Store is excluded", not any(".DS_Store" in m for m in members))
            check("__pycache__/.pyc is excluded", not any(m.endswith(".pyc") for m in members))
            check("real scripts survive exclusion", "ex-skill/scripts/keep.py" in members)

            # --- frontmatter stripping -------------------------------------------
        @group("Frontmatter stripping")
        def _stripping():
            make_skill(root, "cc-skill",
                       "name: cc-skill\ndescription: Strips keys. Use when stripping.\n"
                       "disable-model-invocation: true\nallowed-tools: Bash, Read")
            zp, notes = package_in(root, "cc-skill")
            md = read_in(zp, "cc-skill/SKILL.md")
            check("disable-model-invocation is stripped", "disable-model-invocation" not in md)
            check("allowed-tools is stripped", "allowed-tools" not in md)
            check("name survives stripping", "name: cc-skill" in md)
            check("description survives stripping", "description: Strips keys." in md)
            check("stripping model-invocation is reported as a note",
                  any("model-invocable" in n for n in notes))
            check("frontmatter stays well-formed", md.startswith("---\n") and md.count("---") >= 2)
            check("body is preserved", "# Body" in md)

            # --- multi-line descriptions -----------------------------------------
        @group("Multi-line frontmatter values")
        def _multiline():
            long_desc = "Wrapped description. " * 12  # ~250 chars across lines
            wrapped = "\n  ".join(long_desc[i:i + 60] for i in range(0, len(long_desc), 60))
            make_skill(root, "wrap-skill", f"name: wrap-skill\ndescription: {wrapped}")
            zp, _ = package_in(root, "wrap-skill")
            fm, _body = ps.parse_frontmatter(read_in(zp, "wrap-skill/SKILL.md"), "x")
            got = ps.read_field(fm, "description")
            check("a hand-wrapped description is read across continuation lines", len(got) > 200)
            check("a key after a wrapped value is not swallowed",
                  ps.read_field(["description: a", "  b", "name: real-name"], "name") == "real-name")

            # --- validation ------------------------------------------------------
        @group("Frontmatter validation")
        def _validation():

            def fails(dirname, fm, body="\n# B\n", expect=None):
                """True if packaging raises. `expect` pins the reason, so a check can't
                pass because some *other* rule fired first (e.g. the name-vs-directory
                mismatch masking a charset violation)."""
                make_skill(root, dirname, fm, body=body)
                try:
                    package_in(root, dirname)
                    return False
                except ps.SkillError as e:
                    return expect in str(e) if expect else True

            check("over-long description (>1024) is rejected",
                  fails("d-long", "name: d-long\ndescription: " + "x" * 1100, expect="max 1024"))
            # These use a directory equal to the frontmatter name, so the charset and
            # reserved-word rules are what reject them -- not the mismatch rule.
            check("uppercase name is rejected",
                  fails("Bad-Case", "name: Bad-Case\ndescription: d", expect="lowercase"))
            check("name with underscores is rejected",
                  fails("bad_name", "name: bad_name\ndescription: d", expect="lowercase"))
            check("reserved word 'claude' in name is rejected",
                  fails("claude-helper", "name: claude-helper\ndescription: d", expect="reserved word"))
            check("reserved word 'anthropic' in name is rejected",
                  fails("anthropic-tool", "name: anthropic-tool\ndescription: d", expect="reserved word"))
            check("missing description is rejected",
                  fails("nodesc", "name: nodesc", expect="missing required field `description`"))
            check("missing name is rejected",
                  fails("noname", "description: only a description", expect="missing required field `name`"))
            check("XML tags in description are rejected",
                  fails("xml", "name: xml\ndescription: Uses <tag> markup", expect="XML tags"))
            check("name not matching its directory is rejected",
                  fails("mismatch", "name: something-else\ndescription: d", expect="does not match directory"))

            over = "n" * 70
            check(f"name over {ps.NAME_MAX} chars is rejected",
                  fails(over, f"name: {over}\ndescription: d", expect=f"max {ps.NAME_MAX}"))

            # missing / malformed SKILL.md
            (root / "skills" / "no-md").mkdir(parents=True, exist_ok=True)
            try:
                package_in(root, "no-md")
                check("a skill with no SKILL.md is rejected", False)
            except ps.SkillError:
                check("a skill with no SKILL.md is rejected", True)

            d = root / "skills" / "no-fm"
            d.mkdir(parents=True, exist_ok=True)
            (d / "SKILL.md").write_text("# Just a heading, no frontmatter\n")
            try:
                package_in(root, "no-fm")
                check("SKILL.md without frontmatter is rejected", False)
            except ps.SkillError:
                check("SKILL.md without frontmatter is rejected", True)

            try:
                package_in(root, "does-not-exist")
                check("an unknown skill name is rejected", False)
            except ps.SkillError:
                check("an unknown skill name is rejected", True)

            # --- valid edge cases pass -------------------------------------------
        @group("Valid edge cases")
        def _edge_cases():
            exact = "d" * ps.DESC_MAX
            make_skill(root, "exact-desc", f"name: exact-desc\ndescription: {exact}")
            try:
                package_in(root, "exact-desc")
                check(f"a description of exactly {ps.DESC_MAX} chars is accepted", True)
            except ps.SkillError:
                check(f"a description of exactly {ps.DESC_MAX} chars is accepted", False)

            make_skill(root, "digits-9", "name: digits-9\ndescription: Numbers and hyphens are legal.")
            try:
                package_in(root, "digits-9")
                check("digits and hyphens in a name are accepted", True)
            except ps.SkillError:
                check("digits and hyphens in a name are accepted", False)

            # --- stale path references -------------------------------------------
        @group("Stale reference warnings")
        def _stale_refs():
            make_skill(root, "ref-skill", "name: ref-skill\ndescription: Refers to tests.",
                       body="\nRun `./tests/test.sh` after changing this.\n",
                       extra=[("tests/test.sh", "#!/bin/sh")])
            _zp, notes = package_in(root, "ref-skill")
            check("a SKILL.md pointing at excluded tests/ is flagged",
                  any("tests/" in n for n in notes))

            make_skill(root, "clean-skill", "name: clean-skill\ndescription: Mentions nothing excluded.")
            _zp, notes = package_in(root, "clean-skill")
            check("a clean skill produces no notes", notes == [])

            # --- idempotence -----------------------------------------------------
        @group("Repeat runs")
        def _repeat_runs():
            first = read_in(package_in(root, "my-skill")[0], "my-skill/SKILL.md")
            second = read_in(package_in(root, "my-skill")[0], "my-skill/SKILL.md")
            check("re-packaging is idempotent", first == second)
            check("source SKILL.md is never modified",
                  "disable-model-invocation: true" in (root / "skills" / "cc-skill" / "SKILL.md").read_text())
    finally:
        shutil.rmtree(root, ignore_errors=True)

    total, passed = len(results), sum(results)
    if passed == total:
        print(f"\n\033[32mAll {total} checks passed.\033[0m")
        return 0
    print(f"\n\033[31m{total - passed} of {total} checks FAILED.\033[0m")
    return 1


if __name__ == "__main__":
    sys.exit(run())
