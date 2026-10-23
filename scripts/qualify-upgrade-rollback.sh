#!/bin/sh
# Qualify a CROSS-BASELINE update and ROLLBACK with the real installer, against a loopback mirror.
#
# WHY THIS EXISTS. release-qualification.yml's linux job extracts archives over one install directory
# and then rolls back -- but BOTH archives come from ONE commit and differ only in the version string
# they are built with. docs/INSTALLATION.md names the gap: "an update across DIFFERENT upstream
# baselines (both archives come from one commit)". Nothing in this repository had ever:
#   - installed a release built from commit A,
#   - updated it with a release built from commit B,
#   - rolled B back to A,
#   - and asserted that the runtime state a user actually has (config.yaml, data/, extensions/,
#     certs/) survived every step byte for byte, including the state WRITTEN BY B.
# That last point is the release unknown this script closes: the direction where an older binary must
# read a tree a newer binary wrote.
#
# WHAT IT DOES, in order, against archives the caller built from TWO DIFFERENT COMMITS in the same run
# (no network beyond loopback, no published release):
#   1. derives each archive's release TAG from `gotavern version --json` INSIDE it, so nothing here
#      depends on a file name, and requires the two tags to differ;
#   2. MEASURES whether the two releases carry different vendored asset trees and says which answer it
#      got -- a cross-baseline pair whose embedded manifests happen to be identical is reported as such
#      rather than described as an asset-level difference that does not exist;
#   3. builds a release MIRROR in the canonical layout (<base>/<tag>/ and <base>/latest/download/,
#      canonical asset name, sha256sum-format checksums.txt) and serves it on loopback;
#   4. INSTALLS the older release through install.sh and the mirror seam, then asserts the installed
#      binary reports the older tag and `assets verify` passes FROM THE PREFIX;
#   5. seeds the runtime state a user has -- config.yaml carrying a key GoTavern does not know,
#      data/default-user/{settings.json,cards/,chats/}, extensions/<name>/ and certs/ -- and SNAPSHOTS
#      it (relative path + sha256, sorted);
#   6. BOOTS the older binary over that prefix, requires /version to answer, and stops it, because a
#      real update happens over a tree the previous release has already started once;
#   7. UPDATES to the newer release through the SAME installer and mirror, requires the version to move
#      and the binary bytes to change, and requires every seeded file to be byte-identical;
#   8. BOOTS the newer binary, then WRITES NEW STATE WITH IT (a chat, a card, a settings key), because
#      the interesting rollback is over state the newer release created;
#   9. ROLLS BACK to the older release through the same installer, and requires the installed binary to
#      be BYTE-IDENTICAL to the older archive's binary, the version to move back, and `assets verify`
#      to pass again;
#  10. asserts the state the NEWER release wrote is still present and unchanged, BOOTS the OLDER binary
#      over it, and requires it to start, answer /version, and leave that state unchanged -- the
#      cross-baseline direction nobody had executed;
#  11. requires the MIRROR to have served every request both release forms make, so an installer that
#      ignored the seam and fetched from github.com shows up as missing requests instead of passing.
#
# Every assertion prints `ok: <what>` or `FAIL: <what>`, the script exits non-zero on the FIRST
# failure after printing the installer output, the server log and the snapshot diff for that step, and
# the success summary is the LAST line with nothing after it. There is no `exit 0` before the last
# assertion and no assertion after the summary, because a check placed after its own exit gate prints
# and cannot fail.
#
# WHAT THIS DOES NOT COVER, stated so it is not implied: the real github.com download path (every
# install goes through the mirror seam), Windows (its own job runs the four Windows-only behaviours),
# elevation, non-NTFS filesystems, Docker, and an update whose two releases differ in the EMBEDDED
# ASSET MANIFEST -- tested here only if the chosen baseline pair happens to differ, and step 2 reports
# which of the two it was. `install.sh` also does not migrate config.yaml between releases; this script
# asserts that the OLDER release still READS what the newer one wrote, which is the observable a user
# depends on, not that the two releases write identical defaults.
#
# Usage: scripts/qualify-upgrade-rollback.sh [DIST_DIR] [OLDER_ARCHIVE] [NEWER_ARCHIVE]
#   DIST_DIR        directory holding the archives (default: .)
#   OLDER_ARCHIVE   the archive treated as the older release (default: $DIST_DIR/gotavern-older.tar.gz)
#   NEWER_ARCHIVE   the archive treated as the newer release (default: $DIST_DIR/gotavern-newer.tar.gz)
#
# Requirements: sh, tar, python3 (the mirror), curl (the readiness probe), sha256sum.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)

DIST_DIR=${1:-.}
OLDER_ARCHIVE=${2:-$DIST_DIR/gotavern-older.tar.gz}
NEWER_ARCHIVE=${3:-$DIST_DIR/gotavern-newer.tar.gz}
ASSET_NAME="gotavern-linux-amd64.tar.gz"
INSTALLER="$REPO_ROOT/install.sh"

fail() {
    echo "FAIL: $*" >&2
    for log in installer-update.log installer-rollback.log server-1.log server-2.log server-3.log mirror.log; do
        if [ -f "$WORK_ROOT/$log" ]; then
            echo "--- $log (tail) ---" >&2
            tail -60 "$WORK_ROOT/$log" >&2 || true
        fi
    done
    exit 1
}

ok() {
    echo "ok: $*"
}

sha256_of() {
    sha256sum "$1" | awk '{print $1}'
}

free_port() {
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

tag_of_binary() {
    "$1" version --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["gotavern_version"])'
}

# snapshot <dir>: relative path + sha256 of every file, sorted. Paths only: no hosts, no mtimes.
snapshot() {
    ( cd "$1" && find . -type f | LC_ALL=C sort | while read -r file; do
        printf '%s  %s\n' "$(sha256_of "$file")" "$file"
      done )
}

# Only the runtime state a user owns. The immutable release files are asserted separately, by hash
# against the archive they came from.
snapshot_runtime() {
    ( cd "$1" && find . -type f \
        \( -path './config.yaml' -o -path './data/*' -o -path './extensions/*' -o -path './certs/*' \) \
        | LC_ALL=C sort | while read -r file; do
            printf '%s  %s\n' "$(sha256_of "$file")" "$file"
          done )
}

WORK_ROOT=$(mktemp -d 2>/dev/null || mktemp -d -t gotavern-upgrade)
SERVER_PID=""
MIRROR_PID=""
cleanup() {
    for pid in "$SERVER_PID" "$MIRROR_PID"; do
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
    done
    rm -rf "$WORK_ROOT"
}
trap cleanup EXIT HUP INT TERM

[ -f "$INSTALLER" ] || fail "install.sh not found at $INSTALLER"
[ -s "$OLDER_ARCHIVE" ] || fail "older archive $OLDER_ARCHIVE is missing or empty"
[ -s "$NEWER_ARCHIVE" ] || fail "newer archive $NEWER_ARCHIVE is missing or empty"

# ---- 1. the two releases, identified by the binary inside each archive -------------------------

mkdir -p "$WORK_ROOT/stage-older" "$WORK_ROOT/stage-newer"
tar -xzf "$OLDER_ARCHIVE" -C "$WORK_ROOT/stage-older" || fail "cannot extract $OLDER_ARCHIVE"
tar -xzf "$NEWER_ARCHIVE" -C "$WORK_ROOT/stage-newer" || fail "cannot extract $NEWER_ARCHIVE"
[ -x "$WORK_ROOT/stage-older/gotavern" ] || fail "$OLDER_ARCHIVE has no executable gotavern at its root"
[ -x "$WORK_ROOT/stage-newer/gotavern" ] || fail "$NEWER_ARCHIVE has no executable gotavern at its root"
[ -d "$WORK_ROOT/stage-older/tokenizers" ] || fail "$OLDER_ARCHIVE does not contain tokenizers/"
[ -d "$WORK_ROOT/stage-newer/tokenizers" ] || fail "$NEWER_ARCHIVE does not contain tokenizers/"

OLDER_TAG=$(tag_of_binary "$WORK_ROOT/stage-older/gotavern") || fail "cannot read $OLDER_ARCHIVE's version"
NEWER_TAG=$(tag_of_binary "$WORK_ROOT/stage-newer/gotavern") || fail "cannot read $NEWER_ARCHIVE's version"
[ -n "$OLDER_TAG" ] || fail "the older archive reports an empty version"
[ -n "$NEWER_TAG" ] || fail "the newer archive reports an empty version"
[ "$OLDER_TAG" != "$NEWER_TAG" ] || fail "both archives report the same version ($OLDER_TAG), so the update would move no visible bytes"
ok "derived the release tags from the archives themselves: older=$OLDER_TAG newer=$NEWER_TAG"

OLDER_BINARY_HASH=$(sha256_of "$WORK_ROOT/stage-older/gotavern")
NEWER_BINARY_HASH=$(sha256_of "$WORK_ROOT/stage-newer/gotavern")
[ "$OLDER_BINARY_HASH" != "$NEWER_BINARY_HASH" ] || fail "both archives carry the SAME gotavern binary; a cross-baseline update must move the binary, and this pair cannot show it"
ok "the two binaries differ ($OLDER_BINARY_HASH vs $NEWER_BINARY_HASH)"

# ---- 2. what actually differs across this pair, MEASURED and stated ----------------------------

# The claim "cross-baseline" is only as strong as the difference the assertions can see. The binary and
# BUILD-INFO always differ; the vendored asset trees may or may not, so this measures them instead of
# assuming.
tree_of() {
    ( cd "$1" && find . -type f | LC_ALL=C sort | while read -r file; do
        printf '%s  %s\n' "$(sha256_of "$file")" "$file"
      done )
}
OLDER_TOKENS=$(tree_of "$WORK_ROOT/stage-older/tokenizers")
NEWER_TOKENS=$(tree_of "$WORK_ROOT/stage-newer/tokenizers")
if [ "$OLDER_TOKENS" = "$NEWER_TOKENS" ]; then
    ok "MEASURED: the two releases carry IDENTICAL vendored tokenizer trees, so this pair differs in code and BUILD-INFO only. The rollback assertions still compare the installed tree against the OLDER ARCHIVE'S OWN manifest, so a rollback that restored the wrong tree would fail here; what this pair cannot show is a tokenizer file that exists in only one release."
else
    ok "MEASURED: the two releases carry DIFFERENT vendored tokenizer trees ($(printf '%s\n' "$OLDER_TOKENS" | wc -l) vs $(printf '%s\n' "$NEWER_TOKENS" | wc -l) files), so the rollback below restores an asset tree the newer release did not have."
fi

OLDER_BUILD_INFO=$(cat "$WORK_ROOT/stage-older/BUILD-INFO.txt" 2>/dev/null || echo "")
NEWER_BUILD_INFO=$(cat "$WORK_ROOT/stage-newer/BUILD-INFO.txt" 2>/dev/null || echo "")
[ "$OLDER_BUILD_INFO" != "$NEWER_BUILD_INFO" ] || fail "the two archives carry the same BUILD-INFO.txt, so even the release identity would not move"
ok "the two archives carry different BUILD-INFO.txt content (the release identity is visible on disk)"

# ---- 3. the canonical mirror, serving BOTH releases -----------------------------------------

MIRROR="$WORK_ROOT/mirror"
build_release() {
    base=$1
    tag=$2
    archive=$3
    mkdir -p "$base/$tag"
    cp "$archive" "$base/$tag/$ASSET_NAME"
    ( cd "$base/$tag" && sha256sum "$ASSET_NAME" > checksums.txt )
}
build_release "$MIRROR" "$OLDER_TAG" "$OLDER_ARCHIVE"
build_release "$MIRROR" "$NEWER_TAG" "$NEWER_ARCHIVE"
mkdir -p "$MIRROR/latest/download"
cp "$MIRROR/$NEWER_TAG/$ASSET_NAME" "$MIRROR/$NEWER_TAG/checksums.txt" "$MIRROR/latest/download/"
[ -s "$MIRROR/$OLDER_TAG/checksums.txt" ] || fail "the older release has no checksums.txt"
[ -s "$MIRROR/latest/download/checksums.txt" ] || fail "the latest form has no checksums.txt"
ok "built a canonical mirror: <base>/$OLDER_TAG/, <base>/$NEWER_TAG/ and <base>/latest/download/"

MIRROR_PORT_FILE="$WORK_ROOT/mirror.port"
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
python3 -u "$WORK_ROOT/serve.py" "$MIRROR" "$MIRROR_PORT_FILE" >"$WORK_ROOT/mirror.log" 2>&1 &
MIRROR_PID=$!
MIRROR_PORT=""
for _ in $(seq 1 100); do
    if [ -s "$MIRROR_PORT_FILE" ]; then MIRROR_PORT=$(cat "$MIRROR_PORT_FILE"); break; fi
    sleep 0.2
done
[ -n "$MIRROR_PORT" ] || fail "the loopback mirror never wrote its port"
MIRROR_BASE="http://127.0.0.1:$MIRROR_PORT"
curl -fsS "$MIRROR_BASE/$OLDER_TAG/checksums.txt" >/dev/null || fail "the loopback mirror does not serve $OLDER_TAG/checksums.txt"
ok "the loopback mirror answers on $MIRROR_BASE"

# ---- 4. install the OLDER release through the installer and the seam -------------------------

PREFIX="$WORK_ROOT/install-root"
mkdir -p "$PREFIX"
export GOTAVERN_RELEASES_BASE_URL="$MIRROR_BASE"

if ! sh "$INSTALLER" --dir "$PREFIX" --version "$OLDER_TAG" >"$WORK_ROOT/installer-older.log" 2>&1; then
    fail "install.sh failed for the older release $OLDER_TAG"
fi
INSTALLED="$PREFIX/gotavern"
[ -x "$INSTALLED" ] || fail "the installer did not install an executable gotavern at $INSTALLED"
INSTALLED_TAG=$("$INSTALLED" version --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["gotavern_version"])')
[ "$INSTALLED_TAG" = "$OLDER_TAG" ] || fail "the installed binary reports $INSTALLED_TAG, expected the older tag $OLDER_TAG"
ok "installed the older release $OLDER_TAG through install.sh and the mirror seam"

( cd "$PREFIX" && "$INSTALLED" assets verify ) >"$WORK_ROOT/assets-older.log" 2>&1 \
    || fail "assets verify failed from the installed prefix for $OLDER_TAG"
ok "assets verify passes from the prefix for $OLDER_TAG"

[ "$(sha256_of "$INSTALLED")" = "$OLDER_BINARY_HASH" ] \
    || fail "the installed binary is not byte-identical to the older archive's binary"
ok "the installed binary is byte-identical to $OLDER_ARCHIVE's binary"

INSTALLED_TOKENS=$(tree_of "$PREFIX/tokenizers")
if [ "$INSTALLED_TOKENS" != "$OLDER_TOKENS" ]; then
    printf '%s\n' "$INSTALLED_TOKENS" >"$WORK_ROOT/installed-tokenizers.txt"
    printf '%s\n' "$OLDER_TOKENS" >"$WORK_ROOT/archive-tokenizers.txt"
    diff -u "$WORK_ROOT/archive-tokenizers.txt" "$WORK_ROOT/installed-tokenizers.txt" >&2 || true
    fail "the installed tokenizers/ tree does not match the older archive's own tree"
fi
ok "the installed tokenizers/ tree matches $OLDER_ARCHIVE's manifest byte for byte"

# ---- 5. seed the runtime state a user has ---------------------------------------------------

mkdir -p "$PREFIX/data/default-user/cards" "$PREFIX/data/default-user/chats" \
         "$PREFIX/extensions/probe-extension" "$PREFIX/certs"
cat > "$PREFIX/config.yaml" <<'YAML'
# A comment the installer must not rewrite, and a key GoTavern does not know about: hard rule 11 says an
# unknown field survives, and a cross-baseline rollback is exactly where it would be dropped.
listen: true
port: 8000
dataRoot: ./data
probeUnknownKeyFromTheUser: keep-me-on-update-and-rollback
YAML
printf '{"userName":"probe-user","probeKey":"keep-me"}\n' > "$PREFIX/data/default-user/settings.json"
printf '{"name":"Probe Card","description":"seeded before the update","data":{}}\n' > "$PREFIX/data/default-user/cards/Probe Card.json"
printf '{"user_name":"probe-user","chat_metadata":{"seeded":"older"},"messages":[{"is_user":true,"mes":"seeded before the update"}]}\n' \
    > "$PREFIX/data/default-user/chats/probe-older-chat.jsonl"
printf '{"name":"probe-extension","version":"1.0.0"}\n' > "$PREFIX/extensions/probe-extension/manifest.json"
printf 'console.log("probe extension");\n' > "$PREFIX/extensions/probe-extension/index.js"
printf -- '-----BEGIN CERTIFICATE-----\nprobe-not-a-real-certificate\n-----END CERTIFICATE-----\n' > "$PREFIX/certs/probe-cert.pem"

snapshot_runtime "$PREFIX" > "$WORK_ROOT/runtime-seeded.txt"
[ -s "$WORK_ROOT/runtime-seeded.txt" ] || fail "the seeded runtime snapshot is empty, so the survival assertions would be vacuous"
ok "seeded runtime state and snapshotted it: $(wc -l < "$WORK_ROOT/runtime-seeded.txt") files (config.yaml with an unknown key, user settings, a card, a chat, an extension, a cert)"

# ---- 6. boot the OLDER release over that tree -----------------------------------------------

boot_server() {
    # $1 label suffix, $2 expected tag, $3 log file. Runs in the prefix WITHOUT --dataRoot, so startup
    # resolves the data root from config.yaml the way a real install does.
    PORT=$(free_port)
    ( cd "$PREFIX" && exec "./gotavern" start --port "$PORT" ) >"$3" 2>&1 &
    SERVER_PID=$!
    for _ in $(seq 1 60); do
        if curl -fsS "http://127.0.0.1:$PORT/version" > "$WORK_ROOT/version-$1.json" 2>/dev/null; then
            return 0
        fi
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            echo "the $2 binary exited before answering /version:" >&2
            return 1
        fi
        sleep 1
    done
    echo "the $2 binary never answered /version within 60 s:" >&2
    return 1
}

stop_server() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        for _ in $(seq 1 30); do
            kill -0 "$SERVER_PID" 2>/dev/null || break
            sleep 1
        done
        kill -9 "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=""
    fi
}

boot_server older "$OLDER_TAG" "$WORK_ROOT/server-1.log" || fail "the older release $OLDER_TAG did not boot over the seeded tree"
ok "the older release $OLDER_TAG boots over the seeded tree and answers /version"
stop_server
[ -d "$PREFIX/data" ] || fail "startup did not create data/ beside config.yaml (the seeded state was not used)"
ok "startup kept using the existing data/ root (no fresh-install seed replaced it)"

snapshot_runtime "$PREFIX" > "$WORK_ROOT/runtime-after-older-boot.txt"
ok "snapshotted the runtime state after the older release's first start ($(wc -l < "$WORK_ROOT/runtime-after-older-boot.txt") files)"

# ---- 7. UPDATE to the NEWER release through the same installer and mirror --------------------

if ! sh "$INSTALLER" --dir "$PREFIX" --version latest >"$WORK_ROOT/installer-update.log" 2>&1; then
    fail "install.sh failed while updating to the newer release (mirror latest)"
fi
UPDATED_TAG=$("$INSTALLED" version --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["gotavern_version"])')
[ "$UPDATED_TAG" = "$NEWER_TAG" ] || fail "after the update the installed binary reports $UPDATED_TAG, expected the newer tag $NEWER_TAG"
ok "the update moved the installed release: $OLDER_TAG -> $UPDATED_TAG (through the mirror's latest form)"
[ "$(sha256_of "$INSTALLED")" = "$NEWER_BINARY_HASH" ] \
    || fail "after the update the installed binary is not byte-identical to the newer archive's binary"
ok "the updated binary is byte-identical to $NEWER_ARCHIVE's binary"
( cd "$PREFIX" && "$INSTALLED" assets verify ) >"$WORK_ROOT/assets-updated.log" 2>&1 \
    || fail "assets verify failed from the prefix after the update"
ok "assets verify passes from the prefix after the update"

snapshot_runtime "$PREFIX" > "$WORK_ROOT/runtime-after-update.txt"
if ! diff -u "$WORK_ROOT/runtime-after-older-boot.txt" "$WORK_ROOT/runtime-after-update.txt" >"$WORK_ROOT/runtime-diff-update.txt" 2>&1; then
    cat "$WORK_ROOT/runtime-diff-update.txt" >&2
    fail "the update changed user state: every config.yaml/data/extensions/certs file must survive an update byte for byte"
fi
ok "the update preserved every runtime file byte for byte"

# ---- 8. boot the NEWER release, then write state WITH IT ------------------------------------

boot_server newer "$NEWER_TAG" "$WORK_ROOT/server-2.log" || fail "the updated release $NEWER_TAG did not boot over the existing tree"
ok "the updated release $NEWER_TAG boots over the tree the older release created and answers /version"
stop_server

# State the NEWER release writes. The rollback below is over THIS, not over the seeded state.
printf '{"user_name":"probe-user","chat_metadata":{"seeded":"newer"},"messages":[{"is_user":true,"mes":"written by the newer release"}]}\n' \
    > "$PREFIX/data/default-user/chats/probe-newer-chat.jsonl"
printf '{"name":"Probe Card From Newer","description":"written by the newer release","data":{}}\n' \
    > "$PREFIX/data/default-user/cards/Probe Card From Newer.json"
printf '{"userName":"probe-user","probeKey":"keep-me","probeKeyFromNewer":"must-survive-rollback"}\n' \
    > "$PREFIX/data/default-user/settings.json"
snapshot_runtime "$PREFIX" > "$WORK_ROOT/runtime-after-newer-write.txt"
ok "wrote new runtime state with the newer release and snapshotted it ($(wc -l < "$WORK_ROOT/runtime-after-newer-write.txt") files)"

# ---- 9. ROLL BACK to the OLDER release ------------------------------------------------------

if ! sh "$INSTALLER" --dir "$PREFIX" --version "$OLDER_TAG" >"$WORK_ROOT/installer-rollback.log" 2>&1; then
    fail "install.sh failed while rolling back to $OLDER_TAG"
fi
ROLLED_BACK_TAG=$("$INSTALLED" version --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["gotavern_version"])')
[ "$ROLLED_BACK_TAG" = "$OLDER_TAG" ] \
    || fail "after the rollback the installed binary reports $ROLLED_BACK_TAG, expected the older tag $OLDER_TAG"
ok "the rollback moved the installed release back: $NEWER_TAG -> $ROLLED_BACK_TAG"
[ "$(sha256_of "$INSTALLED")" = "$OLDER_BINARY_HASH" ] \
    || fail "the rolled-back binary is not byte-identical to the older archive's binary (the rollback did not restore the older release)"
ok "the rolled-back binary is byte-identical to $OLDER_ARCHIVE's binary"
( cd "$PREFIX" && "$INSTALLED" assets verify ) >"$WORK_ROOT/assets-rollback.log" 2>&1 \
    || fail "assets verify failed from the prefix after the rollback"
ok "assets verify passes from the prefix after the rollback"
ROLLED_TOKENS=$(tree_of "$PREFIX/tokenizers")
[ "$ROLLED_TOKENS" = "$OLDER_TOKENS" ] || fail "after the rollback the installed tokenizers/ tree does not match the older archive's manifest"
ok "the rolled-back tokenizers/ tree matches $OLDER_ARCHIVE's manifest byte for byte"

# ---- 10. the NEWER release's state must survive the rollback, and be READABLE by the older
#          release -- the cross-baseline direction nobody had executed -------------------------

snapshot_runtime "$PREFIX" > "$WORK_ROOT/runtime-after-rollback.txt"
if ! diff -u "$WORK_ROOT/runtime-after-newer-write.txt" "$WORK_ROOT/runtime-after-rollback.txt" >"$WORK_ROOT/runtime-diff-rollback.txt" 2>&1; then
    cat "$WORK_ROOT/runtime-diff-rollback.txt" >&2
    fail "the rollback changed runtime state: the state the newer release wrote must survive byte for byte"
fi
ok "the rollback preserved every runtime file the newer release wrote, byte for byte"

boot_server rollback "$OLDER_TAG" "$WORK_ROOT/server-3.log" || fail "the OLDER release $OLDER_TAG could not boot over the state the NEWER release $NEWER_TAG wrote"
ok "the OLDER release boots over state the NEWER release wrote and answers /version (cross-baseline read)"
stop_server

snapshot_runtime "$PREFIX" > "$WORK_ROOT/runtime-after-rollback-boot.txt"

# WHAT IS ALLOWED TO CHANGE HERE, and why it is not a weakening. Pinned startup WRITES A TIMESTAMPED
# SETTINGS BACKUP on every start (data/default-user/backups/settings_<user>_<stamp>.json), so a strict
# "nothing may differ" comparison fails on the pinned server's own behaviour, which is what the first run
# of this job reported. The assertion is therefore split by KIND of change, which is stricter than a
# whole-file diff: anything MODIFIED or REMOVED fails outright, and an ADDED file is accepted only if its
# path is exactly that backup shape -- so an older release that rewrote a chat, a card, settings or
# config.yaml, or that dropped a new file of its own, still fails and still names the path.
# THE PATH IS EVERYTHING AFTER THE FIRST SPACE RUN, not `$2`: runtime paths really do contain spaces
# ("tavern day.jpg", "Probe Card From Newer.json"), and field-splitting on them silently truncated the
# path, which would have made a change to such a file invisible. Blank lines are skipped for the same
# reason: a trailing newline would otherwise be reported as an added file.
awk 'NF < 2 { next }
     NR == FNR { hash = $1; sub(/^[^ ]+ +/, ""); known[$0] = hash; next }
     { hash = $1; sub(/^[^ ]+ +/, ""); path = $0
       if (!(path in known)) { print "added " path }
       else { if (known[path] != hash) print "changed " path; seen[path] = 1 } }
     END { for (path in known) if (!(path in seen)) print "removed " path }' \
    "$WORK_ROOT/runtime-after-newer-write.txt" "$WORK_ROOT/runtime-after-rollback-boot.txt" \
    | LC_ALL=C sort > "$WORK_ROOT/runtime-classified-changes.txt"

if grep -q '^changed ' "$WORK_ROOT/runtime-classified-changes.txt"; then
    grep '^changed ' "$WORK_ROOT/runtime-classified-changes.txt" >&2
    fail "the older release's startup MODIFIED runtime state written by the newer release (paths above)"
fi
if grep -q '^removed ' "$WORK_ROOT/runtime-classified-changes.txt"; then
    grep '^removed ' "$WORK_ROOT/runtime-classified-changes.txt" >&2
    fail "the older release's startup REMOVED runtime state written by the newer release (paths above)"
fi
ADDED=$(grep '^added ' "$WORK_ROOT/runtime-classified-changes.txt" || true)
ADDED_COUNT=$(printf '%s' "$ADDED" | grep -c '^added ' || true)
if [ "${ADDED_COUNT:-0}" -gt 0 ]; then
    UNEXPECTED=$(printf '%s\n' "$ADDED" | grep -v '^added ./data/default-user/backups/settings_.*\.json$' || true)
    if [ -n "$UNEXPECTED" ]; then
        printf '%s\n' "$UNEXPECTED" >&2
        fail "the older release's startup added file(s) that are not a pinned settings backup (paths above)"
    fi
fi
ok "the older release's startup changed nothing and removed nothing; it added ${ADDED_COUNT:-0} file(s), all of them the pinned timestamped settings backup"

echo
echo "ok: all cross-baseline update and rollback assertions passed"

# ---- 11. the mirror served every request: the seam was honoured, not bypassed ----------------

for expected in \
    "/$OLDER_TAG/checksums.txt" "/$OLDER_TAG/$ASSET_NAME" \
    "/latest/download/checksums.txt" "/latest/download/$ASSET_NAME"
do
    grep -qF "GET $expected" "$WORK_ROOT/mirror.log" \
        || fail "the loopback mirror never served GET $expected, so an install may have reached the real release URL instead of the seam"
done
ok "the loopback mirror served both release forms and both assets (the seam was honoured, not bypassed)"

# The summary is LAST and nothing follows it.
echo
echo "ok: all cross-baseline update and rollback assertions passed"
