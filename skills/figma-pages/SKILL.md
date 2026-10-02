---
name: figma-pages
description: Build several WordPress pages from Figma designs at once, one agent per page, and merge their reports into one developer task list.
argument-hint: "<figma-section-or-frame-url> … [up to 5 pages at a time]"
disable-model-invocation: true
---

# figma-pages

Each page is one agent running the **figma-page** skill. You
are the dispatcher: the agents build, diff and fix content; you check the ground they share
before they start and merge what they bring back.

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

Send one Agent call per page in a single message, so they run in parallel, at most five at a
time (more pages go in a second wave). Give each agent this prompt, filled in:

> Build the page "<page name>" with the figma-page skill from `<its links>`, on
> the site behind the `<server name>` MCP server. Existing page: <replace post <id> | write a
> `Figma Preview:` page | none>. Forms: <Formidable | HubSpot portal <id>, form <id>>. The
> user can't be asked: where the skill says to ask, take the best fit and list it under
> "Needs a decision". End with the report the skill describes.

Done when every page has an agent running.

## 3. Collect

Wait for every agent's report. An agent that fails or stops early is a page to report, not to
redo silently: note what it finished and why it stopped.

Done when every page has a report or a stated failure.

## 4. Report

- **Pages:** one row per page: title, URL, `correctness` per breakpoint, the path of its
  `report.html`.
- **Developer tasks:** every defect the agents left for a developer (one no block setting or
  content fixes), merged across pages. The
  same block with the same defect on several pages (a margin, a font size) is one task
  naming each page and defect `id`. So is one block needing per-breakpoint visibility
  across pages. Sections that need a new block are tasks for figma-block.
- **Needs a decision:** refused replacements, site data (post counts, form setup), hidden
  layers that aren't proven states.
