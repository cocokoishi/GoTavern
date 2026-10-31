#!/bin/sh
#
# qualify-prepublish.sh DIST_DIR CANDIDATE_TAG
#
# PROVE THE BARE-INSTALL PATH FOR A CANDIDATE RELEASE BEFORE ITS TAG EXISTS.
#
# WHY THIS EXISTS. `install.sh` and `install.ps1` with no version argument download
# `https://github.com/<repo>/releases/latest/download/...`. That URL only exists AFTER a release is
# published, so the one thing `release-install-smoke.yml` can never do is judge the candidate BEFORE the
# tag is cut -- it downloads the published release, and the published release is what the tag creates.
# `scripts/qualify-install.sh` does run both installers, but against a synthetic mirror built from two
# in-run archives whose tags are derived from the binaries (`qual-a`, `qual-b`): it proves the parsing and
# the mirror seam, not that the SIX CANONICAL assets this run built resolve through the installer's latest
# path with THEIR OWN checksums.txt entries.
#
# WHAT THIS DOES, and each item is an assertion in the body rather than a claim in this header:
#   1. asks the canonical classifier (scripts/classify-version-tag.sh) what channel CANDIDATE_TAG is, and
#      REFUSES to qualify a bare-install candidate that is not `stable`. A prerelease must NOT become
#      releases/latest; that negative direction is asserted after publication by
#      release-install-smoke.yml, and qualifying one here would prove the wrong thing;
#   2. requires the six canonical archives plus checksums.txt (produced by
#      scripts/release-assemble-checksums.sh, the SAME script release.yml's publish job calls) and
#      re-verifies every digest and every installer-parser entry independently;
#   3. requires the archive to NAME the candidate: BUILD-INFO.txt says "GoTavern release <tag>" and the
#      shipped binaries carry the tag's bytes, so the artefact this qualification installs is the
#      artefact the tag will publish;
#   4. builds a release mirror in the canonical layout, <base>/<tag>/ AND <base>/latest/download/, from
#      those very files. THE MIRROR'S latest/download IS A STAND-IN, AND IT SAYS SO: GitHub's
#      releases/latest for this tag does not exist and is NOT consulted; the directory stands in for the
#      pointer the stable channel will create, and it is populated only because assertion 1 said
#      `stable`. Nothing here pretends a remote `latest` exists or invents a network path;
#   5. serves that mirror on loopback, points the installers at it with GOTAVERN_RELEASES_BASE_URL, and
#      runs the BARE forms -- `install.sh --dir <prefix>` and `install.ps1 -InstallDir <prefix>`, no
#      `--version` / `-Version` -- so the code path under test is the documented one-liner's;
#   6. requires the mirror to have SERVED the checksums and the archive for the platform under test, so an
#      installer that ignored the seam and reached github.com shows up as a MISSING request rather than as
#      a successful install (AGENTS.md "Verification methods" 14);
#   7. requires the installed binary to report CANDIDATE_TAG and to be BYTE-IDENTICAL to the binary inside
#      the candidate archive, requires `assets verify` from the prefix (src/tokenizers/ present), and boots
#      it to a `/version` answer;
#   8. requires a TAMPERED archive, served beside the untouched checksums, to ABORT naming the SHA-256
#      mismatch and to install nothing.
#
# WHAT THIS DOES NOT PROVE, stated so a green is not read as more:
#   - The Windows installer is executed under `pwsh` ON LINUX (install.ps1 has no platform-specific
#     download logic), against the REAL windows/amd64 zip. Its download/verify/extract/install path is
#     therefore proven, but the installed `gotavern.exe` is a PE binary and CANNOT be executed here, so
#     "the installed Windows binary reports the tag" is ARCHIVE-INSPECTED (bytes + BUILD-INFO) only.
#     Windows-only installer behaviour (replacing a running exe, backslash paths, Start.cmd via cmd.exe,
#     registry/shortcut absence) is executed by release-qualification.yml's qualify-windows-amd64 job,
#     against archives it builds itself, and is not a claim of this script.
#   - No archive is booted on darwin or arm64: this runner is linux/amd64, and those four assets are
#     cross-compiled and archive-inspected, never runtime-qualified by any job in this repository.
#   - GitHub's releases/latest is not touched at all; the post-publication positive direction (latest
#     really serves this release's own checksums.txt bytes) belongs to release-install-smoke.yml, which
#     runs after the tag.
#
# Usage: sh scripts/qualify-prepublish.sh DIST_DIR CANDIDATE_TAG
#   DIST_DIR       directory holding the six canonical archives and checksums.txt
#   CANDIDATE_TAG  the tag the candidate will be published as (must classify `stable`)
# Requirements: sh, tar, unzip, python3 (the mirror), curl (readiness), sha256sum, and pwsh
#               (a missing pwsh is a FAILURE: a run without it would assert nothing about install.ps1).
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)

DIST_DIR=${1:-}
CANDIDATE_TAG=${2:-}
if [ -z "$DIST_DIR" ] || [ -z "$CANDIDATE_TAG" ]; then
    echo "usage: qualify-prepublish.sh DIST_DIR CANDIDATE_TAG" >&2
    exit 2
fi
case "$DIST_DIR" in
    /*) ;;
    *) DIST_DIR="$(pwd -P)/${DIST_DIR}" ;;
esac

ASSET_LINUX="gotavern-linux-amd64.tar.gz"
ASSET_WINDOWS="gotavern-windows-amd64.zip"
CANONICAL="gotavern-darwin-amd64.tar.gz
gotavern-darwin-arm64.tar.gz
gotavern-linux-amd64.tar.gz
gotavern-linux-arm64.tar.gz
gotavern-windows-amd64.zip
gotavern-windows-arm64.zip"

ok() { echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

for required in "$REPO_ROOT/install.sh" "$REPO_ROOT/install.ps1" "$REPO_ROOT/scripts/classify-version-tag.sh" "$DIST_DIR"; do
    [ -e "$required" ] || fail "missing required input: $required"
done
for tool in tar unzip python3 curl sha256sum awk; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
PWSH=${PWSH:-pwsh}
command -v "$PWSH" >/dev/null 2>&1 || fail "$PWSH is required to qualify install.ps1; a run without it would assert nothing about the Windows installer (the same rule scripts/qualify-install.sh uses)"

WORK_ROOT=$(mktemp -d 2>/dev/null || mktemp -d -t gotavern-prepublish)
GOOD_PID=""
BAD_PID=""
SERVER_PID=""
cleanup() {
    for pid in "$SERVER_PID" "$BAD_PID" "$GOOD_PID"; do
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
    done
    rm -rf "$WORK_ROOT"
}
trap cleanup EXIT HUP INT TERM

sha256_of() { sha256sum "$1" | awk '{print $1}'; }
free_port() {
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

# ---- 1. THE CANDIDATE MUST BE STABLE, PER THE CANONICAL CLASSIFIER -----------------------------------
# The classifier is called, never reimplemented: this is the same answer release.yml uses to decide
# --prerelease/--latest and docker.yml uses to decide whether :latest moves.
channel="$(bash "$REPO_ROOT/scripts/classify-version-tag.sh" "$CANDIDATE_TAG")" || {
    fail "scripts/classify-version-tag.sh REFUSED '${CANDIDATE_TAG}' (exit 2): it is not a version tag this repository can release"
}
if [ "$channel" != "stable" ]; then
    cat >&2 <<EOF
FAIL: '${CANDIDATE_TAG}' is classified '${channel}' by scripts/classify-version-tag.sh, not 'stable'.
      The bare-install path (releases/latest/download) may only be qualified for a tag the classifier
      calls stable, because only then will the release that publishes it become releases/latest. A
      PRERELEASE candidate's correct bare-install behaviour is the opposite -- latest must NOT resolve it
      -- and that direction is proven after publication by release-install-smoke.yml.
EOF
    exit 1
fi
ok "canonical classifier: '${CANDIDATE_TAG}' is stable (scripts/classify-version-tag.sh)"

# ---- 2. THE SIX CANONICAL ARCHIVES AND THEIR OWN checksums.txt --------------------------------------
for asset in $CANONICAL; do
    [ -s "$DIST_DIR/$asset" ] || fail "missing or empty canonical archive: ${DIST_DIR}/${asset}"
done
[ -s "$DIST_DIR/checksums.txt" ] || fail "missing ${DIST_DIR}/checksums.txt; run scripts/release-assemble-checksums.sh first"

if grep -q "$(printf '\r')" "$DIST_DIR/checksums.txt"; then
    fail "checksums.txt contains CR; the installer's name field would carry a trailing CR"
fi
lines=$(wc -l < "$DIST_DIR/checksums.txt" | tr -d ' ')
[ "$lines" -eq 6 ] || fail "checksums.txt has ${lines} lines, expected 6"

expected_names=$(printf '%s\n' $CANONICAL | LC_ALL=C sort)
actual_names=$(awk '{print $2}' "$DIST_DIR/checksums.txt" | LC_ALL=C sort)
[ "$actual_names" = "$expected_names" ] || {
    echo "FAIL: checksums.txt does not name exactly the canonical six" >&2
    printf 'expected:\n%s\nactual:\n%s\n' "$expected_names" "$actual_names" >&2
    exit 1
}
while read -r hash name; do
    printf '%s' "$hash" | grep -Eq '^[0-9a-f]{64}$' || fail "checksums.txt entry for '${name}' has a malformed digest '${hash}'"
    actual=$(sha256_of "$DIST_DIR/$name")
    [ "$actual" = "$hash" ] || fail "${name}: checksums.txt says ${hash}, the archive hashes to ${actual}"
    entries=$(awk -v asset="$name" '$2 == asset' "$DIST_DIR/checksums.txt" | wc -l | tr -d ' ')
    [ "$entries" -eq 1 ] || fail "'${name}' resolves to ${entries} installer-parser entries, expected 1"
done < "$DIST_DIR/checksums.txt"
ok "the six canonical archives are present and checksums.txt resolves one verified entry per archive"

# ---- 3. THE ARCHIVES NAME THE CANDIDATE (this is the candidate's artefact, not another release's) ----
mkdir -p "$WORK_ROOT/unpack-linux" "$WORK_ROOT/unpack-windows"
tar -xzf "$DIST_DIR/$ASSET_LINUX" -C "$WORK_ROOT/unpack-linux" || fail "cannot extract $ASSET_LINUX"
unzip -q "$DIST_DIR/$ASSET_WINDOWS" -d "$WORK_ROOT/unpack-windows" || fail "cannot extract $ASSET_WINDOWS"
[ -x "$WORK_ROOT/unpack-linux/gotavern" ] || fail "$ASSET_LINUX has no executable gotavern at its root"
[ -s "$WORK_ROOT/unpack-windows/gotavern.exe" ] || fail "$ASSET_WINDOWS has no gotavern.exe at its root"
for tree in "$WORK_ROOT/unpack-linux" "$WORK_ROOT/unpack-windows"; do
    grep -q "GoTavern release ${CANDIDATE_TAG}" "$tree/BUILD-INFO.txt" || {
        echo "FAIL: ${tree}/BUILD-INFO.txt does not name ${CANDIDATE_TAG}:" >&2
        cat "$tree/BUILD-INFO.txt" >&2
        exit 1
    }
done
# The stamped version string must be IN the shipped binary. For linux/amd64 it is additionally EXECUTED
# below; for the PE binary this byte-level check is the strongest identity assertion a Linux runner has,
# and it is labelled archive-inspected everywhere it is reported.
grep -qF "$CANDIDATE_TAG" "$WORK_ROOT/unpack-linux/gotavern" || fail "the linux binary does not carry the release version string '${CANDIDATE_TAG}'"
grep -qF "$CANDIDATE_TAG" "$WORK_ROOT/unpack-windows/gotavern.exe" || fail "the windows binary does not carry the release version string '${CANDIDATE_TAG}'"
ok "both candidate archives name ${CANDIDATE_TAG} in BUILD-INFO.txt and carry its bytes in the binary"

# ---- 4. THE MIRROR: the candidate in the canonical layout, including the latest pointer --------------
# READ THIS BEFORE TRUSTING THE WORD "latest" ANYWHERE BELOW. GitHub's releases/latest for CANDIDATE_TAG
# does not exist yet, and this run never asks GitHub. <base>/latest/download/ is a STAND-IN for the
# pointer the stable channel will create: it holds the candidate's own files because assertion 1
# classified the candidate stable, which is exactly the state GitHub will be in after the tag publishes.
# The alternative -- publishing first and qualifying later -- is what release-install-smoke.yml does, and
# it cannot fail the release before users see it.
GOOD_MIRROR="$WORK_ROOT/mirror"
BAD_MIRROR="$WORK_ROOT/mirror-tampered"
for base in "$GOOD_MIRROR" "$BAD_MIRROR"; do
    mkdir -p "$base/$CANDIDATE_TAG" "$base/latest/download"
    for asset in $CANONICAL checksums.txt; do
        cp "$DIST_DIR/$asset" "$base/$CANDIDATE_TAG/$asset"
        cp "$DIST_DIR/$asset" "$base/latest/download/$asset"
    done
done
# The tampered mirror keeps the checksums.txt generated BEFORE the alteration: that is precisely the
# situation the digest check exists for.
printf 'tampered\n' >> "$BAD_MIRROR/latest/download/$ASSET_LINUX"
ok "built the candidate mirror (<base>/${CANDIDATE_TAG}/ and the latest stand-in <base>/latest/download/) and a tampered copy"
echo "note: releases/latest is NOT consulted in this run -- <base>/latest/download is a stand-in for the pointer the tag will create"

# ---- 5. SERVE BOTH MIRRORS ON LOOPBACK ---------------------------------------------------------------
cat > "$WORK_ROOT/serve.py" <<'PY'
import http.server
import socketserver
import sys

directory, port_file = sys.argv[1], sys.argv[2]
handler = lambda *args, **kwargs: http.server.SimpleHTTPRequestHandler(*args, directory=directory, **kwargs)
with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
    with open(port_file, "w", encoding="utf-8") as handle:
        handle.write(str(httpd.server_address[1]))
    httpd.serve_forever()
PY

MIRROR_LAST_PID=""
MIRROR_LAST_PORT=""
start_mirror() {
    python3 "$WORK_ROOT/serve.py" "$1" "$2" > "$3" 2>&1 &
    MIRROR_LAST_PID=$!
    attempt=0
    while [ ! -s "$2" ]; do
        kill -0 "$MIRROR_LAST_PID" 2>/dev/null || { cat "$3" >&2; fail "the mirror server died before reporting a port"; }
        attempt=$((attempt + 1))
        [ "$attempt" -lt 400 ] || fail "the mirror server never reported a port"
        sleep 0.05
    done
    MIRROR_LAST_PORT=$(cat "$2")
    attempt=0
    while [ "$attempt" -lt 100 ]; do
        if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$MIRROR_LAST_PORT/" 2>/dev/null; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 0.1
    done
    fail "the mirror server on port $MIRROR_LAST_PORT is not answering"
}

rm -f "$WORK_ROOT/good.port" "$WORK_ROOT/bad.port"
start_mirror "$GOOD_MIRROR" "$WORK_ROOT/good.port" "$WORK_ROOT/good.log"
GOOD_PID=$MIRROR_LAST_PID
GOOD_URL="http://127.0.0.1:$MIRROR_LAST_PORT"
start_mirror "$BAD_MIRROR" "$WORK_ROOT/bad.port" "$WORK_ROOT/bad.log"
BAD_PID=$MIRROR_LAST_PID
BAD_URL="http://127.0.0.1:$MIRROR_LAST_PORT"
ok "serving the candidate mirror at $GOOD_URL and the tampered one at $BAD_URL"

# ---- 6. BARE `install.sh` (NO --version): resolves latest/download, verifies, installs, RUNS ----------
PREFIX="$WORK_ROOT/prefix-linux"
if GOTAVERN_RELEASES_BASE_URL="$GOOD_URL" sh "$REPO_ROOT/install.sh" --dir "$PREFIX" > "$WORK_ROOT/install-linux.log" 2>&1; then
    ok "install.sh with NO --version installed through <base>/latest/download/"
else
    cat "$WORK_ROOT/install-linux.log" >&2
    cat "$WORK_ROOT/good.log" >&2
    fail "the BARE install.sh form did not install the candidate"
fi
# The bare form selected the latest path, not a tag path.
grep -q 'release: latest stable' "$WORK_ROOT/install-linux.log" || {
    cat "$WORK_ROOT/install-linux.log" >&2
    fail "install.sh did not take the 'latest stable' form (was a --version passed?)"
}
grep -q '^Checksum verified\.$' "$WORK_ROOT/install-linux.log" || {
    cat "$WORK_ROOT/install-linux.log" >&2
    fail "install.sh did not report a verified checksum"
}
# THE MIRROR MUST HAVE SERVED THE REQUESTS: an installer that ignored the seam and reached github.com
# would fail later anyway (the tag is not published), but a MISSING request is the assertion that names
# it, rather than an unexplained download error.
grep -q "/latest/download/checksums.txt" "$WORK_ROOT/good.log" || {
    cat "$WORK_ROOT/good.log" >&2
    fail "the mirror was never asked for latest/download/checksums.txt (did install.sh ignore GOTAVERN_RELEASES_BASE_URL?)"
}
grep -q "/latest/download/$ASSET_LINUX" "$WORK_ROOT/good.log" || {
    cat "$WORK_ROOT/good.log" >&2
    fail "the mirror was never asked for latest/download/$ASSET_LINUX"
}
ok "the mirror served the bare installer's checksums and archive requests"

[ -x "$PREFIX/gotavern" ] || fail "the installed prefix has no executable gotavern"
[ -d "$PREFIX/src/tokenizers" ] || fail "the installed prefix has no src/tokenizers/"

# SAME ARCHIVE: the installed binary is the candidate archive's binary, byte for byte. A version string
# alone could be a rebuild; this is the file the checksum in the release covers.
archive_binary_sha=$(sha256_of "$WORK_ROOT/unpack-linux/gotavern")
installed_binary_sha=$(sha256_of "$PREFIX/gotavern")
[ "$archive_binary_sha" = "$installed_binary_sha" ] || fail "the installed binary (${installed_binary_sha}) is not the candidate archive's binary (${archive_binary_sha})"
ok "the installed binary is byte-identical to the candidate archive's gotavern"

"$PREFIX/gotavern" version --json > "$WORK_ROOT/version.json" || fail "the installed binary does not run"
cat "$WORK_ROOT/version.json"
reported=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gotavern_version"])' "$WORK_ROOT/version.json")
[ "$reported" = "$CANDIDATE_TAG" ] || fail "the installed binary reports '${reported}', expected '${CANDIDATE_TAG}'"
ok "the installed binary EXECUTES and reports ${CANDIDATE_TAG}"

( cd "$PREFIX" && "./gotavern" assets verify ) > "$WORK_ROOT/assets-verify.log" 2>&1 || {
    cat "$WORK_ROOT/assets-verify.log" >&2
    fail "assets verify FAILED from the bare-installed prefix"
}
grep -q '/src/tokenizers' "$WORK_ROOT/assets-verify.log" || fail "assets verify did not confirm the src/tokenizers layout"
ok "assets verify passes from the installed prefix (src/tokenizers/ shipped)"

# ---- 7. THE INSTALLED BINARY BOOTS AND ANSWERS /version ----------------------------------------------
PORT=$(free_port)
[ -n "$PORT" ] || fail "could not allocate a port for the installed server"
mkdir -p "$WORK_ROOT/data"
( cd "$PREFIX" && exec "./gotavern" start --port "$PORT" --dataRoot "$WORK_ROOT/data" ) > "$WORK_ROOT/server.log" 2>&1 &
SERVER_PID=$!
SERVER_READY=0
attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 -o "$WORK_ROOT/version-endpoint.json" "http://127.0.0.1:${PORT}/version" 2>/dev/null; then
        SERVER_READY=1
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        cat "$WORK_ROOT/server.log" >&2
        fail "the bare-installed binary exited before answering /version"
    fi
    attempt=$((attempt + 1))
    sleep 1
done
[ "$SERVER_READY" -eq 1 ] || { cat "$WORK_ROOT/server.log" >&2; fail "the bare-installed binary never answered /version within 60 s"; }
cat "$WORK_ROOT/version-endpoint.json"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
ok "the bare-installed binary booted and answered /version"

# ---- 8. A TAMPERED ARCHIVE MUST BE REFUSED -----------------------------------------------------------
TAMPERED_PREFIX="$WORK_ROOT/prefix-tampered"
if GOTAVERN_RELEASES_BASE_URL="$BAD_URL" sh "$REPO_ROOT/install.sh" --dir "$TAMPERED_PREFIX" > "$WORK_ROOT/install-tampered.log" 2>&1; then
    cat "$WORK_ROOT/install-tampered.log" >&2
    fail "the bare installer SUCCEEDED on a tampered archive"
fi
grep -q 'SHA-256 verification failed' "$WORK_ROOT/install-tampered.log" || {
    cat "$WORK_ROOT/install-tampered.log" >&2
    fail "the installer aborted on the tampered archive but did not name the checksum mismatch"
}
[ ! -e "$TAMPERED_PREFIX/gotavern" ] || fail "the installer left gotavern in the prefix after a checksum failure"
[ ! -e "$TAMPERED_PREFIX/src/tokenizers" ] || fail "the installer left src/tokenizers/ in the prefix after a checksum failure"
ok "a tampered archive was REFUSED by the bare installer, naming the mismatch, and installed nothing"

# ---- 9. BARE `install.ps1` (NO -Version): the real windows/amd64 zip, resolver + install -------------
# install.ps1 is executed under pwsh ON LINUX. Its download/verify/extract/install path is
# platform-independent and this is the REAL windows/amd64 zip from the release build, so what is proven
# is: the bare (latest) resolver, the checksum entry, the archive, and the installed file set. What is
# NOT proven here is the PE binary's runtime behaviour -- it cannot be executed on a Linux runner.
PREFIX_WIN="$WORK_ROOT/prefix-windows"
if GOTAVERN_RELEASES_BASE_URL="$GOOD_URL" "$PWSH" -NoProfile -NonInteractive -File "$REPO_ROOT/install.ps1" -InstallDir "$PREFIX_WIN" > "$WORK_ROOT/install-windows.log" 2>&1; then
    ok "install.ps1 with NO -Version installed through <base>/latest/download/"
else
    cat "$WORK_ROOT/install-windows.log" >&2
    cat "$WORK_ROOT/good.log" >&2
    fail "the BARE install.ps1 form did not install the candidate"
fi
grep -q 'Checksum verified\.' "$WORK_ROOT/install-windows.log" || {
    cat "$WORK_ROOT/install-windows.log" >&2
    fail "install.ps1 did not report a verified checksum"
}
# WHICH WINDOWS ASSET DID THE BARE RESOLVER ASK FOR? install.ps1 selects the asset from the RUNNER's
# architecture, and the claim this qualification makes is about the canonical windows/amd64 archive. The
# installer prints the platform it selected, so it is READ AND ASSERTED rather than assumed: on a
# non-x64 runner the run would be proving a different asset, which must fail loudly instead of being read
# as the x64 claim.
windows_arch="$(sed -n 's/.*target:  windows\/\([A-Za-z0-9]*\).*/\1/p' "$WORK_ROOT/install-windows.log" | sed -n '1p')"
[ -n "$windows_arch" ] || {
    cat "$WORK_ROOT/install-windows.log" >&2
    fail "could not read the platform install.ps1 selected (expected a 'target:  windows/<arch>' line)"
}
[ "$windows_arch" = "amd64" ] || fail "install.ps1 selected windows/${windows_arch} on this runner; this qualification asserts the canonical windows/amd64 archive on the release workflow's linux/amd64 runner, so a different host would prove a different claim"
grep -q "/latest/download/$ASSET_WINDOWS" "$WORK_ROOT/good.log" || {
    cat "$WORK_ROOT/good.log" >&2
    fail "the mirror was never asked for latest/download/$ASSET_WINDOWS"
}
[ -s "$PREFIX_WIN/gotavern.exe" ] || fail "the installed Windows prefix has no gotavern.exe"
[ -f "$PREFIX_WIN/Start.cmd" ] || fail "install.ps1 did not write Start.cmd"
[ -d "$PREFIX_WIN/src/tokenizers" ] || fail "install.ps1 did not install src/tokenizers/"
archive_exe_sha=$(sha256_of "$WORK_ROOT/unpack-windows/gotavern.exe")
installed_exe_sha=$(sha256_of "$PREFIX_WIN/gotavern.exe")
[ "$archive_exe_sha" = "$installed_exe_sha" ] || fail "the installed gotavern.exe (${installed_exe_sha}) is not the candidate archive's (${archive_exe_sha})"
ok "the installed gotavern.exe is byte-identical to the candidate archive's"
echo "skip: the installed gotavern.exe was NOT executed -- a windows/amd64 PE cannot run on this Linux runner."
echo "      Its identity is ARCHIVE-INSPECTED here (bytes + BUILD-INFO); Windows runtime qualification is"
echo "      release-qualification.yml's qualify-windows-amd64 job, which executes the installer and the"
echo "      binary on a Windows runner against archives it builds itself."

# ---- WHAT THE GREEN MEANS ---------------------------------------------------------------------------
echo
echo "prepublish qualification for ${CANDIDATE_TAG}: every assertion passed"
echo "  - classifier: stable (the same answer release.yml and docker.yml consume)"
echo "  - bare install.sh : latest/download -> checksum entry -> the candidate archive -> executed ${CANDIDATE_TAG}"
echo "  - bare install.ps1: latest/download -> checksum entry -> the candidate windows archive -> installed (not executed)"
echo "  - tampered archive: refused, nothing installed"
echo "  - releases/latest on GitHub: NOT consulted (the tag does not exist yet); the mirror's latest/download"
echo "    is the stand-in, populated only because the classifier calls this candidate stable"
