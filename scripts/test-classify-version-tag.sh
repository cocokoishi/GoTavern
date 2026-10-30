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
# Every case is NAMED, so a red run reads `FAIL [historical-alpha-graduation]: ...` and names the property that
# broke rather than only the tag -- a mutation run is judged by whether the failure identifies what was mutated.
#
# THREE PROPERTIES, not only the word table:
#
#   1. the word table (below);
#   2. "prints exactly one word on stdout" -- asserted on BYTES for one stable and one prerelease tag, because a
#      workflow does `channel="$(bash scripts/classify-version-tag.sh "$tag")"` and a second line of chatter would
#      be captured into the channel name and compared against "stable" as a string, silently;
#   3. "a refusal writes NOTHING to stdout" -- the exit-2 path must not leave a word that a careless caller could
#      read as a channel, and its diagnostic must go to stderr.
#
# The one deliberate exception is covered from BOTH sides: the graduated tag must be `stable`, and the four tags
# that a widened exception (a regex, a prefix, a series comparison) would wrongly graduate must stay
# `prerelease`. Those four are the difference between a documented decision and an exception that eats the
# series.
#
# Style matches the rest of the repository's qualifiers: `ok:` / `FAIL:` per case, a final summary line, and a
# non-zero exit on any failure.
#
# Runs on a POSIX bash with no extra tools beyond `cmp`, `mktemp`, `printf` and `wc`: it is executed by the Linux
# `verify` job and on the Windows development host through `C:\Program Files\Git\bin\bash.exe`.

set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
classifier="${script_dir}/classify-version-tag.sh"

if [ ! -f "$classifier" ]; then
  echo "FAIL: the classifier is missing at ${classifier}" >&2
  exit 1
fi

passed=0
failed=0

# check <case name> <tag> <expected word> <expected exit code>
check() {
  local name="$1" tag="$2" expected_word="$3" expected_status="$4" output status
  # The classifier is deliberately run through `bash`, not executed directly, so this test does not depend on
  # an executable bit surviving a checkout on a filesystem that cannot store one.
  output="$(bash "$classifier" "$tag" 2>/dev/null)" && status=0 || status=$?
  if [ "$status" -ne "$expected_status" ]; then
    echo "FAIL [${name}]: '${tag}' exited ${status}, expected ${expected_status} (stdout: '${output}')" >&2
    failed=$((failed + 1))
    return
  fi
  if [ "$expected_status" -ne 0 ]; then
    echo "ok [${name}]: '${tag}' is refused (exit ${status})"
    passed=$((passed + 1))
    return
  fi
  if [ "$output" != "$expected_word" ]; then
    echo "FAIL [${name}]: '${tag}' printed '${output}', expected '${expected_word}'" >&2
    failed=$((failed + 1))
    return
  fi
  echo "ok [${name}]: '${tag}' is ${output}"
  passed=$((passed + 1))
}

# check_one_word_on_stdout <case name> <tag> <expected word>
# Asserts the exact BYTES: the word, one newline, and an empty stderr. This is the property a workflow relies on
# when it captures the channel into a variable, and it is invisible to a `$(...)` comparison.
check_one_word_on_stdout() {
  local name="$1" tag="$2" expected="$3" out_file expected_file err_file words bytes
  out_file="$(mktemp)" || { echo "FAIL [${name}]: mktemp failed, so the byte assertion did not run" >&2; failed=$((failed + 1)); return; }
  expected_file="$(mktemp)" || { rm -f "$out_file"; echo "FAIL [${name}]: mktemp failed, so the byte assertion did not run" >&2; failed=$((failed + 1)); return; }
  err_file="$(mktemp)" || { rm -f "$out_file" "$expected_file"; echo "FAIL [${name}]: mktemp failed, so the byte assertion did not run" >&2; failed=$((failed + 1)); return; }
  printf '%s\n' "$expected" > "$expected_file"
  if ! bash "$classifier" "$tag" > "$out_file" 2> "$err_file"; then
    echo "FAIL [${name}]: '${tag}' did not exit 0 while stdout was redirected" >&2
    rm -f "$out_file" "$expected_file" "$err_file"
    failed=$((failed + 1))
    return
  fi
  bytes="$(wc -c < "$out_file" | tr -d ' ')"
  if ! cmp -s "$out_file" "$expected_file"; then
    words="$(tr '\n' ' ' < "$out_file")"
    echo "FAIL [${name}]: '${tag}' must write exactly '${expected}\\n' to stdout (${#expected}+1 bytes); got ${bytes} bytes: '${words}'" >&2
    rm -f "$out_file" "$expected_file" "$err_file"
    failed=$((failed + 1))
    return
  fi
  if [ -s "$err_file" ]; then
    echo "FAIL [${name}]: '${tag}' wrote a diagnostic to stderr on the success path: $(cat "$err_file")" >&2
    rm -f "$out_file" "$expected_file" "$err_file"
    failed=$((failed + 1))
    return
  fi
  rm -f "$out_file" "$expected_file" "$err_file"
  echo "ok [${name}]: '${tag}' writes exactly '${expected}' and one newline to stdout, nothing to stderr"
  passed=$((passed + 1))
}

# check_refused_silently <case name> <tag>
# A refusal must exit 2, print NOTHING on stdout, and say why on stderr. A refusal that printed a word would let a
# caller capture a channel for a name the pipeline refuses to classify.
check_refused_silently() {
  local name="$1" tag="$2" out_file err_file status bytes
  out_file="$(mktemp)" || { echo "FAIL [${name}]: mktemp failed, so the refusal assertion did not run" >&2; failed=$((failed + 1)); return; }
  err_file="$(mktemp)" || { rm -f "$out_file"; echo "FAIL [${name}]: mktemp failed, so the refusal assertion did not run" >&2; failed=$((failed + 1)); return; }
  bash "$classifier" "$tag" > "$out_file" 2> "$err_file" && status=0 || status=$?
  if [ "$status" -ne 2 ]; then
    echo "FAIL [${name}]: '${tag}' exited ${status}, expected 2 (a refusal is exit 2, never 0 or 1)" >&2
    rm -f "$out_file" "$err_file"
    failed=$((failed + 1))
    return
  fi
  bytes="$(wc -c < "$out_file" | tr -d ' ')"
  if [ "$bytes" -ne 0 ]; then
    echo "FAIL [${name}]: '${tag}' was refused but still wrote ${bytes} byte(s) to stdout: '$(cat "$out_file")'" >&2
    rm -f "$out_file" "$err_file"
    failed=$((failed + 1))
    return
  fi
  if [ ! -s "$err_file" ]; then
    echo "FAIL [${name}]: '${tag}' was refused with exit 2 but printed no reason on stderr" >&2
    rm -f "$out_file" "$err_file"
    failed=$((failed + 1))
    return
  fi
  rm -f "$out_file" "$err_file"
  echo "ok [${name}]: '${tag}' is refused with exit 2, nothing on stdout, a reason on stderr"
  passed=$((passed + 1))
}

# ---- THE GRADUATION EXCEPTION: the one tag whose channel leaves the alpha series ---------------------------------
# v0.1.0-alpha.9 IS the stable-channel release. The tag name is kept for history; the channel is what graduates.
# If this case goes red, the exception in scripts/classify-version-tag.sh was removed, neutered or widened away.
check 'historical-alpha-graduation' 'v0.1.0-alpha.9' stable 0
check_one_word_on_stdout 'historical-alpha-graduation-one-word' 'v0.1.0-alpha.9' stable

# ---- THE EXCEPTION MUST NOT WIDEN ---------------------------------------------------------------------------------
# Each of these is one plausible wrong implementation of "alpha.9 graduates": a family prefix (`>= alpha.9`), a
# regex (`alpha\.9` matching `alpha.9x`/`alpha.09`), a series bump (`alpha.N >= 9`), a different patch, or the
# exception leaking into build-metadata tags. None of them has been qualified, so each must stay a prerelease.
check 'alpha-before-graduation' 'v0.1.0-alpha.8' prerelease 0
check 'alpha-after-graduation-in-series' 'v0.1.0-alpha.10' prerelease 0
check 'alpha-zero-padded' 'v0.1.0-alpha.09' prerelease 0
check 'alpha-nine-in-another-patch' 'v0.1.1-alpha.9' prerelease 0
check 'alpha-nine-in-another-minor' 'v0.2.0-alpha.9' prerelease 0
check 'graduated-tag-with-build-metadata' 'v0.1.0-alpha.9+build.1' prerelease 0
check 'graduated-tag-with-uppercase-alpha' 'v0.1.0-Alpha.9' prerelease 0
check 'next-alpha-series' 'v0.2.0-alpha.1' prerelease 0

# ---- stable: exactly v<major>.<minor>.<patch>, which is the general rule the exception sits beside ----------------
check 'plain-three-component' 'v0.1.0' stable 0
check 'plain-v1-2-3' 'v1.2.3' stable 0
check 'plain-multi-digit' 'v10.20.30' stable 0
check 'plain-zero-zero-zero' 'v0.0.0' stable 0
check_one_word_on_stdout 'plain-three-component-one-word' 'v0.1.0' stable

# ---- prerelease: every other version-shaped spelling -------------------------------------------------------------
check 'alpha-one' 'v0.1.0-alpha.1' prerelease 0
check 'alpha-bare' 'v0.1.0-alpha' prerelease 0
check 'beta-suffix' 'v0.1.0-beta.2' prerelease 0
check 'rc-suffix' 'v1.0.0-rc.1' prerelease 0
check 'rc-no-dot' 'v1.0.0-rc1' prerelease 0
check 'snapshot-suffix' 'v1.2.3-SNAPSHOT' prerelease 0

# ---- prerelease because the artefacts cannot express it ---------------------------------------------------------
# Build metadata is the documented judgement call: semver treats v1.2.3+7 as the same release as v1.2.3, but the
# canonical asset names are fixed, so a `+` tag cannot be recorded in the release assets. It must not be `latest`.
check 'build-metadata-cannot-be-expressed' 'v1.2.3+build.7' prerelease 0

# ---- refused because the version is not three-component ---------------------------------------------------------
# A fourth component is not a semver release this pipeline can express, and guessing which of its parts is the
# patch number is exactly the kind of guess that decides whether users receive an alpha.
check 'four-component-version' 'v1.2.3.4' 0 2

# ---- refused: a name this pipeline cannot classify ----------------------------------------------------------------
# These are the cases where guessing would be worst: a non-version tag would otherwise be published as a STABLE
# GitHub release and move `:latest`.
check 'empty-tag' '' 0 2
check 'missing-v-prefix' '1.2.3' 0 2
check 'two-component-version' 'v1.2' 0 2
check 'named-release' 'release-1.2.3' 0 2
check 'not-a-version' 'vabc' 0 2
check 'dangling-prerelease-dash' 'v0.1.0-' 0 2
check 'version-with-space' 'v0.1.0 alpha' 0 2
check 'branch-name' 'lane/release' 0 2

# ---- the refusal path's own contract ------------------------------------------------------------------------------
check_refused_silently 'refused-tag-writes-nothing-to-stdout' 'not-a-version'
check_refused_silently 'refused-four-component-writes-nothing-to-stdout' 'v1.2.3.4'

echo ""
if [ "$failed" -ne 0 ]; then
  echo "FAIL: ${failed} of $((passed + failed)) version-classification cases did not hold" >&2
  exit 1
fi
echo "version-tag classification is correct for ${passed} cases: v0.1.0-alpha.9 is the documented historical graduation to the stable channel, stable tags are otherwise exactly v<major>.<minor>.<patch>, everything else version-shaped is a prerelease, and a non-version tag is refused with exit 2 and nothing on stdout"
