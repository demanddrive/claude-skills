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

**In Claude Code**, skills are discovered from directories Claude Code is configured to
load. Two easy options:

- **Symlink into your personal skills dir** (available in every session):
  ```bash
  ln -s "$(pwd)/skills/redirect-sheet-creator" ~/.claude/skills/redirect-sheet-creator
  ```
- **Or copy it** into `~/.claude/skills/` (no live updates when the repo changes).

Once discovered, just describe the task — Claude picks up the skill from its description.
You can also invoke one explicitly with `/redirect-sheet-creator` if it's registered as a
command in your setup.

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
