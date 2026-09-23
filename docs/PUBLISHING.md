# Publishing

Releases publish from GitHub Actions with npm trusted publishing and provenance. No long-lived npm token belongs in this repository.

## One-time npm configuration

Configure the `makefx` package trusted publisher with:

- Provider: GitHub Actions
- Organization or user: `makefx`
- Repository: `cli`
- Workflow: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish` only

Set npm Publishing access to **Require two-factor authentication and disallow bypass 2FA tokens**. Trusted publishing uses a short-lived OIDC credential rather than an npm token.

In the repository's `npm` environment, limit deployment branches to `main`. The workflow also refuses any other ref, and npm provenance requires a public source repository, so the publish job does not run while this repository is private.

## Release

1. Open a pull request updating `package.json`, `package-lock.json`, and `CHANGELOG.md` with the next semantic version and its publication date.
2. Obtain approval from the human code owner after CI passes.
3. Merge the reviewed change to `main`.
4. The push workflow checks whether that exact version is new, runs the full package gate, and publishes it with npm provenance.
5. After publication, the workflow creates the matching `v<package version>` tag and GitHub release on the reviewed merge commit using the curated `CHANGELOG.md` entry.
6. Verify `npm view makefx version dist-tags repository dist.integrity --json` and install the exact version in a clean temporary directory.

If a release run fails, fix the workflow through the normal reviewed pull-request process, then rerun it from current `main`:

```sh
gh workflow run publish.yml --repo makefx/cli
```

Reruns are safe: the workflow never republishes a version already present on npm. If npm publication succeeded but tag or release creation failed, a rerun only finishes the missing GitHub release metadata, on the commit npm recorded as the package's source rather than on current `main`.

Human approval of the version-changing pull request is the release authorization. No long-lived npm credential is stored in CI.

## Versions

Use a patch version for compatible fixes, a minor version for additive commands or flags, and a major version for command, flag, output, environment, or Node.js compatibility breaks. Do not bump the version for documentation, tests, CI, or repository maintenance that does not change the shipped CLI.
