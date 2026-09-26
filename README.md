# Internal Skills

A collection of [Claude Code](https://docs.claude.com/en/docs/claude-code) skills our team
maintains and shares. Each skill lives under `skills/<name>/` and packages a repeatable
workflow — instructions plus any helper scripts and assets — so anyone can invoke it
instead of reinventing the process each time.

## Skills

| Skill | What it does |
|-------|--------------|
| [`redirect-sheet-creator`](skills/redirect-sheet-creator/) | Builds a 301 redirect sheet mapping a production sitemap onto a new/staging site for a migration — exact + semantic matching, loop/chain validation, Excel workbook output. |

## Installing as a plugin

The repo is also a Claude Code plugin marketplace, so the skills can be installed once and
used in every project, and updated in place:

```text
/plugin marketplace add demanddrive/claude-skills
/plugin install demanddrive-skills@demanddrive
```

Update with `/plugin marketplace update demanddrive`. Installed skills are namespaced, e.g.
`/demanddrive-skills:figma-visual-diff`. If your GitHub access goes through an SSH host alias
(e.g. `git@workgit:…`), add the marketplace by URL instead:
`/plugin marketplace add git@workgit:demanddrive/claude-skills.git`.

To have a project offer the skills to everyone who opens it, add to its `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "demanddrive": { "source": { "source": "github", "repo": "demanddrive/claude-skills" } }
  },
  "enabledPlugins": { "demanddrive-skills@demanddrive": true }
}
```

When a skill changes, bump `version` in `.claude-plugin/plugin.json` so installs pick it up.

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
.claude-plugin/
  plugin.json         # the repo as one plugin: every skill under skills/
  marketplace.json    # the repo as a marketplace listing that plugin
package.json          # Node dependencies for skills that need them
skills/
  <skill-name>/
    SKILL.md          # the skill itself (instructions Claude follows)
    scripts/          # helper scripts the skill calls
    assets/           # templates / reference files used in output
    tests/            # runnable regression tests + offline fixtures
    README.md         # human-facing overview
```

## Contributing / maintaining a skill

Skills are built and iterated with the `skill-creator` skill, which runs test cases and
opens a review viewer so you can see outputs before shipping changes. In short:

1. Edit the skill under `skills/<name>/` (usually `SKILL.md` and/or its scripts).
2. Run its tests (`./tests/test.sh`) to confirm nothing regressed.
3. Commit and open a PR.

**Where a skill leans on a script, test the script.** A skill's real guarantees live in its
code, so prefer a runnable `tests/test.sh` that exits nonzero on regression over prose
describing intended behavior. Keep fixtures offline — tests that hit live third-party sites
can't pass deterministically. Sanity-check a new assertion by breaking the guard it covers
and confirming it fails; an assertion that never fails is worse than none, because it reads
like coverage.

Keep `SKILL.md` to what the model must decide. Rules the script already enforces don't need
restating there — that prose goes stale against the code and costs context on every run.

Write and review skills against Matt Pocock's
[`writing-for-agents`](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents)
skill: sharp descriptions, steps that end on a checkable "done when", reference moved into
sibling files behind a pointer saying when to read it.

> `redirect-sheet-creator` follows this pattern.
