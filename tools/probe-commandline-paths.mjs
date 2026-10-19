#!/usr/bin/env node
// Capture the pinned CommandLineParser's config/data path and directory effects.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-commandline-paths.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-commandline-oracle-'));
const worker = String.raw`
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const sourceRoot = process.env.GOTAVERN_SOURCE_ROOT;
const { default: envPaths } = await import(pathToFileURL(path.join(sourceRoot, 'node_modules', 'env-paths', 'index.js')).href);
const workingDirectory = process.cwd();
const serverDirectory = process.env.GOTAVERN_SERVER_DIRECTORY;
const args = JSON.parse(process.env.GOTAVERN_ARGS);
const warnings = [];
console.warn = (...values) => warnings.push(values.map(String).join(' '));
console.log = () => {};
if (process.env.GOTAVERN_FORCE_GLOBAL === 'true') globalThis.FORCE_GLOBAL_MODE = true;
for (const key of Object.keys(process.env)) {
    if (key.startsWith('SILLYTAVERN_')) delete process.env[key];
}
delete process.env.SILLYTAVERN_DATAROOT;
if (process.env.GOTAVERN_DATA_ROOT_ENV !== '') process.env.SILLYTAVERN_DATAROOT = process.env.GOTAVERN_DATA_ROOT_ENV;
Object.assign(process.env, JSON.parse(process.env.GOTAVERN_OPTION_ENV));
process.argv = [process.execPath, path.join(sourceRoot, 'server.js'), ...args];

const { CommandLineParser } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'command-line.js')).href);
const { getConfigValue } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
const globalDataDirectory = envPaths('SillyTavern', { suffix: '' }).data;
const initialConfigPath = process.env.GOTAVERN_INITIAL_CONFIG_PATH;
const result = new CommandLineParser().parse(process.argv);
const useIPv4 = process.env.GOTAVERN_USE_IPV4 === 'true';
const useIPv6 = process.env.GOTAVERN_USE_IPV6 === 'true';
const captureURL = callback => {
    try { return { href: callback().href }; }
    catch (error) { return { errorName: error.name, errorMessage: error.message }; }
};
const browserLaunchHostname = await result.getBrowserLaunchHostname({ useIPv6, useIPv4 });
const derivedURLs = {
    ipv4ListenUrl: captureURL(() => result.getIPv4ListenUrl()),
    ipv6ListenUrl: captureURL(() => result.getIPv6ListenUrl()),
    browserLaunchHostname,
    browserLaunchUrl: captureURL(() => result.getBrowserLaunchUrl(browserLaunchHostname)),
};
const options = Object.fromEntries([
    'port', 'listen', 'listenAddressIPv6', 'listenAddressIPv4', 'enableIPv4', 'enableIPv6',
    'dnsPreferIPv6', 'heartbeatInterval', 'browserLaunchEnabled', 'browserLaunchHostname',
    'browserLaunchPort', 'browserLaunchAvoidLocalhost', 'enableCorsProxy', 'disableCsrf',
    'ssl', 'certPath', 'keyPath', 'keyPassphrase', 'whitelistMode', 'basicAuthMode',
    'enableKeepAlive', 'requestProxyEnabled', 'requestProxyUrl', 'requestProxyBypass',
].map(key => [key, result[key]]));
const startupSettings = {
    legacyCookieSecret: getConfigValue('cookieSecret'),
    sessionTimeout: getConfigValue('sessionTimeout', -1, 'number'),
    enableUserAccounts: getConfigValue('enableUserAccounts', false, 'boolean'),
    enableDiscreetLogin: getConfigValue('enableDiscreetLogin', false, 'boolean'),
    securityOverride: getConfigValue('securityOverride', false, 'boolean'),
    perUserBasicAuth: getConfigValue('perUserBasicAuth', false, 'boolean'),
    preferRealIPHeader: getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean'),
    basicAuthMaxAttempts: getConfigValue('rateLimiting.basicAuthMaxAttempts', 5, 'number'),
    accountsLoginMaxAttempts: getConfigValue('rateLimiting.accountsLoginMaxAttempts', 5, 'number'),
    accountsRecoverMaxAttempts: getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number'),
    forwardedXRealIP: getConfigValue('forwardedHeaders.xRealIp', true, 'boolean'),
    forwardedCFConnectingIP: getConfigValue('forwardedHeaders.cfConnectingIp', false, 'boolean'),
    forwardedXForwardedFor: getConfigValue('forwardedHeaders.xForwardedFor', true, 'boolean'),
    enableForwardedWhitelist: getConfigValue('enableForwardedWhitelist', false, 'boolean'),
    whitelist: getConfigValue('whitelist', []),
    whitelistDockerHosts: getConfigValue('whitelistDockerHosts', true, 'boolean'),
    hostWhitelistEnabled: getConfigValue('hostWhitelist.enabled', false, 'boolean'),
    hostWhitelistScan: getConfigValue('hostWhitelist.scan', false, 'boolean'),
    hostWhitelistHosts: getConfigValue('hostWhitelist.hosts', []),
    basicAuthUsername: getConfigValue('basicAuthUser.username', ''),
    basicAuthPassword: getConfigValue('basicAuthUser.password', ''),
    skipContentCheck: getConfigValue('skipContentCheck', false, 'boolean'),
    useDiskCache: getConfigValue('performance.useDiskCache', true, 'boolean'),
    settingsBackupRetention: getConfigValue('backups.common.numberOfBackups', 50, 'number'),
};
const resolvedConfig = path.resolve(result.configPath);
const configBytes = readFileSync(resolvedConfig);
const resolvedDataRoot = path.resolve(result.dataRoot);
const runtimeDataRoot = path.resolve(serverDirectory, result.dataRoot);
const configRelativeToGlobal = path.relative(globalDataDirectory, resolvedConfig);
const configIsInGlobalDirectory = configRelativeToGlobal === '' || (!configRelativeToGlobal.startsWith('..' + path.sep) && configRelativeToGlobal !== '..' && !path.isAbsolute(configRelativeToGlobal));
let dataRootIsDirectory = false;
try { dataRootIsDirectory = statSync(resolvedDataRoot).isDirectory(); } catch {}
const normalizeGlobalPath = (value) => {
    const absolute = path.resolve(value);
    const relative = path.relative(globalDataDirectory, absolute);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
        return '<globalData>' + (relative ? '/' + relative.split(path.sep).join('/') : '');
    }
    return value;
};
const relativePath = (base, value) => path.relative(base, value).split(path.sep).join('/');
const relevantWarnings = {
    ignoredConfigPath: warnings.some(value => value.includes('--configPath') && value.includes('ignored in global mode')),
    ignoredDataRoot: warnings.some(value => value.includes('--dataRoot') && value.includes('ignored in global mode')),
    failedDataRootCreation: warnings.some(value => value.includes('Failed to create data root directory')),
};
const optionWarnings = {
    invalidIPv4Protocol: warnings.some(value => value.includes('protocol: ipv4') && value.includes('option invalid')),
    invalidIPv6Protocol: warnings.some(value => value.includes('protocol: ipv6') && value.includes('option invalid')),
};
const configWasPresent = initialConfigPath !== '' && path.resolve(initialConfigPath) === resolvedConfig;
const initialConfigHash = process.env.GOTAVERN_INITIAL_CONFIG_SHA256;
const configSha256 = createHash('sha256').update(configBytes).digest('hex');
process.stdout.write(JSON.stringify({
    global: configIsInGlobalDirectory,
    configPath: normalizeGlobalPath(result.configPath),
    configFileRelativeToCwd: configIsInGlobalDirectory ? normalizeGlobalPath(result.configPath) : relativePath(workingDirectory, resolvedConfig),
    dataRoot: normalizeGlobalPath(result.dataRoot),
    dataRootCreationRelativeToCwd: configIsInGlobalDirectory ? normalizeGlobalPath(result.dataRoot) : relativePath(workingDirectory, resolvedDataRoot),
    runtimeDataRootRelativeToServerDirectory: configIsInGlobalDirectory ? normalizeGlobalPath(result.dataRoot) : relativePath(serverDirectory, runtimeDataRoot),
    configBytes: configBytes.length,
    configSha256,
    configCreated: !configWasPresent,
    configUpdated: configWasPresent && initialConfigHash !== configSha256,
    dataRootIsDirectory,
    dataRootWasDirectoryBeforeParse: process.env.GOTAVERN_DATA_ROOT_PREEXISTED === 'true',
    warnings: relevantWarnings,
    options,
    startupSettings,
    optionWarnings,
    derivedURLs,
}));
`;

const scenarios = [
    { name: 'standalone-default', args: [] },
    { name: 'standalone-global-disabled', args: ['--global=false'] },
    { name: 'standalone-global-disabled-separated', args: ['--global', 'false'] },
    { name: 'standalone-missing-path-flag-values', args: ['--configPath', '--dataRoot'] },
    { name: 'standalone-config-data-root', args: [], initialConfigPath: './config.yaml', initialConfig: 'dataRoot: ./from-config\n' },
    { name: 'standalone-existing-data-root', args: [], initialConfigPath: './config.yaml', initialConfig: 'dataRoot: ./existing-data\n', existingDataRoot: './existing-data' },
    { name: 'standalone-cli-precedence', args: ['--configPath', './custom.yaml', '--dataRoot', './from-cli'], initialConfigPath: './custom.yaml', initialConfig: 'dataRoot: ./from-config\n' },
    { name: 'standalone-env-precedence', args: [], initialConfigPath: './config.yaml', initialConfig: 'dataRoot: ./from-config\n', environmentDataRoot: './from-env' },
    { name: 'standalone-cli-over-env', args: ['--dataRoot=./from-cli'], initialConfigPath: './config.yaml', initialConfig: 'dataRoot: ./from-config\n', environmentDataRoot: './from-env' },
    { name: 'global-ignores-cli', args: ['--global', '--configPath', './ignored-config.yaml', '--dataRoot', './ignored-data'] },
    { name: 'forced-global', args: ['--global=false', '--configPath', './ignored-config.yaml', '--dataRoot', './ignored-data'], forceGlobal: true },
    { name: 'failed-data-root-create', args: ['--dataRoot', './file-blocker/child'], blockerFile: './file-blocker' },
    { name: 'empty-data-root', args: ['--dataRoot', ''] },
    {
        name: 'all-cli-server-options',
        args: [
            '--port', '9111', '--listen', '--listenAddressIPv6', '::1', '--listenAddressIPv4', '192.0.2.4',
            '--enableIPv4', 'auto', '--enableIPv6', 'true', '--dnsPreferIPv6', '--heartbeatInterval', '17',
            '--browserLaunchEnabled', 'false', '--browserLaunchHostname', 'launch.example', '--browserLaunchPort', '9999',
            '--browserLaunchAvoidLocalhost', '--corsProxy', '--disableCsrf', '--ssl', '--certPath', './tls/cert.pem',
            '--keyPath', './tls/key.pem', '--keyPassphrase', 'a pass phrase', '--whitelist=false', '--basicAuthMode',
            '--enableKeepAlive', '--requestProxyEnabled', '--requestProxyUrl', 'socks5://127.0.0.1:1080',
            '--requestProxyBypass', 'localhost', '127.0.0.1',
        ],
    },
    {
        name: 'listen-mode-derived-urls',
        args: ['--listen', '--listenAddressIPv4', '192.0.2.24', '--listenAddressIPv6', '[::]'],
        useIPv4: true,
        useIPv6: true,
    },
    {
        name: 'listen-mode-invalid-address-fallbacks',
        args: ['--listen', '--listenAddressIPv4', 'localhost', '--listenAddressIPv6', '[::]'],
        useIPv4: true,
        useIPv6: true,
    },
    {
        name: 'browser-launch-zero-port-normalizes-hostname',
        args: ['--browserLaunchPort', '0', '--browserLaunchHostname', 'Example.COM'],
    },
    {
        name: 'browser-launch-auto-dual-protocol',
        args: ['--browserLaunchAvoidLocalhost'],
        useIPv4: true,
        useIPv6: true,
    },
    {
        name: 'browser-launch-auto-no-detected-protocol',
        args: [],
        useIPv4: false,
        useIPv6: false,
    },
    {
        name: 'yargs-boolean-inline-coercion',
        args: ['--listen=1', '--ssl=true', '--basicAuthMode=invalid'],
    },
    {
        name: 'yargs-number-coercion',
        args: ['--port=invalid', '--heartbeatInterval='],
    },
    {
        name: 'config-and-environment-options',
        args: [],
        initialConfigPath: './config.yaml',
        initialConfig: `port: 1234\nlisten: true\nlistenAddress:\n  ipv4: 192.0.2.10\n  ipv6: '2001:db8::10'\nprotocol:\n  ipv4: false\n  ipv6: auto\ndnsPreferIPv6: true\nheartbeatInterval: 9\nbrowserLaunch:\n  enabled: false\n  hostname: config.example\n  port: 8181\n  avoidLocalhost: true\nenableCorsProxy: true\ndisableCsrfProtection: true\nssl:\n  enabled: true\n  certPath: config-cert.pem\n  keyPath: config-key.pem\n  keyPassphrase: config-pass\nwhitelistMode: false\nbasicAuthMode: true\nenableKeepAlive: true\nrequestProxy:\n  enabled: true\n  url: http://config-proxy:8080\n  bypass: [config-host]\n`,
        optionEnvironment: {
            SILLYTAVERN_PORT: '4321',
            SILLYTAVERN_LISTEN: 'false',
            SILLYTAVERN_REQUESTPROXY_BYPASS: '["environment-host"]',
            SILLYTAVERN_ENABLEKEEPALIVE: 'false',
        },
    },
    {
        name: 'startup-settings-config-values',
        args: [],
        initialConfigPath: './config.yaml',
        initialConfig: `cookieSecret: legacy-file-secret\nenableUserAccounts: true\nenableDiscreetLogin: true\nsecurityOverride: true\nperUserBasicAuth: true\nrateLimiting:\n  preferRealIpHeader: true\n  accountsLoginMaxAttempts: 3.5\n  accountsRecoverMaxAttempts: 4.5\nforwardedHeaders:\n  xRealIp: false\n  cfConnectingIp: true\n  xForwardedFor: false\nbasicAuthUser:\n  username: config-user\n  password: config-password\nskipContentCheck: true\nperformance:\n  useDiskCache: false\nbackups:\n  common:\n    numberOfBackups: 7\n`,
    },
    {
        name: 'startup-settings-environment-overrides',
        args: [],
        initialConfigPath: './config.yaml',
        initialConfig: `enableUserAccounts: false\nsecurityOverride: true\nperUserBasicAuth: false\nskipContentCheck: false\nperformance:\n  useDiskCache: true\nbackups:\n  common:\n    numberOfBackups: 9\n`,
        optionEnvironment: {
            SILLYTAVERN_COOKIESECRET: 'environment-secret',
            SILLYTAVERN_ENABLEUSERACCOUNTS: 'true',
            SILLYTAVERN_SECURITYOVERRIDE: 'false',
            SILLYTAVERN_PERUSERBASICAUTH: 'true',
            SILLYTAVERN_ENABLEDISCREETLOGIN: 'true',
            SILLYTAVERN_RATELIMITING_PREFERREALIPHEADER: 'true',
            SILLYTAVERN_RATELIMITING_ACCOUNTSLOGINMAXATTEMPTS: '8.5',
            SILLYTAVERN_RATELIMITING_ACCOUNTSRECOVERMAXATTEMPTS: '6.5',
            SILLYTAVERN_FORWARDEDHEADERS_XREALIP: 'false',
            SILLYTAVERN_FORWARDEDHEADERS_CFCONNECTINGIP: 'true',
            SILLYTAVERN_FORWARDEDHEADERS_XFORWARDEDFOR: 'false',
            SILLYTAVERN_BASICAUTHUSER_USERNAME: 'environment-user',
            SILLYTAVERN_BASICAUTHUSER_PASSWORD: 'environment-password',
            SILLYTAVERN_SKIPCONTENTCHECK: 'true',
            SILLYTAVERN_PERFORMANCE_USEDISKCACHE: 'false',
            SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS: '6.5',
        },
    },
    {
        name: 'deprecated-browser-option-fallbacks',
        args: ['--autorun', '--autorunHostname', 'legacy.example', '--autorunPortOverride', '5050', '--avoidLocalhost'],
    },
    {
        name: 'canonical-browser-options-win-over-deprecated',
        args: ['--autorun', '--browserLaunchEnabled=false', '--autorunHostname', 'legacy.example', '--browserLaunchHostname', 'current.example', '--autorunPortOverride', '5050', '--browserLaunchPort', '7070', '--avoidLocalhost', '--browserLaunchAvoidLocalhost=false'],
    },
    {
        name: 'invalid-protocol-values-fall-back',
        args: [],
        initialConfigPath: './config.yaml',
        initialConfig: 'protocol:\n  ipv4: enabled\n  ipv6: disabled\n',
    },
];

function globalEnvironment(globalBase) {
    const environment = {
        GOTAVERN_GLOBAL_BASE: globalBase,
        GOTAVERN_SOURCE_ROOT: sourceRoot,
        GOTAVERN_SERVER_DIRECTORY: sourceRoot,
    };
    if (process.platform === 'win32') {
        environment.LOCALAPPDATA = globalBase;
        environment.APPDATA = path.join(globalBase, 'roaming');
        environment.USERPROFILE = globalBase;
    } else if (process.platform === 'darwin') {
        environment.HOME = globalBase;
    } else {
        environment.XDG_DATA_HOME = globalBase;
        environment.HOME = globalBase;
    }
    return environment;
}

function runScenario(scenario) {
    const scenarioRoot = path.join(runtimeRoot, scenario.name);
    const workingDirectory = path.join(scenarioRoot, 'work');
    const globalBase = path.join(scenarioRoot, 'global-base');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(globalBase, { recursive: true });
    if (scenario.initialConfigPath) {
        const target = path.resolve(workingDirectory, scenario.initialConfigPath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, scenario.initialConfig);
    }
    if (scenario.blockerFile) {
        writeFileSync(path.resolve(workingDirectory, scenario.blockerFile), 'blocker');
    }
    if (scenario.existingDataRoot) {
        mkdirSync(path.resolve(workingDirectory, scenario.existingDataRoot), { recursive: true });
    }
    const initialConfigAbsolute = scenario.initialConfigPath ? path.resolve(workingDirectory, scenario.initialConfigPath) : '';
    const initialConfigSha256 = initialConfigAbsolute && existsSync(initialConfigAbsolute)
        ? createHash('sha256').update(readFileSync(initialConfigAbsolute)).digest('hex')
        : '';
    const environment = {
        ...process.env,
        ...globalEnvironment(globalBase),
        GOTAVERN_ARGS: JSON.stringify(scenario.args),
        GOTAVERN_FORCE_GLOBAL: scenario.forceGlobal ? 'true' : 'false',
        GOTAVERN_DATA_ROOT_ENV: scenario.environmentDataRoot ?? '',
        GOTAVERN_OPTION_ENV: JSON.stringify(scenario.optionEnvironment ?? {}),
        GOTAVERN_USE_IPV4: String(scenario.useIPv4 ?? true),
        GOTAVERN_USE_IPV6: String(scenario.useIPv6 ?? false),
        GOTAVERN_INITIAL_CONFIG_PATH: initialConfigAbsolute,
        GOTAVERN_INITIAL_CONFIG_SHA256: initialConfigSha256,
        GOTAVERN_DATA_ROOT_PREEXISTED: scenario.existingDataRoot ? 'true' : 'false',
    };
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', worker], {
        cwd: workingDirectory,
        env: environment,
        encoding: 'utf8',
    });
    return {
        name: scenario.name,
        args: scenario.args,
        initialConfigPath: scenario.initialConfigPath ?? null,
        initialConfig: scenario.initialConfig ?? null,
        environmentDataRoot: scenario.environmentDataRoot ?? null,
        optionEnvironment: scenario.optionEnvironment ?? {},
        useIPv4: scenario.useIPv4 ?? true,
        useIPv6: scenario.useIPv6 ?? false,
        forceGlobal: scenario.forceGlobal ?? false,
        blockerFile: scenario.blockerFile ?? null,
        existingDataRoot: scenario.existingDataRoot ?? null,
        result: JSON.parse(output),
    };
}

try {
    const captured = scenarios.map(runScenario);
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'pinned CommandLineParser config/data path effects and server options across CLI, config, and environment precedence',
        source: 'src/command-line.js: CommandLineParser.parse/getDefaultConfig',
        scenarios: Object.fromEntries(captured.map(item => [item.name, item])),
    };
    const fixtureDirectory = path.join(outputRoot, 'tests', 'oracle');
    mkdirSync(fixtureDirectory, { recursive: true });
    const fixturePath = path.join(fixtureDirectory, 'sillytavern-1.19.0-commandline-paths.json');
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(outputRoot, fixturePath)} from pinned CommandLineParser`);
} finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
}
