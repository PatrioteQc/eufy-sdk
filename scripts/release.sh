#!/usr/bin/env bash
# Cut a release: `npm run release` (maintainers only).
#
# Creates the GitHub Release for the version currently in package.json. That is the whole job — the
# release workflow does the rest, publishing to npm with provenance after a maintainer approves the
# deployment.
#
# The version is READ, never typed. Typing it again here is how a tag ends up disagreeing with the
# file it was cut from, and since the tag is what decides the published version, that disagreement
# ships silently. Bump first, release second:
#
#   npm version minor --no-git-tag-version   # on a beta-X.Y.Z branch, merged to main first
#   npm run release
#
# Notes are written by hand on purpose: they ARE the changelog (CHANGELOG.md only points at the
# releases), so this opens $EDITOR rather than generating them from commit subjects.
set -euo pipefail

version="$(npm pkg get version | tr -d '"')"
tag="v$version"

command -v gh >/dev/null || { echo "error: the GitHub CLI (gh) is required" >&2; exit 1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "error: releases are cut from main, not $branch" >&2
  exit 1
fi

# A release must point at a commit that is actually on the remote — the workflow checks out the tag,
# not your working copy.
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "error: main is not in sync with origin — push or pull before releasing" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty — commit or stash first" >&2
  exit 1
fi

# Immutable releases mean a tag name is spent the moment it belongs to a release, and stays spent
# after the release is deleted. This sees tags that exist; the ledger of names burned by a deleted
# release is not exposed anywhere, so a clean result means "not obviously taken", not "available".
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  echo "error: $tag already exists — a released version number can never be reused" >&2
  exit 1
fi

published="$(npm view "$(npm pkg get name | tr -d '"')" version 2>/dev/null || true)"
echo "  package.json : $version"
echo "  npm latest   : ${published:-<none>}"
echo "  tag to cut   : $tag"
echo
read -r -p "Cut $tag and publish $version? [y/N] " reply
[ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "aborted"; exit 1; }

# No --generate-notes: the notes are the changelog, so gh opens an editor for them.
gh release create "$tag" --target main --title "$tag"

echo
echo "Release created. The publish job is waiting for a maintainer to approve the deployment:"
echo "  https://github.com/mega-yfue/eufy-sdk/actions/workflows/release.yml"
