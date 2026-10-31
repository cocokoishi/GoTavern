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
#   scripts/qualify-upgrade-rollback.sh --published-alpha9 <candidate.tar.gz>
#     The RELEASE-BLOCKING Beta 1 mode: installs the PUBLISHED v0.1.0-alpha.9 linux-amd64 release (downloaded from
#     the public GitHub release and verified against its PUBLISHED checksums.txt), seeds the generated long-lived
#     corpus into that install, boots alpha.9 over it, backs up the runtime tree, updates to the candidate archive
#     through the same installer, then USES Beta 1 over the corpus (open the existing chat, save a continuation,
#     assets, settings/world book), restarts it and reads the continuation back, restores the pre-update backup
#     into a fresh prefix and boots alpha.9 over it, and classifies every runtime path Beta 1 wrote. Needs node
#     (the corpus generator is the qualification input) in addition to the requirements below. Network: the public
#     GitHub release only (gh or curl), no other live egress.
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
    # MACHINE-READABLE VERDICT: a CI job must be able to upload a verdict, not only a log. QUALIFY_REPORT_DIR is
    # set by the workflow; when it is absent the report would live in WORK_ROOT and be deleted by cleanup, so the
    # absence is not a silent no-op -- the failure path prints where a report WOULD have gone.
    if [ -n "${QUALIFY_REPORT_DIR:-}" ]; then
        mkdir -p "$QUALIFY_REPORT_DIR"
        python3 -c 'import json,os,sys; json.dump({"schema":"gotavern-published-upgrade-verdict","schemaVersion":1,"ok":False,"failure":sys.argv[1]}, open(os.path.join(sys.argv[2], "published-alpha9-verdict.json"), "w"), indent=2)' \
            "$*" "$QUALIFY_REPORT_DIR" 2>/dev/null \
            || echo "FAIL: could not write the machine-readable verdict into $QUALIFY_REPORT_DIR" >&2
    fi
    # FAILURE HANDLING FOR THE PUBLISHED-BASELINE MODE: a failed upgrade is restored from the pre-update backup into
    # the SAME prefix, and the restore is announced with its evidence. This is the difference between a qualification
    # that reports a failure and one that leaves the operator a tree they can retry from.
    if [ -n "${FAILURE_BACKUP:-}" ] && [ -d "${FAILURE_BACKUP:-}" ] && [ -n "${FAILURE_PREFIX:-}" ]; then
        echo "failure handling: restoring the pre-update backup into $FAILURE_PREFIX ..." >&2
        rm -rf "$FAILURE_PREFIX"
        mkdir -p "$FAILURE_PREFIX"
        cp -R "$FAILURE_BACKUP/." "$FAILURE_PREFIX/" 2>/dev/null || true
        if [ -d "$FAILURE_PREFIX/data/default-user" ]; then
            echo "failure handling: restored $(find "$FAILURE_PREFIX" -type f | wc -l) file(s) from the backup" >&2
        else
            echo "failure handling: THE BACKUP RESTORE DID NOT PRODUCE A USER TREE" >&2
        fi
    fi
    for log in installer-update.log installer-rollback.log server-1.log server-2.log server-3.log mirror.log \
        published-installer-alpha.log published-installer-update.log published-installer-fresh.log \
        published-alpha-server.log published-fresh-server.log published-dropin-server.log \
        published-beta-server-1.log published-beta-server-2.log published-restore-server.log published-mirror.log; do
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

# ---- THE PUBLISHED-BASELINE MODE: alpha.9 -> Beta 1, with real downloads and a usable journey ---------
#
# WHY THIS MODE EXISTS. The mode above compares two archives built from two commits in ONE run; it never touches
# a PUBLISHED release. Beta 1's release-blocking question is different: a user is ON the published
# v0.1.0-alpha.9 (real artifact, real checksum), has a long-lived tree, and updates to Beta 1. Does Beta 1 start
# over that tree and let them CONTINUE using it -- open an existing chat, take another turn, restart the server,
# read the same chat back, fetch assets -- with no undocumented manual migration?
#
# WHAT IT DOES, in order:
#   1. downloads the PUBLISHED alpha.9 `gotavern-linux-amd64.tar.gz` and `checksums.txt` from the GitHub release
#      (gh, or curl against the public release URL) and verifies the sha256 AGAINST THE PUBLISHED CHECKSUMS;
#   2. derives each archive's tag from the binary inside it, builds a loopback mirror for BOTH releases in the
#      canonical layout, and INSTALLS alpha.9 through the real `install.sh` seam;
#   3. seeds the generated long-lived corpus (tools/build-longlived-corpus.mjs) into the installed prefix, boots
#      alpha.9 over it, and asserts the published release itself opens the corpus chat -- the baseline is measured,
#      not assumed;
#   4. BACKS UP the runtime tree (config.yaml, data/, extensions/, certs/) before the update, then updates to the
#      candidate Beta 1 archive through the SAME installer and asserts the installed release moved and the user
#      tree is byte-identical across the update;
#   5. boots Beta 1 over the corpus and USES it over HTTP the way a user does: CSRF session, card list, open the
#      existing long chat, save a continuation, assets/thumbnail, settings/world book, then RESTART and read the
#      continuation back from disk;
#   6. exercises the BACKUP PATH for real: restores the pre-update backup into a fresh prefix, boots alpha.9 over
#      it, and asserts the restored tree is usable and does not contain the Beta 1 continuation (a clean rollback);
#   7. classifies EVERY runtime path Beta 1 changed/added/removed during the boot+journey and fails on anything
#      that is not a known artefact shape, so "no undocumented manual migration" is a measurement: the boot needs
#      no manual step, the chat opens, and the only writes are enumerated.
#
# Requirements: node (the corpus generator is the qualification INPUT and must not be a hand-written fallback),
# plus tar, python3, curl, sha256sum. Network: gh/curl to the public GitHub release only (AGENTS egress rules).

stage_archive() {
    # $1 destination, $2 archive. A tar.gz in the canonical release layout.
    rm -rf "$1"
    mkdir -p "$1"
    tar -xzf "$2" -C "$1"
}

# Boot the installed release from a prefix WITH the desktop-browser launch disabled: a qualification job must
# never open a window on an operator's desktop (the flag is what the installer-era gate also passes).
boot_prefix_server() {
    # $1 prefix, $2 log file, $3 label. Sets SERVER_PID and PORT; fails when /version never answers.
    PORT=$(free_port)
    ( cd "$1" && exec ./gotavern start --port "$PORT" --browserLaunchEnabled false --heartbeatInterval 0 ) >"$2" 2>&1 &
    SERVER_PID=$!
    BOOT_DEADLINE=$(( $(date +%s) + 120 ))
    while [ "$(date +%s)" -lt "$BOOT_DEADLINE" ]; do
        if curl -fsS "http://127.0.0.1:$PORT/version" > "$WORK_ROOT/version-$3.json" 2>/dev/null; then
            BASE="http://127.0.0.1:$PORT"
            return 0
        fi
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            echo "the $3 server exited before answering /version:" >&2
            tail -40 "$2" >&2 || true
            return 1
        fi
        sleep 1
    done
    echo "the $3 server never answered /version within 120 s:" >&2
    tail -40 "$2" >&2 || true
    return 1
}

qualify_published_alpha9() {
    CANDIDATE_ARCHIVE=$1
    ALPHA_TAG="v0.1.0-alpha.9"
    REPO_SLUG="cocokoishi/GoTavern"
    # THE PUBLISHED ASSET IS A LINUX BINARY. This mode installs and BOOTS the real published archive, so it can only
    # run where that archive runs; on a non-Linux host it must refuse by name instead of downloading 60 MB and then
    # failing with "cannot execute binary file".
    [ "$(uname -s)" = "Linux" ] || fail "the published-baseline mode boots the published linux-amd64 archive, so it requires Linux (this host is $(uname -s)); run it in .github/workflows/release-qualification.yml's ubuntu job"
    PUBLISHED_DIR="$WORK_ROOT/published"
    MIRROR="$WORK_ROOT/published-mirror"
    PREFIX="$WORK_ROOT/published-install"
    BACKUP="$WORK_ROOT/published-backup"
    RESTORE_PREFIX="$WORK_ROOT/published-restore"
    CORPUS="$WORK_ROOT/corpus"
    JAR="$WORK_ROOT/cookies.txt"
    rm -rf "$PUBLISHED_DIR" "$MIRROR" "$PREFIX" "$BACKUP" "$RESTORE_PREFIX" "$CORPUS"
    mkdir -p "$PUBLISHED_DIR" "$MIRROR" "$PREFIX" "$BACKUP" "$RESTORE_PREFIX"

    command -v node >/dev/null 2>&1 || fail "node is required: the long-lived corpus is the qualification input and is generated, never hand-written"
    command -v python3 >/dev/null 2>&1 || fail "python3 is required for the mirror, the JSON parsing and the checksum comparison"

    # ---- 1. the PUBLISHED artefact: real download, real checksums -------------------------------
    if command -v gh >/dev/null 2>&1; then
        ( cd "$PUBLISHED_DIR" && gh release download "$ALPHA_TAG" --repo "$REPO_SLUG" \
            --pattern "$ASSET_NAME" --pattern checksums.txt --clobber ) \
            || fail "gh could not download the published $ALPHA_TAG assets ($ASSET_NAME and checksums.txt)"
    else
        ( cd "$PUBLISHED_DIR" && curl -fsSL -O "https://github.com/$REPO_SLUG/releases/download/$ALPHA_TAG/$ASSET_NAME" \
            -O "https://github.com/$REPO_SLUG/releases/download/$ALPHA_TAG/checksums.txt" ) \
            || fail "curl could not download the published $ALPHA_TAG assets"
    fi
    [ -s "$PUBLISHED_DIR/$ASSET_NAME" ] || fail "the published $ALPHA_TAG archive is missing or empty"
    [ -s "$PUBLISHED_DIR/checksums.txt" ] || fail "the published $ALPHA_TAG checksums.txt is missing or empty"
    PUBLISHED_EXPECTED=$(awk -v asset="$ASSET_NAME" '$2 == asset || $2 == "*" asset { print $1; exit }' "$PUBLISHED_DIR/checksums.txt")
    [ -n "$PUBLISHED_EXPECTED" ] || fail "the published checksums.txt does not list $ASSET_NAME"
    PUBLISHED_ACTUAL=$(sha256_of "$PUBLISHED_DIR/$ASSET_NAME")
    [ "$PUBLISHED_ACTUAL" = "$PUBLISHED_EXPECTED" ] \
        || fail "the downloaded published alpha.9 archive does not match its PUBLISHED checksum (expected $PUBLISHED_EXPECTED, got $PUBLISHED_ACTUAL)"
    ok "downloaded the PUBLISHED $ALPHA_TAG $ASSET_NAME ($(wc -c < "$PUBLISHED_DIR/$ASSET_NAME") bytes) and verified it against the published checksums.txt"

    # ---- 2. tags from the binaries inside the archives, and a loopback mirror for both ----------
    stage_archive "$WORK_ROOT/stage-alpha" "$PUBLISHED_DIR/$ASSET_NAME"
    ALPHA_TAG_FROM_BINARY=$(tag_of_binary "$WORK_ROOT/stage-alpha/gotavern") || fail "cannot read the version from the published alpha.9 binary"
    [ "$ALPHA_TAG_FROM_BINARY" = "$ALPHA_TAG" ] || fail "the published archive reports $ALPHA_TAG_FROM_BINARY, expected $ALPHA_TAG"
    stage_archive "$WORK_ROOT/stage-candidate" "$CANDIDATE_ARCHIVE"
    CANDIDATE_TAG=$(tag_of_binary "$WORK_ROOT/stage-candidate/gotavern") || fail "cannot read the version from the candidate binary"
    [ "$CANDIDATE_TAG" != "$ALPHA_TAG" ] || fail "the candidate archive reports the alpha.9 tag; this is not an upgrade"
    CANDIDATE_BINARY_HASH=$(sha256_of "$WORK_ROOT/stage-candidate/gotavern")
    ok "candidate archive is $CANDIDATE_TAG (binary $(printf '%s' "$CANDIDATE_BINARY_HASH" | cut -c1-12)...), a different release from $ALPHA_TAG"

    mkdir -p "$MIRROR/$ALPHA_TAG" "$MIRROR/$CANDIDATE_TAG" "$MIRROR/latest/download"
    cp "$PUBLISHED_DIR/$ASSET_NAME" "$MIRROR/$ALPHA_TAG/$ASSET_NAME"
    cp "$CANDIDATE_ARCHIVE" "$MIRROR/$CANDIDATE_TAG/$ASSET_NAME"
    cp "$CANDIDATE_ARCHIVE" "$MIRROR/latest/download/$ASSET_NAME"
    ( cd "$MIRROR/$ALPHA_TAG" && sha256sum "$ASSET_NAME" > checksums.txt )
    ( cd "$MIRROR/$CANDIDATE_TAG" && sha256sum "$ASSET_NAME" > checksums.txt )
    cp "$MIRROR/$CANDIDATE_TAG/checksums.txt" "$MIRROR/latest/download/checksums.txt"
    MIRROR_PORT=$(free_port)
    ( cd "$MIRROR" && exec python3 -m http.server "$MIRROR_PORT" --bind 127.0.0.1 ) >"$WORK_ROOT/published-mirror.log" 2>&1 &
    MIRROR_PID=$!
    MIRROR_READY=$(( $(date +%s) + 30 ))
    while [ "$(date +%s)" -lt "$MIRROR_READY" ]; do
        if curl -fsS "http://127.0.0.1:$MIRROR_PORT/$ALPHA_TAG/checksums.txt" >/dev/null 2>&1; then break; fi
        sleep 1
    done
    export GOTAVERN_RELEASES_BASE_URL="http://127.0.0.1:$MIRROR_PORT"
    ok "built the loopback release mirror for $ALPHA_TAG and $CANDIDATE_TAG (latest -> $CANDIDATE_TAG)"

    # ---- 3. install the PUBLISHED release through the real installer ---------------------------
    if ! sh "$INSTALLER" --dir "$PREFIX" --version "$ALPHA_TAG" >"$WORK_ROOT/published-installer-alpha.log" 2>&1; then
        fail "install.sh failed for the published $ALPHA_TAG"
    fi
    INSTALLED="$PREFIX/gotavern"
    [ -x "$INSTALLED" ] || fail "the installer did not install an executable at $INSTALLED"
    INSTALLED_TAG=$(tag_of_binary "$INSTALLED")
    [ "$INSTALLED_TAG" = "$ALPHA_TAG" ] || fail "the installed binary reports $INSTALLED_TAG, expected the published $ALPHA_TAG"
    [ "$(sha256_of "$INSTALLED")" = "$(sha256_of "$WORK_ROOT/stage-alpha/gotavern")" ] \
        || fail "the installed alpha.9 binary is not byte-identical to the published archive's binary"
    ok "installed the PUBLISHED $ALPHA_TAG through install.sh and the mirror seam (binary verified byte-identical)"

    # THE OLDER BINARY'S TOKENIZER LAYOUT, the same measured accommodation the cross-commit mode documents: this
    # repository's installer installs the CURRENT `src/tokenizers` tier, while the published alpha.9 looks at
    # `<prefix>/tokenizers` and `<prefix>/upstream/tokenizers`. The SAME bytes are mirrored to the legacy path so the
    # published release can count tokens exactly; the candidate keeps using src/tokenizers.
    if [ -d "$PREFIX/src/tokenizers" ] && [ ! -d "$PREFIX/tokenizers" ]; then
        cp -R "$PREFIX/src/tokenizers" "$PREFIX/tokenizers"
        ok "mirrored src/tokenizers to the legacy root path so the published $ALPHA_TAG can tokenize exactly"
    fi

    # ---- 4. seed the long-lived corpus into the installed prefix -------------------------------
    node "$REPO_ROOT/tools/build-longlived-corpus.mjs" --size small --out "$CORPUS" \
        --seed beta1-published-upgrade --force --quiet >"$WORK_ROOT/corpus-generation.json" 2>"$WORK_ROOT/corpus-generation.log" \
        || fail "the long-lived corpus generator failed"
    [ -s "$CORPUS/manifest.json" ] || fail "the generated corpus has no manifest.json"
    node "$REPO_ROOT/tools/longlived/verify.mjs" --corpus "$CORPUS" >/dev/null 2>"$WORK_ROOT/corpus-verify.log" \
        || fail "the generated corpus was refused by tools/longlived/verify.mjs"
    # THE INSTALLED PREFIX HAS NO data/ UNTIL A SERVER BOOTS, so copying the corpus into it needs the directory
    # created first. This branch is Linux-only (it boots the published linux-amd64 asset) and was therefore never
    # executed on the Windows development host -- CI run 41205015776 is the record: `cp: cannot create directory
    # .../published-install/data/default-user: No such file or directory`. The failure was in the harness, not the
    # product, and the qualification produced no verdict.
    mkdir -p "$PREFIX/data"
    cp -R "$CORPUS/default-user" "$PREFIX/data/default-user"
    cp "$CORPUS/config.yaml" "$PREFIX/config.yaml"
    [ -s "$CORPUS/content.log" ] && cp "$CORPUS/content.log" "$PREFIX/data/content.log"
    CORPUS_TREE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tree"]["sha256"])' "$CORPUS/manifest.json")
    PRIMARY_AVATAR=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["surfaces"]["characters"][0]["avatar"].split("/")[-1])' "$CORPUS/manifest.json")
    PRIMARY_NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["surfaces"]["characters"][0]["name"])' "$CORPUS/manifest.json")
    LONG_CHAT_FILE=$(python3 -c 'import json,sys,os; c=[x for x in json.load(open(sys.argv[1]))["surfaces"]["chats"] if x.get("long")][0]; print(os.path.basename(c["file"]).replace(".jsonl",""))' "$CORPUS/manifest.json")
    PLANTED_MESSAGES=$(python3 -c 'import json,sys; c=[x for x in json.load(open(sys.argv[1]))["surfaces"]["chats"] if x.get("long")][0]; print(c["messages"])' "$CORPUS/manifest.json")
    WORLD_NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["surfaces"]["worlds"][0]["name"])' "$CORPUS/manifest.json")
    WORLD_ENTRIES=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["surfaces"]["worlds"][0]["entries"])' "$CORPUS/manifest.json")
    PRESET_NAME=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print([p["name"] for p in m["surfaces"]["presets"] if p.get("structurePreserving")][0])' "$CORPUS/manifest.json")
    ok "seeded the generated long-lived corpus (tree $CORPUS_TREE): $PRIMARY_NAME's $PLANTED_MESSAGES-message chat, world $WORLD_NAME ($WORLD_ENTRIES entries), preset $PRESET_NAME"

    # ---- 5. the PUBLISHED release boots over the corpus and can read it -----------------------
    boot_prefix_server "$PREFIX" "$WORK_ROOT/published-alpha-server.log" alpha || fail "the published $ALPHA_TAG did not boot over the corpus tree"
    ALPHA_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pkgVersion"])' "$WORK_ROOT/version-alpha.json")
    [ -n "$ALPHA_VERSION" ] || fail "the published alpha.9 answered /version without a pkgVersion"
    ok "the published $ALPHA_TAG boots over the long-lived corpus and answers /version (pkgVersion $ALPHA_VERSION)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""

    # ---- 6. BACK UP the pre-update runtime tree, then update to the candidate ------------------
    mkdir -p "$BACKUP"
    for item in config.yaml data extensions certs; do
        [ -e "$PREFIX/$item" ] && cp -R "$PREFIX/$item" "$BACKUP/$item"
    done
    [ -d "$BACKUP/data/default-user" ] || fail "the pre-update backup does not hold the user tree"
    snapshot_runtime "$PREFIX" > "$WORK_ROOT/published-runtime-before-update.txt"
    FAILURE_PREFIX="$PREFIX"
    FAILURE_BACKUP="$BACKUP"
    if ! sh "$INSTALLER" --dir "$PREFIX" --version latest >"$WORK_ROOT/published-installer-update.log" 2>&1; then
        fail "install.sh failed while updating the published $ALPHA_TAG tree to $CANDIDATE_TAG"
    fi
    UPDATED_TAG=$(tag_of_binary "$INSTALLED")
    [ "$UPDATED_TAG" = "$CANDIDATE_TAG" ] || fail "after the update the installed binary reports $UPDATED_TAG, expected $CANDIDATE_TAG"
    [ "$(sha256_of "$INSTALLED")" = "$CANDIDATE_BINARY_HASH" ] || fail "the updated binary is not byte-identical to the candidate archive's binary"
    snapshot_runtime "$PREFIX" > "$WORK_ROOT/published-runtime-after-update.txt"
    if ! diff -u "$WORK_ROOT/published-runtime-before-update.txt" "$WORK_ROOT/published-runtime-after-update.txt" >"$WORK_ROOT/published-runtime-diff-update.txt" 2>&1; then
        cat "$WORK_ROOT/published-runtime-diff-update.txt" >&2
        fail "the update changed the user's runtime tree file by file, which no update may do"
    fi
    ok "updated $ALPHA_TAG -> $CANDIDATE_TAG through install.sh: binary moved and every config/data/extension/cert file survived byte for byte"

    # ---- 7. boot Beta 1 over the corpus and USE it --------------------------------------------
    boot_prefix_server "$PREFIX" "$WORK_ROOT/published-beta-server-1.log" beta || fail "the candidate $CANDIDATE_TAG did not boot over the published alpha.9's long-lived tree"
    BETA_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pkgVersion"])' "$WORK_ROOT/version-beta.json")
    [ -n "$BETA_VERSION" ] || fail "the candidate answered /version without a pkgVersion"

    TOKEN=$(curl -fsS -c "$JAR" -b "$JAR" "$BASE/csrf-token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
    [ -n "$TOKEN" ] || fail "the candidate answered /csrf-token without a token"
    api_post() {
        curl -fsS -b "$JAR" -c "$JAR" -H "X-CSRF-Token: $TOKEN" -H 'Content-Type: application/json' \
            --data-binary @"$2" "$BASE$1"
    }
    api_get_code() {
        curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" "$BASE$1"
    }

    printf '{}' > "$WORK_ROOT/chars-request.json"
    api_post /api/characters/all "$WORK_ROOT/chars-request.json" > "$WORK_ROOT/characters.json" || fail "the candidate's /api/characters/all failed over the corpus tree"
    grep -qF "$PRIMARY_AVATAR" "$WORK_ROOT/characters.json" \
        || fail "the candidate does not list the corpus character $PRIMARY_AVATAR, so the user's card is invisible after the upgrade"
    ok "the candidate lists the corpus cards after the upgrade (e.g. $PRIMARY_AVATAR)"

    python3 -c 'import json,sys; json.dump({"avatar_url": sys.argv[1], "file_name": sys.argv[2]}, open(sys.argv[3], "w"))' \
        "$PRIMARY_AVATAR" "$LONG_CHAT_FILE" "$WORK_ROOT/chat-get-request.json"
    api_post /api/chats/get "$WORK_ROOT/chat-get-request.json" > "$WORK_ROOT/chat-before.json" || fail "the candidate's /api/chats/get failed for the existing corpus chat"
    SERVED_MESSAGES=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d))' "$WORK_ROOT/chat-before.json")
    [ "$SERVED_MESSAGES" -ge "$PLANTED_MESSAGES" ] \
        || fail "the candidate served $SERVED_MESSAGES of the $PLANTED_MESSAGES planted messages: the user's history is truncated after the upgrade"
    ok "the candidate RESUMED the existing chat $LONG_CHAT_FILE: $SERVED_MESSAGES of $PLANTED_MESSAGES planted messages served"

    # A continuation, saved through the product's own route, is the "keep using it" observable. The record is
    # appended to what the server SERVED (never hand-written into the file) so the save path is the one exercised.
    python3 - "$WORK_ROOT/chat-before.json" "$PRIMARY_AVATAR" "$LONG_CHAT_FILE" "$PRIMARY_NAME" "$WORK_ROOT/chat-save-request.json" <<'PY'
import json, sys
source, avatar, chat_name, character_name, target = sys.argv[1:6]
records = json.load(open(source))
records.append({"name": character_name, "is_user": False, "is_system": False,
                "send_date": "2026-10-31T00:00:00.000Z", "mes": "BETA1_UPGRADE_CONTINUE_MARKER", "extra": {}})
json.dump({"avatar_url": avatar, "file_name": chat_name, "chat": records, "force": True}, open(target, "w"))
PY
    api_post /api/chats/save "$WORK_ROOT/chat-save-request.json" > "$WORK_ROOT/chat-save-response.json" \
        || fail "the candidate's /api/chats/save failed for the resumed chat after the upgrade"
    grep -q '"ok"' "$WORK_ROOT/chat-save-response.json" || fail "the candidate's /api/chats/save did not answer ok: $(cat "$WORK_ROOT/chat-save-response.json")"
    ok "the candidate SAVED a continuation into the user's existing chat after the upgrade"

    CHARACTER_CODE=$(api_get_code "/characters/$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$PRIMARY_AVATAR")")
    [ "$CHARACTER_CODE" = "200" ] || fail "the candidate answers $CHARACTER_CODE for the corpus character image after the upgrade"
    THUMBNAIL_CODE=$(api_get_code "/thumbnail?type=avatar&file=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$PRIMARY_AVATAR")")
    [ "$THUMBNAIL_CODE" = "200" ] || fail "the candidate answers $THUMBNAIL_CODE for the corpus character thumbnail after the upgrade"
    ok "the candidate serves the user's character image and thumbnail after the upgrade (200/200)"

    printf '{"name": "%s"}' "$WORLD_NAME" > "$WORK_ROOT/world-request.json"
    api_post /api/worldinfo/get "$WORK_ROOT/world-request.json" > "$WORK_ROOT/world.json" || fail "the candidate's /api/worldinfo/get failed for $WORLD_NAME"
    SERVED_ENTRIES=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("entries", {})))' "$WORK_ROOT/world.json")
    [ "$SERVED_ENTRIES" = "$WORLD_ENTRIES" ] || fail "the candidate served $SERVED_ENTRIES of the $WORLD_ENTRIES world-book entries after the upgrade"
    printf '{}' > "$WORK_ROOT/settings-request.json"
    api_post /api/settings/get "$WORK_ROOT/settings-request.json" > "$WORK_ROOT/settings.json" || fail "the candidate's /api/settings/get failed"
    python3 - "$WORK_ROOT/settings.json" "$PRESET_NAME" <<'PY' || fail "the upgrade changed what the settings route reports (unknown key or preset missing); the user would need a manual migration"
import json, sys
payload = json.load(open(sys.argv[1]))
settings = json.loads(payload["settings"])
assert "longlived_legacy_state" in settings, "the unknown top-level settings key was dropped"
assert "longlived_legacy_extension" in settings.get("extension_settings", {}), "the unknown extension-settings carrier was dropped"
assert sys.argv[2] in payload["settings"], f"the preset {sys.argv[2]} is not in the served settings text"
assert len(payload.get("world_names", [])) >= 2, "the world list is empty after the upgrade"
PY
    ok "the candidate serves the user's settings unknown keys and preset $PRESET_NAME after the upgrade (no manual migration needed)"

    # ---- 8. RESTART the candidate and read the saved continuation back ------------------------
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    boot_prefix_server "$PREFIX" "$WORK_ROOT/published-beta-server-2.log" beta-restart || fail "the candidate $CANDIDATE_TAG did not restart over the tree it had just written"
    TOKEN=$(curl -fsS -c "$JAR" -b "$JAR" "$BASE/csrf-token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
    api_post /api/chats/get "$WORK_ROOT/chat-get-request.json" > "$WORK_ROOT/chat-after-restart.json" || fail "the restarted candidate could not read the resumed chat"
    python3 - "$WORK_ROOT/chat-after-restart.json" <<'PY' || fail "the restarted candidate did not serve the continuation it saved (the session did not survive a restart, or the chat file was not read back)"
import json, sys
records = json.load(open(sys.argv[1]))
texts = [str(record.get("mes", "")) for record in records]
assert "BETA1_UPGRADE_CONTINUE_MARKER" in texts, "the saved continuation is missing after the restart"
assert len(records) >= 100, "the restarted server served a truncated history"
PY
    ok "the restarted candidate READ BACK the continuation and the full history it had saved (restart -> resume -> continue)"

    # ---- 9. THE BACKUP PATH, exercised for real -----------------------------------------------
    cp -R "$BACKUP/data" "$RESTORE_PREFIX/data"
    [ -e "$BACKUP/config.yaml" ] && cp "$BACKUP/config.yaml" "$RESTORE_PREFIX/config.yaml"
    cp -R "$WORK_ROOT/stage-alpha/." "$RESTORE_PREFIX/"
    if [ -d "$RESTORE_PREFIX/src/tokenizers" ] && [ ! -d "$RESTORE_PREFIX/tokenizers" ]; then
        cp -R "$RESTORE_PREFIX/src/tokenizers" "$RESTORE_PREFIX/tokenizers"
    fi
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    boot_prefix_server "$RESTORE_PREFIX" "$WORK_ROOT/published-restore-server.log" restore || fail "the pre-update backup could not boot the published alpha.9 over it"
    RESTORED_TAG=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pkgVersion"])' "$WORK_ROOT/version-restore.json")
    [ -n "$RESTORED_TAG" ] || fail "the restored prefix answered /version without a pkgVersion"
    TOKEN=$(curl -fsS -c "$JAR" -b "$JAR" "$BASE/csrf-token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
    api_post /api/chats/get "$WORK_ROOT/chat-get-request.json" > "$WORK_ROOT/chat-restored.json" || fail "the restored prefix could not read the chat"
    python3 - "$WORK_ROOT/chat-restored.json" <<'PY' || fail "the restored backup is not the pre-upgrade state: it already contains the Beta 1 continuation or lost the history"
import json, sys
records = json.load(open(sys.argv[1]))
texts = [str(record.get("mes", "")) for record in records]
assert "BETA1_UPGRADE_CONTINUE_MARKER" not in texts, "the restored backup contains the Beta 1 continuation"
assert len(records) >= 100, "the restored backup lost the user's history"
PY
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    ok "the pre-update backup was RESTORED into a fresh prefix, booted $ALPHA_TAG over it, and served the pre-upgrade chat (backup path exercised)"

    # ---- 9b. FRESH INSTALL and a SillyTavern-DATA-COPY DROP-IN over the SAME corpus ----------
    #
    # The upgrade path is not the only way a user arrives: a new user installs Beta 1 fresh and brings an existing
    # SillyTavern tree, and a returning user drops the release archive into a directory that already holds their
    # data. Both are executed over the SAME generated corpus, so all three arrival paths are measured on one input.
    FRESH_PREFIX="$WORK_ROOT/published-fresh"
    DROPIN_PREFIX="$WORK_ROOT/published-dropin"
    rm -rf "$FRESH_PREFIX" "$DROPIN_PREFIX"
    mkdir -p "$FRESH_PREFIX"
    if ! sh "$INSTALLER" --dir "$FRESH_PREFIX" --version latest >"$WORK_ROOT/published-installer-fresh.log" 2>&1; then
        fail "install.sh failed for a FRESH candidate install"
    fi
    [ "$(tag_of_binary "$FRESH_PREFIX/gotavern")" = "$CANDIDATE_TAG" ] || fail "the fresh install does not report $CANDIDATE_TAG"
    mkdir -p "$FRESH_PREFIX/data"
    cp -R "$CORPUS/default-user" "$FRESH_PREFIX/data/default-user"
    cp "$CORPUS/config.yaml" "$FRESH_PREFIX/config.yaml"
    [ -s "$CORPUS/content.log" ] && cp "$CORPUS/content.log" "$FRESH_PREFIX/data/content.log"
    boot_prefix_server "$FRESH_PREFIX" "$WORK_ROOT/published-fresh-server.log" fresh || fail "the FRESH candidate install did not boot over the corpus tree"
    TOKEN=$(curl -fsS -c "$JAR" -b "$JAR" "$BASE/csrf-token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
    api_post /api/chats/get "$WORK_ROOT/chat-get-request.json" > "$WORK_ROOT/chat-fresh.json" || fail "the fresh install could not read the corpus chat"
    FRESH_MESSAGES=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$WORK_ROOT/chat-fresh.json")
    [ "$FRESH_MESSAGES" -ge "$PLANTED_MESSAGES" ] || fail "the fresh install served $FRESH_MESSAGES of the $PLANTED_MESSAGES planted messages"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    ok "FRESH Beta 1 install over the same corpus boots and serves the existing chat ($FRESH_MESSAGES messages)"

    mkdir -p "$DROPIN_PREFIX"
    cp -R "$WORK_ROOT/stage-candidate/." "$DROPIN_PREFIX/"
    mkdir -p "$DROPIN_PREFIX/data"
    cp -R "$CORPUS/default-user" "$DROPIN_PREFIX/data/default-user"
    cp "$CORPUS/config.yaml" "$DROPIN_PREFIX/config.yaml"
    [ -s "$CORPUS/content.log" ] && cp "$CORPUS/content.log" "$DROPIN_PREFIX/data/content.log"
    if [ -d "$DROPIN_PREFIX/src/tokenizers" ] && [ ! -d "$DROPIN_PREFIX/tokenizers" ]; then
        cp -R "$DROPIN_PREFIX/src/tokenizers" "$DROPIN_PREFIX/tokenizers"
    fi
    boot_prefix_server "$DROPIN_PREFIX" "$WORK_ROOT/published-dropin-server.log" dropin || fail "the SillyTavern-data-copy drop-in did not boot over the corpus tree"
    TOKEN=$(curl -fsS -c "$JAR" -b "$JAR" "$BASE/csrf-token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
    api_post /api/chats/get "$WORK_ROOT/chat-get-request.json" > "$WORK_ROOT/chat-dropin.json" || fail "the drop-in could not read the corpus chat"
    DROPIN_MESSAGES=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$WORK_ROOT/chat-dropin.json")
    [ "$DROPIN_MESSAGES" -ge "$PLANTED_MESSAGES" ] || fail "the drop-in served $DROPIN_MESSAGES of the $PLANTED_MESSAGES planted messages"
    DROPIN_CODE=$(api_get_code "/characters/$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$PRIMARY_AVATAR")")
    [ "$DROPIN_CODE" = "200" ] || fail "the drop-in answered $DROPIN_CODE for the corpus character image"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    ok "SillyTavern-DATA-COPY drop-in over the same corpus boots, serves the existing chat ($DROPIN_MESSAGES messages) and the character image (200)"

    # ---- 10. WHAT BETA 1 WROTE, classified ----------------------------------------------------
    snapshot_runtime "$PREFIX" > "$WORK_ROOT/published-runtime-after-journey.txt"
    awk 'NF < 2 { next }
         NR == FNR { hash = $1; sub(/^[^ ]+ +/, ""); known[$0] = hash; next }
         { hash = $1; sub(/^[^ ]+ +/, ""); path = $0
           if (!(path in known)) { print "added " path }
           else { if (known[path] != hash) print "changed " path; seen[path] = 1 } }
         END { for (path in known) if (!(path in seen)) print "removed " path }' \
        "$WORK_ROOT/published-runtime-before-update.txt" "$WORK_ROOT/published-runtime-after-journey.txt" \
        | LC_ALL=C sort > "$WORK_ROOT/published-runtime-classified.txt"
    if grep -q '^removed ' "$WORK_ROOT/published-runtime-classified.txt"; then
        grep '^removed ' "$WORK_ROOT/published-runtime-classified.txt" >&2
        fail "Beta 1 REMOVED user runtime state (paths above)"
    fi
    CHANGED_UNEXPECTED=$(grep '^changed ' "$WORK_ROOT/published-runtime-classified.txt" \
        | grep -v -e 'data/default-user/chats/' -e 'data/default-user/settings.json' -e 'data/default-user/stats.json' -e 'config.yaml' || true)
    if [ -n "$CHANGED_UNEXPECTED" ]; then
        printf '%s\n' "$CHANGED_UNEXPECTED" >&2
        fail "Beta 1 modified runtime state outside the chat/settings/config it was driven to change (paths above): an undocumented migration would look like this"
    fi
    ADDED_UNEXPECTED=$(grep '^added ' "$WORK_ROOT/published-runtime-classified.txt" \
        | grep -v -e 'data/default-user/backups/' -e 'data/default-user/thumbnails/' -e 'data/default-user/_cache' -e 'data/_cache' \
                 -e 'cookie-secret.txt' -e 'data/_storage/' -e 'data/default-user/secrets.json' -e 'data/default-user/image-metadata.json' \
                 -e 'data/default-user/sysprompt/.migrated' -e 'data/default-user/content.log' -e 'data/content.log' || true)
    if [ -n "$ADDED_UNEXPECTED" ]; then
        printf '%s\n' "$ADDED_UNEXPECTED" >&2
        fail "Beta 1 added runtime file(s) that are not an enumerated artefact shape (paths above): 'no undocumented migration' is a measurement, and this is a FAIL"
    fi
    ok "Beta 1's writes were classified: $(grep -c '^changed ' "$WORK_ROOT/published-runtime-classified.txt" || true) changed path(s) inside the chat/settings/config it was driven to change, $(grep -c '^added ' "$WORK_ROOT/published-runtime-classified.txt" || true) added path(s) all of known artefact shapes, 0 removed"

    FAILURE_PREFIX=""
    FAILURE_BACKUP=""
    if [ -n "${QUALIFY_REPORT_DIR:-}" ]; then
        mkdir -p "$QUALIFY_REPORT_DIR"
        python3 - "$QUALIFY_REPORT_DIR" "$ALPHA_TAG" "$CANDIDATE_TAG" "$CORPUS_TREE" "$PUBLISHED_ACTUAL" "$PRIMARY_NAME" "$PLANTED_MESSAGES" "$SERVED_MESSAGES" "$SERVED_ENTRIES" <<'PY'
import json, os, sys
report_dir, alpha_tag, candidate_tag, corpus_tree, published_sha256, character, planted, served, world_entries = sys.argv[1:10]
json.dump({
    "schema": "gotavern-published-upgrade-verdict",
    "schemaVersion": 1,
    "ok": True,
    "baseline": {"publishedTag": alpha_tag, "source": "github-release", "assetSha256": published_sha256, "checksumVerified": True},
    "candidate": {"tag": candidate_tag},
    "corpus": {"treeSha256": corpus_tree, "character": character, "plantedMessages": int(planted), "servedMessages": int(served), "worldEntries": int(world_entries)},
    "journey": {"resumedExistingChat": True, "savedContinuation": True, "restartReadBack": True, "assets": True, "settingsUnknownKeysPreserved": True, "worldBookServed": True},
    "arrivalPaths": {"publishedUpgrade": True, "freshInstallOverCorpus": True, "sillytavernDataCopyDropin": True},
    "backup": {"preUpdateBackupExercised": True, "restoredPrefixBooted": True},
    "migration": {"manualStepsRequired": 0, "writesClassified": True},
}, open(os.path.join(report_dir, "published-alpha9-verdict.json"), "w"), indent=2)
PY
        ok "wrote the machine-readable verdict to $QUALIFY_REPORT_DIR/published-alpha9-verdict.json"
    fi
    echo
    echo "ok: published $ALPHA_TAG -> candidate $CANDIDATE_TAG upgrade qualification passed (real artifacts, checksum-verified; chat resumed, continued, restarted and read back; backup restore exercised; migration writes classified)"
    exit 0
}


WORK_ROOT=$(mktemp -d 2>/dev/null || mktemp -d -t gotavern-upgrade)
SERVER_PID=""
MIRROR_PID=""
FAILURE_PREFIX=""
FAILURE_BACKUP=""
cleanup() {
    for pid in "$SERVER_PID" "$MIRROR_PID"; do
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
    done
    rm -rf "$WORK_ROOT"
}
trap cleanup EXIT HUP INT TERM

# ---- PUBLISHED-BASELINE DISPATCH ------------------------------------------------------------------
# `--published-alpha9 <candidate-archive>` qualifies the PUBLISHED v0.1.0-alpha.9 -> candidate upgrade with real
# downloads and a usable journey (see qualify_published_alpha9 above). The default invocation keeps the original
# two-archive cross-commit qualification, unchanged.
if [ "${1:-}" = "--published-alpha9" ]; then
    shift
    [ "$#" -ge 1 ] || fail "usage: $0 --published-alpha9 <candidate-archive>"
    [ -s "$1" ] || fail "candidate archive $1 is missing or empty"
    qualify_published_alpha9 "$1"
fi

[ -f "$INSTALLER" ] || fail "install.sh not found at $INSTALLER"
[ -s "$OLDER_ARCHIVE" ] || fail "older archive $OLDER_ARCHIVE is missing or empty"
[ -s "$NEWER_ARCHIVE" ] || fail "newer archive $NEWER_ARCHIVE is missing or empty"

# ---- 1. the two releases, identified by the binary inside each archive -------------------------

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
OLDER_TOKENS=$(tree_of "$WORK_ROOT/stage-older/src/tokenizers")
NEWER_TOKENS=$(tree_of "$WORK_ROOT/stage-newer/src/tokenizers")
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

# THE OLDER RELEASE'S OWN BINARY DOES NOT KNOW THE src/tokenizers TIER. This installer ships with the CURRENT
# source and installs the PINNED layout (`<prefix>/src/tokenizers`), which is what a user installing THIS release
# gets -- but the older archive's binary only looks at `<prefix>/tokenizers` and `<prefix>/upstream/tokenizers`, so
# `assets verify` from the older prefix would fail against a tree no installer of its era could have produced.
#
# Reproducing the state a user of the older release actually had means mirroring the tree to the legacy path: the
# SAME bytes, because both releases vendor the same tokenizer tree (asserted just below, where the installed tree
# is compared with the older archive's own manifest). This is a harness accommodation and it says so: the point of
# this job is UPDATE AND ROLLBACK over a user tree written by a different build, not a binary judged against a
# layout that did not exist when it was built.
[ -d "$PREFIX/src/tokenizers" ] || fail "the installer did not install src/tokenizers/, so the older release's tree cannot be reproduced"
rm -rf "$PREFIX/tokenizers"
cp -R "$PREFIX/src/tokenizers" "$PREFIX/tokenizers"
ok "mirrored the tree to the legacy root path, which is the layout $OLDER_TAG's own installer produced"

( cd "$PREFIX" && "$INSTALLED" assets verify ) >"$WORK_ROOT/assets-older.log" 2>&1 \
    || fail "assets verify failed from the installed prefix for $OLDER_TAG"
ok "assets verify passes from the prefix for $OLDER_TAG"

[ "$(sha256_of "$INSTALLED")" = "$OLDER_BINARY_HASH" ] \
    || fail "the installed binary is not byte-identical to the older archive's binary"
ok "the installed binary is byte-identical to $OLDER_ARCHIVE's binary"

INSTALLED_TOKENS=$(tree_of "$PREFIX/src/tokenizers")
if [ "$INSTALLED_TOKENS" != "$OLDER_TOKENS" ]; then
    printf '%s\n' "$INSTALLED_TOKENS" >"$WORK_ROOT/installed-tokenizers.txt"
    printf '%s\n' "$OLDER_TOKENS" >"$WORK_ROOT/archive-tokenizers.txt"
    diff -u "$WORK_ROOT/archive-tokenizers.txt" "$WORK_ROOT/installed-tokenizers.txt" >&2 || true
    fail "the installed src/tokenizers/ tree does not match the older archive's own tree"
fi
ok "the installed src/tokenizers/ tree matches $OLDER_ARCHIVE's manifest byte for byte"

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
    #
    # `--browserLaunchEnabled false` IS NOT OPTIONAL: the pinned default config enables browser launch, and a
    # qualification that opens a window on an operator's desktop is a defect in the gate (the same flag the
    # browser harness passes to every boot it makes).
    PORT=$(free_port)
    ( cd "$PREFIX" && exec "./gotavern" start --port "$PORT" --browserLaunchEnabled false --heartbeatInterval 0 ) >"$3" 2>&1 &
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
ROLLED_TOKENS=$(tree_of "$PREFIX/src/tokenizers")
[ "$ROLLED_TOKENS" = "$OLDER_TOKENS" ] || fail "after the rollback the installed src/tokenizers/ tree does not match the older archive's manifest"
ok "the rolled-back src/tokenizers/ tree matches $OLDER_ARCHIVE's manifest byte for byte"

# ---- 10. the NEWER release's state must survive the rollback, and be READABLE by the older
#          release -- the cross-baseline direction nobody had executed -------------------------

snapshot_runtime "$PREFIX" > "$WORK_ROOT/runtime-after-rollback.txt"
if ! diff -u "$WORK_ROOT/runtime-after-newer-write.txt" "$WORK_ROOT/runtime-after-rollback.txt" >"$WORK_ROOT/runtime-diff-rollback.txt" 2>&1; then
    cat "$WORK_ROOT/runtime-diff-rollback.txt" >&2
    fail "the rollback changed runtime state: the state the newer release wrote must survive byte for byte"
fi
ok "the rollback preserved every runtime file the newer release wrote, byte for byte"

# CAPTURE THE ONE FILE AN OLDER BOOT IS ALLOWED TO EXTEND. `data/access.log` is an append-only runtime log:
# both releases write request lines into it, so booting the older binary over a prefix the newer release
# used necessarily extends it. A hash comparison cannot demand "unchanged", and simply ignoring the path
# would let a release that TRUNCATED or REWROTE the newer release's log pass. The bytes are therefore
# captured here and the assertion below requires them to be an exact PREFIX of the file after the boot.
ACCESS_LOG_PRESENT=0
if [ -f "$PREFIX/data/access.log" ]; then
    cp "$PREFIX/data/access.log" "$WORK_ROOT/access-log-before-rollback-boot.txt"
    ACCESS_LOG_PRESENT=1
fi

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
    NON_LOG_CHANGES=$(grep '^changed ' "$WORK_ROOT/runtime-classified-changes.txt" | grep -v '^changed ./data/access\.log$' || true)
    if [ -n "$NON_LOG_CHANGES" ]; then
        printf '%s\n' "$NON_LOG_CHANGES" >&2
        fail "the older release's startup MODIFIED runtime state written by the newer release (paths above)"
    fi
    # The only permitted modification is the append-only access log, and it is CHECKED, not excused: the
    # older boot must have added bytes to the newer release's file without changing any that were already
    # there. A truncating or rewriting log implementation fails here and names the path.
    [ "$ACCESS_LOG_PRESENT" = "1" ] \
        || fail "the older release's startup created data/access.log although the newer release left none, so the change is not an append"
    ACCESS_LOG_BEFORE_SIZE=$(wc -c < "$WORK_ROOT/access-log-before-rollback-boot.txt")
    head -c "$ACCESS_LOG_BEFORE_SIZE" "$PREFIX/data/access.log" | cmp -s - "$WORK_ROOT/access-log-before-rollback-boot.txt" \
        || fail "the older release's startup REWROTE data/access.log instead of appending to it (the newer release's bytes are not a prefix of the file)"
    ok "the older release appended to data/access.log and preserved every byte the newer release wrote (append-only log, checked as a byte prefix)"
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
