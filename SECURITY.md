# Security

Yardhand holds the keys to other services, so a weakness in it matters. Thank you for reporting one privately.

## Reporting

Use GitHub's [private vulnerability reporting](https://github.com/escalay/yardhand/security/advisories/new) for this
repository. Please don't open a public issue, discussion or pull request about it.

Include what you found, how to reproduce it, the version (`Settings › Running`, or `GET /api/system`) and what an
attacker could do with it. You will get an answer within five working days, and a fix or a plan within 30 days for
anything confirmed. We credit reporters in the advisory unless you prefer not to be named.

## Supported versions

Fixes land on the latest release. Before 1.0, only the latest minor version receives security fixes.

## What counts

In scope: the server, the app, the container image and the compose file in this repository. For example, reading or
using a stored credential, acting as the owner without the owner key, a client key reaching a tool or server it wasn't
given, a pack key leaving its pack, or a secret appearing in logs, traces or exports.

Out of scope: problems in the servers you connect, findings that need the owner key or the master key, and denial of
service by an authenticated owner.

## Verifying a release

Every image is signed with cosign by the release workflow and carries build provenance. Check either with cosign 3
or later, or with the GitHub CLI:

```sh
cosign verify ghcr.io/escalay/yardhand:<version> \
  --certificate-identity-regexp 'https://github.com/escalay/yardhand/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/escalay/yardhand:<version> --owner escalay
```
