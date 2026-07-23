# Internal Skills

A collection of [Claude Code](https://docs.claude.com/en/docs/claude-code) skills our team
maintains and shares. Each skill lives under `skills/<name>/` and packages a repeatable
workflow — instructions plus any helper scripts and assets — so anyone can invoke it
instead of reinventing the process each time.

## Skills

| Skill | What it does |
|-------|--------------|
| [`redirect-sheet-creator`](skills/redirect-sheet-creator/) | Builds a 301 redirect sheet mapping a production sitemap onto a new/staging site for a migration — exact + semantic matching, loop/chain validation, Excel + CSV output. |

## Using a skill

**These skills auto-load when you run Claude Code from inside this repo.** Claude Code
discovers skills in `.claude/skills/`, and this repo keeps that folder populated via
symlinks back to `skills/<name>/` (so there's only one real copy to maintain). Clone the
repo, open Claude Code in it, and the skills are available — no setup.

```bash
git clone <repo-url> && cd <repo>
# ...run Claude Code here; skills are already discoverable.
```

To describe the task in plain language is enough — Claude triggers a skill from its
description. You can also invoke one explicitly by name, e.g. `/redirect-sheet-creator`.

**To use a skill outside this repo** (in your other projects), symlink it into your
personal skills dir so it's available in every session:

```bash
ln -s "$(pwd)/skills/redirect-sheet-creator" ~/.claude/skills/redirect-sheet-creator
```

> **Note on symlinks:** the `.claude/skills/` entries are git-tracked symlinks. On Windows,
> or if you cloned with symlink support disabled, they may not resolve — enable symlinks
> (`git config core.symlinks true` and re-checkout) or copy `skills/<name>/` into
> `.claude/skills/` manually.

Each skill's own `README.md` documents what it does; the real instructions Claude follows
live in that skill's `SKILL.md`.

## Repo layout

```
skills/
  <skill-name>/
    SKILL.md          # the skill itself (instructions Claude follows)
    scripts/          # helper scripts the skill calls
    assets/           # templates / reference files used in output
    evals/            # test prompts + fixtures for validating the skill
    README.md         # human-facing overview
```

## Contributing / maintaining a skill

Skills are built and iterated with the `skill-creator` skill, which runs test cases and
opens a review viewer so you can see outputs before shipping changes. In short:

1. Edit the skill under `skills/<name>/` (usually `SKILL.md` and/or its scripts).
2. Re-run its evals (see the skill's `evals/evals.json` for the test prompts) to confirm
   nothing regressed.
3. Commit and open a PR.

Eval **run outputs** are intentionally git-ignored (they're large and regenerated each
run); only the reproducible inputs — `evals/evals.json` and `evals/fixtures/` — are
committed, so anyone can re-run the tests.
