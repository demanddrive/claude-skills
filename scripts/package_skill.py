#!/usr/bin/env python3
"""Package a skill under skills/ into a zip uploadable to claude.ai.

claude.ai takes skills as zip uploads (Settings > Capabilities > Skills). The zip
must contain a single top-level directory holding SKILL.md. Its frontmatter is
validated against `name` + `description` only, so Claude Code-specific keys are
stripped rather than shipped -- an unrecognized key risks rejection at upload.

Usage:
    python3 scripts/package_skill.py redirect-sheet-creator
    python3 scripts/package_skill.py --all
    python3 scripts/package_skill.py --list
"""

import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILLS_DIR = REPO / "skills"
DIST_DIR = REPO / "dist"

# Frontmatter keys claude.ai does not recognize. Claude Code reads these, but
# claude.ai validates name+description only, so they're dropped from the shipped
# copy. `disable-model-invocation` is the consequential one: without it the skill
# becomes model-invocable on claude.ai (auto-triggered from its description)
# rather than explicit-invoke only. That's reported, not silently accepted.
CLAUDE_CODE_ONLY_KEYS = ("disable-model-invocation", "allowed-tools", "license", "model")

# Dev-only directories. Fixtures and eval definitions are for maintaining the
# skill, not running it, so they'd be dead weight in the upload container.
EXCLUDE_DIRS = ("tests", "evals", "__pycache__", ".venv", "venv", ".git", ".pytest_cache")
EXCLUDE_FILES = (".DS_Store", ".gitignore")
EXCLUDE_SUFFIXES = (".pyc", ".pyo", ".swp")

# claude.ai frontmatter limits (docs: agent-skills/overview#skill-structure).
NAME_MAX = 64
DESC_MAX = 1024
NAME_RE = re.compile(r"^[a-z0-9-]+$")
RESERVED_WORDS = ("anthropic", "claude")

# Upload-size guardrail. Not a documented claude.ai cap -- a sanity check that
# catches an accidentally-committed database or video before upload, not a limit
# the platform enforces.
WARN_SIZE_MB = 20


class SkillError(Exception):
    """A packaging problem worth stopping for."""


def parse_frontmatter(text, skill_path):
    """Split SKILL.md into (frontmatter_lines, body). Raises if absent."""
    if not text.startswith("---"):
        raise SkillError(f"{skill_path}: SKILL.md has no YAML frontmatter (must start with '---')")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise SkillError(f"{skill_path}: SKILL.md frontmatter is not closed with '---'")
    return parts[1].strip("\n").split("\n"), parts[2]


def read_field(lines, key):
    """Read a top-level scalar frontmatter field. Returns None if absent.

    Handles values wrapped onto continuation lines (a plain YAML scalar may run
    across several indented lines), which matters because descriptions are long
    and hand-wrapped -- measuring only the first line would under-count against
    the 1024-char limit and let an over-long description through.
    """
    prefix = f"{key}:"
    for i, line in enumerate(lines):
        if not line.startswith(prefix):
            continue
        value = line[len(prefix):].strip()
        for cont in lines[i + 1:]:
            # A new top-level key ends the value; indented/bare text continues it.
            if re.match(r"^[a-zA-Z0-9_-]+:", cont):
                break
            if not cont.strip():
                break
            value += " " + cont.strip()
        return value
    return None


def strip_keys(lines, keys):
    """Drop the named top-level keys. Returns (kept_lines, removed_key_names)."""
    kept, removed = [], []
    skipping = False
    for line in lines:
        matched = next((k for k in keys if line.startswith(f"{k}:")), None)
        if matched:
            removed.append(matched)
            skipping = True
            continue
        # Continuation lines of a removed key go with it.
        if skipping:
            if re.match(r"^[a-zA-Z0-9_-]+:", line) or not line.strip():
                skipping = False
            else:
                continue
        kept.append(line)
    return kept, removed


def validate(name, description, skill_dir_name, skill_path):
    """Check frontmatter against claude.ai's documented constraints."""
    problems = []
    if not name:
        problems.append("frontmatter is missing required field `name`")
    else:
        if len(name) > NAME_MAX:
            problems.append(f"`name` is {len(name)} chars (max {NAME_MAX})")
        if not NAME_RE.match(name):
            problems.append(f"`name` must be lowercase letters, numbers, and hyphens only: {name!r}")
        for word in RESERVED_WORDS:
            if word in name.lower():
                problems.append(f"`name` contains reserved word {word!r}")
        if name != skill_dir_name:
            # The upload uses the directory name; a mismatch means the skill
            # shows up under a different name than its frontmatter claims.
            problems.append(f"`name` ({name!r}) does not match directory name ({skill_dir_name!r})")
    if not description:
        problems.append("frontmatter is missing required field `description`")
    elif len(description) > DESC_MAX:
        problems.append(f"`description` is {len(description)} chars (max {DESC_MAX})")
    for field, value in (("name", name), ("description", description)):
        if value and re.search(r"<[^>]+>", value):
            problems.append(f"`{field}` cannot contain XML tags")
    if problems:
        raise SkillError(f"{skill_path}:\n" + "\n".join(f"  - {p}" for p in problems))


def included_files(src):
    """Walk the skill directory, yielding files that belong in the upload."""
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        if any(part in EXCLUDE_DIRS for part in rel.parts):
            continue
        if path.is_dir():
            continue
        if path.name in EXCLUDE_FILES or path.suffix in EXCLUDE_SUFFIXES:
            continue
        yield path, rel


def package(skill_name, out_dir, quiet=False):
    """Build one skill's zip. Returns (zip_path, list_of_notes)."""
    src = SKILLS_DIR / skill_name
    if not src.is_dir():
        raise SkillError(f"no such skill: skills/{skill_name}")
    skill_md = src / "SKILL.md"
    if not skill_md.is_file():
        raise SkillError(f"skills/{skill_name}: no SKILL.md")

    notes = []
    text = skill_md.read_text()
    fm_lines, body = parse_frontmatter(text, f"skills/{skill_name}")

    name = read_field(fm_lines, "name")
    description = read_field(fm_lines, "description")
    validate(name, description, skill_name, f"skills/{skill_name}")

    kept, removed = strip_keys(fm_lines, CLAUDE_CODE_ONLY_KEYS)
    for key in removed:
        if key == "disable-model-invocation":
            notes.append(
                "stripped `disable-model-invocation` — on claude.ai this skill becomes "
                "model-invocable (auto-triggered from its description)"
            )
        else:
            notes.append(f"stripped `{key}` (not read by claude.ai)")

    packaged_md = "---\n" + "\n".join(kept) + "\n---" + body

    # Flag references to paths that were excluded, so SKILL.md doesn't point the
    # model at files absent from the container.
    for pattern, label in ((r"\btests?/", "tests/"), (r"\bevals?/", "evals/")):
        if re.search(pattern, body):
            notes.append(f"SKILL.md references {label} which is excluded from the package — check it still reads correctly")

    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / f"{skill_name}.zip"
    total = count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # SKILL.md is written from memory (frontmatter modified); everything else copies.
        zf.writestr(f"{skill_name}/SKILL.md", packaged_md)
        count += 1
        total += len(packaged_md.encode())
        for path, rel in included_files(src):
            if rel.as_posix() == "SKILL.md":
                continue
            zf.write(path, f"{skill_name}/{rel.as_posix()}")
            count += 1
            total += path.stat().st_size

    size_mb = total / 1_000_000
    if size_mb > WARN_SIZE_MB:
        notes.append(f"uncompressed contents are {size_mb:.1f} MB — large for an upload, check for stray files")

    if not quiet:
        zipped = zip_path.stat().st_size
        print(f"  {zip_path.relative_to(REPO)}  ({count} files, {zipped / 1024:.0f} KB)")
        for note in notes:
            print(f"    note: {note}")
    return zip_path, notes


def list_skills():
    return sorted(p.name for p in SKILLS_DIR.iterdir() if (p / "SKILL.md").is_file())


def main():
    ap = argparse.ArgumentParser(
        description="Package skills under skills/ into zips uploadable to claude.ai.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Upload the resulting zip at claude.ai > Settings > Capabilities > Skills.",
    )
    ap.add_argument("skill", nargs="*", help="skill name(s) under skills/ (default: prompt via --list)")
    ap.add_argument("--all", action="store_true", help="package every skill")
    ap.add_argument("--list", action="store_true", help="list packageable skills and exit")
    ap.add_argument("-o", "--out", default=str(DIST_DIR), help="output directory (default: dist/)")
    ap.add_argument("--clean", action="store_true", help="remove the output directory first")
    args = ap.parse_args()

    available = list_skills()
    if args.list:
        for name in available:
            print(name)
        return 0

    targets = available if args.all else args.skill
    if not targets:
        ap.error("name at least one skill, or pass --all (see --list)")

    unknown = [t for t in targets if t not in available]
    if unknown:
        print(f"error: no such skill: {', '.join(unknown)}", file=sys.stderr)
        print(f"available: {', '.join(available)}", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = REPO / out_dir
    if args.clean and out_dir.exists():
        shutil.rmtree(out_dir)

    print(f"Packaging {len(targets)} skill(s) for claude.ai upload:")
    failed = []
    for name in targets:
        try:
            package(name, out_dir)
        except SkillError as e:
            print(f"  {name}: FAILED", file=sys.stderr)
            print(f"    {e}", file=sys.stderr)
            failed.append(name)

    if failed:
        print(f"\n{len(failed)} skill(s) failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("\nUpload at claude.ai > Settings > Capabilities > Skills > Upload skill.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
