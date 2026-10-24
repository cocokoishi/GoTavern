#!/usr/bin/env bash
#
# test-classify-version-tag.sh
#
# The table test for scripts/classify-version-tag.sh, run by CI in the `verify` job. It exists because the two
# behaviours this classifier gates -- "does this tag become a GitHub pre-release" and "may this tag move the
# Docker `:latest` alias" -- cannot be observed without cutting a tag, and cutting a tag is the one thing that
# must not be done experimentally on a release repository. A wrong answer here is discovered by users, not by us.
#
# Every case asserts BOTH the printed word AND the exit status: a classifier that printed `prerelease` while
# exiting 0 on `v1.2` would be a pass for the wrong reason, and a case that only checked stdout could not see it.
#
# Style matches the rest of the repository's qualifiers: `ok:` / `FAIL:` per case, a final summary line, and a
# non-zero exit on any failure.

set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
classifier="${script_dir}/classify-version-tag.sh"

if [ ! -f "$classifier" ]; then
  echo "FAIL: the classifier is missing at ${classifier}" >&2
  exit 1
fi

passed=0
failed=0

# check <tag> <expected word> <expected exit code>
check() {
  local tag="$1" expected_word="$2" expected_status="$3" output status
  # The classifier is deliberately run through `bash`, not executed directly, so this test does not depend on
  # an executable bit surviving a checkout on a filesystem that cannot store one.
  output="$(bash "$classifier" "$tag" 2>/dev/null)" && status=0 || status=$?
  if [ "$status" -ne "$expected_status" ]; then
    echo "FAIL: '${tag}' exited ${status}, expected ${expected_status} (stdout: '${output}')" >&2
    failed=$((failed + 1))
    return
  fi
  if [ "$expected_status" -ne 0 ]; then
    echo "ok: '${tag}' is refused (exit ${status})"
    passed=$((passed + 1))
    return
  fi
  if [ "$output" != "$expected_word" ]; then
    echo "FAIL: '${tag}' printed '${output}', expected '${expected_word}'" >&2
    failed=$((failed + 1))
    return
  fi
  echo "ok: '${tag}' is ${output}"
  passed=$((passed + 1))
}

# ---- stable: exactly v<major>.<minor>.<patch> --------------------------------------------------------------
check 'v0.1.0' stable 0
check 'v1.2.3' stable 0
check 'v10.20.30' stable 0
check 'v0.0.0' stable 0

# ---- prerelease: the alpha this release is about, and every sibling spelling ---------------------------------
check 'v0.1.0-alpha.1' prerelease 0
check 'v0.1.0-alpha' prerelease 0
check 'v0.1.0-beta.2' prerelease 0
check 'v0.1.0-rc.1' prerelease 0
check 'v1.0.0-rc1' prerelease 0
check 'v1.2.3-SNAPSHOT' prerelease 0

# ---- prerelease because the artefacts cannot express it -----------------------------------------------------
# Build metadata is the documented judgement call: semver treats v1.2.3+7 as the same release as v1.2.3, but the
# canonical asset names are fixed, so a `+` tag cannot be recorded in the release assets. It must not be `latest`.
check 'v1.2.3+build.7' prerelease 0

# ---- refused because the version is not three-component ------------------------------------------------------
# A fourth component is not a semver release this pipeline can express, and guessing which of its parts is the
# patch number is exactly the kind of guess that decides whether users receive an alpha.
check 'v1.2.3.4' 0 2

# ---- refused: a name this pipeline cannot classify ----------------------------------------------------------
# These are the cases where guessing would be worst: a non-version tag would otherwise be published as a STABLE
# GitHub release and move `:latest`.
check '' 0 2
check '1.2.3' 0 2
check 'v1.2' 0 2
check 'release-1.2.3' 0 2
check 'vabc' 0 2
check 'v0.1.0-' 0 2
check 'v0.1.0 alpha' 0 2

echo ""
if [ "$failed" -ne 0 ]; then
  echo "FAIL: ${failed} of $((passed + failed)) version-classification cases did not hold" >&2
  exit 1
fi
echo "version-tag classification is correct for ${passed} cases: stable tags are exactly v<major>.<minor>.<patch>, everything else version-shaped is a prerelease, and a non-version tag is refused"
