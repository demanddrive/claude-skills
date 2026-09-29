# What figma-visual-diff measures

What each defect compares, and what is left out on purpose. Back to the steps:
[`SKILL.md`](SKILL.md).

## `triage.json`

It follows `triage.schema.json` (triage validates it before writing). Every section (module)
has a `verdict`, its most severe defect kind, and a `defects` list with one entry per problem:
a missing logo, a changed heading and a short padding are three defects. Each defect has an
`id` (`<section>.<n>`), `kind`, `issue`, `owner`, a one-line `summary`, and the values on both
sides: `figma` and `page` (an element box, or px for `height`/`spacing`) plus the `delta`.
Element boxes are px at the breakpoint, relative to the top-left of the section on that side.
Section-level `structure` defects list sections missing or out of order.

## Copy

A `copy` defect is one element whose words differ: texts with different copy pair only where
the element was plausibly reworded in place, its top within a line of where the section's
matched elements put it. A text that is neither there nor beside a text with the same copy is
another element, and reads as a `missing` one and an `extra` one (a form's "Company" field
and a "File upload" field in its place, not "Company" reworded). With no text of the same copy
nearby (a design still in placeholder copy), texts pair by position.

## Spacing

`spacing` defects compare the space you see, edge to edge, however each side builds it: Figma
with auto-layout gaps and Text Block padding, the page with CSS margins (which collapse) and
padding. Three spaces are compared (`where`): `between` two neighbouring elements (stacked or
side by side, nothing between them on either side), `inside` an element from its edge to the
content nearest it (a card's padding), and from the section's `edge` to its content.

Each carries the margins in the space on both sides (`margins`: in Figma the Text Block's
vertical padding, on the page the CSS margin), which say where to fix it: "92px in Figma (72
padding + 20 margin), 73px on the page (73 padding + 0 margin)" is a missing margin, not a
padding change. A difference counts when it's over a quarter of the Figma space, at least 4px
and at most the tolerance; spaces with the same difference are one defect (`count`). The page
is measured again at a taller viewport, and a space that changes with the viewport's height (a
`100vh` slide, a `min-height` hero) isn't a design value, so it isn't compared.

## Styles

`style` defects compare design tokens between the same element on both sides: font, size, line
height, weight, text colour, letter spacing, italic, underline or strike-through, and the case the
letters are drawn in (upper, lower, title, sentence or mixed; Figma's text case and CSS
`text-transform` applied, and none for under 3 letters), plus text alignment once text wraps.
A text's style is the one on at least 60% of its letters, on both sides (a heading with one
bold word is regular); where no value covers that much, that token isn't compared. Font names
compare without case, spaces or a variable font's suffix. Texts from a Figma file extracted
before this was read by runs keep their first character's style, compared with the page's
first character's. Then a surface's fill, corner
radius and border; an image's corner radius and border. Corners are compared one by one and
borders side by side (a bottom-only divider isn't a full border). A border only one side has
counts only where the other side draws no line along that edge at all, since it may draw the
same line another way: both sides record every line they visibly draw (borders, outlines, box-shadow
rings, gradients, `::before`/`::after` rules and thin elements on the page; strokes, LINE
layers, thin fills and tight shadows in Figma), and a line within 3px of the edge along half
its length draws it. A Figma file extracted before lines were recorded can't say which sides a
border has, so such a side isn't judged until the frame is extracted again. A Figma frame drawn
around an image is compared with the page image's border directly. An image's
corners are its own, or those of a frame, mask or wrapper (`overflow: hidden`, `clip-path`)
that clips it, for each corner they share (a rounded card rounds the top corners of the photo
along its top). Elliptical corners (an oval, a percentage of a box that isn't square) and other
clip shapes have no one radius and aren't compared, and radii are fitted to their box as CSS
draws them (a 999px pill is half its height). An image from a Figma file extracted before
images had corners has none to compare until the frame is extracted again. One defect covers
every element with the same difference (`count`). Text is compared only where both sides say
the same thing; in `live` sections, whose copy comes from the posts, each text style the design
uses must appear somewhere on the page (`text-style`, with the closest page style).

## Wrapped text

Text over several lines ends its lines unevenly: its ink is as wide as its longest line,
wherever the lines broke. So its width compares by its text box (where lines may run: Figma's
text layer, the page element's content box; `textBox` on a `resized` defect), and no space is
measured from its uneven side (the right of left-aligned text, both sides of centred text).
Figma inputs extracted before text boxes were recorded have none, so wrapped text's width isn't
compared until the frame is extracted again.

## Images

Images scale with their column, so only a different aspect ratio (more than 2%) is a defect
(`aspect`).

## What is compared

Only what's on screen, on both sides. Content clipped by an `overflow` box on the page or a
frame with "Clip content" in Figma (a carousel's other slides), screen-reader-only text and
hidden elements aren't extracted. An element cut off on either side is checked for presence
only, not size, shape or style. Text sizes are compared only between the same words, a fill
under an image covering it isn't compared, and a space is compared only where the same
elements bound it on both sides (for text, the same words); otherwise it measures a content
difference, reported as such. A section's background holds no spaces of its own: the space
inside it is the space to the section's edge.

Elements that only moved aren't defects: they follow from something above changing size, and
the overlays show them. An element of a different size is a `resized` defect in any section,
even one that otherwise passes: over 8px for text (its box follows the font's metrics), over
3px for any other box (an input, a button, a card). A section taller or shorter by over 16px is
a `height` defect.

Sliders are compared too: before measuring, the scripts interact once (so scripts delayed until
interaction, e.g. by caching plugins, run), stop autoplay and park Swiper sliders on their
first real slide.

## Jev

With a Jev key set, Jev (a model that answers typed questions with calibrated probabilities)
judges what the rules can't: every defect gets `matters`, the probability that a careful
reviewer would ask for it to be fixed, and each compared section a `diagnosis.correct`, the
probability they'd accept it. A defect at 0.2 or below is likely noise, but it's still
measured: say so when reporting it. Sections with `correct` between 0.2 and 0.8 need a person
to look.

## Metrics

`metrics` measures the build: `correctness` is the share of Figma sections on the page with no
defects (missing sections count against it, `dynamic` ones are left out; 1 is correct), with
section counts, defect counts by kind and owner, the wireframe and pixel scores, and with Jev
`diagnosis.expectedCorrectness` (the expected share of sections a reviewer would accept) and
`diagnosis.expectedFixes` (the expected number of defects they'd ask to fix). `metricsDelta` is
the change since the previous run. Each run also appends its metrics to `metrics.jsonl` in the
page/breakpoint runs folder, which keeps the build's history after old runs are pruned.

## `report.html`

For a person reviewing each defect. A list on the left holds every defect, grouped by module
and ordered by how worth fixing Jev thinks it is; each module row carries its rule verdict,
Jev's judgement and a flag where they disagree (rules pass a module Jev wouldn't sign off,
defects Jev thinks nobody would ask to fix). Filters narrow it by kind, owner, Jev's call or
disagreements. The pane on the right shows one defect: large Figma and page crops around it,
its values on both sides, and the whole section with it outlined. A module row shows the
module: Jev's answers, what Jev was shown and asked, and the overlays. Previous and Next step
through the defects the filters leave. Swipe stacks Figma and the page in one frame, split at a
divider you drag, for the crops and the whole section. Copy ticket copies the defect as
markdown with its link: `report.html#d-<id>` (e.g. `#d-9.6`) opens with that defect shown.

## Overlays

- `wireframe/<n>-<slug>.png`: Figma boxes red, page boxes blue; thick boxes are unmatched.
  Padding bands are tinted the same way (purple where both agree), and a line in each colour
  marks that side's section bottom.
- `pixel/<n>-<slug>.png`: Figma | page | diff, both sections whole and lined up row by row at
  the elements matched on both sides, like a side-by-side text diff. Grey stripes are gaps:
  rows only the other side has (more space, an extra field, a line more of text). In the diff
  panel, content in a gap shows red, since the other side doesn't have it; extra space alone
  costs nothing, so read spacing from the `spacing` defects, not the panels. Images present on both
  sides are masked so placeholder photos don't count as differences: the Figma and page panels
  show them as they are, and the diff panel paints them magenta.
