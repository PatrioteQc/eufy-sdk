# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub Security Advisories:

> [Report a vulnerability](https://github.com/mega-yfue/eufy-sdk/security/advisories/new)

Include what you can — affected version, reproduction steps, and impact. We will acknowledge the
report and keep you updated while it is investigated, and we will credit you in the advisory unless
you'd rather stay anonymous.

## Scope

In scope: anything in this repository that weakens a user's account or devices — credential or token
handling, session persistence, the cryptographic transport implementations, and dependency
vulnerabilities that are actually reachable from the SDK's own code paths.

Out of scope: vulnerabilities in eufy or Anker services themselves. Report those to the vendor. A
finding about how _this SDK_ talks to those services is in scope.

## Supported versions

The project is pre-1.0: only the latest published version receives fixes.

## Credentials in your own setup

The SDK reads credentials from the environment and persists a session through a store you provide.
Never commit either. If you believe a session token was exposed, log out from the eufy app to
invalidate it and change your password.
