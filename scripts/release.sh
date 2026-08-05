#!/usr/bin/env bash
# Release helper: `npm run release [patch|minor|major|X.Y.Z]` (maintainers only).
#
# One command, two jobs, chosen by the branch it runs on:
#
#   on beta-X.Y.Z   npm run release minor   bump package.json, commit, push
#   on main         npm run release         cut the GitHub Release for the version already there
#
# The bump belongs on the beta branch because that is where the work is, and because the branch is
# what carries it to main through the pull request the merge policy requires. Bumping on main would
# mean writing to main outside a review, which nothing else here does. Pushing the beta branch also
# publishes a X.Y.Z-beta.N prerelease, so the number is real and installable before the tag exists.
#
# Cutting the release is the whole job on main. The release workflow takes over: it waits for a
# maintainer to approve the deployment, runs the full gate, and publishes to npm with provenance.
#
# The version is READ, never typed twice. The tag decides what publishes, so a tag that disagrees
# with the file it was cut from ships the wrong number under a release page announcing the right one.
#
# Notes are written by hand: they ARE the changelog (CHANGELOG.md only points at the releases), so
# `gh` opens an editor rather than assembling commit subjects into something nobody chose to write.
set -euo pipefail

bump="${1:-}"
branch="$(git rev-parse --abbrev-ref HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty — commit or stash first" >&2
  exit 1
fi

# ── Bump on a beta branch ───────────────────────────────────────────────────────────────────────
if [ -n "$bump" ]; then
  if ! printf '%s' "$branch" | grep -qE '^beta-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    echo "error: the version bump belongs on a beta-X.Y.Z branch, not on $branch" >&2
    echo "       It reaches main through the pull request that branch opens, like any other change." >&2
    exit 1
  fi

  case "$bump" in
    patch | minor | major) ;;
    *)
      if ! printf '%s' "$bump" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
        echo "error: '$bump' is not patch, minor, major, or an X.Y.Z version" >&2
        exit 1
      fi
      ;;
  esac

  previous="$(npm pkg get version | tr -d '"')"
  # Any exit from here until the push has succeeded leaves package.json untouched.
  trap 'git checkout --quiet -- package.json package-lock.json 2>/dev/null || true' EXIT
  npm version "$bump" --no-git-tag-version >/dev/null
  version="$(npm pkg get version | tr -d '"')"

  # The branch names the base version the prereleases are built from; a bump that walks away from it
  # would publish X.Y.Z-beta.N under a branch called something else.
  if [ "$branch" != "beta-$version" ]; then
    echo "error: bumping to $version on $branch — the branch would no longer name the version it builds" >&2
    echo "       Open beta-$version instead." >&2
    exit 1
  fi

  echo
  echo "  branch : $branch"
  echo "  bump   : $previous → $version ($bump)"
  echo
  read -r -p "Commit and push? Every push here publishes $version-beta.N. [y/N] " reply
  case "$reply" in y | Y) ;; *)
    echo "aborted"
    exit 1
    ;;
  esac

  git add package.json package-lock.json
  git commit --quiet -m "chore(release): $version

Co-authored-by: max246 <1809444+max246@users.noreply.github.com>
Co-authored-by: lenoxys <3996456+lenoxys@users.noreply.github.com>
Co-authored-by: Martijn Poppen <7694138+martijnpoppen@users.noreply.github.com>"
  git push --quiet --set-upstream origin "$branch"
  trap - EXIT

  echo
  echo "Pushed. Open the pull request against main when the release is ready:"
  echo "  gh pr create --base main --head $branch"
  echo "Then, once it is merged, cut the tag from main with: npm run release"
  exit 0
fi

# ── Cut the release from main ───────────────────────────────────────────────────────────────────
command -v gh >/dev/null || {
  echo "error: the GitHub CLI (gh) is required" >&2
  exit 1
}

if [ "$branch" != "main" ]; then
  echo "error: releases are cut from main, not $branch" >&2
  echo "       Pass a bump (patch|minor|major|X.Y.Z) to bump the version on a beta branch instead." >&2
  exit 1
fi

# The workflow builds the tag, not the working copy, so main has to match the remote before it is cut.
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "error: main is not in sync with origin — push or pull before releasing" >&2
  exit 1
fi

version="$(npm pkg get version | tr -d '"')"
tag="v$version"

# Immutable releases mean a tag name is spent the moment it belongs to a release, and stays spent
# after the release is deleted. This sees tags that exist; the ledger of names burned by a deleted
# release is not exposed anywhere, so a clean result means "not obviously taken", not "available".
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  echo "error: $tag already exists — a released version number can never be reused" >&2
  exit 1
fi

published="$(npm view "$(npm pkg get name | tr -d '"')" version 2>/dev/null || true)"
echo
echo "  version    : $version"
echo "  npm latest : ${published:-<none>}"
echo "  tag to cut : $tag"
echo
read -r -p "Cut $tag and publish $version? [y/N] " reply
case "$reply" in y | Y) ;; *)
  echo "aborted"
  exit 1
  ;;
esac

gh release create "$tag" --target main --title "$tag"

echo
echo "Release created. The publish job is waiting for a maintainer to approve the deployment:"
echo "  https://github.com/mega-yfue/eufy-sdk/actions/workflows/release.yml"
