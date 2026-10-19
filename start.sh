#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$SCRIPT_DIR"
if [ ! -x "$SCRIPT_DIR/gotavern" ]; then
    echo "error: $SCRIPT_DIR/gotavern was not found or is not executable." >&2
    echo "Install a prebuilt GoTavern release first." >&2
    exit 1
fi
exec "$SCRIPT_DIR/gotavern" "$@"
