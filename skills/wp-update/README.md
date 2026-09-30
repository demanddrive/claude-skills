# wp-update

Changes content on a live WordPress site through the tools the
[mcp-server](https://github.com/demanddrive/mcp-server) plugin exposes: pages and posts,
nav menus, ACF fields, site settings, media, and Formidable forms.

Describe the change in plain language ("add Resources to the header nav after About", "swap the
footer logo for this image") or run `/wp-update <change>`.

## Requirements

- The site runs mcp-server, and your client is connected to its MCP endpoint.
- Block-level page editing needs the site to expose `mcps/post-blocks` in place of `mcps/post`.
  Without it, the skill edits post content as a markup string with no validation.
- ACF fields and Formidable forms need those plugins active on the site.

## Site facts

Menu locations, ACF fields, block shapes, and form field types come from each tool's `discover`
action, so the skill needs no access to the theme's source. It works the same from Claude Code,
Claude chat, or any other MCP client.

## Files

- `SKILL.md` holds the instructions the agent follows.
- `reference/error-codes.md` lists every `mcps-post-blocks` validation and storage code with
  its recovery. The agent reads it when a write is rejected.

Both mirror mcp-server's current behaviour. When the plugin changes a tool's shape or adds an
error code, update them to match.
