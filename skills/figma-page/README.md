# figma-page

Builds a WordPress page from a Figma frame out of the blocks the site already has, then
checks the result with [`figma-visual-diff`](../figma-visual-diff/).

1. Reads the frame's sections through the Figma MCP.
2. Reads the site's block schema (`mcps-post-blocks` → `discover`) from the site's MCP server
   ([demanddrive/mcp-server](https://github.com/demanddrive/mcp-server)).
3. Maps each section to a block, fills in the copy, text presets and imported images, and writes the
   page. The server validates every write against the blocks registered on that site.
4. Runs figma-visual-diff per breakpoint and fixes page-side findings until only developer
   or site-data findings remain.

Sections with no matching block are handed to [`figma-block`](../figma-block/).

## Requirements

- Figma MCP at user scope: `claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`
- The site's MCP server: `claude mcp add --transport http <name> https://<site>/wp-json/mcp/mcp`, then `/mcp`
