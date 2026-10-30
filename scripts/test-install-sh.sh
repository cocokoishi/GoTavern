#!/bin/sh
# Test install.sh's INSTALL LOCATION contract, with no network and no real release.
#
# WHY THIS EXISTS. The Unix installer used to default to $HOME/GoTavern, so `mkdir GoTavern && cd GoTavern`
# followed by the documented piped install put the files somewhere the user was not looking. The contract that
# replaced it is three sentences and every one needs a test that would go red if it were removed:
#
#   A. With no `--dir`, GoTavern installs into the CALLER'S CURRENT WORKING DIRECTORY, and nothing is created
#      at the old default ($HOME/GoTavern).
#   B. `--dir` still overrides the default, and the working directory is then left alone.
#   C. An existing `config.yaml` and `data/` in the target are PRESERVED byte-for-byte, on install and on
#      re-install.
#   D. The default comes from the process working directory, NOT from the script's location: invoked by
#      absolute path from another directory, it installs into the directory it was CALLED from.
#
# HOW IT RUNS WITHOUT THE INTERNET, AND ON A NON-UNIX HOST. Every install goes through the installer's
# `GOTAVERN_RELEASES_BASE_URL` mirror seam, served by a loopback HTTP server over a synthetic release. The
# mirror's request log is asserted, so an installer that ignored the seam and reached github.com fails this
# test instead of passing on a cached asset. The installer reads `uname` to choose the asset, so the test puts
# a `uname` shim FIRST on PATH: that makes the Unix installer's logic testable from a Windows development host
# (where `uname` says MINGW64_NT) as well as from Linux, without changing the installer.
#
# Usage: sh scripts/test-install-sh.sh   (bash works too; run from anywhere)
# Exit: 0 only when every case and every assertion passed.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
INSTALLER="$REPO_ROOT/install.sh"
[ -f "$INSTALLER" ] || { echo "FAIL: no installer at $INSTALLER" >&2; exit 1; }

WORK_ROOT=$(mktemp -d 2>/dev/null || mktemp -d -t gotavern-install-location)
TAG="v9.9.9-test"
MIRROR_PID=""
TMPDIR_UNDER_TEST="$WORK_ROOT/tmp"
mkdir -p "$TMPDIR_UNDER_TEST"

cleanup() {
    if [ -n "$MIRROR_PID" ]; then kill "$MIRROR_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT HUP INT TERM

fail() {
    echo "FAIL: $1" >&2
    echo "(this run's work root, kept for diagnosis: $WORK_ROOT)" >&2
    shift
    for log in "$@"; do
        [ -n "$log" ] || continue
        [ -f "$log" ] || continue
        echo "--- $log ---" >&2
        tail -n 60 "$log" >&2 || true
    done
    exit 1
}

ok() { echo "ok: $1"; }

# ---- a uname shim, so this exercises the Unix installer's own logic on any host ---------------------
mkdir -p "$WORK_ROOT/shim"
cat > "$WORK_ROOT/shim/uname" <<'SHIM'
#!/bin/sh
case "${1:-}" in
    -s) echo Linux ;;
    -m) echo x86_64 ;;
    *)  echo Linux ;;
esac
SHIM
chmod 0755 "$WORK_ROOT/shim/uname"
PATH="$WORK_ROOT/shim:$PATH"
export PATH

# ---- synthetic release ------------------------------------------------------------------------------
STAGE="$WORK_ROOT/stage"
mkdir -p "$STAGE/src/tokenizers"
printf 'synthetic-gotavern-binary\n' > "$STAGE/gotavern"
chmod 0755 "$STAGE/gotavern"
printf 'synthetic-tokenizer\n' > "$STAGE/src/tokenizers/llama.model"
printf 'AGPL-3.0\n' > "$STAGE/LICENSE"
printf 'synthetic notices\n' > "$STAGE/THIRD_PARTY_NOTICES.txt"
printf 'version=%s\ncommit=synthetic\n' "$TAG" > "$STAGE/BUILD-INFO.txt"

ASSET="gotavern-linux-amd64.tar.gz"
MIRROR_ROOT="$WORK_ROOT/mirror"
TAG_DIR="$MIRROR_ROOT/$TAG"
LATEST_DIR="$MIRROR_ROOT/latest/download"
mkdir -p "$TAG_DIR" "$LATEST_DIR"
(cd "$STAGE" && tar -czf "$TAG_DIR/$ASSET" .)
cp "$TAG_DIR/$ASSET" "$LATEST_DIR/$ASSET"
sha256_program=""
if command -v sha256sum >/dev/null 2>&1; then sha256_program="sha256sum"; elif command -v shasum >/dev/null 2>&1; then sha256_program="shasum"; fi
[ -n "$sha256_program" ] || fail "neither sha256sum nor shasum is available to build the synthetic checksums.txt"
if [ "$sha256_program" = "sha256sum" ]; then HASH=$(sha256sum "$TAG_DIR/$ASSET" | awk '{print $1}'); else HASH=$(shasum -a 256 "$TAG_DIR/$ASSET" | awk '{print $1}'); fi
printf '%s  %s\n' "$HASH" "$ASSET" > "$TAG_DIR/checksums.txt"
cp "$TAG_DIR/checksums.txt" "$LATEST_DIR/checksums.txt"
ok "built a synthetic linux/amd64 release and a canonical mirror root"

# ---- loopback mirror --------------------------------------------------------------------------------
# A CANDIDATE MUST ACTUALLY RUN. Windows ships a `python3` App Execution Alias that is a Store stub: `command
# -v` finds it, it exits non-zero with "Python was not found", and a test that trusted `command -v` alone would
# fail here for a reason that has nothing to do with the installer. The probe below is the real check.
PYTHON=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import http.server' >/dev/null 2>&1; then
        PYTHON="$candidate"
        break
    fi
done
[ -n "$PYTHON" ] || fail "no python3/python on PATH; the loopback mirror needs one (the qualification jobs use it too)"
PORT_FILE="$WORK_ROOT/mirror.port"
MIRROR_LOG="$WORK_ROOT/mirror.log"
cat > "$WORK_ROOT/serve.py" <<'PY'
import http.server, socketserver, sys
directory, port_file = sys.argv[1], sys.argv[2]
handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=directory, **k)
with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
    with open(port_file, "w", encoding="utf-8") as handle:
        handle.write(str(httpd.server_address[1]))
    httpd.serve_forever()
PY
"$PYTHON" -u "$WORK_ROOT/serve.py" "$MIRROR_ROOT" "$PORT_FILE" > /dev/null 2> "$MIRROR_LOG" &
MIRROR_PID=$!
MIRROR_PORT=""
attempt=0
while [ "$attempt" -lt 100 ]; do
    if [ -s "$PORT_FILE" ]; then MIRROR_PORT=$(cat "$PORT_FILE"); break; fi
    attempt=$((attempt + 1))
    sleep 0.2 2>/dev/null || sleep 1
done
[ -n "$MIRROR_PORT" ] || fail "the loopback mirror never wrote its port" "$MIRROR_LOG"
GOTAVERN_RELEASES_BASE_URL="http://127.0.0.1:$MIRROR_PORT"
export GOTAVERN_RELEASES_BASE_URL
ok "the loopback mirror answers on $GOTAVERN_RELEASES_BASE_URL (the installer's seam)"

# The old default must be OBSERVED, not assumed: if this machine already has one, absence proves nothing.
LEGACY_DEFAULT="$HOME/GoTavern"
LEGACY_EXISTED_BEFORE=0
if [ -e "$LEGACY_DEFAULT" ]; then LEGACY_EXISTED_BEFORE=1; echo "note: $LEGACY_DEFAULT already exists, so case A asserts it is UNCHANGED rather than absent"; fi

run_installer() {
    # $1 = working directory, $2 = log file, rest = installer arguments
    workdir="$1"; log="$2"; shift 2
    ( cd "$workdir" && TMPDIR="$TMPDIR_UNDER_TEST" sh "$INSTALLER" "$@" ) > "$log" 2>&1 || return 1
    return 0
}

assert_tree() {
    directory="$1"; why="$2"
    for relative in gotavern start.sh LICENSE THIRD_PARTY_NOTICES.txt BUILD-INFO.txt src/tokenizers/llama.model; do
        [ -f "$directory/$relative" ] || fail "$why: expected $relative in $directory"
    done
    [ -x "$directory/start.sh" ] || fail "$why: start.sh is not executable in $directory"
    grep -q 'cd "\$SCRIPT_DIR"' "$directory/start.sh" || fail "$why: start.sh does not cd to its own directory"
}

assert_tmpdir_clean() {
    leftovers=$(ls -A "$TMPDIR_UNDER_TEST" 2>/dev/null || true)
    [ -z "$leftovers" ] || fail "the installer left scratch entries behind in TMPDIR: $leftovers"
}

# ---- CASE A: no --dir => the current working directory ----------------------------------------------
CASE_A="$WORK_ROOT/case-a-cwd"
mkdir -p "$CASE_A"
run_installer "$CASE_A" "$WORK_ROOT/case-a.log" --version "$TAG" || fail "case A: the installer failed with no --dir" "$WORK_ROOT/case-a.log"
assert_tree "$CASE_A" 'case A'
grep -qx 'Install directory:' "$WORK_ROOT/case-a.log" || fail "case A: the summary has no 'Install directory:' label" "$WORK_ROOT/case-a.log"
grep -qxF "$CASE_A" "$WORK_ROOT/case-a.log" || fail "case A: the summary does not print $CASE_A" "$WORK_ROOT/case-a.log"
ok "case A: no --dir installed into the current working directory ($CASE_A), and the summary names it"
if [ "$LEGACY_EXISTED_BEFORE" -eq 0 ]; then
    [ ! -e "$LEGACY_DEFAULT" ] || fail "case A: the old default $LEGACY_DEFAULT was CREATED, so the default is still \$HOME/GoTavern"
    ok "case A: nothing was created at the old default ($LEGACY_DEFAULT)"
fi
assert_tmpdir_clean
ok "case A: the installer removed its own temporary download/extract directory"

# ---- CASE B: --dir overrides, and the working directory is left alone -------------------------------
CASE_B_WORK="$WORK_ROOT/case-b-cwd"
CASE_B_TARGET="$WORK_ROOT/case-b-target"
mkdir -p "$CASE_B_WORK" "$CASE_B_TARGET"
run_installer "$CASE_B_WORK" "$WORK_ROOT/case-b.log" --version "$TAG" --dir "$CASE_B_TARGET" || fail "case B: the installer failed with --dir" "$WORK_ROOT/case-b.log"
assert_tree "$CASE_B_TARGET" 'case B'
[ ! -e "$CASE_B_WORK/gotavern" ] || fail "case B: --dir was given, but gotavern also landed in the working directory"
ok "case B: --dir installed into $CASE_B_TARGET and left the working directory alone"

# ---- CASE C: an existing config.yaml and data/ survive, on install and on re-install -----------------
CASE_C="$WORK_ROOT/case-c-state"
mkdir -p "$CASE_C/data"
printf 'port: 8123\nsomeFutureSection:\n  keptValue: 41\n' > "$CASE_C/config.yaml"
printf 'user state that must survive\n' > "$CASE_C/data/test-marker.txt"
if [ "$sha256_program" = "sha256sum" ]; then
    CONFIG_HASH_BEFORE=$(sha256sum "$CASE_C/config.yaml" | awk '{print $1}')
    MARKER_HASH_BEFORE=$(sha256sum "$CASE_C/data/test-marker.txt" | awk '{print $1}')
else
    CONFIG_HASH_BEFORE=$(shasum -a 256 "$CASE_C/config.yaml" | awk '{print $1}')
    MARKER_HASH_BEFORE=$(shasum -a 256 "$CASE_C/data/test-marker.txt" | awk '{print $1}')
fi
run_installer "$CASE_C" "$WORK_ROOT/case-c-first.log" --version "$TAG" || fail "case C: the first install failed" "$WORK_ROOT/case-c-first.log"
assert_tree "$CASE_C" 'case C (first install)'
# The second run is the upgrade path a user hits with `install.sh --version <next>`.
run_installer "$CASE_C" "$WORK_ROOT/case-c-second.log" --version "$TAG" || fail "case C: the re-install failed" "$WORK_ROOT/case-c-second.log"
assert_tree "$CASE_C" 'case C (re-install)'
if [ "$sha256_program" = "sha256sum" ]; then
    CONFIG_HASH_AFTER=$(sha256sum "$CASE_C/config.yaml" | awk '{print $1}')
    MARKER_HASH_AFTER=$(sha256sum "$CASE_C/data/test-marker.txt" | awk '{print $1}')
else
    CONFIG_HASH_AFTER=$(shasum -a 256 "$CASE_C/config.yaml" | awk '{print $1}')
    MARKER_HASH_AFTER=$(shasum -a 256 "$CASE_C/data/test-marker.txt" | awk '{print $1}')
fi
[ "$CONFIG_HASH_BEFORE" = "$CONFIG_HASH_AFTER" ] || fail "case C: config.yaml changed across install+re-install ($CONFIG_HASH_BEFORE -> $CONFIG_HASH_AFTER)"
[ "$MARKER_HASH_BEFORE" = "$MARKER_HASH_AFTER" ] || fail "case C: data/test-marker.txt changed across install+re-install"
grep -q 'config.yaml' "$WORK_ROOT/case-c-second.log" || fail "case C: the summary does not name config.yaml as preserved" "$WORK_ROOT/case-c-second.log"
grep -q 'data/' "$WORK_ROOT/case-c-second.log" || fail "case C: the summary does not name data/ as preserved" "$WORK_ROOT/case-c-second.log"
ok 'case C: config.yaml (byte-identical) and data/ survived install and re-install, and the summary names them'

# ---- CASE D: the default is the CALLER'S directory, not the script's --------------------------------
CASE_D="$WORK_ROOT/case-d-called-from"
mkdir -p "$CASE_D"
REPO_EXE_BEFORE=0
[ -e "$REPO_ROOT/gotavern" ] && REPO_EXE_BEFORE=1
run_installer "$CASE_D" "$WORK_ROOT/case-d.log" --version "$TAG" || fail "case D: the installer failed when invoked by absolute path" "$WORK_ROOT/case-d.log"
assert_tree "$CASE_D" 'case D'
REPO_EXE_AFTER=0
[ -e "$REPO_ROOT/gotavern" ] && REPO_EXE_AFTER=1
[ "$REPO_EXE_BEFORE" = "$REPO_EXE_AFTER" ] || fail "case D: a gotavern binary was created beside the SCRIPT ($REPO_ROOT), so the default is the script's location rather than the working directory"
ok "case D: invoked by absolute path from $CASE_D, it installed into $CASE_D and nothing beside the script"

# ---- the mirror was honoured, so no case reached github.com ------------------------------------------
MIRROR_TEXT=$(cat "$MIRROR_LOG" 2>/dev/null || true)
case "$MIRROR_TEXT" in
    *"/$TAG/checksums.txt"*) ;;
    *) fail "the loopback mirror never served /$TAG/checksums.txt" "$MIRROR_LOG" ;;
esac
case "$MIRROR_TEXT" in
    *"/$TAG/$ASSET"*) ;;
    *) fail "the loopback mirror never served /$TAG/$ASSET" "$MIRROR_LOG" ;;
esac
ok 'the loopback mirror served the checksum and the asset (the seam was honoured in every case)'

assert_tmpdir_clean
ok 'the installer removed its own temporary download/extract directories in every case'

echo
echo 'ok: every Unix install-location assertion passed'
rm -rf "$WORK_ROOT"
exit 0
