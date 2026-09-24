# makefx CLI

The open-source command-line client for [makefx.app](https://makefx.app).

makefx.app is a pay-per-asset workshop where you and your agent make images,
video, and audio on one shared canvas. This CLI calls the same hosted MCP tools
an agent uses, plus a few person-only REST commands, for terminal automation,
local file transfer, and scripts that need structured JSON.

## Install and sign in

Node.js 22.18 or newer is required.

```bash
npm install -g makefx
makefx login
```

Login always prints the authorization URL and callback address
(`http://127.0.0.1:8765/callback`), then tries to open a browser. If the CLI is
running on a remote host, keep login running and open a separate terminal on
the computer with your browser. Start the printed SSH tunnel before opening
the authorization URL:

```bash
ssh -N -L 8765:127.0.0.1:8765 user@remote-host
```

The CLI suggests the detected hostname; replace it with your usual SSH
destination or alias if needed. Keep the tunnel open until login finishes.

Use `--env production|stage|local` to keep separate credentials and select the
endpoint. Production is the default. `makefx logout` revokes the grant when the
service is reachable and always removes the stored credentials; a grant can
also be revoked from your makefx.app profile. Every help command works without
signing in.

## Commands

```text
login                         Sign in through the browser
logout                        Revoke and remove stored credentials
mcp                           Relay stdio JSON-RPC to the hosted MCP endpoint
account                       Show balance and active holds
purchase create|get           Prepare or read a credit purchase
profile get|update            Read or change the signed-in profile
health                        Check service reachability and environment
spaces                        List available spaces
space create|get|update|delete
                              Create, read, rename, or soft-delete a space
space publish|unpublish       Change public visibility as an account owner
                              (a space the home page is built from cannot be
                              made private)
voices sync                   Refresh an account's ElevenLabs voices
models                        List the model catalog for the payer
estimate                      Quote creation or replay before spending credits
create                        Create assets or replay an immutable recipe
upload                        Upload a local image, video, or audio file
download                      Download ready media to a new local file
asset get|update|delete       Read, change, or soft-delete an asset
describe                      Describe reusable visual traits
audio align                   Align or re-align ready audio
audio timings                 Read or save canonical word timings
link | unlink                 Manage links between assets
export                        Write a space document to stdout or a new file
open                          Print and optionally open a space or asset URL
```

Run `makefx --help` for the complete command list. Use
`makefx help <command>`, `makefx space help`, `makefx asset help`,
`makefx audio help`, or `makefx voices help` for exact arguments.

## Create media

Read the current model id and parameter schema before creating. Quote a request
before spending credits, and reuse its request id when recovering an uncertain
result.

```bash
makefx models --kind image --json
makefx estimate --kind image --model MODEL --prompt "A painted market" --json
makefx create --space ACCOUNT/SPACE --kind image \
  --model MODEL --prompt "A painted market" --request-id market-01 --wait --json
```

`models` accepts `--family provider|internal|browser` as well as `--kind`.
`create` accepts repeated `--ref ASSET:SLOT` and `--param NAME=VALUE` options.
References keep their left-to-right command-line order as MCP order 0, 1, and
so on. It also accepts `--seed INTEGER`, `--position '{"x":0,"y":0}'`,
`--tags '["tag"]'`, and `--note TEXT`.
It reads the live catalog for the paying Space before each creation, applies
that catalog's defaults, and refuses invalid model settings or an unavailable
current model without calling `create_asset`. Exact replay leaves availability
to the recorded route. Use `--from-asset` with `--recipe-mode current|exact` to
replay a recipe.

## Credits and profile

Prepare a purchase quote without sending card data or payment tokens. The
optional billing identity is one JSON object, inline or loaded from a file by
prefixing its path with `@`:

```bash
makefx purchase create --account ACCOUNT --product eur20 \
  --request-id topup-01 --billing @./billing.json --json
makefx purchase get --purchase PURCHASE --json
makefx profile get --json
makefx profile update --name "Ada Example" --json
makefx health --json
```

Every public MCP tool has one dedicated shell command recorded in the CLI
dispatcher mapping, unless a product-approved exception is documented there.
`makefx mcp` is only the generic stdio bridge. Convenience commands such as
`download` and `open` may compose a mapped read tool but do not replace its
dedicated command.

## Files and handoff

`upload` and `download` stream media directly through signed URLs; media bytes
do not pass through MCP. Output commands never replace an existing destination.

```bash
makefx upload --space ACCOUNT/SPACE --kind image --file ./reference.png
makefx download ASSET --space ACCOUNT/SPACE --out ./result.png
makefx export --space ACCOUNT/SPACE --out ./space.json
MAKEFX_NO_OPEN=1 makefx open ACCOUNT/SPACE
```

Add `--json` when a script needs the tool's unchanged structured result. Exit
codes are 0 for success, 1 for tool, network, or file errors, and 2 for invalid
command usage.

Full documentation: [makefx.app/docs/cli](https://makefx.app/docs/cli)

## Deliberate boundary

This repository is a thin client for the public makefx.app API and MCP
endpoint. Every command maps to a public MCP tool or a documented REST route
that a signed-in person may call. It contains no service code, provider
credentials, model prompts, database access, raw API passthrough, or
administrative controls.

The makefx.app service, canvas, and generation pipeline remain closed source.
See [TRADEMARKS.md](TRADEMARKS.md) for the distinction between the
Apache-licensed code and the makefx name.

## Environments and credentials

Production is the default. `--env stage` and `--env local` are intended for
makefx.app development. Credentials are stored per environment in
`$XDG_CONFIG_HOME/makefx-cli/config.json` (by default under `~/.config`),
readable only by your user; the CLI never writes them into a project directory.

## Development

```bash
npm install
npm run check
node dist/makefx.js --help
```

`npm run check` type-checks and tests the client, builds the executable,
verifies the public client boundary, and installs the packed npm tarball in a
clean directory to exercise help, sign-in hints, and an authenticated tool call
against a local mock server.

Contributions are welcome for the public client. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening
a pull request or reporting a vulnerability.

## License

Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
