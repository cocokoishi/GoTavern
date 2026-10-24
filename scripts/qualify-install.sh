#!/bin/sh
# Qualify a GoTavern release with the INSTALLER, not with an archive extraction.
#
# WHY THIS EXISTS. Nothing in this repository ever executed install.sh. The install/update/rollback
# requirements in docs/INSTALLATION.md were documented procedures with no execution behind them, and the
# first time this script ran it found that install.sh never installed tokenizers/ -- so the one-line
# install, the documented primary path, produced a runtime whose own `gotavern assets verify` FAILED and
# whose tokenizer routes silently counted every prompt about 25% high. That defect survived precisely
# because no job ever ran the installer, and this script plus the installer fix land together so the
# first execution is also the proof that it is fixed.
#
# WHAT IT DOES, against archives the caller built in the SAME run (no network, no published release):
#   1. derives each archive's release TAG from `gotavern version --json` inside it, so nothing here
#      depends on a file name;
#   2. builds a release MIRROR in the canonical layout (<base>/<tag>/ and <base>/latest/download/,
#      canonical asset name, generated sha256sum-format checksums.txt);
#   3. serves it on loopback and points the installer at it via GOTAVERN_RELEASES_BASE_URL;
#   4. installs, runs the installed binary, and requires `assets verify` to pass FROM THE PREFIX;
#   5. requires the MIRROR to have served the requests, so an installer that ignored the seam and
#      fetched from github.com shows up as a missing request instead of as a successful install;
#   6. requires a tampered archive to ABORT naming the mismatch and to install nothing;
#   7. requires a re-install to succeed and to preserve runtime state;
#   8. requires an upgrade and then a rollback over the same prefix to preserve the user file and
#      config.yaml byte for byte, and the prefix to stay verifiable after each.
#
# Every assertion prints `ok: <what>` or `FAIL: <what>` and the script exits non-zero on the FIRST
# failure, after printing the installer output and the server log, so a CI log names the failing step.
#
# MODES. --powershell qualifies install.ps1 instead of install.sh with the SAME mirror and the SAME
# assertions, so the two installers cannot drift apart in what they claim. The payload differs (a zip
# with gotavern.exe at its root) and so does one check: Start.cmd is asserted to be written and to run
# gotavern.exe from its own directory, but it is NOT executed, because a .cmd launcher needs cmd.exe.
#
# WHAT RUNNING install.ps1 UNDER pwsh ON LINUX DOES NOT COVER, and therefore leaves unexecuted:
#   - Windows path separators and drive-letter handling: Join-Path runs, the separator is never a \;
#   - replacing a RUNNING gotavern.exe, which fails on Windows while the file is locked -- nothing here
#     holds it open, so that branch cannot be reached;
#   - the registry, shortcuts, $env:LOCALAPPDATA, Start Menu entries and elevation: install.ps1 does
#     none of these, and this run can prove neither that it does none of them nor that it would work;
#   - cmd.exe itself, so Start.cmd's behaviour under cmd is unproven.
# Those gaps are repeated in the release-qualification workflow comment and in docs/INSTALLATION.md
# section 3.1, so the claim and the coverage stay in the same place.
#
# Usage: scripts/qualify-install.sh [--powershell] [DIST_DIR] [NEWER_ARCHIVE] [OLDER_ARCHIVE]
#   DIST_DIR        directory holding the archives (default: .)
#   NEWER_ARCHIVE   the archive treated as the newer release (default: $DIST_DIR/gotavern-b.tar.gz)
#   OLDER_ARCHIVE   the archive treated as the older release (default: $DIST_DIR/gotavern-a.tar.gz)
#
# Requirements: sh, tar, python3 (the mirror), curl (the readiness probe), sha256sum.
#
# NOT COVERED, stated so nothing is implied: the Windows installer (same seam and same tokenizers fix,
# executed by nothing on a Linux runner), an update across DIFFERENT upstream baselines (both archives
# come from one commit; that is the runtime round-trip fixture's job), replacing a binary while a server
# is running, proxy/TLS behaviour against the real github.com path, and Docker.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)
# --powershell qualifies install.ps1 instead of install.sh. The mirror, the assertions and the
# fixtures are SHARED, so the two installers cannot drift apart in what they claim; only the payload
# shape (a zip with gotavern.exe at its root) and the launcher check differ.
MODE="sh"
if [ "${1:-}" = "--powershell" ]; then
    MODE="powershell"
    shift
fi

INSTALLER_NAME="install.sh"
ASSET_NAME="gotavern-linux-amd64.tar.gz"
BINARY_NAME="gotavern"
LAUNCHER="start.sh"
if [ "$MODE" = "powershell" ]; then
    INSTALLER_NAME="install.ps1"
    ASSET_NAME="gotavern-windows-amd64.zip"
    BINARY_NAME="gotavern.exe"
    LAUNCHER="Start.cmd"
fi
INSTALLER="$REPO_ROOT/$INSTALLER_NAME"

DIST_DIR=${1:-.}
NEWER_ARCHIVE=${2:-$DIST_DIR/gotavern-b.tar.gz}
OLDER_ARCHIVE=${3:-$DIST_DIR/gotavern-a.tar.gz}

ok() {
    echo "ok: $1"
}

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

for required in "$INSTALLER" "$NEWER_ARCHIVE" "$OLDER_ARCHIVE"; do
    [ -e "$required" ] || fail "missing required input: $required"
done
for tool in tar python3 curl sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
if [ "$MODE" = "powershell" ]; then
    # A missing pwsh would silently turn this into a zero-assertion run, so it is a failure, not a skip.
    # PWSH exists so a developer on Windows can rehearse this same script with powershell.exe; the lane
    # gate uses the default and fails loudly if it is absent.
    PWSH=${PWSH:-pwsh}
    command -v "$PWSH" >/dev/null 2>&1 || fail "$PWSH is required to qualify $INSTALLER_NAME, and a run without it would assert nothing"
fi

WORK_ROOT=$(mktemp -d 2>/dev/null || mktemp -d -t gotavern-qualify)
GOOD_PID=""
BAD_PID=""
SERVER_PID=""
cleanup() {
    for pid in "$SERVER_PID" "$BAD_PID" "$GOOD_PID"; do
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    rm -rf "$WORK_ROOT"
}
trap cleanup EXIT HUP INT TERM

sha256_of() {
    sha256sum "$1" | awk '{print $1}'
}

free_port() {
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

tag_of_binary() {
    "$1" version --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["gotavern_version"])'
}

# ---- 1. derive each release's tag from the binary inside the archive --------------------------

rm -rf "$WORK_ROOT/stage-older" "$WORK_ROOT/stage-newer"
mkdir -p "$WORK_ROOT/stage-older" "$WORK_ROOT/stage-newer"
tar -xzf "$OLDER_ARCHIVE" -C "$WORK_ROOT/stage-older" || fail "cannot extract $OLDER_ARCHIVE"
tar -xzf "$NEWER_ARCHIVE" -C "$WORK_ROOT/stage-newer" || fail "cannot extract $NEWER_ARCHIVE"
[ -x "$WORK_ROOT/stage-older/gotavern" ] || fail "$OLDER_ARCHIVE has no executable gotavern at its root"
[ -x "$WORK_ROOT/stage-newer/gotavern" ] || fail "$NEWER_ARCHIVE has no executable gotavern at its root"
[ -d "$WORK_ROOT/stage-older/src/tokenizers" ] || fail "$OLDER_ARCHIVE does not contain src/tokenizers/"
[ -d "$WORK_ROOT/stage-newer/src/tokenizers" ] || fail "$NEWER_ARCHIVE does not contain src/tokenizers/"

OLDER_TAG=$(tag_of_binary "$WORK_ROOT/stage-older/gotavern") || fail "cannot read $OLDER_ARCHIVE's version"
NEWER_TAG=$(tag_of_binary "$WORK_ROOT/stage-newer/gotavern") || fail "cannot read $NEWER_ARCHIVE's version"
[ -n "$OLDER_TAG" ] || fail "the older archive reports an empty version"
[ -n "$NEWER_TAG" ] || fail "the newer archive reports an empty version"
[ "$OLDER_TAG" != "$NEWER_TAG" ] || fail "both archives report the same version ($OLDER_TAG), so an update would move no immutable bytes"
ok "derived the release tags from the archives themselves: older=$OLDER_TAG newer=$NEWER_TAG"

# ---- 2. build the canonical mirror ----------------------------------------------------------

CANONICAL_ASSET="$ASSET_NAME"
GOOD_MIRROR="$WORK_ROOT/mirror"
BAD_MIRROR="$WORK_ROOT/mirror-tampered"

# build_release <base> <tag> <archive> <staged-tree>
#
# The mirror serves the asset the installer UNDER TEST asks for: the linux tar.gz for install.sh, or a
# zip with gotavern.exe at its root for install.ps1. The zip is built from the SAME staged tree the
# tar.gz holds and carries the same unix mode on the executable, so the two payloads differ only in the
# way the two installers' formats differ. Serving both shapes at once would let a run pass on the asset
# the installer under test did not ask for, which is why only one is served.
build_release() {
    base=$1
    tag=$2
    archive=$3
    staged=$4
    mkdir -p "$base/$tag"
    if [ "$MODE" = "powershell" ]; then
        python3 - "$staged" "$base/$tag/$CANONICAL_ASSET" <<'PY'
import os
import sys
import zipfile

staged, output = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for root, directories, names in os.walk(staged):
        directories.sort()
        for name in sorted(names):
            full = os.path.join(root, name)
            relative = os.path.relpath(full, staged).replace(os.sep, "/")
            if relative == "gotavern":
                relative = "gotavern.exe"
            entry = zipfile.ZipInfo(relative)
            entry.external_attr = (0o755 if relative.endswith(("gotavern.exe", ".sh")) else 0o644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as handle:
                archive.writestr(entry, handle.read())
PY
        [ -s "$base/$tag/$CANONICAL_ASSET" ] || fail "the windows payload was not built"
    else
        cp "$archive" "$base/$tag/$CANONICAL_ASSET"
    fi
    ( cd "$base/$tag" && sha256sum "$CANONICAL_ASSET" > checksums.txt )
}

build_release "$GOOD_MIRROR" "$OLDER_TAG" "$OLDER_ARCHIVE" "$WORK_ROOT/stage-older"
build_release "$GOOD_MIRROR" "$NEWER_TAG" "$NEWER_ARCHIVE" "$WORK_ROOT/stage-newer"
mkdir -p "$GOOD_MIRROR/latest/download"
cp "$GOOD_MIRROR/$NEWER_TAG/$CANONICAL_ASSET" "$GOOD_MIRROR/$NEWER_TAG/checksums.txt" "$GOOD_MIRROR/latest/download/"
[ -s "$GOOD_MIRROR/$OLDER_TAG/checksums.txt" ] || fail "the older release has no checksums.txt"
[ -s "$GOOD_MIRROR/latest/download/checksums.txt" ] || fail "the latest form has no checksums.txt"
ok "built a canonical mirror: <base>/$OLDER_TAG/, <base>/$NEWER_TAG/, <base>/latest/download/"

# The tampered mirror serves an ALTERED archive beside the checksums.txt generated BEFORE the
# alteration, which is exactly the situation the verification exists for.
build_release "$BAD_MIRROR" "$OLDER_TAG" "$OLDER_ARCHIVE" "$WORK_ROOT/stage-older"
printf 'tampered\n' >> "$BAD_MIRROR/$OLDER_TAG/$CANONICAL_ASSET"
ok "built the tampered mirror: its archive no longer matches its recorded checksum"

# ---- 3. serve both mirrors on loopback on ports nobody hardcoded -----------------------------

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

# start_mirror <dir> <port-file> <log-file>; the pid lands in MIRROR_LAST_PID and the port in
# MIRROR_LAST_PORT. Deliberately NOT a command substitution: state assigned inside $( ) is lost in the
# subshell, which is a bug this script had before it ever ran.
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
ok "serving the canonical mirror at $GOOD_URL and the tampered one at $BAD_URL"

# run_installer <mirror-url> <log-file> <version-or-empty> <prefix>
#
# ONE dispatch for both installers, called from one place so that a change to what is asserted cannot
# apply to only one of them. An empty version selects the default "latest" form.
run_installer() {
    mirror_url=$1
    log_file=$2
    version=$3
    prefix=$4
    if [ "$MODE" = "powershell" ]; then
        if [ -n "$version" ]; then
            GOTAVERN_RELEASES_BASE_URL="$mirror_url" "$PWSH" -NoProfile -NonInteractive -File "$INSTALLER" \
                -InstallDir "$prefix" -Version "$version" > "$log_file" 2>&1
        else
            GOTAVERN_RELEASES_BASE_URL="$mirror_url" "$PWSH" -NoProfile -NonInteractive -File "$INSTALLER" \
                -InstallDir "$prefix" > "$log_file" 2>&1
        fi
    else
        if [ -n "$version" ]; then
            GOTAVERN_RELEASES_BASE_URL="$mirror_url" sh "$INSTALLER" --version "$version" --dir "$prefix" > "$log_file" 2>&1
        else
            GOTAVERN_RELEASES_BASE_URL="$mirror_url" sh "$INSTALLER" --dir "$prefix" > "$log_file" 2>&1
        fi
    fi
}

# ---- 4. install the older release through the mirror, then run what was installed ------------

PREFIX="$WORK_ROOT/prefix"
if run_installer "$GOOD_URL" "$WORK_ROOT/install-older.log" "$OLDER_TAG" "$PREFIX"; then
    ok "$INSTALLER_NAME --version $OLDER_TAG installed through the mirror"
else
    cat "$WORK_ROOT/install-older.log" >&2
    fail "$INSTALLER_NAME --version $OLDER_TAG did not succeed against the mirror"
fi
[ -f "$PREFIX/$BINARY_NAME" ] || fail "the installed prefix has no $BINARY_NAME"
if [ "" = "powershell" ] && [ ! -x "$PREFIX/$BINARY_NAME" ]; then
    # Expand-Archive does not always carry a zip entry's unix mode to this host, and an executable bit
    # is MEANINGLESS on Windows, where install.ps1 actually runs. Restoring it is a harness concession
    # to running a Windows installer on Linux rather than a workaround for a product defect -- and it is
    # printed, so nobody mistakes it for something the installer did.
    chmod +x "$PREFIX/$BINARY_NAME"
    echo "note: restored the executable bit that Expand-Archive did not carry to this Unix host"
fi

# THE MIRROR MUST HAVE SERVED THE REQUESTS. Without this, an installer that ignored the seam would fetch
# from github.com, install fine, and pass every other assertion here.
grep -q "/$OLDER_TAG/checksums.txt" "$WORK_ROOT/good.log" \
    || { cat "$WORK_ROOT/good.log" >&2; fail "the mirror was never asked for $OLDER_TAG/checksums.txt (did the installer ignore GOTAVERN_RELEASES_BASE_URL?)"; }
grep -q "/$OLDER_TAG/$CANONICAL_ASSET" "$WORK_ROOT/good.log" \
    || fail "the mirror was never asked for $OLDER_TAG/$CANONICAL_ASSET"
ok "the mirror served the installer's metadata and archive requests"

INSTALLED_TAG=$(tag_of_binary "$PREFIX/$BINARY_NAME") || fail "the installed binary does not run"
[ "$INSTALLED_TAG" = "$OLDER_TAG" ] || fail "the installed binary reports $INSTALLED_TAG, expected $OLDER_TAG"
ok "the installed binary runs and reports $OLDER_TAG"

[ -d "$PREFIX/src/tokenizers" ] || fail "the installer did not install src/tokenizers/, which the release archive ships and the runtime reads from <InstallRoot>/src/tokenizers"
ok "the installer installed src/tokenizers/ under the install prefix"

if ( cd "$PREFIX" && "./$BINARY_NAME" assets verify > "$WORK_ROOT/assets-older.log" 2>&1 ); then
    ok "assets verify passes from the installed prefix"
else
    cat "$WORK_ROOT/assets-older.log" >&2
    fail "assets verify FAILED from the installed prefix"
fi

# The launcher is WRITTEN BY THE INSTALLER rather than copied from the archive, so it gets its own
# check. install.sh writes start.sh, which this host can execute; install.ps1 writes Start.cmd, which
# needs cmd.exe and therefore CANNOT be executed here -- that gap is named, not papered over.
#
# THE BOOT RUNS IN BOTH MODES, because it is a claim about the INSTALLED BINARY (it must create
# config.yaml and answer /version from the prefix), not about the launcher. In sh mode it goes through
# start.sh so the launcher is exercised too; in powershell mode it runs the installed binary directly
# and the launcher is covered by the assertions above plus the named skip.
DATA_ROOT="$WORK_ROOT/data-root"
LAUNCHED_THROUGH="$BINARY_NAME"
if [ "$MODE" = "powershell" ]; then
    [ -f "$PREFIX/$LAUNCHER" ] || fail "the installer did not write $LAUNCHER"
    # The launcher install.ps1 writes ends with `"%~dp0gotavern.exe" %*`, so a QUOTE sits between the
    # binary name and the arguments. The first version of this assertion looked for `gotavern.exe %*`
    # and failed the qualification run -- a HARNESS defect, and the pattern below was proven against a
    # real Start.cmd from a local rehearsal before this line was changed.
    grep -q '"%~dp0gotavern\.exe" %\*' "$PREFIX/$LAUNCHER" || fail "$LAUNCHER does not run gotavern.exe with the caller's arguments"
    grep -q 'cd /d "%~dp0"' "$PREFIX/$LAUNCHER" || fail "$LAUNCHER does not change to its own directory first"
    ok "$LAUNCHER was written and runs gotavern.exe from its own directory"
    echo "skip: $LAUNCHER was NOT executed: a .cmd launcher needs cmd.exe, so what it does when run is unproven here"
else
    LAUNCHED_THROUGH="$LAUNCHER"
fi

START_PORT=$(free_port)
[ -n "$START_PORT" ] || fail "could not allocate a port for the installed server"
( cd "$PREFIX" && exec "./$LAUNCHED_THROUGH" start --port "$START_PORT" --dataRoot "$DATA_ROOT" ) \
    > "$WORK_ROOT/server.log" 2>&1 &
SERVER_PID=$!
SERVER_READY=0
attempt=0
while [ "$attempt" -lt 300 ]; do
    if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$START_PORT/version" 2>/dev/null; then
        SERVER_READY=1
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        cat "$WORK_ROOT/server.log" >&2
        fail "the installed server exited before answering /version"
    fi
    attempt=$((attempt + 1))
    sleep 0.2
done
[ "$SERVER_READY" -eq 1 ] || { cat "$WORK_ROOT/server.log" >&2; fail "the installed server never answered /version"; }
ok "the installed server, started through $LAUNCHED_THROUGH, answered /version"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

[ -f "$PREFIX/config.yaml" ] || fail "the first start did not create config.yaml in the prefix"
USER_FILE="$DATA_ROOT/default-user/user/files/qualification.txt"
mkdir -p "$(dirname "$USER_FILE")"
printf 'gotavern installer qualification marker\n' > "$USER_FILE"
CONFIG_BEFORE=$(sha256_of "$PREFIX/config.yaml")
USER_BEFORE=$(sha256_of "$USER_FILE")

# ---- 5. the default (latest) form installs through the mirror -------------------------------

LATEST_PREFIX="$WORK_ROOT/prefix-latest"
if run_installer "$GOOD_URL" "$WORK_ROOT/install-latest.log" "" "$LATEST_PREFIX"; then
    ok "the default (latest) form installed through the mirror"
else
    cat "$WORK_ROOT/install-latest.log" >&2
    fail "the default (latest) form did not install from the mirror"
fi
LATEST_TAG=$(tag_of_binary "$LATEST_PREFIX/$BINARY_NAME") || fail "the latest-form binary does not run"
[ "$LATEST_TAG" = "$NEWER_TAG" ] || fail "the latest form installed $LATEST_TAG, expected the newer release $NEWER_TAG"
grep -q "/latest/download/$CANONICAL_ASSET" "$WORK_ROOT/good.log" || fail "the mirror was never asked for latest/download/$CANONICAL_ASSET"
ok "the latest form resolved to $NEWER_TAG through <base>/latest/download/"

# ---- 6. a tampered archive must ABORT and install nothing -----------------------------------

TAMPERED_PREFIX="$WORK_ROOT/prefix-tampered"
if run_installer "$BAD_URL" "$WORK_ROOT/install-tampered.log" "$OLDER_TAG" "$TAMPERED_PREFIX"; then
    cat "$WORK_ROOT/install-tampered.log" >&2
    fail "the installer SUCCEEDED on a tampered archive"
fi
grep -q "SHA-256 verification failed" "$WORK_ROOT/install-tampered.log" \
    || { cat "$WORK_ROOT/install-tampered.log" >&2; fail "the installer aborted but did not name the checksum mismatch"; }
[ ! -e "$TAMPERED_PREFIX/$BINARY_NAME" ] || fail "the installer left $BINARY_NAME in the prefix after a checksum failure"
[ ! -e "$TAMPERED_PREFIX/src/tokenizers" ] || fail "the installer left src/tokenizers/ in the prefix after a checksum failure"
ok "a tampered archive aborted, named the mismatch, and installed nothing"

# ---- 7. re-install: idempotent, and it preserves runtime state ------------------------------

if run_installer "$GOOD_URL" "$WORK_ROOT/install-again.log" "$OLDER_TAG" "$PREFIX"; then
    ok "re-running the installer over the same prefix succeeded"
else
    cat "$WORK_ROOT/install-again.log" >&2
    fail "re-running the installer over the same prefix failed"
fi
[ "$(sha256_of "$USER_FILE")" = "$USER_BEFORE" ] || fail "a re-install changed the user file"
[ "$(sha256_of "$PREFIX/config.yaml")" = "$CONFIG_BEFORE" ] || fail "a re-install changed config.yaml"
ok "a re-install preserved the user file and config.yaml byte for byte"

# ---- 8. upgrade, then rollback, at the installer level ---------------------------------------

if run_installer "$GOOD_URL" "$WORK_ROOT/install-newer.log" "$NEWER_TAG" "$PREFIX"; then
    ok "installed the newer release ($NEWER_TAG) over the older prefix"
else
    cat "$WORK_ROOT/install-newer.log" >&2
    fail "installing the newer release over the older prefix failed"
fi
UPGRADED_TAG=$(tag_of_binary "$PREFIX/$BINARY_NAME") || fail "the upgraded binary does not run"
[ "$UPGRADED_TAG" = "$NEWER_TAG" ] || fail "after the upgrade the prefix reports $UPGRADED_TAG, expected $NEWER_TAG"
[ "$(sha256_of "$USER_FILE")" = "$USER_BEFORE" ] || fail "the upgrade changed the user file"
[ "$(sha256_of "$PREFIX/config.yaml")" = "$CONFIG_BEFORE" ] || fail "the upgrade changed config.yaml"
# The tokenizer tree is REPLACED by every install, so an upgrade that drops it is precisely the
# regression this fix could reintroduce; verifying from the upgraded prefix is cheaper than
# rediscovering it later.
if ( cd "$PREFIX" && "./$BINARY_NAME" assets verify > "$WORK_ROOT/assets-upgraded.log" 2>&1 ); then
    ok "assets verify still passes from the upgraded prefix (src/tokenizers/ survived the update)"
else
    cat "$WORK_ROOT/assets-upgraded.log" >&2
    fail "assets verify FAILED from the upgraded prefix"
fi

# ROLLBACK: the older release over the same prefix. No boot happens between the two installs, so this is
# the INSTALLER's claim about mutable state rather than a startup migration wearing its clothes.
if run_installer "$GOOD_URL" "$WORK_ROOT/install-rollback.log" "$OLDER_TAG" "$PREFIX"; then
    ok "rolled the prefix back to $OLDER_TAG"
else
    cat "$WORK_ROOT/install-rollback.log" >&2
    fail "rolling the prefix back to $OLDER_TAG failed"
fi
ROLLED_BACK_TAG=$(tag_of_binary "$PREFIX/$BINARY_NAME") || fail "the rolled-back binary does not run"
[ "$ROLLED_BACK_TAG" = "$OLDER_TAG" ] || fail "after the rollback the prefix reports $ROLLED_BACK_TAG, expected $OLDER_TAG"
[ "$(sha256_of "$USER_FILE")" = "$USER_BEFORE" ] || fail "the rollback changed the user file"
[ "$(sha256_of "$PREFIX/config.yaml")" = "$CONFIG_BEFORE" ] || fail "the rollback changed config.yaml"
[ -f "$PREFIX/BUILD-INFO.txt" ] || fail "the prefix has no BUILD-INFO.txt after the rollback"
ok "the rollback preserved the user file and config.yaml byte for byte, and the binary is $OLDER_TAG again"

echo
echo "installer qualification: all assertions passed ($OLDER_TAG <-> $NEWER_TAG)"
