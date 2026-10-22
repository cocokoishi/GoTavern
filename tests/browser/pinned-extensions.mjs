// The pinned extension revisions, in one place.
//
// AGENTS.md hard rule 15 names these revisions and requires them verbatim, so the
// probe and the installer must not each hold their own copy: a typo in one of two
// literals would produce a leg recorded against a revision nobody pinned.
//
// `name` is the directory the extension is installed as, which is what the pinned
// install route derives from the repository URL (sanitize(path.basename(pathname,
// '.git'))), so an installed tree looks exactly like one a user installed.

export const PINNED_EXTENSIONS = {
    'tavern-helper': {
        label: 'Tavern Helper / JS-Slash-Runner',
        name: 'JS-Slash-Runner',
        repo: 'https://github.com/N0VI028/JS-Slash-Runner.git',
        commit: '837a6288135cde61522a9279173b98020f08807e',
    },
    littlewhitebox: {
        label: 'LittleWhiteBox',
        name: 'LittleWhiteBox',
        repo: 'https://github.com/RT15548/LittleWhiteBox.git',
        commit: '9e71caef9ba7b3ca324ce9f1cb06a69ff54d734b',
    },
};

export function pinnedExtension(key) {
    const extension = PINNED_EXTENSIONS[key];
    if (!extension) {
        throw new Error(`unknown pinned extension ${key}; known: ${Object.keys(PINNED_EXTENSIONS).join(', ')}`);
    }
    return extension;
}
