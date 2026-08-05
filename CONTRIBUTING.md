# Contributing

Thanks for helping out. This file covers setup, the dev workflow and the PR process. **How to write
the code — the architecture invariants and the rules CI enforces — is in
[AGENTS.md](./AGENTS.md)** (same file as `CODING_STANDARDS.md`); read it before your first PR. If you
drive an AI coding agent, also read [Working with AI agents](#working-with-ai-agents).

The usage guides live at <https://mega-yfue.github.io/>.

## License

The project is licensed under [Apache-2.0](./LICENSE). By opening a pull request you agree that your
Contributions are provided under that same license (inbound = outbound).

## Setup

```bash
nvm use                 # Node 24.5.0 (see .nvmrc) — required, not just recommended
npm install
npm run build           # tsc → dist/ (ESM)
npm test                # vitest (offline, synthetic fixtures)
```

`ffmpeg` is optional — only the JPEG-snapshot, one-shot mp4 record, and WebRTC container-output paths
use it.

## How the code is written

Four layers with one dependency direction (`core` → `transport` → `model` → `client`), capability ↔
transport decorrelation, the capability `members` table, and the rules CI enforces — all in
**[AGENTS.md](./AGENTS.md)**. It is not optional reading: several of those rules fail the build rather
than a review.

## Dev workflow

One command reproduces the whole CI gate — run it green before opening a PR:

```bash
npm run verify
```

It chains, in CI order: `format:check` → `typecheck` → the guards → `build` → the `.d.ts` seal guard →
an ESM load smoke test → `typecheck:examples` → `test`. A green `npm test` alone is **not** the bar.
`.github/workflows/ci.yml` invokes the same script, so green `verify` means green CI.

Individual pieces if you need them: `npm run guard:decorrelation`, `npm run guard:lines`,
`npm run guard:docrefs`, `npm run guard:consumer-agnostic`, `npm run guard:seal` (build first),
`npm run check:esm`, and `npm run format` to auto-fix formatting.

**One gate lives outside `verify`:** `guard:docs`, the publication guard over the generated API
reference. It needs the docs toolchain, which `verify` deliberately does not require. Reproduce it
with:

```bash
npm -C docs ci && npm -C docs run build     # TypeDoc → guard:docs → VitePress
npm -C docs run dev                         # preview the site
```

Tests live in a `__tests__/` folder **beside the code they cover**, are fully offline, and use only
synthetic fixtures. Add tests for new wire logic and capability behaviour.

## Commits & PRs

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, …).
- **Sign your commits** (GPG / `-S`).
- **Maintainer commits credit all three of us.** The project is jointly owned, so a commit from one
  maintainer carries `Co-authored-by:` trailers for the other two — every commit, not just the notable
  ones. `git config commit.template .gitmessage` fills them in for you. Your own contributions keep
  your authorship; this rule is about not letting shared work read as one person's.
- **PRs: concise, dev-to-dev, to the point.** Say what changed and why; call out anything unverified
  or deferred. If a PR is stacked on another, set its base to that branch and say so.
- **Live testing is read-only by default.** Never run write commands against a real device without
  explicit confirmation — the unverified-write rule exists for a reason.

## Working with AI agents

An AI agent is welcome here — most tools load [AGENTS.md](./AGENTS.md) on their own, which is where
the invariants live. Beyond that:

- **Never trust training data for a wire detail.** Models "know" older third-party eufy clients and
  will confidently reproduce them, and those are wrong for this protocol. Point the agent at real
  evidence or it will guess convincingly.
- **Never let it paste real data.** Agents happily inline whatever they saw — serials, device ids,
  account ids, IPs. Review every AI diff for these before committing, and grep it.
- **Keep it out of the public API reference.** `guard:docs` fails the build on protocol or crypto
  detail that reaches a public symbol's JSDoc; don't let an agent "helpfully" add wire explanations
  there.
- **Verify, don't trust.** If an agent names a file, flag or symbol, check it still exists. Run the
  full gate on its output — a green build is the bar, not a confident summary.
- **You own what you submit.** AI-assisted or not, the code in your PR is _your_ Contribution. You are
  responsible for making sure the agent did not regurgitate code under a license incompatible with
  Apache-2.0 — GPL/AGPL and proprietary code exist in training data. If you can't stand behind a hunk,
  don't submit it.

## Reporting a security issue

Don't open a public issue — see [SECURITY.md](./SECURITY.md).
