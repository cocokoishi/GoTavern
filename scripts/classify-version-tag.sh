#!/usr/bin/env bash
#
# classify-version-tag.sh <tag>
#
# Prints exactly one word on stdout -- `stable` or `prerelease` -- and nothing else, so a workflow can use it
# without parsing prose:
#
#   channel="$(bash scripts/classify-version-tag.sh "${GITHUB_REF_NAME}")"
#
# WHY THIS IS A SCRIPT AND NOT TWO COPIES OF A REGEX. Before this existed, `release.yml` created every tag as a
# full GitHub Release and `docker.yml` moved `:latest` on every tag, so `v0.1.0-alpha.1` would have become the
# repository's "Latest release" AND the image every `docker pull` gets. `install.sh` and `install.ps1` both fetch
# `releases/latest/download/...`, so that one mistake would have handed every fresh install an alpha. Two YAML
# copies of the same rule would drift the moment one of them is edited; one script, called by both, cannot.
#
# THE RULE, stated so it can be argued with rather than guessed at:
#
#   stable      the tag is EXACTLY v<major>.<minor>.<patch> -- plain digits, three components, nothing else --
#               OR it is HISTORY_GRADUATION_TAG, the single documented historical exception below. There is
#               exactly one such tag in this file's history and it is a constant, not a pattern.
#   prerelease  anything else that still looks like a version tag: an alpha/beta/rc suffix, a 4th component, or
#               semver build metadata (`+build.7`). Build metadata is a judgement call: semver calls `1.2.3+7`
#               the same release as `1.2.3`, but an asset named `gotavern-linux-amd64.tar.gz` cannot carry the
#               build, so a tag with `+` is not a tag this project's release assets can express. Classifying it
#               prerelease keeps `latest` off a tag whose meaning the artefacts cannot record.
#   exit 2      the tag is not a version tag at all. A release pipeline must not guess a channel for a name it
#               does not understand, because the guess decides whether real users receive it.
#
# The safe direction is deliberate: an unrecognised-but-version-shaped tag becomes a PRERELEASE, which is loud
# and reversible, rather than a stable release, which silently becomes `latest`.
#
# THE EXCEPTION IS A CONSTANT SO IT CANNOT WIDEN. The rule above is a shape rule; the graduation is a decision
# about ONE tag. Written as an equality test on a named constant it graduates `v0.1.0-alpha.9` and nothing else:
# `v0.1.0-alpha.10`, `v0.1.0-alpha.09`, `v0.1.1-alpha.9`, `v0.1.0-alpha.9+build.1` and `v0.2.0-alpha.1` all stay
# prereleases, and each of those is an assertion in scripts/test-classify-version-tag.sh so a future editor who
# turns the exception into a regex (`alpha\.9`, `>= alpha.9`, a series prefix) breaks a named case instead of
# quietly graduating an alpha nobody qualified.

set -eu

tag="${1:-}"

if [ -z "$tag" ]; then
  echo "classify-version-tag.sh: a tag argument is required (e.g. v0.1.0 or v0.1.0-alpha.1)" >&2
  exit 2
fi

# The shape every release tag in this repository must have: v<digits[.digits]...> with an optional
# -<prerelease> and/or +<build metadata>. Anything outside it is refused rather than classified.
if ! printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z][0-9A-Za-z.-]*)?$'; then
  echo "classify-version-tag.sh: '${tag}' is not a version tag this repository can classify (expected v<major>.<minor>.<patch> with an optional -prerelease or +build suffix)" >&2
  exit 2
fi

# =============================================================================================================
# THE HISTORICAL ALPHA-SERIES GRADUATION EXCEPTION.
#
# `v0.1.0-alpha.9` is GoTavern's FIRST OFFICIAL STABLE-CHANNEL RELEASE even though its name still carries the
# `-alpha.9` suffix the eight releases before it were published under. The name is kept on purpose:
#
#   - The tag name is a historical fact. `v0.1.0-alpha.1` .. `v0.1.0-alpha.8` are published, prerelease-flagged
#     releases that runs, fixtures and documentation already cite by name. Re-tagging or renaming alpha.9 would
#     make the release that graduates the product the one tag whose name does not sort, compare or resolve the
#     way every other tag in this series does, and every recorded citation of the alpha series would have to be
#     re-derived to explain why one member is spelled differently.
#   - What graduates is the CHANNEL, not the semver string. `release.yml` reads this word to decide whether to
#     pass `--prerelease --latest=false`, and `docker.yml` reads it to decide whether to move `:latest`. Those
#     are the two places a user feels the difference: `releases/latest/download/...` (what a bare `install.sh`
#     or `install.ps1` fetches) and `docker pull ...:latest`. Making THIS word `stable` is the whole change.
#   - The exception therefore lives HERE and nowhere else. `release.yml`, `docker.yml` and both installers
#     consume this script's answer; none of them may grow its own `if alpha.9`, because a second copy is a
#     second answer that drifts, and the drift is invisible until it has already shipped a channel to users.
#
# ARGUING WITH IT: this is a deliberate single-tag decision, defensible exactly once. The next release must be
# named for the channel it is on (`v0.1.0` or later), and then this constant should be deleted in the change
# that publishes that release -- with its test cases moved to "prerelease" in the same commit, so the exception
# cannot silently become a permanent widening. Until then, deleting or neutering this constant is what makes
# `v0.1.0-alpha.9` a prerelease again, which is exactly the mutation
# `scripts/test-classify-version-tag.sh`'s `historical-alpha-graduation` case exists to catch.
# =============================================================================================================
HISTORY_GRADUATION_TAG='v0.1.0-alpha.9'

if [ "$tag" = "$HISTORY_GRADUATION_TAG" ]; then
  echo stable
  exit 0
fi

if printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo stable
else
  echo prerelease
fi
