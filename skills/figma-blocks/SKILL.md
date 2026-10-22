---
name: figma-blocks
description: Code theme blocks from Figma sections, one sonnet agent per block, each block's code and look reviewed here. Use when asked to build or code a block from a Figma URL, or when a figma-pages report lists sections that need a new block.
argument-hint: "<figma-section-url> [mobile section url] [block name] … [--model <alias>]"
---

# figma-blocks

Each block is one **figma-block-builder** agent (`dd:figma-block-builder` when the skills are
installed as the plugin): a sonnet agent with the **figma-block** skill preloaded. You are the
dispatcher and the reviewer: the agents write the code, show it on a demo page and diff it;
you settle what they share before they start, review the code and the look, and merge the
reports. One block is the same flow with one agent.

## 1. Preflight

Confirm once for all blocks:

- figma-block's requirements: the Figma MCP, the site's MCP server (if several sites are
  connected, ask which one), a checkout of the theme and its project instructions.
- Group the links into blocks: a section link, and when given, its mobile section and a
  name.
- `mcps-post-blocks` `action: "discover"`: for each block, whether an existing block already
  covers the section with a field or style variation. Ask once which of those to extend
  instead of building new.

Done when every link belongs to a named block that is either new or names the block it
extends.

## 2. Dispatch

One Agent call per block, `subagent_type: figma-block-builder`, one block at a time: the
agents share the theme's build and its demo site, and parallel builds trample each other. The
agent pins its own model; `--model <alias>` overrides it per Agent call, for cost tests
only. The prompt, filled in:

> Build the block "<name>" from `<its links>` in the theme at `<theme path>`, shown on the
> site behind the `<server name>` MCP server. <New block | Extend `<block slug>`>.

Done when the agent has returned its report.

## 3. Review

The report lists the files it changed and the demo page's run folders. Read both:

- The code, against figma-block's **3. Build** rules (read that section of its `SKILL.md`)
  and the theme's own project instructions, plus the ordinary reading of new code: how it
  differs from the similar block it was modelled on, naming, dead code.
- Each breakpoint's latest run: `triage.json`, and each section's `pixel/*.png`, which shows
  Figma beside the page.

Send the fix list to the agent with SendMessage: per item the file and line or the defect
`id`, and the change. One round: the agent rebuilds, re-diffs every breakpoint and replies
with an updated report. What remains after that is reported as it stands.

Done when every changed file has been read, every section's picture looked at at every
breakpoint, and the fix list has come back or there was none to send.

## 4. Report

- **Blocks:** per block, the files added or changed, the demo page URL, each breakpoint's
  wireframe and pixel scores and verdict, raw values used where the theme had no token, and
  the manual-review list from the agent's report.
- **Needs a decision:** what the agents listed.
- **Cost:** one line: run `/cost`. Its per-model lines are the bill; the sonnet line is the
  builders, this session's model is the review. A builder model other than sonnet there
  means the org's model allowlist or an override has silently changed the model.
