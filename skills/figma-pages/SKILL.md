---
name: figma-pages
description: Build WordPress pages from Figma designs, one sonnet agent per page, each build reviewed here, the reports merged into one developer task list. Use when asked to build, implement or post one or more pages from Figma URLs.
argument-hint: "<figma-section-or-frame-url> … [up to 5 pages at a time] [--model <alias>]"
---

# figma-pages

Each page is one **figma-page-builder** agent (`dd:figma-page-builder` when the skills are
installed as the plugin): a sonnet agent with the **figma-page** skill preloaded. You are the
dispatcher and the reviewer: the agents build, diff and fix content; you check the ground they
share before they start, review what they bring back, and merge the reports. One page is the
same flow with one agent.

## 1. Preflight

Before dispatching, confirm once for all pages:

- The Figma MCP and the site's MCP server are connected (see figma-page's Requirements). If
  several sites are connected, ask which one: every agent writes to the same site.
- Group the links into pages with `get_metadata` (parse `fileKey` and `node-id` from each). A
  Figma section node holding breakpoint frames is one page. Frame links are grouped by the
  section they sit in, or by name without its breakpoint (`Homepage - Desktop` and
  `Homepage - Mobile` are one page).
- No two pages would make the same page title.

The agents run in the background, where they can't ask the user, so settle figma-page's
questions now and pass the answers down:

- **Existing pages**: `mcps-post-search` for each frame's page title. Ask once which of the
  pages found to replace.
- **Live site**: pages are published so the diff can load them; on a live site, get the
  go-ahead.
- **Forms**: Formidable, unless the user gave HubSpot portal and form ids.

Done when every link belongs to a named page, the target site is settled, and every existing
page has a replace-or-preview answer.

## 2. Dispatch

Send one Agent call per page in a single message, `subagent_type: figma-page-builder`, so
they run in parallel, at most five at a time (more pages go in a second wave). The agent pins
its own model; `--model <alias>` overrides it per Agent call, for cost tests only. Give each
agent this prompt, filled in:

> Build the page "<page name>" from `<its links>`, on the site behind the `<server name>`
> MCP server. Existing page: <replace post <id> | write a `Figma Preview:` page | none>.
> Forms: <Formidable | HubSpot portal <id>, form <id>>.

Done when every page has an agent running.

## 3. Collect

Wait for every agent's report. An agent that fails or stops early is a page to report, not to
redo silently: note what it finished and why it stopped.

Done when every page has a report or a stated failure.

## 4. Review

A report is the builder's claim; the run folders are the evidence. For each page and
breakpoint, open the latest run (the paths the report gives, or
`<runs>/<page-slug>/<width>/latest/`): read `triage.json`, and look at each section's
`pixel/*.png`, which shows Figma beside the page.

A fix the builder still owes is one of:

- A defect with `owner` `page` or `page-or-developer` that a block setting or a content
  change fixes, by figma-page's rules, and the report rules out with no stated setting.
- What the diff can't see and the picture shows: a wrong block or style variant, items in
  the wrong order, a missing item, placeholder copy.

Send the page's fix list to its agent with SendMessage: per item the section, the defect
`id` (or what the picture shows) and the setting or content change to make. The agent
re-diffs every breakpoint and replies with an updated report. Two rounds per page at most;
what remains after that is reported as it stands. Developer defects stay with the developer.

Done when every section's picture has been looked at, at every breakpoint of every page, and
every fix list has come back or hit the cap.

## 5. Report

- **Pages:** one row per page: title, URL, `correctness` per breakpoint, the path of its
  `report.html`.
- **Developer tasks:** every defect the agents left for a developer (one no block setting or
  content fixes), merged across pages. The
  same block with the same defect on several pages (a margin, a font size) is one task
  naming each page and defect `id`. So is one block needing per-breakpoint visibility
  across pages. Sections that need a new block are tasks for figma-blocks.
- **Needs a decision:** refused replacements, site data (post counts, form setup), hidden
  layers that aren't proven states.
- **Cost:** one line: run `/cost`. Its per-model lines are the bill, priced by Claude Code
  itself; the sonnet line is the builders, this session's model is the review. A builder
  model other than sonnet there means the org's model allowlist or an override has silently
  changed the model.
