#!/usr/bin/env bash
# Copy a SillyTavern runtime into a GoTavern runtime without modifying the source.
#
# This is intentionally a COPY operation, not a data-format conversion.
# Invoke with bash if the executable bit was not preserved by your checkout:
#   bash scripts/migrate-from-sillytavern.sh --source /opt/SillyTavern --dest /opt/GoTavern

set -euo pipefail

usage() {
    cat <<'EOF'
Usage:
  migrate-from-sillytavern.sh --source <SillyTavern-root> [--dest <GoTavern-runtime-root>] [--force]

Options:
  --source PATH   SillyTavern runtime/repository root containing config.yaml.
  --dest PATH     GoTavern runtime root. Defaults to the current directory.
  --force         Allow replacing an existing destination config/data tree after
                  first moving the destination copies into a destination-side backup.
  -h, --help      Show this help.

Safety properties:
  * Source is opened/read/copied only. This script never writes, renames, deletes,
    chmods, locks, migrates, or cleans anything in the source tree.
  * The complete configured relative dataRoot is copied, including _storage and
    cookie-secret.txt. It does not cherry-pick only visible user folders.
  * Node server plugins are NOT migrated as supported functionality.

Notes:
  * For a consistent copy, stop SillyTavern first or copy from a filesystem snapshot.
  * Absolute dataRoot values are refused because copying config.yaml unchanged would
    make GoTavern continue using the old absolute source path.
EOF
}

SOURCE=""
DEST="$(pwd -P)"
FORCE=0

while (($#)); do
    case "$1" in
        --source)
            [[ $# -ge 2 ]] || { echo "error: --source requires a path" >&2; exit 2; }
            SOURCE="$2"
            shift 2
            ;;
        --dest)
            [[ $# -ge 2 ]] || { echo "error: --dest requires a path" >&2; exit 2; }
            DEST="$2"
            shift 2
            ;;
        --force)
            FORCE=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

[[ -n "$SOURCE" ]] || { echo "error: --source is required" >&2; usage >&2; exit 2; }
[[ -d "$SOURCE" ]] || { echo "error: source directory does not exist: $SOURCE" >&2; exit 1; }

SOURCE="$(cd "$SOURCE" && pwd -P)"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd -P)"

[[ "$SOURCE" != "$DEST" ]] || { echo "error: source and destination are the same directory" >&2; exit 1; }

CONFIG_SRC="$SOURCE/config.yaml"
[[ -f "$CONFIG_SRC" ]] || {
    echo "error: $CONFIG_SRC not found" >&2
    echo "       Point --source at the SillyTavern runtime root, not at its data directory." >&2
    exit 1
}

# Read only the simple top-level scalar syntax used by SillyTavern's config template.
# We deliberately refuse complex/absolute dataRoot values rather than guessing.
DATA_ROOT_RAW="$({ awk '
    /^[[:space:]]*dataRoot:[[:space:]]*/ {
        line=$0
        sub(/^[[:space:]]*dataRoot:[[:space:]]*/, "", line)
        sub(/[[:space:]]+#.*$/, "", line)
        print line
        exit
    }
' "$CONFIG_SRC"; } || true)"

# Trim whitespace and matching single/double quotes.
DATA_ROOT_RAW="$(printf '%s' "$DATA_ROOT_RAW" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ -z "$DATA_ROOT_RAW" ]]; then
    DATA_ROOT_RAW="./data"
fi
if [[ "$DATA_ROOT_RAW" == \"*\" && "$DATA_ROOT_RAW" == *\" ]]; then
    DATA_ROOT_RAW="${DATA_ROOT_RAW:1:${#DATA_ROOT_RAW}-2}"
elif [[ "$DATA_ROOT_RAW" == \'*\' && "$DATA_ROOT_RAW" == *\' ]]; then
    DATA_ROOT_RAW="${DATA_ROOT_RAW:1:${#DATA_ROOT_RAW}-2}"
fi

case "$DATA_ROOT_RAW" in
    /*)
        echo "error: config.yaml uses an absolute dataRoot: $DATA_ROOT_RAW" >&2
        echo "       Refusing to copy config.yaml unchanged because the destination would still" >&2
        echo "       point at the original data path. Use GoTavern direct-use mode or make a" >&2
        echo "       destination-side config copy with a deliberate new dataRoot." >&2
        exit 1
        ;;
    *://*)
        echo "error: unsupported dataRoot value: $DATA_ROOT_RAW" >&2
        exit 1
        ;;
esac

# Strip a leading ./ but otherwise preserve the relative layout named by config.yaml.
DATA_REL="${DATA_ROOT_RAW#./}"
[[ -n "$DATA_REL" && "$DATA_REL" != "." ]] || { echo "error: unsafe dataRoot: $DATA_ROOT_RAW" >&2; exit 1; }

# Reject parent traversal. SillyTavern can technically be pointed elsewhere, but a
# copy tool should not infer a destination outside --dest.
IFS='/' read -r -a DATA_PARTS <<< "$DATA_REL"
for part in "${DATA_PARTS[@]}"; do
    [[ "$part" != ".." ]] || {
        echo "error: dataRoot escapes the SillyTavern root: $DATA_ROOT_RAW" >&2
        echo "       Refusing ambiguous copy migration." >&2
        exit 1
    }
done

DATA_SRC="$SOURCE/$DATA_REL"
DATA_DST="$DEST/$DATA_REL"
CONFIG_DST="$DEST/config.yaml"

[[ -d "$DATA_SRC" ]] || {
    echo "error: configured dataRoot does not exist: $DATA_SRC" >&2
    exit 1
}

# Protect against accidentally placing the destination inside the source data tree.
case "$DEST/" in
    "$SOURCE/"*)
        echo "error: destination must not be inside the SillyTavern source tree" >&2
        exit 1
        ;;
esac

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="$DEST/.migration-backup-$TIMESTAMP"

if [[ -e "$CONFIG_DST" || -e "$DATA_DST" ]]; then
    if (( FORCE == 0 )); then
        echo "error: destination already contains config.yaml and/or $DATA_REL" >&2
        echo "       Re-run with --force only if you intend to replace destination copies." >&2
        exit 1
    fi

    mkdir -p "$BACKUP_ROOT"
    if [[ -e "$CONFIG_DST" ]]; then
        mv -- "$CONFIG_DST" "$BACKUP_ROOT/config.yaml"
    fi
    if [[ -e "$DATA_DST" ]]; then
        mkdir -p "$BACKUP_ROOT/$(dirname "$DATA_REL")"
        mv -- "$DATA_DST" "$BACKUP_ROOT/$DATA_REL"
    fi
    echo "Destination-side backup: $BACKUP_ROOT"
fi

echo "Source (read-only): $SOURCE"
echo "Destination:        $DEST"
echo "Data root:          $DATA_REL"
echo

echo "[1/4] Copying config.yaml..."
cp -p -- "$CONFIG_SRC" "$CONFIG_DST"

echo "[2/4] Copying complete data root..."
mkdir -p "$(dirname "$DATA_DST")"
cp -a -- "$DATA_SRC" "$DATA_DST"

# Global third-party extensions are separate from per-user data in some deployments.
GLOBAL_EXT_REL="public/scripts/extensions/third-party"
GLOBAL_EXT_SRC="$SOURCE/$GLOBAL_EXT_REL"
GLOBAL_EXT_DST="$DEST/$GLOBAL_EXT_REL"
if [[ -d "$GLOBAL_EXT_SRC" ]]; then
    echo "[3/4] Copying global third-party extension overlay..."
    mkdir -p "$(dirname "$GLOBAL_EXT_DST")"
    if [[ -e "$GLOBAL_EXT_DST" ]]; then
        if (( FORCE == 0 )); then
            echo "error: destination extension overlay already exists: $GLOBAL_EXT_DST" >&2
            exit 1
        fi
        mkdir -p "$BACKUP_ROOT/$(dirname "$GLOBAL_EXT_REL")"
        mv -- "$GLOBAL_EXT_DST" "$BACKUP_ROOT/$GLOBAL_EXT_REL"
    fi
    cp -a -- "$GLOBAL_EXT_SRC" "$GLOBAL_EXT_DST"
else
    echo "[3/4] No global third-party extension overlay found; skipping."
fi

# Relative TLS paths commonly point at ./certs. Copying it preserves config behavior.
if [[ -d "$SOURCE/certs" ]]; then
    echo "[4/4] Copying certs/ (source remains untouched)..."
    if [[ -e "$DEST/certs" ]]; then
        if (( FORCE == 0 )); then
            echo "error: destination certs/ already exists" >&2
            exit 1
        fi
        mkdir -p "$BACKUP_ROOT"
        mv -- "$DEST/certs" "$BACKUP_ROOT/certs"
    fi
    cp -a -- "$SOURCE/certs" "$DEST/certs"
else
    echo "[4/4] No certs/ directory found; skipping."
fi

echo
if [[ -d "$SOURCE/plugins" ]] && find "$SOURCE/plugins" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .; then
    cat <<'EOF'
WARNING: The source contains SillyTavern server plugins under plugins/.
GoTavern intentionally does not support Node.js server plugins. They were not copied
as supported runtime functionality. Frontend extensions are handled separately.
EOF
    echo
fi

# Lightweight destination-only sanity checks. Never modify source for verification.
[[ -f "$CONFIG_DST" ]] || { echo "error: copied config.yaml is missing" >&2; exit 1; }
[[ -d "$DATA_DST" ]] || { echo "error: copied data root is missing" >&2; exit 1; }

# Compare counts/bytes as a quick copy sanity check without requiring rsync.
# Metadata/caches may contain symlinks; du/count output is advisory, not a proof.
SRC_FILES="$(find "$DATA_SRC" -type f 2>/dev/null | wc -l | tr -d ' ')"
DST_FILES="$(find "$DATA_DST" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$SRC_FILES" != "$DST_FILES" ]]; then
    echo "error: file-count mismatch after copy: source=$SRC_FILES destination=$DST_FILES" >&2
    exit 1
fi

cat <<EOF
Migration copy completed.

Copied:
  $CONFIG_SRC
    -> $CONFIG_DST
  $DATA_SRC
    -> $DATA_DST

Data files checked: $DST_FILES

The SillyTavern source tree was not modified.
Before first GoTavern start, keep the original SillyTavern process stopped so two
servers cannot write the same logical dataset concurrently.
EOF
