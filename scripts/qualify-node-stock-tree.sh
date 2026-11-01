#!/bin/sh
# QUALIFY THE NODE-ORIGINATED STOCK TREE: Node writes -> GoTavern reads/mutates -> pinned Node reads/continues
# -> GoTavern reads again, with the whole tree hashed before and after.
#
# This is the POSIX entry point the Linux CI workflow runs (scripts are also the documented interface on a
# developer host; on Windows run it from Git Bash, or call the Node driver directly). It delegates the work to
# `tools/qualify-node-stock-tree.mjs`; it does not re-implement any of it, so a local run and a CI run execute
# the same assertions.
#
# WHAT IT REFUSES BEFORE IT STARTS:
#   - no pinned checkout, or a checkout whose `git rev-parse HEAD` is not `upstream/SILLYTAVERN_COMMIT`
#     (the driver checks the commit too; both checks exist so a hand-transcribed path cannot silently measure a
#     different baseline);
#   - a pinned checkout without `node_modules` (the pinned server cannot boot without it);
#   - `--tree` without `--manifest`: a tree whose recorded per-file bytes are not available cannot be asserted
#     "preserved", so the run is refused rather than downgraded.
#
# USAGE
#   scripts/qualify-node-stock-tree.sh [--pinned DIR] [--tree DIR --manifest FILE] [--gotavern BIN]
#        [--work DIR] [--report FILE] [--verify-deterministic] [--keep] [--quiet]

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)

usage() {
    cat >&2 <<'USAGE'
usage: scripts/qualify-node-stock-tree.sh [options]

  --pinned DIR            pinned SillyTavern checkout (default: ../SillyTavern)
  --tree DIR              qualify an EXISTING generated tree instead of generating one
  --manifest FILE         the tree's recorded manifest (required with --tree)
  --tree-report FILE      the generator's report for --tree (default: <tree>.report.json)
  --gotavern BIN          use an existing binary instead of `go build ./cmd/gotavern`
  --work DIR              scratch directory (default: .tmp-artifacts/node-stock-tree-qualify)
  --report FILE           JSON report path (default: <work>/node-stock-tree-roundtrip.report.json)
  --verify-deterministic  generate the tree twice and require the normalised digests to match with every
                          difference inside the declared volatile set (only valid without --tree)
  --keep                  keep the scratch directory
  --quiet                 only print assertions, not progress

A run is GREEN only when every assertion in the report passed; the script exits 0 only then. The report is
written even on failure and the failing assertion's name is printed.
USAGE
    exit 2
}

PINNED="$REPO_ROOT/../SillyTavern"
TREE=""
MANIFEST=""
GOTAVERN_BIN=""
WORK="$REPO_ROOT/.tmp-artifacts/node-stock-tree-qualify"
REPORT=""
TREE_REPORT=""
VERIFY=0
KEEP=0
QUIET=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --pinned) [ "$#" -ge 2 ] || usage; PINNED="$2"; shift 2 ;;
        --tree) [ "$#" -ge 2 ] || usage; TREE="$2"; shift 2 ;;
        --manifest) [ "$#" -ge 2 ] || usage; MANIFEST="$2"; shift 2 ;;
        --tree-report) [ "$#" -ge 2 ] || usage; TREE_REPORT="$2"; shift 2 ;;
        --gotavern) [ "$#" -ge 2 ] || usage; GOTAVERN_BIN="$2"; shift 2 ;;
        --work) [ "$#" -ge 2 ] || usage; WORK="$2"; shift 2 ;;
        --report) [ "$#" -ge 2 ] || usage; REPORT="$2"; shift 2 ;;
        --verify-deterministic) VERIFY=1; shift ;;
        --keep) KEEP=1; shift ;;
        --quiet) QUIET=1; shift ;;
        -h|--help) usage ;;
        *) echo "error: unknown argument $1" >&2; usage ;;
    esac
done

command -v node >/dev/null 2>&1 || { echo "error: node is required (Node 24.x)" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "error: git is required" >&2; exit 1; }

# THE PINNED CHECKOUT IS THE ORACLE. Assert its identity here as well as in the driver, because a wrapper that
# hands the driver the wrong directory would otherwise produce a green run about a different SillyTavern.
if [ ! -d "$PINNED" ]; then
    echo "error: pinned SillyTavern checkout not found at $PINNED (pass --pinned DIR)" >&2
    exit 1
fi
AUTHORITATIVE=$(tr -d '[:space:]' < "$REPO_ROOT/upstream/SILLYTAVERN_COMMIT")
ACTUAL=$(git -C "$PINNED" rev-parse HEAD)
if [ "$ACTUAL" != "$AUTHORITATIVE" ]; then
    echo "error: $PINNED is at $ACTUAL, but upstream/SILLYTAVERN_COMMIT pins $AUTHORITATIVE" >&2
    exit 1
fi
if [ ! -d "$PINNED/node_modules" ]; then
    echo "error: $PINNED has no node_modules; run 'npm ci' in it first (the pinned server cannot boot without it)" >&2
    exit 1
fi
for required in "$PINNED/server.js" "$PINNED/default/config.yaml"; do
    if [ ! -e "$required" ]; then
        echo "error: the pinned checkout is incomplete: $required is missing" >&2
        exit 1
    fi
done

if [ -n "$TREE" ] && [ -z "$MANIFEST" ]; then
    echo "error: --tree requires --manifest (a tree without its recorded per-file bytes cannot be asserted preserved)" >&2
    exit 2
fi
if [ -n "$TREE" ] && [ "$VERIFY" -eq 1 ]; then
    echo "error: --verify-deterministic generates a fresh tree and cannot be combined with --tree" >&2
    exit 2
fi

mkdir -p "$WORK"

if [ -z "$TREE" ] && [ "$VERIFY" -eq 1 ]; then
    # THE DETERMINISM CLAIM IS ITS OWN STEP: generate twice, compare the normalised digests, and refuse a
    # difference outside the declared volatile set. The tree it leaves behind is the one the round trip uses.
    echo "node-stock-tree: generating the tree with the determinism self-check..."
    node "$REPO_ROOT/tools/build-node-stock-tree.mjs" \
        --pinned "$PINNED" \
        --out "$WORK/generated/tree" \
        --report "$WORK/generated/report.json" \
        --manifest "$WORK/generated/manifest.json" \
        --verify-deterministic
    TREE="$WORK/generated/tree"
    MANIFEST="$WORK/generated/manifest.json"
fi

if [ -z "$REPORT" ]; then
    REPORT="$WORK/node-stock-tree-roundtrip.report.json"
fi

set -- --pinned "$PINNED" --work "$WORK/roundtrip" --report "$REPORT"
if [ -n "$TREE" ]; then
    set -- "$@" --tree "$TREE" --manifest "$MANIFEST"
    if [ -n "$TREE_REPORT" ]; then set -- "$@" --tree-report "$TREE_REPORT"; fi
fi
if [ -n "$GOTAVERN_BIN" ]; then
    set -- "$@" --gotavern "$GOTAVERN_BIN"
fi
if [ "$KEEP" -eq 1 ]; then set -- "$@" --keep; fi
if [ "$QUIET" -eq 1 ]; then set -- "$@" --quiet; fi

echo "node-stock-tree: pinned $AUTHORITATIVE"
echo "node-stock-tree: work $WORK"

STATUS=0
node "$REPO_ROOT/tools/qualify-node-stock-tree.mjs" "$@" || STATUS=$?
echo "node-stock-tree: report $REPORT"
exit "$STATUS"
