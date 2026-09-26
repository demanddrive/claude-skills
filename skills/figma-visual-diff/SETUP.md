# figma-visual-diff setup

Once per machine. Back to the steps: [`SKILL.md`](SKILL.md).

## Figma MCP

`use_figma` and `get_screenshot` come from the Figma MCP. Without them, stop and ask the user
to add it at user scope:
`claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`, then `/mcp`.

## Browser and packages

When a script can't find `playwright` or reports that no Chromium was found:

```bash
node <skill-dir>/scripts/config.js setup
```

It installs the npm dependencies when they're missing (an installed plugin gets them
automatically) and downloads Playwright's Chromium.

## Jev

Jev's diagnoses need a provider key in the environment Claude Code runs in. The default
provider is OpenCode Zen: `OPENCODE_API_KEY` (its `jev-1.13-free` model is free). Another
endpoint speaking TypeSafe's System One API (TypeSafe itself, a local router) goes in
`~/.config/figma-visual-diff/config.json`, or a project's `.figma-visual-diff.json`:

```json
{ "jev": { "url": "http://127.0.0.1:20128/v1/systemone", "model": "oc/jev-1.13-free", "keyEnv": "NINEROUTER_API_KEY" } }
```

`keyEnv` names the environment variable holding the key; keys stay out of config files. An
HTTPS endpoint with a local certificate (mkcert) needs Node to trust it:
`NODE_OPTIONS=--use-system-ca` or `NODE_EXTRA_CA_CERTS=$(mkcert -CAROOT)/rootCA.pem`.
Without a key, triage still measures everything and names the variable to set.
