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
#   stable      the tag is EXACTLY v<major>.<minor>.<patch> -- plain digits, three components, nothing else.
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

if printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo stable
else
  echo prerelease
fi
