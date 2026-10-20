#!/usr/bin/env node
// Build SillyTavern's generated frontend library in an isolated temporary clone.
// The supplied upstream checkout is only read; all npm and Webpack writes stay
// outside it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamRoot = path.resolve(process.argv[2] ?? '');

if (!process.argv[2]) {
    console.error('usage: node tools/build-generated-lib.mjs <pinned-SillyTavern-checkout>');
    process.exit(2);
}

function run(command, args, cwd, options = {}) {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit', ...options });
}

function runNpm(args, cwd, options = {}) {
    if (process.platform === 'win32') {
        const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (!existsSync(npmCli)) throw new Error(`npm CLI not found beside Node.js: ${npmCli}`);
        return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: 'inherit', ...options });
    }
    return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: 'inherit', ...options });
}

function changedJSONPaths(left, right, location = '$', output = []) {
    if (Object.is(left, right) || output.length >= 40) return output;
    if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length) output.push(`${location}.length`);
        for (let index = 0; index < Math.min(left.length, right.length); index++) {
            changedJSONPaths(left[index], right[index], `${location}[${index}]`, output);
        }
        return output;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
        const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
        for (const key of keys) {
            if (!(key in left) || !(key in right)) output.push(`${location}.${key}`);
            else changedJSONPaths(left[key], right[key], `${location}.${key}`, output);
            if (output.length >= 40) break;
        }
        return output;
    }
    output.push(location);
    return output;
}

function generatedManifest(directory) {
    const entries = [];
    function visit(current, prefix = '') {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                visit(absolute, relative);
            } else if (entry.isFile()) {
                const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
                entries.push({ path: relative, digest });
            } else {
                throw new Error(`unsupported generated asset type: ${absolute}`);
            }
        }
    }
    visit(directory);
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return `${entries.map(entry => `${entry.digest}  ${entry.path}`).join('\n')}\n`;
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstreamRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);
}

const dirty = execFileSync('git', ['status', '--porcelain', '--', 'public', 'src/public/lib.js', 'webpack.config.js', 'package.json', 'package-lock.json'], {
    cwd: upstreamRoot,
    encoding: 'utf8',
});
if (dirty.trim()) {
    throw new Error('upstream build inputs have local changes; refusing to build from a modified oracle');
}

// The pinned checkout must have LF line endings. `git status` cannot detect a
// CRLF checkout when core.autocrlf is true, because git converts on read and
// reports the tree as clean, yet every recorded response body and every seeded
// default file then carries an extra CR per line. That is how the vendored
// upstream/** assets drifted from the pinned blobs: the assets were committed
// from a CRLF checkout, so their manifests were self-consistent with the wrong
// bytes. Fail loudly rather than record host-converted observations again.
for (const relative of [
    'public/index.html',
    'public/login.html',
    'public/script.js',
    'default/config.yaml',
    'default/content/presets/kobold/Deterministic.json',
]) {
    const candidate = path.join(upstreamRoot, relative);
    if (!existsSync(candidate)) continue;
    if (readFileSync(candidate).includes(13)) {
        throw new Error(
            `pinned checkout ${relative} contains CR; re-check out the oracle with core.autocrlf=false `
            + '(for example: git -c core.autocrlf=false checkout-index -a -f) before recording fixtures');
    }
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-upstream-webpack-'));
const buildRoot = path.join(tempRoot, 'source');
const outputPath = path.join(repositoryRoot, 'upstream', 'generated', 'lib.js');

try {
    run('git', ['clone', '--shared', '--no-checkout', upstreamRoot, buildRoot], repositoryRoot);
    // Give the isolated runtime probe a stable branch name. The checkout is
    // still pinned to the exact commit, but /version's branch field is now a
    // real and reproducible observation instead of a machine-dependent value.
    run('git', ['checkout', '--force', '-B', 'release', PINNED_COMMIT], buildRoot);
    runNpm(['ci', '--no-audit', '--no-fund'], buildRoot);

    const userStoreProbe = path.join(buildRoot, '.gotavern-probe-user-store-roundtrip.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-user-store-roundtrip.mjs'), userStoreProbe);
    const userStoreFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-user-storage-roundtrip.json');
    run(process.execPath, [userStoreProbe, buildRoot, repositoryRoot], buildRoot);
    const firstUserStoreProbe = readFileSync(userStoreFixturePath);
    run(process.execPath, [userStoreProbe, buildRoot, repositoryRoot], buildRoot);
    const secondUserStoreProbe = readFileSync(userStoreFixturePath);
    if (!firstUserStoreProbe.equals(secondUserStoreProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstUserStoreProbe), JSON.parse(secondUserStoreProbe));
        throw new Error(`user-store round-trip oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const cookieSecretProbe = path.join(buildRoot, '.gotavern-probe-cookie-secret.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-cookie-secret.mjs'), cookieSecretProbe);
    const cookieSecretFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-cookie-secret.json');
    run(process.execPath, [cookieSecretProbe, buildRoot, repositoryRoot], buildRoot);
    const firstCookieSecretProbe = readFileSync(cookieSecretFixturePath);
    run(process.execPath, [cookieSecretProbe, buildRoot, repositoryRoot], buildRoot);
    const secondCookieSecretProbe = readFileSync(cookieSecretFixturePath);
    if (!firstCookieSecretProbe.equals(secondCookieSecretProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstCookieSecretProbe), JSON.parse(secondCookieSecretProbe));
        throw new Error(`cookie-secret oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const csrfSessionProbe = path.join(buildRoot, '.gotavern-probe-csrf-session.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-csrf-session.mjs'), csrfSessionProbe);
    const csrfSessionFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-csrf-session.json');
    run(process.execPath, [csrfSessionProbe, buildRoot, repositoryRoot], buildRoot);
    const firstCsrfSessionProbe = readFileSync(csrfSessionFixturePath);
    run(process.execPath, [csrfSessionProbe, buildRoot, repositoryRoot], buildRoot);
    const secondCsrfSessionProbe = readFileSync(csrfSessionFixturePath);
    if (!firstCsrfSessionProbe.equals(secondCsrfSessionProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstCsrfSessionProbe), JSON.parse(secondCsrfSessionProbe));
        throw new Error(`CSRF session oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }
    const disabledCsrfFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-csrf-disabled.json');
    run(process.execPath, [csrfSessionProbe, buildRoot, repositoryRoot, 'disabled'], buildRoot);
    const firstDisabledCsrfProbe = readFileSync(disabledCsrfFixturePath);
    run(process.execPath, [csrfSessionProbe, buildRoot, repositoryRoot, 'disabled'], buildRoot);
    const secondDisabledCsrfProbe = readFileSync(disabledCsrfFixturePath);
    if (!firstDisabledCsrfProbe.equals(secondDisabledCsrfProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstDisabledCsrfProbe), JSON.parse(secondDisabledCsrfProbe));
        throw new Error(`disabled CSRF oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountSessionProbe = path.join(buildRoot, '.gotavern-probe-account-session.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-session.mjs'), accountSessionProbe);
    const accountSessionFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-session.json');
    run(process.execPath, [accountSessionProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountSessionProbe = readFileSync(accountSessionFixturePath);
    run(process.execPath, [accountSessionProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountSessionProbe = readFileSync(accountSessionFixturePath);
    if (!firstAccountSessionProbe.equals(secondAccountSessionProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountSessionProbe), JSON.parse(secondAccountSessionProbe));
        throw new Error(`account session oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountRecoveryProbe = path.join(buildRoot, '.gotavern-probe-account-recovery.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-recovery.mjs'), accountRecoveryProbe);
    const accountRecoveryFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-recovery.json');
    run(process.execPath, [accountRecoveryProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountRecoveryProbe = readFileSync(accountRecoveryFixturePath);
    run(process.execPath, [accountRecoveryProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountRecoveryProbe = readFileSync(accountRecoveryFixturePath);
    if (!firstAccountRecoveryProbe.equals(secondAccountRecoveryProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountRecoveryProbe), JSON.parse(secondAccountRecoveryProbe));
        throw new Error(`account recovery oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountPrivateProbe = path.join(buildRoot, '.gotavern-probe-account-private.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-private.mjs'), accountPrivateProbe);
    const accountPrivateFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-private.json');
    run(process.execPath, [accountPrivateProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountPrivateProbe = readFileSync(accountPrivateFixturePath);
    run(process.execPath, [accountPrivateProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountPrivateProbe = readFileSync(accountPrivateFixturePath);
    if (!firstAccountPrivateProbe.equals(secondAccountPrivateProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountPrivateProbe), JSON.parse(secondAccountPrivateProbe));
        throw new Error(`account-private oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountMutationsProbe = path.join(buildRoot, '.gotavern-probe-account-mutations.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-mutations.mjs'), accountMutationsProbe);
    const accountMutationsFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-mutations.json');
    run(process.execPath, [accountMutationsProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountMutationsProbe = readFileSync(accountMutationsFixturePath);
    run(process.execPath, [accountMutationsProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountMutationsProbe = readFileSync(accountMutationsFixturePath);
    if (!firstAccountMutationsProbe.equals(secondAccountMutationsProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountMutationsProbe), JSON.parse(secondAccountMutationsProbe));
        throw new Error(`account-mutations oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountAdminProbe = path.join(buildRoot, '.gotavern-probe-account-admin.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-admin.mjs'), accountAdminProbe);
    const accountAdminFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-admin.json');
    run(process.execPath, [accountAdminProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountAdminProbe = readFileSync(accountAdminFixturePath);
    run(process.execPath, [accountAdminProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountAdminProbe = readFileSync(accountAdminFixturePath);
    if (!firstAccountAdminProbe.equals(secondAccountAdminProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountAdminProbe), JSON.parse(secondAccountAdminProbe));
        throw new Error(`account-admin oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountCreateProbe = path.join(buildRoot, '.gotavern-probe-account-create.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-create.mjs'), accountCreateProbe);
    const accountCreateFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-create.json');
    run(process.execPath, [accountCreateProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountCreateProbe = readFileSync(accountCreateFixturePath);
    run(process.execPath, [accountCreateProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountCreateProbe = readFileSync(accountCreateFixturePath);
    if (!firstAccountCreateProbe.equals(secondAccountCreateProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountCreateProbe), JSON.parse(secondAccountCreateProbe));
        throw new Error(`account-create oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountResetSettingsProbe = path.join(buildRoot, '.gotavern-probe-account-reset-settings.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-reset-settings.mjs'), accountResetSettingsProbe);
    const accountResetSettingsFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-reset-settings.json');
    run(process.execPath, [accountResetSettingsProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountResetSettingsProbe = readFileSync(accountResetSettingsFixturePath);
    run(process.execPath, [accountResetSettingsProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountResetSettingsProbe = readFileSync(accountResetSettingsFixturePath);
    if (!firstAccountResetSettingsProbe.equals(secondAccountResetSettingsProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountResetSettingsProbe), JSON.parse(secondAccountResetSettingsProbe));
        throw new Error(`account-reset-settings oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountDataResetProbe = path.join(buildRoot, '.gotavern-probe-account-data-reset.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-data-reset.mjs'), accountDataResetProbe);
    const accountDataResetFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-data-reset.json');
    run(process.execPath, [accountDataResetProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountDataResetProbe = readFileSync(accountDataResetFixturePath);
    run(process.execPath, [accountDataResetProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountDataResetProbe = readFileSync(accountDataResetFixturePath);
    if (!firstAccountDataResetProbe.equals(secondAccountDataResetProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountDataResetProbe), JSON.parse(secondAccountDataResetProbe));
        throw new Error(`account-data-reset oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accountBackupProbe = path.join(buildRoot, '.gotavern-probe-account-backup.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-account-backup.mjs'), accountBackupProbe);
    const accountBackupFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-backup.json');
    run(process.execPath, [accountBackupProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccountBackupProbe = readFileSync(accountBackupFixturePath);
    run(process.execPath, [accountBackupProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccountBackupProbe = readFileSync(accountBackupFixturePath);
    if (!firstAccountBackupProbe.equals(secondAccountBackupProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccountBackupProbe), JSON.parse(secondAccountBackupProbe));
        throw new Error(`account-backup oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const systemPromptProbe = path.join(buildRoot, '.gotavern-probe-system-prompt-migration.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-system-prompt-migration.mjs'), systemPromptProbe);
    const systemPromptFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-system-prompt-migration.json');
    run(process.execPath, [systemPromptProbe, buildRoot, repositoryRoot], buildRoot);
    const firstSystemPromptProbe = readFileSync(systemPromptFixturePath);
    run(process.execPath, [systemPromptProbe, buildRoot, repositoryRoot], buildRoot);
    const secondSystemPromptProbe = readFileSync(systemPromptFixturePath);
    if (!firstSystemPromptProbe.equals(secondSystemPromptProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstSystemPromptProbe), JSON.parse(secondSystemPromptProbe));
        throw new Error(`system-prompt migration oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const userDataMigrationProbe = path.join(buildRoot, '.gotavern-probe-user-data-migration.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-user-data-migration.mjs'), userDataMigrationProbe);
    const userDataMigrationFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-user-data-migration.json');
    run(process.execPath, [userDataMigrationProbe, buildRoot, repositoryRoot], buildRoot);
    const firstUserDataMigrationProbe = readFileSync(userDataMigrationFixturePath);
    run(process.execPath, [userDataMigrationProbe, buildRoot, repositoryRoot], buildRoot);
    const secondUserDataMigrationProbe = readFileSync(userDataMigrationFixturePath);
    if (!firstUserDataMigrationProbe.equals(secondUserDataMigrationProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstUserDataMigrationProbe), JSON.parse(secondUserDataMigrationProbe));
        throw new Error(`user-data migration oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const publicOverridesProbe = path.join(buildRoot, '.gotavern-probe-public-overrides-migration.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-public-overrides-migration.mjs'), publicOverridesProbe);
    const publicOverridesFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-public-overrides-migration.json');
    run(process.execPath, [publicOverridesProbe, buildRoot, repositoryRoot], buildRoot);
    const firstPublicOverridesProbe = readFileSync(publicOverridesFixturePath);
    run(process.execPath, [publicOverridesProbe, buildRoot, repositoryRoot], buildRoot);
    const secondPublicOverridesProbe = readFileSync(publicOverridesFixturePath);
    if (!firstPublicOverridesProbe.equals(secondPublicOverridesProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstPublicOverridesProbe), JSON.parse(secondPublicOverridesProbe));
        throw new Error(`public-overrides migration oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const securitySettingsProbe = path.join(buildRoot, '.gotavern-probe-security-settings.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-security-settings.mjs'), securitySettingsProbe);
    const securitySettingsFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-security-settings.json');
    run(process.execPath, [securitySettingsProbe, buildRoot, repositoryRoot], buildRoot);
    const firstSecuritySettingsProbe = readFileSync(securitySettingsFixturePath);
    run(process.execPath, [securitySettingsProbe, buildRoot, repositoryRoot], buildRoot);
    const secondSecuritySettingsProbe = readFileSync(securitySettingsFixturePath);
    if (!firstSecuritySettingsProbe.equals(secondSecuritySettingsProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstSecuritySettingsProbe), JSON.parse(secondSecuritySettingsProbe));
        throw new Error(`security-settings oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const groupMetadataProbe = path.join(buildRoot, '.gotavern-probe-group-metadata-migration.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-group-metadata-migration.mjs'), groupMetadataProbe);
    const groupMetadataFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-group-metadata-migration.json');
    run(process.execPath, [groupMetadataProbe, buildRoot, repositoryRoot], buildRoot);
    const firstGroupMetadataProbe = readFileSync(groupMetadataFixturePath);
    run(process.execPath, [groupMetadataProbe, buildRoot, repositoryRoot], buildRoot);
    const secondGroupMetadataProbe = readFileSync(groupMetadataFixturePath);
    if (!firstGroupMetadataProbe.equals(secondGroupMetadataProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstGroupMetadataProbe), JSON.parse(secondGroupMetadataProbe));
        throw new Error(`group-metadata migration oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const characterDiskCacheProbe = path.join(buildRoot, '.gotavern-probe-character-disk-cache.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-character-disk-cache.mjs'), characterDiskCacheProbe);
    const characterDiskCacheFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-character-disk-cache.json');
    run(process.execPath, [characterDiskCacheProbe, buildRoot, repositoryRoot], buildRoot);
    const firstCharacterDiskCacheProbe = readFileSync(characterDiskCacheFixturePath);
    run(process.execPath, [characterDiskCacheProbe, buildRoot, repositoryRoot], buildRoot);
    const secondCharacterDiskCacheProbe = readFileSync(characterDiskCacheFixturePath);
    if (!firstCharacterDiskCacheProbe.equals(secondCharacterDiskCacheProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstCharacterDiskCacheProbe), JSON.parse(secondCharacterDiskCacheProbe));
        throw new Error(`character disk-cache oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const flatSecretsProbe = path.join(buildRoot, '.gotavern-probe-flat-secrets.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-flat-secrets.mjs'), flatSecretsProbe);
    const flatSecretsFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-flat-secrets.json');
    run(process.execPath, [flatSecretsProbe, buildRoot, repositoryRoot], buildRoot);
    const firstFlatSecretsProbe = readFileSync(flatSecretsFixturePath);
    run(process.execPath, [flatSecretsProbe, buildRoot, repositoryRoot], buildRoot);
    const secondFlatSecretsProbe = readFileSync(flatSecretsFixturePath);
    if (!firstFlatSecretsProbe.equals(secondFlatSecretsProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstFlatSecretsProbe), JSON.parse(secondFlatSecretsProbe));
        throw new Error(`flat-secrets oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const uploadCleanupProbe = path.join(buildRoot, '.gotavern-probe-upload-cleanup.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-upload-cleanup.mjs'), uploadCleanupProbe);
    const uploadCleanupFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-upload-cleanup.json');
    run(process.execPath, [uploadCleanupProbe, buildRoot, repositoryRoot], buildRoot);
    const firstUploadCleanupProbe = readFileSync(uploadCleanupFixturePath);
    run(process.execPath, [uploadCleanupProbe, buildRoot, repositoryRoot], buildRoot);
    const secondUploadCleanupProbe = readFileSync(uploadCleanupFixturePath);
    if (!firstUploadCleanupProbe.equals(secondUploadCleanupProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstUploadCleanupProbe), JSON.parse(secondUploadCleanupProbe));
        throw new Error(`upload-cleanup oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const accessLogProbe = path.join(buildRoot, '.gotavern-probe-access-log-migration.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-access-log-migration.mjs'), accessLogProbe);
    const accessLogFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-access-log-migration.json');
    run(process.execPath, [accessLogProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAccessLogProbe = readFileSync(accessLogFixturePath);
    run(process.execPath, [accessLogProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAccessLogProbe = readFileSync(accessLogFixturePath);
    if (!firstAccessLogProbe.equals(secondAccessLogProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAccessLogProbe), JSON.parse(secondAccessLogProbe));
        throw new Error(`access-log migration oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const settingsBackupProbe = path.join(buildRoot, '.gotavern-probe-settings-backup.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-settings-backup.mjs'), settingsBackupProbe);
    const settingsBackupFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-settings-backup.json');
    run(process.execPath, [settingsBackupProbe, buildRoot, repositoryRoot], buildRoot);
    const firstSettingsBackupProbe = readFileSync(settingsBackupFixturePath);
    run(process.execPath, [settingsBackupProbe, buildRoot, repositoryRoot], buildRoot);
    const secondSettingsBackupProbe = readFileSync(settingsBackupFixturePath);
    if (!firstSettingsBackupProbe.equals(secondSettingsBackupProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstSettingsBackupProbe), JSON.parse(secondSettingsBackupProbe));
        throw new Error(`settings-backup oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const settingsSnapshotsProbe = path.join(buildRoot, '.gotavern-probe-settings-snapshots.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-settings-snapshots.mjs'), settingsSnapshotsProbe);
    const settingsSnapshotsFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-settings-snapshots.json');
    run(process.execPath, [settingsSnapshotsProbe, buildRoot, repositoryRoot], buildRoot);
    const firstSettingsSnapshotsProbe = readFileSync(settingsSnapshotsFixturePath);
    run(process.execPath, [settingsSnapshotsProbe, buildRoot, repositoryRoot], buildRoot);
    const secondSettingsSnapshotsProbe = readFileSync(settingsSnapshotsFixturePath);
    if (!firstSettingsSnapshotsProbe.equals(secondSettingsSnapshotsProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstSettingsSnapshotsProbe), JSON.parse(secondSettingsSnapshotsProbe));
        throw new Error(`settings-snapshots oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const settingsGetProbe = path.join(buildRoot, '.gotavern-probe-settings-get.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-settings-get.mjs'), settingsGetProbe);
    const settingsGetFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-settings-get.json');
    run(process.execPath, [settingsGetProbe, buildRoot, repositoryRoot], buildRoot);
    const firstSettingsGetProbe = readFileSync(settingsGetFixturePath);
    run(process.execPath, [settingsGetProbe, buildRoot, repositoryRoot], buildRoot);
    const secondSettingsGetProbe = readFileSync(settingsGetFixturePath);
    if (!firstSettingsGetProbe.equals(secondSettingsGetProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstSettingsGetProbe), JSON.parse(secondSettingsGetProbe));
        throw new Error(`settings-get oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const settingsSaveProbe = path.join(buildRoot, '.gotavern-probe-settings-save.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-settings-save.mjs'), settingsSaveProbe);
    const settingsSaveFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-settings-save.json');
    run(process.execPath, [settingsSaveProbe, buildRoot, repositoryRoot], buildRoot);
    const firstSettingsSaveProbe = readFileSync(settingsSaveFixturePath);
    run(process.execPath, [settingsSaveProbe, buildRoot, repositoryRoot], buildRoot);
    const secondSettingsSaveProbe = readFileSync(settingsSaveFixturePath);
    if (!firstSettingsSaveProbe.equals(secondSettingsSaveProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstSettingsSaveProbe), JSON.parse(secondSettingsSaveProbe));
        throw new Error(`settings-save oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const quickRepliesProbe = path.join(buildRoot, '.gotavern-probe-quick-replies.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-quick-replies.mjs'), quickRepliesProbe);
    const quickRepliesFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-quick-replies.json');
    run(process.execPath, [quickRepliesProbe, buildRoot, repositoryRoot], buildRoot);
    const firstQuickRepliesProbe = readFileSync(quickRepliesFixturePath);
    run(process.execPath, [quickRepliesProbe, buildRoot, repositoryRoot], buildRoot);
    const secondQuickRepliesProbe = readFileSync(quickRepliesFixturePath);
    if (!firstQuickRepliesProbe.equals(secondQuickRepliesProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstQuickRepliesProbe), JSON.parse(secondQuickRepliesProbe));
        throw new Error(`Quick Replies oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const themesProbe = path.join(buildRoot, '.gotavern-probe-themes.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-themes.mjs'), themesProbe);
    const themesFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-themes.json');
    run(process.execPath, [themesProbe, buildRoot, repositoryRoot], buildRoot);
    const firstThemesProbe = readFileSync(themesFixturePath);
    run(process.execPath, [themesProbe, buildRoot, repositoryRoot], buildRoot);
    const secondThemesProbe = readFileSync(themesFixturePath);
    if (!firstThemesProbe.equals(secondThemesProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstThemesProbe), JSON.parse(secondThemesProbe));
        throw new Error('theme oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const movingUIProbe = path.join(buildRoot, '.gotavern-probe-moving-ui.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-moving-ui.mjs'), movingUIProbe);
    const movingUIFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-moving-ui.json');
    run(process.execPath, [movingUIProbe, buildRoot, repositoryRoot], buildRoot);
    const firstMovingUIProbe = readFileSync(movingUIFixturePath);
    run(process.execPath, [movingUIProbe, buildRoot, repositoryRoot], buildRoot);
    const secondMovingUIProbe = readFileSync(movingUIFixturePath);
    if (!firstMovingUIProbe.equals(secondMovingUIProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstMovingUIProbe), JSON.parse(secondMovingUIProbe));
        throw new Error('moving UI preset oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const avatarsGetProbe = path.join(buildRoot, '.gotavern-probe-avatars-get.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-avatars-get.mjs'), avatarsGetProbe);
    const avatarsGetFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-avatars-get.json');
    run(process.execPath, [avatarsGetProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAvatarsGetProbe = readFileSync(avatarsGetFixturePath);
    run(process.execPath, [avatarsGetProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAvatarsGetProbe = readFileSync(avatarsGetFixturePath);
    if (!firstAvatarsGetProbe.equals(secondAvatarsGetProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAvatarsGetProbe), JSON.parse(secondAvatarsGetProbe));
        throw new Error('avatar-list oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const avatarsDeleteProbe = path.join(buildRoot, '.gotavern-probe-avatars-delete.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-avatars-delete.mjs'), avatarsDeleteProbe);
    const avatarsDeleteFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-avatars-delete.json');
    run(process.execPath, [avatarsDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const firstAvatarsDeleteProbe = readFileSync(avatarsDeleteFixturePath);
    run(process.execPath, [avatarsDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const secondAvatarsDeleteProbe = readFileSync(avatarsDeleteFixturePath);
    if (!firstAvatarsDeleteProbe.equals(secondAvatarsDeleteProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstAvatarsDeleteProbe), JSON.parse(secondAvatarsDeleteProbe));
        throw new Error('avatar-delete oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const spritesGetProbe = path.join(buildRoot, '.gotavern-probe-sprites-get.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-sprites-get.mjs'), spritesGetProbe);
    const spritesGetFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-sprites-get.json');
    run(process.execPath, [spritesGetProbe, buildRoot, repositoryRoot], buildRoot);
    const firstSpritesGetProbe = readFileSync(spritesGetFixturePath);
    run(process.execPath, [spritesGetProbe, buildRoot, repositoryRoot], buildRoot);
    const secondSpritesGetProbe = readFileSync(spritesGetFixturePath);
    if (!firstSpritesGetProbe.equals(secondSpritesGetProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstSpritesGetProbe), JSON.parse(secondSpritesGetProbe));
        throw new Error('sprite-list oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const imageMetadataIndexProbe = path.join(buildRoot, '.gotavern-probe-image-metadata-index-reads.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-image-metadata-index-reads.mjs'), imageMetadataIndexProbe);
    const imageMetadataIndexFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-index-reads.json');
    run(process.execPath, [imageMetadataIndexProbe, buildRoot, repositoryRoot], buildRoot);
    const firstImageMetadataIndexProbe = readFileSync(imageMetadataIndexFixturePath);
    run(process.execPath, [imageMetadataIndexProbe, buildRoot, repositoryRoot], buildRoot);
    const secondImageMetadataIndexProbe = readFileSync(imageMetadataIndexFixturePath);
    if (!firstImageMetadataIndexProbe.equals(secondImageMetadataIndexProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstImageMetadataIndexProbe), JSON.parse(secondImageMetadataIndexProbe));
        throw new Error('image-metadata index oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const imageMetadataFolderCreateProbe = path.join(buildRoot, '.gotavern-probe-image-metadata-folder-create.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-image-metadata-folder-create.mjs'), imageMetadataFolderCreateProbe);
    const imageMetadataFolderCreateFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-folder-create.json');
    run(process.execPath, [imageMetadataFolderCreateProbe, buildRoot, repositoryRoot], buildRoot);
    const firstImageMetadataFolderCreateProbe = readFileSync(imageMetadataFolderCreateFixturePath);
    run(process.execPath, [imageMetadataFolderCreateProbe, buildRoot, repositoryRoot], buildRoot);
    const secondImageMetadataFolderCreateProbe = readFileSync(imageMetadataFolderCreateFixturePath);
    if (!firstImageMetadataFolderCreateProbe.equals(secondImageMetadataFolderCreateProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstImageMetadataFolderCreateProbe), JSON.parse(secondImageMetadataFolderCreateProbe));
        throw new Error('image-metadata folder-create oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const imageMetadataSetThumbnailsProbe = path.join(buildRoot, '.gotavern-probe-image-metadata-set-thumbnails.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-image-metadata-set-thumbnails.mjs'), imageMetadataSetThumbnailsProbe);
    const imageMetadataSetThumbnailsFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-set-thumbnails.json');
    run(process.execPath, [imageMetadataSetThumbnailsProbe, buildRoot, repositoryRoot], buildRoot);
    const firstImageMetadataSetThumbnailsProbe = readFileSync(imageMetadataSetThumbnailsFixturePath);
    run(process.execPath, [imageMetadataSetThumbnailsProbe, buildRoot, repositoryRoot], buildRoot);
    const secondImageMetadataSetThumbnailsProbe = readFileSync(imageMetadataSetThumbnailsFixturePath);
    if (!firstImageMetadataSetThumbnailsProbe.equals(secondImageMetadataSetThumbnailsProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstImageMetadataSetThumbnailsProbe), JSON.parse(secondImageMetadataSetThumbnailsProbe));
        throw new Error('image-metadata set-thumbnails oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const imageMetadataFolderUpdateProbe = path.join(buildRoot, '.gotavern-probe-image-metadata-folder-update.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-image-metadata-folder-update.mjs'), imageMetadataFolderUpdateProbe);
    const imageMetadataFolderUpdateFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-folder-update.json');
    run(process.execPath, [imageMetadataFolderUpdateProbe, buildRoot, repositoryRoot], buildRoot);
    const firstImageMetadataFolderUpdateProbe = readFileSync(imageMetadataFolderUpdateFixturePath);
    run(process.execPath, [imageMetadataFolderUpdateProbe, buildRoot, repositoryRoot], buildRoot);
    const secondImageMetadataFolderUpdateProbe = readFileSync(imageMetadataFolderUpdateFixturePath);
    if (!firstImageMetadataFolderUpdateProbe.equals(secondImageMetadataFolderUpdateProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstImageMetadataFolderUpdateProbe), JSON.parse(secondImageMetadataFolderUpdateProbe));
        throw new Error('image-metadata folder-update oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const imageMetadataFolderDeleteProbe = path.join(buildRoot, '.gotavern-probe-image-metadata-folder-delete.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-image-metadata-folder-delete.mjs'), imageMetadataFolderDeleteProbe);
    const imageMetadataFolderDeleteFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-folder-delete.json');
    run(process.execPath, [imageMetadataFolderDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const firstImageMetadataFolderDeleteProbe = readFileSync(imageMetadataFolderDeleteFixturePath);
    run(process.execPath, [imageMetadataFolderDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const secondImageMetadataFolderDeleteProbe = readFileSync(imageMetadataFolderDeleteFixturePath);
    if (!firstImageMetadataFolderDeleteProbe.equals(secondImageMetadataFolderDeleteProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstImageMetadataFolderDeleteProbe), JSON.parse(secondImageMetadataFolderDeleteProbe));
        throw new Error('image-metadata folder-delete oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const imageMetadataFolderAssignmentsProbe = path.join(buildRoot, '.gotavern-probe-image-metadata-folder-assignments.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-image-metadata-folder-assignments.mjs'), imageMetadataFolderAssignmentsProbe);
    const imageMetadataFolderAssignmentsFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-folder-assignments.json');
    run(process.execPath, [imageMetadataFolderAssignmentsProbe, buildRoot, repositoryRoot], buildRoot);
    const firstImageMetadataFolderAssignmentsProbe = readFileSync(imageMetadataFolderAssignmentsFixturePath);
    run(process.execPath, [imageMetadataFolderAssignmentsProbe, buildRoot, repositoryRoot], buildRoot);
    const secondImageMetadataFolderAssignmentsProbe = readFileSync(imageMetadataFolderAssignmentsFixturePath);
    if (!firstImageMetadataFolderAssignmentsProbe.equals(secondImageMetadataFolderAssignmentsProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstImageMetadataFolderAssignmentsProbe), JSON.parse(secondImageMetadataFolderAssignmentsProbe));
        throw new Error('image-metadata folder-assignments oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const imageMetadataCleanupProbe = path.join(buildRoot, '.gotavern-probe-image-metadata-cleanup.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-image-metadata-cleanup.mjs'), imageMetadataCleanupProbe);
    const imageMetadataCleanupFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-cleanup.json');
    run(process.execPath, [imageMetadataCleanupProbe, buildRoot, repositoryRoot], buildRoot);
    const firstImageMetadataCleanupProbe = readFileSync(imageMetadataCleanupFixturePath);
    run(process.execPath, [imageMetadataCleanupProbe, buildRoot, repositoryRoot], buildRoot);
    const secondImageMetadataCleanupProbe = readFileSync(imageMetadataCleanupFixturePath);
    if (!firstImageMetadataCleanupProbe.equals(secondImageMetadataCleanupProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstImageMetadataCleanupProbe), JSON.parse(secondImageMetadataCleanupProbe));
        throw new Error('image-metadata cleanup oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const imageMetadataGetProbe = path.join(buildRoot, '.gotavern-probe-image-metadata-get.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-image-metadata-get.mjs'), imageMetadataGetProbe);
    const imageMetadataGetFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-get.json');
    run(process.execPath, [imageMetadataGetProbe, buildRoot, repositoryRoot], buildRoot);
    const firstImageMetadataGetProbe = readFileSync(imageMetadataGetFixturePath);
    run(process.execPath, [imageMetadataGetProbe, buildRoot, repositoryRoot], buildRoot);
    const secondImageMetadataGetProbe = readFileSync(imageMetadataGetFixturePath);
    if (!firstImageMetadataGetProbe.equals(secondImageMetadataGetProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstImageMetadataGetProbe), JSON.parse(secondImageMetadataGetProbe));
        throw new Error('image-metadata get oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const corsMiddlewareProbe = path.join(buildRoot, '.gotavern-probe-cors-middleware.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-cors-middleware.mjs'), corsMiddlewareProbe);
    const corsMiddlewareFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-cors-middleware.json');
    run(process.execPath, [corsMiddlewareProbe, buildRoot, repositoryRoot], buildRoot);
    const firstCorsMiddlewareProbe = readFileSync(corsMiddlewareFixturePath);
    run(process.execPath, [corsMiddlewareProbe, buildRoot, repositoryRoot], buildRoot);
    const secondCorsMiddlewareProbe = readFileSync(corsMiddlewareFixturePath);
    if (!firstCorsMiddlewareProbe.equals(secondCorsMiddlewareProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstCorsMiddlewareProbe), JSON.parse(secondCorsMiddlewareProbe));
        throw new Error('CORS middleware oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const spritesDeleteProbe = path.join(buildRoot, '.gotavern-probe-sprites-delete.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-sprites-delete.mjs'), spritesDeleteProbe);
    const spritesDeleteFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-sprites-delete.json');
    run(process.execPath, [spritesDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const firstSpritesDeleteProbe = readFileSync(spritesDeleteFixturePath);
    run(process.execPath, [spritesDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const secondSpritesDeleteProbe = readFileSync(spritesDeleteFixturePath);
    if (!firstSpritesDeleteProbe.equals(secondSpritesDeleteProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstSpritesDeleteProbe), JSON.parse(secondSpritesDeleteProbe));
        throw new Error('sprite-delete oracle changed across identical pinned Node runs at: ' + paths.join(', '));
    }

    const charactersProbes = [
        ['probe-characters-read.mjs', 'sillytavern-1.19.0-characters-read.json', 'character read'],
        ['probe-characters-write.mjs', 'sillytavern-1.19.0-characters-write.json', 'character write'],
        ['probe-characters-import.mjs', 'sillytavern-1.19.0-characters-import.json', 'character import'],
    ];
    for (const [probeName, fixtureName, label] of charactersProbes) {
        const probePath = path.join(buildRoot, '.gotavern-' + probeName);
        copyFileSync(path.join(repositoryRoot, 'tools', probeName), probePath);
        const fixturePath = path.join(repositoryRoot, 'tests', 'oracle', fixtureName);
        run(process.execPath, [probePath, buildRoot, repositoryRoot], buildRoot);
        const firstRun = readFileSync(fixturePath);
        run(process.execPath, [probePath, buildRoot, repositoryRoot], buildRoot);
        const secondRun = readFileSync(fixturePath);
        if (!firstRun.equals(secondRun)) {
            const paths = changedJSONPaths(JSON.parse(firstRun), JSON.parse(secondRun));
            throw new Error(`${label} oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
        }
    }

    const statsInitProbe = path.join(buildRoot, '.gotavern-probe-stats-init.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-stats-init.mjs'), statsInitProbe);
    const statsInitFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-stats-init.json');
    run(process.execPath, [statsInitProbe, buildRoot, repositoryRoot], buildRoot);
    const firstStatsInitProbe = readFileSync(statsInitFixturePath);
    run(process.execPath, [statsInitProbe, buildRoot, repositoryRoot], buildRoot);
    const secondStatsInitProbe = readFileSync(statsInitFixturePath);
    if (!firstStatsInitProbe.equals(secondStatsInitProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstStatsInitProbe), JSON.parse(secondStatsInitProbe));
        throw new Error(`stats-init oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const inventoryScript = path.join(buildRoot, '.gotavern-generate-inventories.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'generate-upstream-inventories.mjs'), inventoryScript);
    run(process.execPath, [inventoryScript, buildRoot, repositoryRoot], buildRoot);

    const configProbe = path.join(buildRoot, '.gotavern-probe-config-init.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-config-init.mjs'), configProbe);
    const configFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-config-init.json');
    run(process.execPath, [configProbe, buildRoot, repositoryRoot], buildRoot);
    const firstConfigProbe = readFileSync(configFixturePath);
    run(process.execPath, [configProbe, buildRoot, repositoryRoot], buildRoot);
    const secondConfigProbe = readFileSync(configFixturePath);
    if (!firstConfigProbe.equals(secondConfigProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstConfigProbe), JSON.parse(secondConfigProbe));
        throw new Error(`config-init oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }
    const configFixture = JSON.parse(firstConfigProbe);
    writeFileSync(path.join(repositoryRoot, 'upstream', 'generated', 'default-config.yaml'), configFixture.scenarios.fresh.outputYaml);

    const commandLineProbe = path.join(buildRoot, '.gotavern-probe-commandline-paths.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-commandline-paths.mjs'), commandLineProbe);
    const commandLineFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-commandline-paths.json');
    run(process.execPath, [commandLineProbe, buildRoot, repositoryRoot], buildRoot);
    const firstCommandLineProbe = readFileSync(commandLineFixturePath);
    run(process.execPath, [commandLineProbe, buildRoot, repositoryRoot], buildRoot);
    const secondCommandLineProbe = readFileSync(commandLineFixturePath);
    if (!firstCommandLineProbe.equals(secondCommandLineProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstCommandLineProbe), JSON.parse(secondCommandLineProbe));
        throw new Error(`command-line paths oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const basicAuthProbe = path.join(buildRoot, '.gotavern-probe-basic-auth.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-basic-auth.mjs'), basicAuthProbe);
    const basicAuthFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-basic-auth.json');
    run(process.execPath, [basicAuthProbe, buildRoot, repositoryRoot], buildRoot);
    const firstBasicAuthProbe = readFileSync(basicAuthFixturePath);
    run(process.execPath, [basicAuthProbe, buildRoot, repositoryRoot], buildRoot);
    const secondBasicAuthProbe = readFileSync(basicAuthFixturePath);
    if (!firstBasicAuthProbe.equals(secondBasicAuthProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstBasicAuthProbe), JSON.parse(secondBasicAuthProbe));
        throw new Error(`Basic Auth oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const perUserBasicAuthProbe = path.join(buildRoot, '.gotavern-probe-per-user-basic-auth.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-per-user-basic-auth.mjs'), perUserBasicAuthProbe);
    const perUserBasicAuthFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-per-user-basic-auth.json');
    run(process.execPath, [perUserBasicAuthProbe, buildRoot, repositoryRoot], buildRoot);
    const firstPerUserBasicAuthProbe = readFileSync(perUserBasicAuthFixturePath);
    run(process.execPath, [perUserBasicAuthProbe, buildRoot, repositoryRoot], buildRoot);
    const secondPerUserBasicAuthProbe = readFileSync(perUserBasicAuthFixturePath);
    if (!firstPerUserBasicAuthProbe.equals(secondPerUserBasicAuthProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstPerUserBasicAuthProbe), JSON.parse(secondPerUserBasicAuthProbe));
        throw new Error(`per-user Basic Auth oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const hostWhitelistProbe = path.join(buildRoot, '.gotavern-probe-host-whitelist.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-host-whitelist.mjs'), hostWhitelistProbe);
    const hostWhitelistFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-host-whitelist.json');
    run(process.execPath, [hostWhitelistProbe, buildRoot, repositoryRoot], buildRoot);
    const firstHostWhitelistProbe = readFileSync(hostWhitelistFixturePath);
    run(process.execPath, [hostWhitelistProbe, buildRoot, repositoryRoot], buildRoot);
    const secondHostWhitelistProbe = readFileSync(hostWhitelistFixturePath);
    if (!firstHostWhitelistProbe.equals(secondHostWhitelistProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstHostWhitelistProbe), JSON.parse(secondHostWhitelistProbe));
        throw new Error(`host-whitelist oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const heartbeatProbe = path.join(buildRoot, '.gotavern-probe-heartbeat.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-heartbeat.mjs'), heartbeatProbe);
    const heartbeatFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-heartbeat.json');
    run(process.execPath, [heartbeatProbe, buildRoot, repositoryRoot], buildRoot);
    const firstHeartbeatProbe = readFileSync(heartbeatFixturePath);
    run(process.execPath, [heartbeatProbe, buildRoot, repositoryRoot], buildRoot);
    const secondHeartbeatProbe = readFileSync(heartbeatFixturePath);
    if (!firstHeartbeatProbe.equals(secondHeartbeatProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstHeartbeatProbe), JSON.parse(secondHeartbeatProbe));
        throw new Error(`heartbeat oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const serverProtocolsProbe = path.join(buildRoot, '.gotavern-probe-server-protocols.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-server-protocols.mjs'), serverProtocolsProbe);
    const serverProtocolsFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-server-protocols.json');
    run(process.execPath, [serverProtocolsProbe, buildRoot, repositoryRoot], buildRoot);
    const firstServerProtocolsProbe = readFileSync(serverProtocolsFixturePath);
    run(process.execPath, [serverProtocolsProbe, buildRoot, repositoryRoot], buildRoot);
    const secondServerProtocolsProbe = readFileSync(serverProtocolsFixturePath);
    if (!firstServerProtocolsProbe.equals(secondServerProtocolsProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstServerProtocolsProbe), JSON.parse(secondServerProtocolsProbe));
        throw new Error(`server-protocol oracle changed across identical Node runs at: ${paths.join(', ')}`);
    }

    const backgroundAllProbe = path.join(buildRoot, '.gotavern-probe-backgrounds-all.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-backgrounds-all.mjs'), backgroundAllProbe);
    const backgroundAllFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-backgrounds-all.json');
    run(process.execPath, [backgroundAllProbe, buildRoot, repositoryRoot], buildRoot);
    const firstBackgroundAllProbe = readFileSync(backgroundAllFixturePath);
    run(process.execPath, [backgroundAllProbe, buildRoot, repositoryRoot], buildRoot);
    const secondBackgroundAllProbe = readFileSync(backgroundAllFixturePath);
    if (!firstBackgroundAllProbe.equals(secondBackgroundAllProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstBackgroundAllProbe), JSON.parse(secondBackgroundAllProbe));
        throw new Error(`backgrounds-all oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const backgroundDeleteProbe = path.join(buildRoot, '.gotavern-probe-backgrounds-delete.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-backgrounds-delete.mjs'), backgroundDeleteProbe);
    const backgroundDeleteFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-backgrounds-delete.json');
    run(process.execPath, [backgroundDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const firstBackgroundDeleteProbe = readFileSync(backgroundDeleteFixturePath);
    run(process.execPath, [backgroundDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const secondBackgroundDeleteProbe = readFileSync(backgroundDeleteFixturePath);
    if (!firstBackgroundDeleteProbe.equals(secondBackgroundDeleteProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstBackgroundDeleteProbe), JSON.parse(secondBackgroundDeleteProbe));
        throw new Error(`backgrounds-delete oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const backgroundRenameProbe = path.join(buildRoot, '.gotavern-probe-backgrounds-rename.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-backgrounds-rename.mjs'), backgroundRenameProbe);
    const backgroundRenameFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-backgrounds-rename.json');
    run(process.execPath, [backgroundRenameProbe, buildRoot, repositoryRoot], buildRoot);
    const firstBackgroundRenameProbe = readFileSync(backgroundRenameFixturePath);
    run(process.execPath, [backgroundRenameProbe, buildRoot, repositoryRoot], buildRoot);
    const secondBackgroundRenameProbe = readFileSync(backgroundRenameFixturePath);
    if (!firstBackgroundRenameProbe.equals(secondBackgroundRenameProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstBackgroundRenameProbe), JSON.parse(secondBackgroundRenameProbe));
        throw new Error(`backgrounds-rename oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const backgroundUploadProbe = path.join(buildRoot, '.gotavern-probe-backgrounds-upload.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-backgrounds-upload.mjs'), backgroundUploadProbe);
    const backgroundUploadFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-backgrounds-upload.json');
    run(process.execPath, [backgroundUploadProbe, buildRoot, repositoryRoot], buildRoot);
    const firstBackgroundUploadProbe = readFileSync(backgroundUploadFixturePath);
    run(process.execPath, [backgroundUploadProbe, buildRoot, repositoryRoot], buildRoot);
    const secondBackgroundUploadProbe = readFileSync(backgroundUploadFixturePath);
    if (!firstBackgroundUploadProbe.equals(secondBackgroundUploadProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstBackgroundUploadProbe), JSON.parse(secondBackgroundUploadProbe));
        throw new Error(`backgrounds-upload oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const filesDeleteProbe = path.join(buildRoot, '.gotavern-probe-files-delete.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-files-delete.mjs'), filesDeleteProbe);
    const filesDeleteFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-files-delete.json');
    run(process.execPath, [filesDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const firstFilesDeleteProbe = readFileSync(filesDeleteFixturePath);
    run(process.execPath, [filesDeleteProbe, buildRoot, repositoryRoot], buildRoot);
    const secondFilesDeleteProbe = readFileSync(filesDeleteFixturePath);
    if (!firstFilesDeleteProbe.equals(secondFilesDeleteProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstFilesDeleteProbe), JSON.parse(secondFilesDeleteProbe));
        throw new Error(`files-delete oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const filesSanitizeProbe = path.join(buildRoot, '.gotavern-probe-files-sanitize-filename.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-files-sanitize-filename.mjs'), filesSanitizeProbe);
    const filesSanitizeFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-files-sanitize-filename.json');
    run(process.execPath, [filesSanitizeProbe, buildRoot, repositoryRoot], buildRoot);
    const firstFilesSanitizeProbe = readFileSync(filesSanitizeFixturePath);
    run(process.execPath, [filesSanitizeProbe, buildRoot, repositoryRoot], buildRoot);
    const secondFilesSanitizeProbe = readFileSync(filesSanitizeFixturePath);
    if (!firstFilesSanitizeProbe.equals(secondFilesSanitizeProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstFilesSanitizeProbe), JSON.parse(secondFilesSanitizeProbe));
        throw new Error(`files-sanitize-filename oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const filesUploadProbe = path.join(buildRoot, '.gotavern-probe-files-upload.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-files-upload.mjs'), filesUploadProbe);
    const filesUploadFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-files-upload.json');
    run(process.execPath, [filesUploadProbe, buildRoot, repositoryRoot], buildRoot);
    const firstFilesUploadProbe = readFileSync(filesUploadFixturePath);
    run(process.execPath, [filesUploadProbe, buildRoot, repositoryRoot], buildRoot);
    const secondFilesUploadProbe = readFileSync(filesUploadFixturePath);
    if (!firstFilesUploadProbe.equals(secondFilesUploadProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstFilesUploadProbe), JSON.parse(secondFilesUploadProbe));
        throw new Error(`files-upload oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const filesVerifyProbe = path.join(buildRoot, '.gotavern-probe-files-verify.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-files-verify.mjs'), filesVerifyProbe);
    const filesVerifyFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-files-verify.json');
    run(process.execPath, [filesVerifyProbe, buildRoot, repositoryRoot], buildRoot);
    const firstFilesVerifyProbe = readFileSync(filesVerifyFixturePath);
    run(process.execPath, [filesVerifyProbe, buildRoot, repositoryRoot], buildRoot);
    const secondFilesVerifyProbe = readFileSync(filesVerifyFixturePath);
    if (!firstFilesVerifyProbe.equals(secondFilesVerifyProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstFilesVerifyProbe), JSON.parse(secondFilesVerifyProbe));
        throw new Error(`files-verify oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const chatsSaveGetProbe = path.join(buildRoot, '.gotavern-probe-chats-save-get.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-chats-save-get.mjs'), chatsSaveGetProbe);
    const chatsSaveGetFixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-chats-save-get.json');
    run(process.execPath, [chatsSaveGetProbe, buildRoot, repositoryRoot], buildRoot);
    const firstChatsSaveGetProbe = readFileSync(chatsSaveGetFixturePath);
    run(process.execPath, [chatsSaveGetProbe, buildRoot, repositoryRoot], buildRoot);
    const secondChatsSaveGetProbe = readFileSync(chatsSaveGetFixturePath);
    if (!firstChatsSaveGetProbe.equals(secondChatsSaveGetProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstChatsSaveGetProbe), JSON.parse(secondChatsSaveGetProbe));
        throw new Error(`chats-save-get oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    const compiler = `
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from './webpack.config.js';

const config = getPublicLibConfig({ forceDist: true, pruneCache: true });
const stats = await new Promise((resolve, reject) => {
  const compiler = webpack(config);
  compiler.run((error, result) => {
    if (error) {
      compiler.close(() => reject(error));
      return;
    }
    if (result.hasErrors()) {
      compiler.close(() => reject(new Error(result.toString(config.stats))));
      return;
    }
    compiler.close((closeError) => closeError ? reject(closeError) : resolve(result));
  });
});
console.log(stats.toString(config.stats));
copyFileSync(path.join(config.output.path, config.output.filename), process.argv[2]);
`;
    const compilerPath = path.join(buildRoot, '.gotavern-build-lib.mjs');
    const tempOutput = path.join(tempRoot, 'lib.js');
    writeFileSync(compilerPath, compiler);
    run(process.execPath, [compilerPath, tempOutput], buildRoot);

    copyFileSync(tempOutput, outputPath);
    const probeScript = path.join(buildRoot, '.gotavern-probe-node.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'probe-node-reference.mjs'), probeScript);
    run(process.execPath, [probeScript, buildRoot, repositoryRoot], buildRoot);
    const fixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-fresh-start.json');
    const firstProbe = readFileSync(fixturePath);
    run(process.execPath, [probeScript, buildRoot, repositoryRoot], buildRoot);
    const secondProbe = readFileSync(fixturePath);
    if (!firstProbe.equals(secondProbe)) {
        const paths = changedJSONPaths(JSON.parse(firstProbe), JSON.parse(secondProbe));
        throw new Error(`fresh-start oracle changed across identical pinned Node runs at: ${paths.join(', ')}; add only source-verified normalization rules`);
    }

    const custom404FixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-custom-404.json');
    run(process.execPath, [probeScript, buildRoot, repositoryRoot, 'custom-404'], buildRoot);
    const firstCustom404Probe = readFileSync(custom404FixturePath);
    run(process.execPath, [probeScript, buildRoot, repositoryRoot, 'custom-404'], buildRoot);
    const secondCustom404Probe = readFileSync(custom404FixturePath);
    if (!firstCustom404Probe.equals(secondCustom404Probe)) {
        const paths = changedJSONPaths(JSON.parse(firstCustom404Probe), JSON.parse(secondCustom404Probe));
        throw new Error(`custom 404 oracle changed across identical pinned Node runs at: ${paths.join(', ')}`);
    }

    // A probe that is never run by this script produces a fixture that CI
    // cannot re-verify, so its compatibility claim is unfalsifiable. Fail loudly
    // instead of silently accumulating unverified oracle fixtures.
    const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const unwiredProbes = readdirSync(path.join(repositoryRoot, 'tools'))
        .filter(name => name.startsWith('probe-') && name.endsWith('.mjs'))
        .filter(name => !ownSource.includes(name))
        .sort();
    if (unwiredProbes.length > 0) {
        throw new Error('probe scripts are not wired into the deterministic rebuild: ' + unwiredProbes.join(', '));
    }

    const packageJson = JSON.parse(readFileSync(path.join(buildRoot, 'package.json'), 'utf8'));
    const webpackPackage = JSON.parse(readFileSync(path.join(buildRoot, 'node_modules', 'webpack', 'package.json'), 'utf8'));
    const digest = createHash('sha256').update(readFileSync(outputPath)).digest('hex');
    const metadata = {
        source: 'SillyTavern',
        version: PINNED_VERSION,
        commit: PINNED_COMMIT,
        packageVersion: packageJson.version,
        nodeVersion: process.version,
        npmVersion: runNpm(['--version'], repositoryRoot, { stdio: 'pipe' }).trim(),
        webpackVersion: webpackPackage.version,
        output: 'lib.js',
        sha256: digest,
    };
    writeFileSync(path.join(repositoryRoot, 'upstream', 'generated', 'build-info.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    writeFileSync(path.join(repositoryRoot, 'upstream', 'manifests', 'generated.sha256'), generatedManifest(path.join(repositoryRoot, 'upstream', 'generated')));
    console.log(`Built upstream/generated/lib.js (${digest})`);
} finally {
    const resolvedTempRoot = path.resolve(tempRoot);
    const resolvedTempParent = path.resolve(os.tmpdir());
    const tempPathIsContained = path.dirname(resolvedTempRoot).toLowerCase() === resolvedTempParent.toLowerCase()
        && path.basename(resolvedTempRoot).startsWith('gotavern-upstream-webpack-');
    if (!tempPathIsContained) {
        throw new Error(`refusing to remove unexpected temporary path: ${resolvedTempRoot}`);
    }
    rmSync(resolvedTempRoot, { recursive: true, force: true });
}
