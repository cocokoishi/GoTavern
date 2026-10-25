#!/bin/sh
# Drop a PACKAGED release archive into a stock SillyTavern tree and prove it works there.
#
# THE REPORT THIS REPRODUCES. A user took a published release, put the binary into a working SillyTavern
# directory and it hung. No gate in this repository could have seen it: `release-qualification.yml`
# unpacks archives into a directory IT created (no config.yaml, no data/, no extensions, no public/) and
# `release-install-smoke.yml` installs into an EMPTY prefix. `AGENTS.md` rules 23, 34 and 38 require the
# shipped artifact, unpacked, starting against a stock tree with existing config and existing data.
# `docs/startup-state-machine.md` section 1 records why such a hang is hard to read: `cmd/gotavern/main.go`
# prints NOTHING between `main()` and "listener ready", so a hang anywhere in a 17-step startup chain is
# indistinguishable from a hang anywhere else.
#
# WHAT THIS RUNS, per layout (see LAYOUTS below):
#   1. build a stock tree from this repository's vendored pinned baseline (`scripts/build-stock-tree.sh`)
#   2. hash `extensions/**` and every extension's `git status`, and hash `data/**` -- BEFORE anything runs
#   3. unpack the PACKAGED archive and lay it over the tree exactly as a user does: the archive's own
#      files, in the archive's own layout, into the tree root. No `go build`, no source tree
#   4. boot it with a HARD 30 s readiness bound that POLLS a readiness signal -- never a fixed sleep
#      (AGENTS.md rule 33)
#   5. on timeout: SIGQUIT the process for a goroutine dump, print the whole log, and state whether a
#      stage trace exists at all -- a hang must name itself, and if it cannot, that absence is reported
#      as the finding rather than papered over with a longer bound
#   6. API smoke: settings, character list, chat read -- through the browser's real CSRF handshake
#   7. assert boot mutated nothing: the extension hashes and `git status` are identical, and the seeded
#      data is byte-identical
#   8. graceful shutdown (SIGTERM, bounded), then RESTART and re-read the chat: persistence survives
#
# LAYOUTS. The two the Linux archive can be tested in, and what each one MEANS (they are not variations
# of the same claim):
#   cwd-root      CWD = the tree. config.yaml and data/ resolve inside the tree. This is the documented
#                 "put the binary in your SillyTavern directory" path, and it is the one that must see
#                 the user's existing characters, chats and settings.
#   foreign-cwd   binary in the tree, CWD somewhere else. Pinned SillyTavern resolves `config.yaml`
#                 against CWD (`server.js`), so this layout is EXPECTED to start a fresh runtime under
#                 the foreign directory. The assertion is therefore not "it reads the tree's data" but
#                 "it still becomes ready, and it does NOT write into the tree it was not pointed at".
#
# WHAT THIS DOES NOT COVER, stated here so a green is not read as more:
#   - the Windows archive and `Start.cmd`: a Windows runner and a PowerShell twin are required; this
#     script and its CI job are Linux-only and say so.
#   - updater EGRESS is observed, not proven absent: two socket samples are taken (at ready and 2 s
#     later) and any non-loopback socket owned by the process fails the run, but a request that
#     completed between samples cannot be seen. The MUTATION half of the same requirement is proven
#     exactly (hashes + git status). A network-namespace boot is the follow-up that would close it.
#   - `assets verify` is not run here: the archive in a drop-in tree sits beside the user's own
#     `src/tokenizers`, and whether that is the archive's tree or the stock tree is a packaging question
#     this script REPORTS (see the layout report) rather than asserts.
#
# Usage: scripts/qualify-dropin.sh --archive <path> --layout cwd-root|foreign-cwd [--port N] [--keep]
# Requirements: sh, python3 (index parse), curl, jq, git, find, sha256sum, ss (optional).

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)

ARCHIVE=""
LAYOUT=""
PORT="${PORT:-8797}"
KEEP=0
READINESS_BOUND=30
SHUTDOWN_BOUND=20

while [ "$#" -gt 0 ]; do
    case "$1" in
        --archive) [ "$#" -ge 2 ] || { echo "error: --archive needs a path" >&2; exit 2; }; ARCHIVE=$2; shift 2 ;;
        --layout)  [ "$#" -ge 2 ] || { echo "error: --layout needs a value" >&2; exit 2; }; LAYOUT=$2; shift 2 ;;
        --port)    [ "$#" -ge 2 ] || { echo "error: --port needs a value" >&2; exit 2; }; PORT=$2; shift 2 ;;
        --keep)    KEEP=1; shift ;;
        *) echo "error: unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ -z "$ARCHIVE" ] || [ -z "$LAYOUT" ]; then
    echo "usage: $0 --archive <path> --layout cwd-root|foreign-cwd [--port N] [--keep]" >&2
    exit 2
fi
case "$LAYOUT" in
    cwd-root|foreign-cwd) ;;
    *) echo "error: unsupported layout '$LAYOUT' (this script runs cwd-root and foreign-cwd)" >&2; exit 2 ;;
esac
[ -s "$ARCHIVE" ] || { echo "FAIL: archive not found or empty: $ARCHIVE" >&2; exit 1; }

WORK="$REPO_ROOT/.dropin-work/$LAYOUT"
LOG="$WORK/server.log"
BASE="http://127.0.0.1:$PORT"
PASSES=0

ok()   { PASSES=$((PASSES + 1)); echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A failed run must leave the operator with the log, not with a bare exit code.
dump_context() {
    echo "::group::server log ($LOG)"
    if [ -f "$LOG" ]; then tail -120 "$LOG"; else echo "(no log was produced)"; fi
    echo "::endgroup::"
}

# --- 1. the stock tree ---------------------------------------------------------------------
echo "=== layout: $LAYOUT ==="
rm -rf "$WORK"
mkdir -p "$WORK"
TREE="$WORK/tree"
sh "$SCRIPT_DIR/build-stock-tree.sh" "$TREE" | sed 's/^/  /'

# --- 2. baseline, before anything executes -------------------------------------------------
hash_tree() {
    # Path + content digest of every file, sorted: one line per file, so a diff names the file.
    ( cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum )
}
ext_git_status() {
    find "$TREE" -name .git -maxdepth 6 -type d 2>/dev/null | LC_ALL=C sort | while read -r gitdir; do
        repo=$(dirname "$gitdir")
        printf '%s: %s\n' "${repo#$TREE/}" "$(git -C "$repo" status --porcelain | tr '\n' '|')"
    done
}
hash_tree "$TREE/public/scripts/extensions" > "$WORK/extensions.before"
ext_git_status > "$WORK/extstatus.before"
hash_tree "$TREE/data" > "$WORK/data.before"
hash_tree "$TREE/src/tokenizers" > "$WORK/tokenizers.before"
echo "baseline: $(wc -l < "$WORK/extensions.before") extension files, $(wc -l < "$WORK/data.before") data files, $(wc -l < "$WORK/tokenizers.before") tokenizer files"

# --- 3. lay the PACKAGED archive over the tree ---------------------------------------------
# EXACTLY what a user does: the archive is unpacked and its contents land in the tree root. Nothing is
# reorganised, renamed or moved, because "does the archive's layout work here" is the question.
RELEASE="$WORK/release"
mkdir -p "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"
[ -f "$RELEASE/gotavern" ] || fail "the archive does not contain gotavern at its root"
# The archive must NOT carry runtime state (release.yml asserts this too; repeated because a drop-in is
# precisely where such a file would do damage).
for forbidden in config.yaml data extensions; do
    [ ! -e "$RELEASE/$forbidden" ] || fail "the archive carries $forbidden, which must never ship"
done
echo "archive payload: $(find "$RELEASE" -maxdepth 1 -mindepth 1 -printf '%f ' | sed 's/ $//')"

# The packaging difference this job exists to measure: what the RELEASE carries that a stock tree also
# has, and what it does not carry at all.
echo "--- packaging difference, measured on this tree ---"
for item in src/tokenizers public default config.yaml; do
    if [ -e "$RELEASE/$item" ]; then
        echo "  archive carries $item: YES"
    else
        echo "  archive carries $item: no (the tree's own copy is what the runtime will see: $( [ -e "$TREE/$item" ] && echo present || echo absent ))"
    fi
done

cp -R "$RELEASE/." "$TREE/"
chmod 0755 "$TREE/gotavern"
[ -x "$TREE/gotavern" ] || fail "the unpacked binary is not executable"

if [ "$LAYOUT" = "cwd-root" ]; then
    RUN_DIR="$TREE"
else
    # Foreign CWD: a directory that knows nothing about the tree.
    RUN_DIR="$WORK/foreign-cwd"
    mkdir -p "$RUN_DIR"
fi
echo "run directory (CWD): $RUN_DIR"

# --- 4/5. boot, with a bounded readiness POLL and a diagnosis on timeout ---------------------
BIN="$TREE/gotavern"
server_pid=""

start_server() {
    : > "$LOG"
    ( cd "$RUN_DIR" && exec "$BIN" start --port "$PORT" ) >> "$LOG" 2>&1 &
    server_pid=$!
    echo "$server_pid" > "$WORK/server.pid"
}

diagnose_hang() {
    # SIGQUIT is the Go runtime's dump request: it prints every goroutine stack and exits. That is the
    # only way to turn "it hung" into a name for what hung, and rule 24/section 5.2 want exactly this.
    echo "::group::goroutine dump (SIGQUIT)"
    if kill -QUIT "$server_pid" 2>/dev/null; then
        for _ in $(seq 1 40); do
            kill -0 "$server_pid" 2>/dev/null || break
            sleep 0.25
        done
        kill -9 "$server_pid" 2>/dev/null || true
    else
        echo "(the process was already gone, so no dump could be taken)"
    fi
    if grep -q 'goroutine ' "$LOG" 2>/dev/null; then
        sed -n '/goroutine /,$p' "$LOG" | head -120
        echo "--- the dump above names the blocked frames ---"
    else
        echo "(SIGQUIT produced no goroutine dump in the log)"
    fi
    echo "::endgroup::"
    echo "::group::startup stage trace"
    stages=$(grep -cE 'startup\.(begin|ready|[a-z_]+)' "$LOG" 2>/dev/null || true)
    echo "stage markers found in the log: ${stages:-0}"
    if [ "${stages:-0}" -eq 0 ]; then
        echo "NO STAGE TRACE EXISTS at this commit. docs/startup-state-machine.md section 5.2 asks for named"
        echo "stages (startup.begin ... startup.ready) so a hang names itself; until that lands this"
        echo "harness can only report the bound, the log and the goroutine dump. The absence is the"
        echo "finding, not a harness defect."
    fi
    echo "::endgroup::"
    dump_context
}

wait_ready() {
    elapsed=0
    # 0.25 s poll steps up to the bound. The loop POLLS; it never sleeps and then assumes (rule 33).
    steps=$((READINESS_BOUND * 4))
    i=0
    while [ "$i" -lt "$steps" ]; do
        # A stage marker is the signal the contract asks for; it is used when it exists.
        if grep -q 'startup\.ready' "$LOG" 2>/dev/null; then
            READY_SIGNAL="stdout stage marker startup.ready"
            return 0
        fi
        if curl -fsS -m 2 "$BASE/version" -o "$WORK/version.json" 2>/dev/null; then
            READY_SIGNAL="/version answered"
            return 0
        fi
        if ! kill -0 "$server_pid" 2>/dev/null; then
            READY_SIGNAL=""
            return 1
        fi
        sleep 0.25
        i=$((i + 1))
    done
    READY_SIGNAL=""
    return 2
}

echo "--- boot 1 (bound ${READINESS_BOUND}s, polling) ---"
start_server
ready_status=0
wait_ready || ready_status=$?
case "$ready_status" in
    0) ok "became ready within ${READINESS_BOUND}s via ${READY_SIGNAL}" ;;
    1)
        echo "::group::server log"
        cat "$LOG" 2>/dev/null || echo "(no log)"
        echo "::endgroup::"
        fail "the drop-in binary EXITED before becoming ready (layout $LAYOUT). That is the P0-B failure mode."
        ;;
    *)
        diagnose_hang
        fail "the drop-in binary did NOT become ready within ${READINESS_BOUND}s (layout $LAYOUT). Not retried with a longer bound: rule 33."
        ;;
esac
cat "$WORK/version.json"

# --- 6. API smoke, through the browser's real CSRF handshake --------------------------------
COOKIES="$WORK/cookies.txt"
csrf_status=$(curl -sS -c "$COOKIES" -b "$COOKIES" -o "$WORK/csrf.json" -w '%{http_code}' "$BASE/csrf-token")
[ "$csrf_status" = "200" ] || fail "GET /csrf-token returned $csrf_status, so no authenticated smoke could run"
TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("token",""))' "$WORK/csrf.json")
[ -n "$TOKEN" ] || fail "GET /csrf-token returned no token"
ok "csrf handshake (/csrf-token 200, token ${#TOKEN} chars)"

post_json() { # $1 route, $2 body, $3 out file -> prints http status
    curl -sS -c "$COOKIES" -b "$COOKIES" -H "X-CSRF-Token: $TOKEN" -H 'Content-Type: application/json' \
         -d "$2" -o "$3" -w '%{http_code}' "$BASE$1"
}

status=$(post_json /api/settings/get '{}' "$WORK/settings.json")
[ "$status" = "200" ] || { dump_context; fail "POST /api/settings/get = $status"; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,dict) and d, "settings is not a non-empty object"' "$WORK/settings.json" \
    || { dump_context; fail "/api/settings/get did not return a settings object"; }
ok "settings readable ($(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$WORK/settings.json") keys)"

status=$(post_json /api/characters/all '{}' "$WORK/characters.json")
[ "$status" = "200" ] || { dump_context; fail "POST /api/characters/all = $status"; }
character_count=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d) if isinstance(d,list) else -1)' "$WORK/characters.json")
[ "$character_count" -ge 1 ] || { dump_context; fail "/api/characters/all returned no characters: the tree's seeded character was not read (layout $LAYOUT)"; }
ok "character list readable ($character_count character(s): $(python3 -c 'import json,sys; print(", ".join((c.get("name") or "?") for c in json.load(open(sys.argv[1]))))' "$WORK/characters.json"))"

status=$(post_json /api/chats/get '{"avatar_url":"default_Seraphina.png","file_name":"dropin-smoke"}' "$WORK/chat.json")
[ "$status" = "200" ] || { dump_context; fail "POST /api/chats/get = $status"; }
chat_lines=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d) if isinstance(d,list) else -1)' "$WORK/chat.json")
[ "$chat_lines" -eq 3 ] || { dump_context; fail "/api/chats/get returned $chat_lines line(s), expected 3 (1 header + 2 messages)"; }
ok "chat readable ($chat_lines lines, the seeded synthetic chat)"

# --- 7. boot must not mutate what it does not own ------------------------------------------
ext_git_status > "$WORK/extstatus.after"
if diff -u "$WORK/extstatus.before" "$WORK/extstatus.after" > "$WORK/extstatus.diff"; then
    ok "every extension repository reports the same git status after boot"
else
    cat "$WORK/extstatus.diff" >&2
    fail "boot CHANGED an extension repository's git status (P0-C): see the diff above"
fi

ng_sockets=$(ss -tanp 2>/dev/null | grep -F "pid=$server_pid," | awk 'NR>1 {print $5}' | grep -vE '^(127\.0\.0\.1|\[::1\]|Local)' || true)
if [ -n "$ng_sockets" ]; then
    echo "$ng_sockets" >&2
    fail "the server holds a NON-loopback socket while booted, which is what an updater check would look like"
fi
ok "no non-loopback socket is held by the server (sampled: this is an observation, not a proof of absence)"

# --- 8. graceful shutdown, restart, persistence -------------------------------------------
echo "--- graceful shutdown ---"
shutdown_start=$(date +%s)
kill -TERM "$server_pid" 2>/dev/null || fail "could not signal the server to stop"
stopped=0
i=0
while [ "$i" -lt $((SHUTDOWN_BOUND * 4)) ]; do
    if ! kill -0 "$server_pid" 2>/dev/null; then stopped=1; break; fi
    sleep 0.25
    i=$((i + 1))
done
[ "$stopped" -eq 1 ] || { kill -9 "$server_pid" 2>/dev/null || true; dump_context; fail "the server did not exit within ${SHUTDOWN_BOUND}s of SIGTERM"; }
ok "stopped gracefully in $(( $(date +%s) - shutdown_start ))s"

echo "--- boot 2 (restart, same tree) ---"
start_server
ready_status=0
wait_ready || ready_status=$?
if [ "$ready_status" -ne 0 ]; then
    diagnose_hang
    fail "the drop-in binary did not become ready on RESTART (layout $LAYOUT)"
fi
ok "restart became ready via ${READY_SIGNAL}"

curl -sS -c "$COOKIES" -b "$COOKIES" -o "$WORK/csrf2.json" "$BASE/csrf-token" >/dev/null 2>&1 || true
TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("token",""))' "$WORK/csrf2.json")
[ -n "$TOKEN" ] || fail "the restarted server served no CSRF token"
status=$(post_json /api/chats/get '{"avatar_url":"default_Seraphina.png","file_name":"dropin-smoke"}' "$WORK/chat2.json")
[ "$status" = "200" ] || { dump_context; fail "after restart, POST /api/chats/get = $status"; }
chat_lines=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d) if isinstance(d,list) else -1)' "$WORK/chat2.json")
[ "$chat_lines" -eq 3 ] || { dump_context; fail "after restart the chat has $chat_lines line(s), expected 3: persistence did not survive"; }
ok "chat survived the restart ($chat_lines lines)"

kill -TERM "$server_pid" 2>/dev/null || true
i=0
while [ "$i" -lt $((SHUTDOWN_BOUND * 4)) ]; do kill -0 "$server_pid" 2>/dev/null || break; sleep 0.25; i=$((i + 1)); done
kill -9 "$server_pid" 2>/dev/null || true

# --- mutation of the SEEDED USER DATA -------------------------------------------------------
# Only meaningful for cwd-root, where the runtime was pointed at the tree's own data root. Under
# foreign-cwd the tree is deliberately NOT the runtime root, so it must be untouched rather than equal.
hash_tree "$TREE/data" > "$WORK/data.after"
if [ "$LAYOUT" = "cwd-root" ]; then
    # A boot legitimately creates its own runtime files (heartbeat, statistics, a cookie secret, the
    # settings backup). Those are the DECLARED volatile paths; everything else must be byte-identical,
    # and the diff is printed rather than summarised so the claim can be checked.
    grep -vE '/(heartbeat\.json|\.cookie-secret|_stats[^/]*\.json|backups/settings_)' "$WORK/data.before" > "$WORK/data.before.filtered"
    grep -vE '/(heartbeat\.json|\.cookie-secret|_stats[^/]*\.json|backups/settings_)' "$WORK/data.after"  > "$WORK/data.after.filtered"
    if diff -u "$WORK/data.before.filtered" "$WORK/data.after.filtered" > "$WORK/data.diff"; then
        ok "seeded user data is byte-identical after two boots and a restart (volatile paths declared)"
    else
        echo "::group::data diff (declared volatile paths excluded)"
        cat "$WORK/data.diff"
        echo "::endgroup::"
        fail "boot rewrote user data that was already on disk (rule 27)"
    fi
else
    if diff -q "$WORK/data.before" "$WORK/data.after" >/dev/null 2>&1; then
        ok "the tree's data root was NOT touched, because this layout ran under a foreign CWD"
    else
        fail "under a foreign CWD the binary wrote into the stock tree's data root"
    fi
fi
hash_tree "$TREE/public/scripts/extensions" > "$WORK/extensions.after"
if diff -u "$WORK/extensions.before" "$WORK/extensions.after" > "$WORK/extensions.diff"; then
    ok "extensions/** is byte-identical after two boots and a restart"
else
    cat "$WORK/extensions.diff" >&2
    fail "boot modified files under extensions/**"
fi

echo "=== layout $LAYOUT: $PASSES checks passed ==="
if [ "$KEEP" -eq 0 ]; then
    # The tree is kept on failure (the caller wants it) and removed on success to save runner disk.
    rm -rf "$TREE" "$RELEASE"
fi
