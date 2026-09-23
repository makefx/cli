# Contributing

Thanks for improving the makefx CLI.

## Scope

This repository accepts changes to the public client, command help, documentation, packaging, and tests. The makefx.app service, canvas, generation pipeline, provider integrations, and administrative tools are maintained privately and are out of scope here.

Every command maps to a public MCP tool or a documented REST route a signed-in person may call. If a proposal needs a new service capability, open a focused issue describing the user outcome and public contract before implementing a command.

## Development

1. Use Node.js 22.18 or newer.
2. Run `npm install`.
3. Make a focused change with tests and help updates.
4. Run `npm run check`.
5. Open a pull request explaining the public user outcome and verification.

Do not add commands that accept arbitrary API paths or JSON-RPC methods beyond the `mcp` bridge, runtime dependencies, or privileged operator actions. The boundary check is a release gate, not the only review of that policy.

## Service snapshots

`test/fixtures/mcp-tools.json` lists the public MCP tool names and `test/fixtures/catalog-params.json` holds the parameter schemas the model catalog emits. When the service adds a tool or a model parameter shape, refresh the snapshot in the same pull request that adds the matching command or validation. The tool test fails until every listed tool has a dedicated command in `src/tool-mapping.ts` or a documented exception.

By contributing, you agree that your contribution is licensed under Apache-2.0.
