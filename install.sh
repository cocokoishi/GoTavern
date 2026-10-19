#!/bin/sh
# GoTavern release installer.
# Downloads a prebuilt GitHub Release asset. It never installs Go/Node or compiles source.

set -eu

REPO="cocokoishi/GoTavern"
VERSION="latest"
INSTALL_DIR="${HOME}/GoTavern"

usage() {
    cat <<'EOF'
Usage: install.sh [--dir PATH] [--version TAG]

Options:
  --dir PATH      Installation/runtime directory (default: $HOME/GoTavern)
  --version TAG   GitHub release tag to install (default: latest stable release)
  -h, --help      Show this help

The installer replaces only immutable GoTavern release files. It does not delete or
replace config.yaml, data/, extensions, certificates, or other runtime state.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --dir)
            [ "$#" -ge 2 ] || { echo "error: --dir requires a path" >&2; exit 2; }
            INSTALL_DIR=$2
            shift 2
            ;;
        --version)
            [ "$#" -ge 2 ] || { echo "error: --version requires a release tag" >&2; exit 2; }
            VERSION=$2
            shift 2
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

OS_RAW=$(uname -s 2>/dev/null || true)
case "$OS_RAW" in
    Linux)  OS=linux ;;
    Darwin) OS=darwin ;;
    *)
        echo "error: unsupported operating system: ${OS_RAW:-unknown}" >&2
        echo "Download a supported release archive manually from GitHub Releases." >&2
        exit 1
        ;;
esac

ARCH_RAW=$(uname -m 2>/dev/null || true)
case "$ARCH_RAW" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *)
        echo "error: unsupported architecture: ${ARCH_RAW:-unknown}" >&2
        echo "Download a supported release archive manually from GitHub Releases." >&2
        exit 1
        ;;
esac

ASSET="gotavern-${OS}-${ARCH}.tar.gz"
if [ "$VERSION" = "latest" ]; then
    BASE_URL="https://github.com/${REPO}/releases/latest/download"
    RELEASE_LABEL="latest stable"
else
    BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
    RELEASE_LABEL=$VERSION
fi

if command -v curl >/dev/null 2>&1; then
    download() {
        curl -fL --retry 2 --connect-timeout 15 -o "$2" "$1"
    }
elif command -v wget >/dev/null 2>&1; then
    download() {
        wget -q --https-only -O "$2" "$1"
    }
else
    echo "error: curl or wget is required to download a GoTavern release." >&2
    exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
    sha256_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    echo "error: sha256sum or shasum is required for release verification." >&2
    exit 1
fi

TMP_ROOT=$(mktemp -d 2>/dev/null || mktemp -d -t gotavern-install)
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT HUP INT TERM

ARCHIVE="$TMP_ROOT/$ASSET"
CHECKSUMS="$TMP_ROOT/checksums.txt"
EXTRACTED="$TMP_ROOT/extracted"
mkdir -p "$EXTRACTED"

echo "GoTavern installer"
echo "  release: $RELEASE_LABEL"
echo "  target:  $OS/$ARCH"
echo "  dir:     $INSTALL_DIR"
echo

echo "Downloading checksums..."
if ! download "$BASE_URL/checksums.txt" "$CHECKSUMS"; then
    echo >&2
    echo "error: no usable GoTavern $RELEASE_LABEL release metadata was found." >&2
    echo "The project may not have published its first prebuilt release yet, or the tag is invalid." >&2
    echo "This installer will not fall back to compiling source." >&2
    exit 1
fi

echo "Downloading $ASSET..."
if ! download "$BASE_URL/$ASSET" "$ARCHIVE"; then
    echo >&2
    echo "error: release asset $ASSET is unavailable for $RELEASE_LABEL." >&2
    echo "This installer will not fall back to compiling source." >&2
    exit 1
fi

EXPECTED=$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1; exit }' "$CHECKSUMS")
if [ -z "$EXPECTED" ]; then
    echo "error: checksums.txt does not contain an entry for $ASSET" >&2
    exit 1
fi
ACTUAL=$(sha256_file "$ARCHIVE")
if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "error: SHA-256 verification failed for $ASSET" >&2
    echo "expected: $EXPECTED" >&2
    echo "actual:   $ACTUAL" >&2
    exit 1
fi

echo "Checksum verified."

tar -xzf "$ARCHIVE" -C "$EXTRACTED"
if [ ! -f "$EXTRACTED/gotavern" ]; then
    echo "error: release archive is missing the expected gotavern executable at archive root" >&2
    exit 1
fi

mkdir -p "$INSTALL_DIR"
NEW_BINARY="$INSTALL_DIR/.gotavern.new.$$"
cp "$EXTRACTED/gotavern" "$NEW_BINARY"
chmod 0755 "$NEW_BINARY"
# Rename within one directory so Unix filesystems can replace atomically.
mv -f "$NEW_BINARY" "$INSTALL_DIR/gotavern"

# Launchers are immutable convenience files and may be refreshed on update.
cat > "$INSTALL_DIR/start.sh" <<'EOF'
#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$SCRIPT_DIR"
exec "$SCRIPT_DIR/gotavern" "$@"
EOF
chmod 0755 "$INSTALL_DIR/start.sh"

# Copy optional immutable notices from the release without touching runtime state.
for name in LICENSE THIRD_PARTY_NOTICES.txt BUILD-INFO.txt; do
    if [ -f "$EXTRACTED/$name" ]; then
        cp "$EXTRACTED/$name" "$INSTALL_DIR/$name"
    fi
done

echo
echo "Installed GoTavern into: $INSTALL_DIR"
echo "Start it with:"
echo "  $INSTALL_DIR/start.sh"
echo
if [ -e "$INSTALL_DIR/config.yaml" ] || [ -d "$INSTALL_DIR/data" ]; then
    echo "Existing runtime state was preserved."
else
    echo "No runtime state exists yet. The first server start will initialize the pinned SillyTavern-compatible defaults."
fi