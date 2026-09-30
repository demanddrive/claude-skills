# `mcps-post-blocks` error codes

`set` checks the whole payload before writing anything and returns every issue in one
response:

```json
{
  "success": false,
  "error": "{\"error\":\"validation_failed\",\"issues\":[...]}",
  "error_code": "validation_failed",
  "issues": [
    { "path": "/blocks/2/blockName", "code": "unknown_block", "received": "acf/hero" }
  ]
}
```

`error` repeats the issues as a JSON string for clients that surface only that field. Each
issue's `path` is a JSON Pointer into the request. Patch by path and resubmit.

Issues with other codes come from two places. The **payload codes** below are problems in what
you sent, and the payload fixes them. The **storage codes** at the end describe the post as it
is stored, and no payload fixes them.

## How to read the path

The path points at the exact offending value, never its container.

- `/blocks/0` is the first block in the request.
- `/blocks/0/innerBlocks/1/blockName` is the second child of the first block.
- `/blocks/0/attrs/data/buttons/2/link` is the third button's link inside the first block's
  `buttons` repeater.

## Payload codes

### `unknown_block`

`blockName` is not in the `discover` catalog.

Fields: `received`, and `suggestion` when a registered name is within an edit distance of two.

**Recovery:** use the `suggestion` when it matches the user's intent, otherwise pick a block
from the catalog.

### `block_requires_parent`

A block that exists only inside a parent, such as `core/column`, sits at the top level.

Fields: `blockName`, `allowedParents`.

**Recovery:** wrap it in one of `allowedParents`.

### `block_not_allowed_here`

A child block is not in its parent's `allowedChildren`. Its own fields go unchecked until it is
placed legally, so expect new issues on resubmit.

Fields: `received` (the child), `parent`, `allowed`, and `allowedParents` when the child
requires a particular parent.

**Recovery:** pick a block from `allowed`, or move the child to a level where it is allowed.

### `block_not_allowed_at_top_level`

The site keeps blocks matching `pattern` off the top level of this post type.

Fields: `blockName`, `postType`, `pattern`.

**Recovery:** nest the block inside a layout block from `x-mcps.topLevelAllowedBlocks` for the
post type.

### `block_not_allowed_on_post_type`

The block is restricted to other post types. This holds at any depth.

Fields: `blockName`, `postType`, `allowed`.

**Recovery:** remove the block or choose another. If the user meant a different post type,
confirm the target.

### `block_must_be_unique`

A block that disallows multiples appears more than once in the post. `path` points at each
duplicate, and the first occurrence is kept.

Fields: `blockName`.

**Recovery:** remove the duplicates. When the user wants two, this block cannot do it, so pick
another.

### `too_many_of_block`

A parent's `innerBlockLimit` is exceeded. `path` points at the parent's `innerBlocks`.

Fields: `limit` and `received`. For a total cap, `blockName` is the parent. For a per-child
cap, `blockName` is the child and `parent` names the parent.

**Recovery:** trim the children to `limit`.

### `unknown_field`

A property under `attrs.data`, or directly under `attrs`, is not defined for the block.

Fields: `blockName`, `received` (the property), and `suggestion` when a defined field is
within an edit distance of two.

**Recovery:** rename to the `suggestion`, or drop the field and check the block's shape in the
catalog.

### `missing_required_field`

A required ACF field is absent.

Fields: `blockName`, `field`.

**Recovery:** add the field with a valid value.

### `invalid_field_value`

A value has the right place but the wrong content: wrong type, outside an enum, a malformed
object.

Fields, depending on the violation: `blockName`, `expected`, `received`, `received_type` for a
type mismatch, `keyword` and `message` for rarer schema rules.

**Common cases:**

- **Link as a string:** a link field is an object `{ url, title?, target? }`, never a
  JSON-encoded string.
- **Image as a URL:** an image field is an integer attachment ID. Import the URL with
  `mcps-media-import` first.
- **Value outside the enum:** pick one from `expected`.
- **Boolean as a string:** true/false fields take a boolean or `0`/`1`. `"true"` fails.

### `invalid_block_shape`

The item is not an object with a `blockName`. This is a payload construction bug.

**Recovery:** rebuild the block with at least `{ "blockName": "..." }`.

### `invalid_inner_content_mapping`

`innerContent` must hold one `null` placeholder per inner block, and the counts differ.

Fields: `blockName`, `children`, `placeholders`.

**Recovery:** add or remove `null` entries in `innerContent` until `placeholders` equals
`children`.

### `missing_sourced_content_markup`

The block's text lives in its saved markup, and the payload set it in `attrs` with no markup.
Serializing would drop that text.

Fields: `blockName`, `attribute`, `message`.

**Recovery:** put the text in `innerContent` as the block's markup, such as
`"<p>Hello</p>"` for a paragraph's `content`.

### `list_wrapper_markup_required`

A `core/list` arrived without wrapper markup and carries attributes the server cannot turn into
the wrapper's classes or styles. Without them the list renders unstyled.

Fields: `blockName`, `attributes` (the ones it cannot reproduce, such as `fontSize` or
`style`), `message`.

**Recovery:** send `innerContent` as the opening tag with those classes and styles
(`"<ul class=\"wp-block-list has-small-font-size\">"`), one `null` per item, then `"</ul>"`.
Or drop the attributes when the design does not need them.

### `preset_class_in_classname`

`className` holds a class WordPress generates from an attribute, such as `has-t-2-font-size`,
`has-text-align-center`, or `has-primary-color`. Typed into `className` it bypasses the
preset, and a misspelling like `has-t2-font-size` matches no theme CSS.

Fields: `blockName`, `received` (the class), `message` (names the attribute to set).

**Recovery:** remove the class from `className` and set the named attribute, such as
`fontSize: "t2"`. The generated class stays in the element's markup.

### `font_size_markup_mismatch`

The block's outer element and `attrs.fontSize` disagree, which the editor rejects as unexpected
content.

Fields: `blockName`, `message`, `expected` (the class `attrs.fontSize` requires), and
`received` (font size classes in the markup no attribute accounts for). The slug is
kebab-cased, so `t2` becomes `has-t-2-font-size`.

**Recovery:** give the outer element exactly the `expected` class, or drop `fontSize` and the
class together.

## Storage codes

These appear in the `issues` of a `get`, and they are why `set` refuses an update with
`error_code: "unsafe_existing_post_replacement"`. That refusal returns the post's `raw_blocks`
beside the issues. Replacing the post would lose the stored data they point at, so the server
refuses until the stored post is fixed. Report the paths and codes to the user and stop.
`path` points into the stored post, not into a payload.

| Code | What is stored |
|---|---|
| `unsupported_freeform_content` | HTML outside any block, as in classic editor content |
| `unsupported_stored_field` | an ACF value the block's field groups do not define |
| `unsupported_acf_reference` | an ACF field reference with no recognised value beside it |
| `acf_field_reference_mismatch` | a value whose field reference names a different field |
| `unsupported_acf_id_value` | an ID field holding something other than a whole number |
| `invalid_acf_uid` | an ACF `uid` that is empty or not a string |
| `empty_required_stored_field` | a required field saved empty |
| `invalid_repeater_row_count` | a repeater row count that is not a whole number |
| `inconsistent_repeater_row_count` | a repeater row count that disagrees with its stored rows |
| `missing_repeater_subfield` | a required sub-field missing from a repeater row |
