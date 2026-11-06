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
#               OR it is one of GRADUATED_STABLE_TAGS, the documented equality list below. Each entry is a
#               constant chosen by its own commit; the list is not a pattern or a range.
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
# THE GRADUATIONS ARE CONSTANTS SO THE LIST CANNOT WIDEN. The rule above is a shape rule; a graduation is a
# decision about ONE tag. Written as equality tests on named constants the list graduates `v0.1.0-alpha.9` (the
# historical first stable-channel release), `v0.1.0-alpha.12` (the production release of the 0.1.0 line),
# `v0.1.0-alpha.13` (the third-party extension compatibility release), `v0.1.0-alpha.14` (the engineering-program
# release), `v0.1.0-alpha.15` (the evidence-rail release) and `v0.1.0-alpha.16` (the synthetic adversarial
# qualification and release-rehearsal release) and nothing else: v0.1.0-alpha.10, v0.1.0-alpha.11,
# v0.1.0-alpha.17, v0.1.0-alpha.160, v0.1.0-alpha.16-rc1, v0.1.0-alpha.16+build.1, v0.1.0-alpha.150,
# v0.1.0-alpha.15-rc1, v0.1.0-alpha.15+build.1, v0.1.0-alpha.14-rc1, v0.1.0-alpha.140, v0.1.0-alpha.130,
# v0.1.0-alpha.13-rc1, v0.1.0-alpha.09, v0.1.1-alpha.9 and v0.2.0-alpha.1 all stay prereleases, and each of
# those is an assertion in scripts/test-classify-version-tag.sh so a future editor who turns the list into a
# regex, a prefix or a "series >= N" rule breaks a named case instead of quietly graduating an unqualified tag.

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
# THE GRADUATED TAGS: single-tag EQUALITY decisions, never a pattern.
#
# The general rule above calls a tag stable only when it is exactly v<major>.<minor>.<patch>. Six tags in this
# repository's history graduate to the stable channel while keeping their historical alpha-series names:
#
#   v0.1.0-alpha.9    the FIRST stable-channel release (historical; removing it would reclassify a published
#                     release on a re-run, which is a channel-semantic change for an already-served tag)
#   v0.1.0-alpha.12   the release that graduated the 0.1.0 line
#   v0.1.0-alpha.13   the release that adds the 20-extension third-party compatibility gate; it is this project's
#                     decision that alpha.13 is the production release of the line, and the evidence gates in
#                     docs/release-manifest.json are what make publishing it possible (the classifier only says
#                     which channel a tag WOULD be; the release workflow refuses to publish without the gates).
#   v0.1.0-alpha.14   the engineering-program release (M0-M8 of GOAL.md section 11: CLI, performance evidence
#                     gate, compression, streaming chat summaries, identity-keyed caches, panic boundary and
#                     server timeouts). Graduated by its own commit that cites the same-SHA gate evidence.
#   v0.1.0-alpha.15   the EVIDENCE-RAIL release: the release gate now refuses plausible-looking evidence. Publish
#                     requires, for every gate in docs/release-manifest.json, a completed successful run of the
#                     required EVENT at the candidate SHA, with every required JOB completed/success (a skipped job
#                     in a green run is refused), the fixed-name evidence ARTIFACT attached and unexpired, and that
#                     artifact's EMBEDDED document matching its kind, tier marker and head SHA. This tag graduates
#                     by its own commit, which cites the same-SHA qualification evidence for alpha.15 under those
#                     rails: the release cannot be published without them, so the graduation and the evidence are
#                     the same fact.
#   v0.1.0-alpha.16   the SYNTHETIC ADVERSARIAL QUALIFICATION release: the alpha.16 program (M0 audit, M1 scenario
#                     recipes, M2 E03+E04 real-browser journey, M3 recorded-oracle scenarios, M4 evidence-based
#                     refusals, M5 both-direction performance, M6 release rails) plus the release-rehearsal record.
#                     Its 13 required gates, the fail-closed verifier and the appended same-SHA evidence table are
#                     the qualification; the release notes state every skipped or UNPROVEN scenario explicitly.
#
# THE LIST IS EQUALITY, NOT A RANGE. It cannot widen by accident: v0.1.0-alpha.10, v0.1.0-alpha.11,
# v0.1.0-alpha.17, v0.1.0-alpha.160, v0.1.0-alpha.16-rc1, v0.1.0-alpha.16+build.1, v0.1.0-alpha.150,
# v0.1.0-alpha.15-rc1, v0.1.0-alpha.15+build.1, v0.1.0-alpha.140, v0.1.0-alpha.14-rc1, v0.1.0-alpha.130,
# v0.1.0-alpha.13-rc1, v0.1.0-alpha.09, v0.1.1-alpha.9, v0.2.0-alpha.1 and v0.1.0-alpha.13+build.1 all stay
# prereleases, and each of those is an assertion in scripts/test-classify-version-tag.sh so a future editor who
# turns this into a regex, a prefix comparison or a "series >= N" test breaks a named case instead of quietly
# graduating an unqualified tag. Each entry is added by its own commit that cites the qualification evidence for
# that tag.
# =============================================================================================================
GRADUATED_STABLE_TAGS='v0.1.0-alpha.9 v0.1.0-alpha.12 v0.1.0-alpha.13 v0.1.0-alpha.14 v0.1.0-alpha.15 v0.1.0-alpha.16'

for graduated_tag in $GRADUATED_STABLE_TAGS; do
  if [ "$tag" = "$graduated_tag" ]; then
    echo stable
    exit 0
  fi
done

if printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo stable
else
  echo prerelease
fi
