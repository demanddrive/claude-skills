---
name: wp-update
description: "Change content on a live WordPress site through the mcp-server plugin's MCP tools: pages and posts, menus, ACF fields, site settings, media, and Formidable forms. Use when the user asks to add, change, or remove something on the site itself rather than in its code."
argument-hint: "<what to change on the site>"
---

# wp-update

Treat the request as a change to a WordPress site and make it through the mcp-server tools.

## Tools

Each mcp-server ability is one tool, named after the ability with `/` turned into `-`. The
client usually prefixes the server name, so `mcps/post-blocks` may appear as
`mcp__impulse-local__mcps-post-blocks`. Match tools on their `mcps-` name.

| Tool | Covers | Present when |
|---|---|---|
| `mcps-post-blocks` | a post's content as validated blocks | the site opts in, replacing `mcps-post` |
| `mcps-post` | a post's content as one markup string | the site has not opted in to blocks |
| `mcps-post-search` | finding posts and media by keyword, type, term, or date | default |
| `mcps-menu` | nav menus and their theme location | default |
| `mcps-acf-field` | ACF fields on an options page, a post, or a term | ACF is active |
| `mcps-site-settings` | title, tagline, front page, posts page, permalinks | default |
| `mcps-media-import` | uploading images from URLs | default |
| `mcps-formidable-form` | Formidable forms | Formidable is active |

A site can also add or drop tools through the `mcps_exposed_abilities` filter. Each tool's
schema in your tool list is the source of truth for its actions and fields. If a tool the
change needs is absent, stop and say which one. Work through these tools only. They carry the
permission checks and validation that wp-cli, the REST API, and direct SQL skip.

When tools from more than one server are connected, such as a local and a remote copy of the
same site, every write goes to one of them. Name that site in the confirm line, and ask when
the request leaves it open.

## Site facts

Menu locations, ACF fields, block shapes, and form field types belong to the site. Each tool
with site-specific input has a `discover` action that returns them, and the results are the
source of truth. Call it once per session before the first write through that tool:

- `mcps-menu` lists the theme's locations, the menu assigned to each, and every menu by name.
- `mcps-acf-field` lists a target's field groups and the JSON Schema of every field's value.
  On an option target it also lists each options page with the `post_id` its values live
  under.
- `mcps-post-blocks` returns the block catalog.
- `mcps-formidable-form` lists the field types and existing forms.

## Every write replaces

A write replaces the whole thing it targets, and anything left out of it is gone:

- `mcps-post-blocks set` replaces every block in the post.
- `mcps-post set` replaces `post_content`.
- `mcps-menu set` deletes the named menu and rebuilds it from `items`.
- `mcps-formidable-form set` removes every field the payload leaves out.
- An ACF repeater keeps only the rows sent.

So every write begins with a fresh `get` of the current state, and the payload carries forward
everything the user did not ask to change. `mcps-site-settings` and `mcps-acf-field` write only
the fields passed, so read them to confirm current values and send only the ones changing.

## Confirm

State the change in one line before making it ("I'll remove 'Blog' from `header_nav` and add
'Resources' after 'About'"). Ask first when the change replaces most of a menu, swaps a logo,
changes the front page or permalinks, rewrites a published post, or publishes anything. Small,
obvious edits go ahead directly.

## Execute

### Posts through `mcps-post-blocks`

1. Build from the catalog `discover` returned. It defines every block name, each block's
   `attrs.data` shape, and the `x-mcps` placement rules (`topLevelAllowedBlocks` per post type,
   `allowedChildren`, `postTypes`, `multiple`, `innerBlockLimit`). Recall from an earlier
   session goes stale as the theme changes. A block's attributes there are its **editor
   controls** (a heading's `level`, a `fontSize` preset, `theme`, `align`, spacing): set a look
   through them. Content carries no inline style, hex colour or px value, since an editor can't
   see or maintain it; a look no control gives belongs to the block's code, so report it.
2. Find the post. `mcps-post-search` finds an ID by keyword or title, and `get` also accepts
   `post_title` with `post_type`.
3. `get` returns `blocks` in the shape `set` accepts, and an `issues` list. A storage code in
   `issues` means the stored post holds something the block form cannot carry, and `set` on
   that post will be refused. Report those and stop. Any other code is an existing block the
   current schema rejects, which the payload has to fix.
4. Edit the returned `blocks` and `set` them with the `post_id`. Without a `post_id`, `set`
   creates a new post, even when the title matches an existing one.
5. A `validation_failed` response carries `issues`, each with a JSON Pointer `path` and a
   `code`. Patch by path and resubmit. Every code, the storage codes included, is in
   [`reference/error-codes.md`](reference/error-codes.md).

### Posts through `mcps-post`

`post_content` is stored verbatim with no validation. `get` the post, edit its content in
place with every block comment delimiter intact, and `set` it back with the `post_id`.

### Post status

New posts are drafts, and updates keep their status. Pass `post_status` only to change it, and
`"publish"` only when the user asked to publish. A post's type cannot change on update.

### Menus

`get` by `location`, edit the returned `items`, and `set` them back with the same
`menu_name` and `location`. Items round-trip as they come:

```json
{ "label": "About", "url": "https://example.com/about/", "type": "post_type", "post": "About", "children": [] }
```

Keep `post` on post-linked items and `url` on custom links. `post` resolves to a published post
by slug, then by title, across public post types, so an unpublished target fails the call.
`set` matches the menu by `menu_name`. A new name builds a second menu and moves the location
to it, leaving the old one behind. Nesting stops at four tiers of items.

### ACF fields

Every call names a `target`:

- `{ "type": "option" }` for an options page. Add `"id"` with the page's `post_id` from
  `discover` when the page stores its values somewhere other than `options`.
- `{ "type": "post", "id": 42 }` for a post's own fields, apart from its blocks.
- `{ "type": "term", "id": 5 }` for a term.

`get` takes `fields` as a list of names, or no `fields` for all of them. Its `values` come back
in the shape `update` takes, so edit them and send back only the fields that change:

```json
{ "action": "update", "target": { "type": "option" }, "fields": { "phone_number": "(555) 123-4567" } }
```

The `discover` schema defines each value. Image, file, and post fields take integer IDs. Given
an image URL, import it with `mcps-media-import` and use the ID that comes back. Image fields
inside block content work the same way. A repeater takes every row that should remain.

`update` checks every name before writing any, and reports each field as `updated`,
`unchanged`, or `failed`. Fields in a group listed under `unsupported` cannot be written through
this tool, so name them to the user.

### Site settings

`get` returns each setting under the name `set` takes. `front_page_id` is `null` while the
front page shows latest posts.

### Media

`mcps-media-import` takes `url` with optional `alt`, `title`, and `filename` for one image,
or an `images` array of up to 50. It returns an `attachment_id` and `url` per image. A source
URL imported before returns the existing attachment with `duplicate: true`, keeping its
existing alt and title.

### Forms

`get` a form by `key`, edit the returned `fields`, and `set` it back under the same `key` with
its `name`.
Fields match by `key`, so keep each existing field's key.

## Report

Say what changed in a sentence or two, with the IDs and URLs the user needs. For a created or
updated post, always give the returned `url`. On failure, name what broke, with the paths and
codes from `issues`.
