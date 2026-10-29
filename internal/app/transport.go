package app

import (
	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/outbound"
)

// `enableKeepAlive` AND `dnsPreferIPv6` AT BOOT -- the two pinned command-line options that shape the
// provider transport itself, as opposed to a single request.
//
// Both are resolved by the command-line layer with pinned's own semantics and their pinned defaults:
//
//	src/command-line.js:323   `enableKeepAlive: cliArguments.enableKeepAlive ?? getConfigValue(
//	                          'enableKeepAlive', defaultConfig.enableKeepAlive, 'boolean')`, default FALSE
//	                          (src/command-line.js:80, default/config.yaml:44-46, and the pinned comment
//	                          there names the reason: "Disabling restores old Node 18 behavior, can help if
//	                          ECONNRESET and other network errors occur").
//	src/server-main.js:100-101 `http.globalAgent = new http.Agent({ keepAlive: cliArgs.enableKeepAlive })`
//	                          and the same for https, installed at MODULE LOAD, so it covers every
//	                          outbound request in the process.
//
//	src/command-line.js:309   `dnsPreferIPv6: cliArguments.dnsPreferIPv6 ?? getConfigValue('dnsPreferIPv6',
//	                          defaultConfig.dnsPreferIPv6, 'boolean')`, default FALSE
//	                          (src/command-line.js:66, default/config.yaml:17-18).
//	src/server-main.js:481    `.then(setDnsResolutionOrder)` -- the pinned startup chain, i.e. before the
//	                          listener opens, which is why this call sits with the other transport setup
//	                          and not later.
//
// It is the PRODUCTION transport that is configured, never the byte-exact oracle client: rule 30 keeps
// those roles apart, and `raw.go` is reachable only with GOTAVERN_OUTBOUND_WIRE_EXACT=1.
func configureProductionTransport(parsed commandline.CommandLineResult) {
	outbound.ConfigureProductionTransport(outbound.ProductionTransportOptions{
		EnableKeepAlive: nodeTruthyOption(parsed.Options.EnableKeepAlive),
		PreferIPv6:      nodeTruthyOption(parsed.Options.DNSPreferIPv6),
	})
}
