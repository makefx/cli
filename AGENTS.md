# AGENTS.md

This repository contains only the public makefx CLI, a thin client for the makefx.app API and MCP endpoint.

- Every command maps to a public MCP tool or a documented REST route a signed-in person may call. Keep `src/tool-mapping.ts`, `makefx --help`, per-command usage, the README, and tests in sync.
- Do not add raw API passthrough, admin or operator commands, provider credentials, model prompts, or service code. Keep the hosted service and its private repository out of this repository, including their git history.
- The bundle has no runtime dependencies. Validate inputs by hand at the few places the CLI must refuse something before signing in or sending it.
- Refresh `test/fixtures/` from the service in the same pull request that adds the matching command or validation.
- Run `npm run check` before opening a pull request.
- Use Apache-2.0-compatible dependencies and update `THIRD_PARTY_NOTICES.md` when a bundled dependency changes.
- Use Conventional Commits. Keep each commit one coherent change that builds and passes `npm run check`; merge with merge commits, never squash or rebase.
- Prepare every npm release in its implementation pull request: choose the next semantic version, update both `package.json` and `package-lock.json`, and add the new top entry to `CHANGELOG.md`. Merging that reviewed version to `main` publishes it automatically.
- Do not bump the package version for documentation, tests, CI, or repository maintenance that does not change the shipped CLI.
