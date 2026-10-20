#!/usr/bin/env node
// Capture the pinned ServerStartup protocol selection with deterministic
// network interfaces and fake sockets. The upstream source checkout is read
// only; the fixture is written to the GoTavern repository.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-server-protocols.json label="server-protocol"
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-server-protocols.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);

const scenarios = {
    'both-disabled': {
        options: { enableIPv4: false, enableIPv6: false, listen: false },
        interfaces: [],
    },
    'auto-dual-no-loopback': {
        options: { enableIPv4: 'auto', enableIPv6: 'auto', listen: false },
        interfaces: [
            { family: 'IPv4', address: '192.0.2.15' },
            { family: 'IPv6', address: '2001:db8::15' },
        ],
    },
    'auto-v4-loopback': {
        options: { enableIPv4: 'auto', enableIPv6: false, listen: false },
        interfaces: [{ family: 'IPv4', address: '127.0.0.1' }],
    },
    'auto-v6-loopback': {
        options: { enableIPv4: false, enableIPv6: 'auto', listen: false },
        interfaces: [{ family: 'IPv6', address: '::1' }],
    },
    'auto-dual-loopback': {
        options: { enableIPv4: 'auto', enableIPv6: 'auto', listen: false },
        interfaces: [
            { family: 'IPv4', address: '127.0.0.1' },
            { family: 'IPv6', address: '::1' },
        ],
    },
    'listen-v4-public-interface': {
        options: { enableIPv4: 'auto', enableIPv6: false, listen: true },
        interfaces: [{ family: 'IPv4', address: '198.51.100.23' }],
    },
    'listen-v6-public-interface': {
        options: { enableIPv4: false, enableIPv6: 'auto', listen: true },
        interfaces: [{ family: 'IPv6', address: '2001:db8::23' }],
    },
    'explicit-v4-without-interfaces': {
        options: { enableIPv4: true, enableIPv6: false, listen: true },
        interfaces: [],
    },
    'mixed-explicit-v4-auto-v6-no-local': {
        options: { enableIPv4: true, enableIPv6: 'auto', listen: false },
        interfaces: [{ family: 'IPv4', address: '127.0.0.1' }],
    },
};

const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
setConfigFilePath(path.join(sourceRoot, 'default', 'config.yaml'));
const { ServerStartup } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'server-startup.js')).href);

const originalNetworkInterfaces = os.networkInterfaces;
const originalCreateServer = http.createServer;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const output = {};

http.createServer = () => {
    const server = new EventEmitter();
    server.listen = listenOptions => {
        activeResult.listenCalls.push({ host: listenOptions.host, port: listenOptions.port, ipv6Only: listenOptions.ipv6Only });
        queueMicrotask(() => server.emit('listening'));
        return server;
    };
    return server;
};
process.exit = code => {
    const error = new Error('captured process.exit');
    error.gotavernExitCode = code;
    throw error;
};

let activeResult;
try {
    for (const [name, scenario] of Object.entries(scenarios)) {
        activeResult = { stderr: [], listenCalls: [] };
        os.networkInterfaces = () => scenario.interfaces.length === 0 ? {} : { probe: scenario.interfaces };
        console.log = () => {};
        console.error = (...values) => activeResult.stderr.push(values.map(String).join(' '));

        const options = {
            ...scenario.options,
            ssl: false,
            getIPv4ListenUrl: () => new URL(`http://${scenario.options.listen ? '0.0.0.0' : '127.0.0.1'}:8000`),
            getIPv6ListenUrl: () => new URL(`http://${scenario.options.listen ? '[::]' : '[::1]'}:8000`),
        };
        try {
            const result = await new ServerStartup({}, options).start();
            activeResult.useIPv4 = result.useIPv4;
            activeResult.useIPv6 = result.useIPv6;
            activeResult.v4Failed = result.v4Failed;
            activeResult.v6Failed = result.v6Failed;
        } catch (error) {
            if (!Object.hasOwn(error, 'gotavernExitCode')) throw error;
            activeResult.exitCode = error.gotavernExitCode;
        }
        output[name] = { ...scenario, result: activeResult };
    }
} finally {
    os.networkInterfaces = originalNetworkInterfaces;
    http.createServer = originalCreateServer;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
}

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'pinned ServerStartup protocol selection from configured flags and interface addresses',
    source: 'src/server-main.js protocol precondition; src/server-startup.js: ServerStartup.start; src/util.js: getHasIP',
    scenarios: output,
};
const fixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-server-protocols.json');
writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
