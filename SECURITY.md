# Security policy

## Supported versions

Security fixes are provided for the latest published major version of the `makefx` npm package.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository, or contact the maintainer through [krasnoperov.me](https://krasnoperov.me) with the report marked as a security report, including the affected version, reproduction steps, and impact.

We will acknowledge a complete report as soon as practical and coordinate disclosure after a fix is available.

Never include access or refresh tokens, the contents of your credentials file, private media, or other account data in a report. Use synthetic examples, and if a credential may have been exposed, run `makefx logout` and revoke the grant from your makefx.app profile if logout reports that it could not reach the service.
