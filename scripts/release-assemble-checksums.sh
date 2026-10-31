#!/bin/sh
#
# release-assemble-checksums.sh DIST_DIR
#
# Writes `checksums.txt` for a directory holding the six canonical release archives, in the exact shape
# both installers parse (`<64 hex>  <bare asset name>`, sha256sum format).
#
# WHY THIS IS A SCRIPT AND NOT TWO INLINE COPIES. Two release-path consumers hand the installers a
# checksums.txt:
#   1. `release.yml`'s publish job, whose output is UPLOADED with the release;
#   2. `release.yml`'s prepublish-qualification job, which feeds the installers the candidate's own
#      archives and checksums BEFORE the tag exists.
# The second exists to prove the first: if the qualification generated its own file with its own command,
# a green would be evidence about a file the release does not ship. One script, two callers, one shape --
# the same reason scripts/classify-version-tag.sh exists rather than two YAML regexes.
#
# THE CANONICAL NAME SET IS DERIVED, NOT RETYPED. release.yml's build matrix produces
#   gotavern-{linux,darwin}-{amd64,arm64}.tar.gz  and  gotavern-windows-{amd64,arm64}.zip
# and this regex enumerates exactly those six combinations. Requiring (a) every archive present to match
# it, (b) exactly six of them and (c) every checksum line to name one of them makes the set EXACT: a
# seventh file, a misspelled name, or a missing target all fail here rather than at a user's
# `releases/latest/download/` request.
#
# THE FILENAME MUST NOT CARRY A "./" PREFIX. `sha256sum ./*.tar.gz` writes "./gotavern-linux-amd64.tar.gz",
# and install.sh matches `awk '$2 == asset || $2 == "*" asset'`, so the prefixed form parses to no entry
# and the installer aborts with "checksums.txt does not contain an entry". Passing bare names keeps $2
# equal to the asset name the installer requests. This failure has already shipped once; it is not
# hypothetical.
#
# Usage: sh scripts/release-assemble-checksums.sh dist     (run from the repository root or anywhere)
# Exit:  0 only when the six canonical archives are present and checksums.txt holds exactly one valid
#        entry for each of them. Prints the file, so a log names the bytes that were uploaded.
set -eu

dist=${1:-}
if [ -z "$dist" ]; then
    echo "usage: release-assemble-checksums.sh DIST_DIR" >&2
    exit 2
fi
[ -d "$dist" ] || { echo "release-assemble-checksums.sh: no directory at '$dist'" >&2; exit 1; }

canonical_re='^gotavern-(linux|darwin)-(amd64|arm64)\.tar\.gz$|^gotavern-windows-(amd64|arm64)\.zip$'

cd "$dist"

count=0
for asset in *.tar.gz *.zip; do
    # An unmatched glob stays literal; that is not an error by itself, the count check below names it.
    [ -f "$asset" ] || continue
    if ! printf '%s' "$asset" | grep -Eq "$canonical_re"; then
        echo "release-assemble-checksums.sh: '$asset' is not a canonical release asset name" >&2
        echo "  canonical set: gotavern-{linux,darwin}-{amd64,arm64}.tar.gz, gotavern-windows-{amd64,arm64}.zip" >&2
        exit 1
    fi
    [ -s "$asset" ] || { echo "release-assemble-checksums.sh: '$asset' is empty" >&2; exit 1; }
    count=$((count + 1))
done
if [ "$count" -ne 6 ]; then
    echo "release-assemble-checksums.sh: expected exactly 6 canonical archives, found ${count}" >&2
    ls -l >&2 || true
    exit 1
fi

# Bare names. The output is what gets uploaded and what the installers parse.
#
# THE `*` STRIP IS NOT COSMETIC. GNU sha256sum prefixes the name with `*` when it is in BINARY mode and
# writes two spaces in text mode. On the Linux runner this runs in text mode and the two forms never
# differ, but the file's format is an installer contract, not host behaviour: install.sh matches
# `$2 == asset`, install.ps1's regex tolerates `*?`, and release-install-smoke.yml (which validates the
# PUBLISHED bytes) requires a bare name. Normalising here makes the file byte-identical whichever mode the
# host's sha256sum defaults to, and keeps a local rehearsal on Git Bash meaningful.
sha256sum *.tar.gz *.zip | awk '{ name=$2; sub(/^\*/, "", name); print $1 "  " name }' > checksums.txt

lines=$(wc -l < checksums.txt | tr -d ' ')
[ "$lines" -eq 6 ] || {
    echo "release-assemble-checksums.sh: checksums.txt has ${lines} lines, expected 6" >&2
    cat checksums.txt >&2
    exit 1
}

# A CR anywhere would leave a trailing CR on the name field for the Windows installer's regex, and a
# line whose third field is "./name" or whose digest is malformed is not a line either installer can use.
if grep -q "$(printf '\r')" checksums.txt; then
    echo "release-assemble-checksums.sh: checksums.txt contains CR; the name field would carry a trailing CR" >&2
    exit 1
fi

while read -r hash name; do
    printf '%s' "$name" | grep -Eq "$canonical_re" || {
        echo "release-assemble-checksums.sh: checksums.txt entry names '$name', not a canonical bare asset name" >&2
        exit 1
    }
    printf '%s' "$hash" | grep -Eq '^[0-9a-f]{64}$' || {
        echo "release-assemble-checksums.sh: checksums.txt entry for '$name' has a malformed digest '$hash'" >&2
        exit 1
    }
    actual=$(sha256sum "$name" | awk '{print $1}')
    [ "$actual" = "$hash" ] || {
        echo "release-assemble-checksums.sh: $name: recorded $hash, recomputed $actual" >&2
        exit 1
    }
    # AND THE INSTALLER'S OWN PARSE. install.sh:167 and install.ps1:92 resolve an entry by NAME, so a file
    # that has the right bytes but cannot be found by the parser is still broken for users.
    entries=$(awk -v asset="$name" '$2 == asset' checksums.txt | wc -l | tr -d ' ')
    [ "$entries" -eq 1 ] || {
        echo "release-assemble-checksums.sh: '$name' resolves to ${entries} installer-parser entries, expected 1" >&2
        exit 1
    }
done < checksums.txt

cat checksums.txt
echo "ok: checksums.txt holds exactly one sha256sum-format entry for each of the six canonical archives"
