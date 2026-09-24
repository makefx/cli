# Changelog

The 1.x packages were built from the first version of makefx.app and do not
work with the current service.

## 2.0.1 — 2026-09-24

- Always print the login authorization URL, callback port, and an SSH tunnel command with the detected hostname so remote login can be completed from a local browser.

## 2.0.0 — 2026-09-24

### One canvas for you and your agent

- Rebuilt the CLI for makefx.app v2: every command acts on the same space, assets, and recipes that the web canvas and MCP clients see.
- `create` reads the live model catalog for the paying space, applies its defaults, and refuses invalid settings before spending credits; `estimate` quotes the same request first, and `--from-asset` replays a recipe as `current` or `exact`.
- `upload` and `download` stream media through signed URLs, and `export` writes the space document; existing files are never overwritten.
- `audio align` and `audio timings` manage word timings for ready audio.
- `purchase create` prepares a credit purchase without taking card data, and `purchase get` reads its status.
- `space publish` and `space unpublish` change a space's public snapshot, and `open` prints and opens a space or asset URL.
- `mcp` relays a local stdio MCP client to the hosted endpoint with your stored login.
- `--version` prints the installed version.

### Open source

- The CLI is now developed in the open at github.com/makefx/cli under the Apache License 2.0, and ships as one executable with no runtime dependencies.
- Stored credentials are readable only by your user.
