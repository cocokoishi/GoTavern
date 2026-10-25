#!/bin/sh
# Build a STOCK SillyTavern tree that a release binary can be dropped into.
#
# WHY THIS EXISTS. `release-qualification.yml` builds its own archives and boots them in a directory it
# created; `release-install-smoke.yml` installs into an EMPTY prefix. Neither reproduces the report that
# started this lane: a user took a published release, put the binary into a working SillyTavern directory
# and it hung. `AGENTS.md` rules 23, 34 and 38 require the shipped artifact to be tested against a stock
# tree with existing config and existing data, and nothing in this repository built such a tree.
#
# WHY NO PinnedNodeBoot / NO npm / NO network. Every byte below comes from this repository's own vendored
# pinned baseline (`upstream/**`, pinned at `upstream/SILLYTAVERN_COMMIT`): the real frontend, the real
# `default/**` content, the real tokenizer tree. A tree assembled from the pinned bytes IS the pinned
# tree; running `npm ci` and booting Node would add build time and a second source of truth without
# adding fidelity. The one thing this cannot copy is a tree's runtime history (when checked out, Node
# seeds `data/**` from `default/content/index.json`), so this script DOES perform that seeding, using the
# pinned mapping read from the pinned source:
#
#   placement            src/endpoints/content-manager.js:326-368  getUserTargetByType()
#   directory names      src/constants.js:15-46                     USER_DIRECTORY_TEMPLATE
#   global content       src/endpoints/content-manager.js:374-386   getGlobalTargetByType()
#   content index        default/content/index.json                 (169 entries, copied as-is)
#
# That is a DERIVATION of the pinned placement, labelled as one: the trees this script produces are
# faithful to the pinned SOURCE, and are not a recording of a pinned Node run. The `startup` oracle
# fixture (`tests/oracle/sillytavern-1.19.0-fresh-start.json`) remains the oracle for what a fresh boot
# seeds; this script reproduces a tree that has ALREADY been booted and used, which is a different state.
#
# WHAT THE TREE CONTAINS
#   public/**                592 files, byte-identical to `upstream/public` (a stock tree keeps the
#                            frontend on disk; the release archive does NOT ship it, see below)
#   default/**               200 files, byte-identical to `upstream/default`
#   src/tokenizers/**        23 files, byte-identical to `upstream/tokenizers` -- a stock SillyTavern
#                            tree already keeps them here, which is why the release archive's layout
#                            collides with an existing tree rather than merely adding to it
#   config.yaml              a VERBATIM copy of `upstream/default/config.yaml` (16,394 bytes). This is
#                            what SillyTavern's postinstall writes, so it is a stock config and not a
#                            hand-written one. It deliberately keeps `extensions.autoUpdate: true` and
#                            `enableServerPluginsAutoUpdate: true` from the pinned defaults, because that
#                            is exactly the state a user's tree is in and the qualification job asserts
#                            that boot does NOT act on it (AGENTS.md rule 26).
#   data/default-user/**     seeded from `default/content/index.json` by the pinned type->directory
#                            mapping: characters, chats, worlds, themes, backgrounds, presets of every
#                            family, instruct/context/sysprompt/reasoning, movingUI, QuickReplies,
#                            "User Avatars", user/workflows, plus the empty directory skeleton the pinned
#                            `USER_DIRECTORY_TEMPLATE` names (groups, group chats, thumbnails/*, user/
#                            files, user/images, assets, vectors, extensions, backups).
#   data/_errors/**          4 pinned error pages (global content)
#   data/_css/user.css       1 pinned stylesheet (global content)
#   public/scripts/extensions/third-party/stock-example-extension/
#                            a REAL git repository (one commit) with a manifest and an entry point. The
#                            no-mutation assertion needs a repository to run `git status` against, and a
#                            fake empty directory would make that assertion vacuous (AGENTS.md rule 7).
#   plugins/.gitkeep         stock SillyTavern ships this directory
#
# WHAT WAS REMOVED, AND WHY (licensing / privacy)
#   - all API keys and provider credentials: `data/default-user/secrets.json` is written as the EMPTY
#     current-shape object `{}`. No key, token or password of any kind exists anywhere in the tree.
#   - no user account store (`data/_storage/`), no access log, no statistics file, no settings backups,
#     no uploaded files: all of those carry user history, and none is needed to prove the drop-in boots.
#   - no `node_modules/`, no `.git/` of SillyTavern itself, no `src/**` of the pinned Node server: a
#     target machine running GoTavern has no Node (AGENTS.md rule 5), and shipping them would make the
#     tree a checkout rather than an installation.
#   - no character card, chat or world info authored by a real person. The one chat this script writes
#     is synthetic (two invented lines) and is labelled as such in its own JSONL metadata.
#
# Usage: scripts/build-stock-tree.sh <target-dir> [--quiet]
#   Removes and recreates <target-dir>. Requires: sh, cp, mkdir, git (for the extension repository),
#   and the repository's `upstream/` tree.

set -eu

TARGET="${1:-}"
QUIET="${2:-}"
if [ -z "$TARGET" ]; then
    echo "usage: $0 <target-dir> [--quiet]" >&2
    exit 2
fi

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)
UPSTREAM="$REPO_ROOT/upstream"

for required in "$UPSTREAM/public" "$UPSTREAM/default" "$UPSTREAM/tokenizers" \
                "$UPSTREAM/default/content/index.json" "$UPSTREAM/default/config.yaml" \
                "$UPSTREAM/SILLYTAVERN_COMMIT"; do
    if [ ! -e "$required" ]; then
        echo "FAIL: the vendored pinned baseline is incomplete: $required is missing" >&2
        exit 1
    fi
done

say() {
    if [ "$QUIET" != "--quiet" ]; then echo "$@"; fi
}

USER_ROOT="data/default-user"

rm -rf "$TARGET"
mkdir -p "$TARGET" "$TARGET/$USER_ROOT"

# --- 1. the three pinned asset trees a stock installation has on disk -------------------------
cp -R "$UPSTREAM/public" "$TARGET/public"
cp -R "$UPSTREAM/default" "$TARGET/default"
mkdir -p "$TARGET/src"
cp -R "$UPSTREAM/tokenizers" "$TARGET/src/tokenizers"

# A stock SillyTavern tree also keeps its own copy of the Node server sources. They are NOT copied:
# a GoTavern target has no Node (rule 5) and a `src/` that is half-populated would only invite a test
# to read the wrong tree. `src/tokenizers` is the ONE thing under src/ that the runtime reads.

# --- 2. config.yaml: verbatim pinned default --------------------------------------------------
# Not hand-written and not patched. SillyTavern's postinstall copies exactly this file, so a verbatim
# copy is the stock config; editing it here would make the fixture a claim about config we invented.
cp "$UPSTREAM/default/config.yaml" "$TARGET/config.yaml"

# --- 3. seed user content using the PINNED mapping --------------------------------------------
# type -> directory, transcribed from src/endpoints/content-manager.js:326-368 and named from
# src/constants.js:15-46. A type this table does not know is a hard failure below, not a silent skip:
# a content family that quietly stops being seeded would shrink the fixture without anyone noticing.
content_target_for_type() {
    case "$1" in
        settings)          echo "$TARGET/$USER_ROOT" ;;
        character)         echo "$TARGET/$USER_ROOT/characters" ;;
        sprites)           echo "$TARGET/$USER_ROOT/characters" ;;
        background)        echo "$TARGET/$USER_ROOT/backgrounds" ;;
        world)             echo "$TARGET/$USER_ROOT/worlds" ;;
        avatar)            echo "$TARGET/$USER_ROOT/User Avatars" ;;
        theme)             echo "$TARGET/$USER_ROOT/themes" ;;
        workflow)          echo "$TARGET/$USER_ROOT/user/workflows" ;;
        kobold_preset)     echo "$TARGET/$USER_ROOT/KoboldAI Settings" ;;
        openai_preset)     echo "$TARGET/$USER_ROOT/OpenAI Settings" ;;
        novel_preset)      echo "$TARGET/$USER_ROOT/NovelAI Settings" ;;
        textgen_preset)    echo "$TARGET/$USER_ROOT/TextGen Settings" ;;
        instruct)          echo "$TARGET/$USER_ROOT/instruct" ;;
        context)           echo "$TARGET/$USER_ROOT/context" ;;
        moving_ui)         echo "$TARGET/$USER_ROOT/movingUI" ;;
        quick_replies)     echo "$TARGET/$USER_ROOT/QuickReplies" ;;
        sysprompt)         echo "$TARGET/$USER_ROOT/sysprompt" ;;
        reasoning)         echo "$TARGET/$USER_ROOT/reasoning" ;;
        error_page)        echo "$TARGET/data/_errors" ;;
        stylesheet)        echo "$TARGET/data/_css" ;;
        *)                 echo "" ;;
    esac
}

CONTENT_ROOT="$UPSTREAM/default/content"

# THE INDEX IS PARSED BY python3, NOT BY grep/awk. The first version of this script split the JSON with
# awk, which silently corrupts a filename containing a comma and cannot see a duplicated key; python3 is
# already a declared dependency of `scripts/qualify-install.sh` in these same jobs, so it costs nothing
# and parses the real grammar. The entry count is asserted rather than assumed: if the pinned content
# index changes, this script REFUSES rather than quietly seeding a smaller tree (AGENTS.md rule 11).
EXPECTED_ENTRIES=169
ENTRIES_FILE="$TARGET/.content-index.tsv"
python3 - "$CONTENT_ROOT/index.json" "$EXPECTED_ENTRIES" > "$ENTRIES_FILE" <<'PYEOF'
import json, sys
index_path, expected = sys.argv[1], int(sys.argv[2])
with open(index_path, "r", encoding="utf-8") as handle:
    entries = json.load(handle)
if not isinstance(entries, list):
    sys.exit("FAIL: default/content/index.json is not a list")
if len(entries) != expected:
    sys.exit(f"FAIL: expected {expected} content entries, found {len(entries)}; update EXPECTED_ENTRIES "
             "and this script's header together, after checking the pinned tree really changed")
for entry in entries:
    filename, kind = entry.get("filename"), entry.get("type")
    if not isinstance(filename, str) or not isinstance(kind, str):
        sys.exit(f"FAIL: content entry without a string filename/type: {entry!r}")
    print(f"{filename}\t{kind}")
PYEOF

# NO SUBSHELL. `printf ... | while read` would run the loop in a pipeline subshell, where `exit 1`
# ends only that subshell -- the script would print a FAIL and then carry on to report success. The
# entries are read from a file instead, so every failure below exits the script itself.
while IFS="$(printf '\t')" read -r filename type; do
    [ -n "$filename" ] || continue
    target_dir=$(content_target_for_type "$type")
    if [ -z "$target_dir" ]; then
        echo "FAIL: content type '$type' (file '$filename') has no pinned target directory." >&2
        echo "      Add its row from src/endpoints/content-manager.js getUserTargetByType." >&2
        exit 1
    fi
    source_path="$CONTENT_ROOT/$filename"
    if [ ! -e "$source_path" ]; then
        echo "FAIL: content index names '$filename' but the pinned tree does not contain it." >&2
        exit 1
    fi
    mkdir -p "$target_dir"
    # `cp -R` because `sprites` is a DIRECTORY entry (default/content/Seraphina) and the pinned
    # seedContent uses fs.cpSync(..., {recursive:true}).
    cp -R "$source_path" "$target_dir/$(basename "$filename")"
done < "$ENTRIES_FILE"
rm -f "$ENTRIES_FILE"

# --- 4. the directory skeleton a used installation has ----------------------------------------
# Names from USER_DIRECTORY_TEMPLATE (src/constants.js:15-46). Empty on purpose: their EXISTENCE is
# what a real tree has, and a missing directory is a startup mutation the job would otherwise not see.
for dir in groups "group chats" chats thumbnails thumbnails/bg thumbnails/avatar thumbnails/persona \
           user user/files user/images assets vectors extensions backups instruct context sysprompt \
           reasoning movingUI QuickReplies; do
    mkdir -p "$TARGET/$USER_ROOT/$dir"
done
mkdir -p "$TARGET/plugins"
: > "$TARGET/plugins/.gitkeep"

# --- 5. one chat, synthetic and labelled ------------------------------------------------------
# A real chat is user data; none is copied from anywhere. The FORMAT is the pinned JSONL shape the
# pinned server reads and writes (header line, then one line per message), and the content is two
# invented lines that cannot be mistaken for a real conversation. The header carries
# `synthetic: true` so a reader of the fixture is told, and so an assertion can prove the API
# returned THIS file rather than any other.
CHAT_DIR="$TARGET/$USER_ROOT/chats/default_Seraphina"
mkdir -p "$CHAT_DIR"
cat > "$CHAT_DIR/dropin-smoke.jsonl" <<'CHAT_EOF'
{"user_name":"User","character_name":"Seraphina","create_date":"2026-10-25T00:00:00.000Z","chat_metadata":{"synthetic":true,"note":"GoTavern stock-tree fixture; both messages are invented"}}
{"name":"User","is_user":true,"is_system":false,"send_date":"2026-10-25T00:00:01.000Z","mes":"Hello from the stock-tree fixture.","extra":{}}
{"name":"Seraphina","is_user":false,"is_system":false,"send_date":"2026-10-25T00:00:02.000Z","mes":"This reply exists only so the chat has more than one line.","extra":{}}
CHAT_EOF

# --- 6. secrets: the current SHAPE, with no secrets -------------------------------------------
# An empty object is the state of a tree where no provider key was ever configured. Written
# explicitly (rather than left absent) so the file's presence and shape are part of the fixture and
# so "no secrets" is a property this script can print. No key, token or password exists in it.
printf '{}\n' > "$TARGET/$USER_ROOT/secrets.json"

# --- 7. a real extension repository -----------------------------------------------------------
# AGENTS.md 34.3 requires "a recursive hash and a `git status` per repository, taken before and after
# boot". An empty directory cannot be dirtied, so this one is a real repository with a real commit.
EXT_DIR="$TARGET/public/scripts/extensions/third-party/stock-example-extension"
mkdir -p "$EXT_DIR"
cat > "$EXT_DIR/manifest.json" <<'MANIFEST_EOF'
{
    "display_name": "Stock Example Extension",
    "loading_order": 100,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "author": "GoTavern fixture",
    "version": "1.0.0",
    "homePage": "https://example.invalid/stock-example-extension"
}
MANIFEST_EOF
cat > "$EXT_DIR/index.js" <<'EXT_EOF'
// Fixture extension: present so the drop-in job can prove boot neither mutates nor updates an
// installed extension. It intentionally does nothing.
export function onInstall() {}
export function onEnable() {}
export function onDisable() {}
EXT_EOF
printf '# Stock Example Extension\n\nA fixture extension used only by the drop-in qualification job.\n' > "$EXT_DIR/README.md"
(
    cd "$EXT_DIR"
    git init --quiet
    git config user.name "GoTavern fixture"
    git config user.email "fixture@example.invalid"
    git add -A
    git -c commit.gpgsign=false commit --quiet -m "fixture extension: initial commit"
)

# --- 8. report what was built, so the log proves the fixture --------------------------------
# PRINTED, NOT WRITTEN INTO THE TREE. A manifest file inside the tree would be one more file the runtime
# sees, and the job asserts the tree is a stock one; the caller tees this to wherever it wants.
PINNED_COMMIT=$(printf '%s' "$(cat "$UPSTREAM/SILLYTAVERN_COMMIT")" | tr -d '[:space:]')
echo "stock tree built from pinned baseline $PINNED_COMMIT"
echo "target: $TARGET"
for area in public default src/tokenizers data data/default-user data/default-user/characters \
            data/default-user/chats data/default-user/worlds data/default-user/themes \
            data/default-user/backgrounds "data/default-user/OpenAI Settings" \
            public/scripts/extensions/third-party; do
    files=$(find "$TARGET/$area" -type f 2>/dev/null | wc -l)
    echo "  $area: $files files"
done
echo "  secrets.json: $(wc -c < "$TARGET/$USER_ROOT/secrets.json") bytes, no secrets by construction"
echo "  extensions that are git repositories: $(find "$TARGET/public/scripts/extensions/third-party" -name .git -maxdepth 2 -type d | wc -l)"
