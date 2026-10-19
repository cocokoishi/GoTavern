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
