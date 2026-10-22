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
    DEFAULT_BASE_URL="https://github.com/${REPO}/releases/latest/download"
    RELEASE_LABEL="latest stable"
else
    DEFAULT_BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
    RELEASE_LABEL=$VERSION
fi

# MIRROR / AIR-GAPPED INSTALL (docs/INSTALLATION.md section 3.1). When
# GOTAVERN_RELEASES_BASE_URL is set it REPLACES the computed base URL for BOTH forms above, so a
# mirror must serve `<base>/latest/download/` and `<base>/<tag>/` with the canonical asset names and a
# `checksums.txt` in sha256sum format. Checksum verification below stays mandatory and unconditional:
# a mirror is a different source for the same bytes, never a weaker check. When the variable is unset
# every URL and flag in this script is exactly what it was before the seam existed, `--https-only`
# included.
MIRROR_BASE_URL=${GOTAVERN_RELEASES_BASE_URL:-}
if [ -n "$MIRROR_BASE_URL" ]; then
    # THE VARIABLE IS THE RELEASES ROOT, NOT THE FINAL BASE URL.
    #
    # The first version assigned BASE_URL=${MIRROR_BASE_URL%/} directly, which dropped the
    # `/latest/download` or `/<tag>` segment and asked a mirror for `<root>/checksums.txt` while the
    # documented layout (and every real mirror) serves `<root>/<tag>/checksums.txt`. Nothing had ever
    # executed the seam, so nothing caught it; the qualification job did, on its first run, with
    # "no usable GoTavern qual-a release metadata was found".
    if [ "$VERSION" = "latest" ]; then
        BASE_URL="${MIRROR_BASE_URL%/}/latest/download"
    else
        BASE_URL="${MIRROR_BASE_URL%/}/$VERSION"
    fi
else
    BASE_URL=$DEFAULT_BASE_URL
fi

if command -v curl >/dev/null 2>&1; then
    download() {
        curl -fL --retry 2 --connect-timeout 15 -o "$2" "$1"
    }
elif command -v wget >/dev/null 2>&1; then
    if [ -n "$MIRROR_BASE_URL" ]; then
        # A loopback or intranet mirror is a legitimate plain-http target, so --https-only is dropped
        # ONLY for a mirror. curl has never enforced a scheme here, so its branch is unchanged for both.
        download() {
            wget -q -O "$2" "$1"
        }
    else
        download() {
            wget -q --https-only -O "$2" "$1"
        }
    fi
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
# tokenizers/ is REQUIRED, not optional. cmd/gotavern reads it from <InstallRoot>/tokenizers and
# `gotavern assets verify` hashes that directory on disk against the embedded manifest; with it absent
# the tokenizer routes take the pinned FALLBACK path (ids [], chunks null, counts about 25% high) while
# still answering. This installer used to omit it, so the one-line install produced a runtime whose own
# `assets verify` failed. Failing HERE is deliberate: a release archive that lacks it is not installable.
if [ ! -d "$EXTRACTED/tokenizers" ]; then
    echo "error: release archive does not contain tokenizers/ at archive root." >&2
    echo "GoTavern needs that directory beside the binary; without it tokenizer counts silently fall back." >&2
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

# Replace the immutable tokenizer tree. Staged beside its final name and swapped, so an interrupted
# install leaves either the old tree or the new one in place rather than a half-copied directory.
TOKENIZERS_NEW="$INSTALL_DIR/.tokenizers.new.$$"
TOKENIZERS_OLD="$INSTALL_DIR/.tokenizers.old.$$"
rm -rf "$TOKENIZERS_NEW" "$TOKENIZERS_OLD"
cp -R "$EXTRACTED/tokenizers" "$TOKENIZERS_NEW"
if [ -d "$INSTALL_DIR/tokenizers" ]; then
    mv "$INSTALL_DIR/tokenizers" "$TOKENIZERS_OLD"
fi
mv "$TOKENIZERS_NEW" "$INSTALL_DIR/tokenizers"
rm -rf "$TOKENIZERS_OLD"

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