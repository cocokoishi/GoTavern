package server

// `logging.minLogLevel -- the pinned console level gate, for the console calls THIS server makes.
//
// THE PINNED BEHAVIOUR (src/util.js:1133-1143, called from src/server-main.js:448 as the last step of
// postSetupTasks):
//
//	const logLevel = getConfigValue('logging.minLogLevel', LOG_LEVELS.DEBUG, 'number');
//	globalThis.console.debug = logLevel <= LOG_LEVELS.DEBUG ? console.debug : () => { };
//	globalThis.console.info  = logLevel <= LOG_LEVELS.INFO  ? console.info  : () => { };
//	globalThis.console.warn  = logLevel <= LOG_LEVELS.WARN  ? console.warn  : () => { };
//	globalThis.console.error = logLevel <= LOG_LEVELS.ERROR ? console.error : () => { };
//
// with LOG_LEVELS = {DEBUG:0, INFO:1, WARN:2, ERROR:3} (src/constants.js:517-522) and the config key
// defaulting to 0 (default/config.yaml:188-189; `logging.minLogLevel` is also the migration target of the
// legacy top-level `minLogLevel`, src/config-init.js:85-89).
//
// THREE PROPERTIES OF THAT CODE ARE LOAD-BEARING:
//
//  1. the comparison is `logLevel <= LEVEL`, so 0 shows everything, 1 hides debug, 3 hides everything but
//     errors, and 4 hides everything;
//  2. it REPLACES the function, so what it silences is the console line only -- a file the same code path
//     writes is untouched (that is why the access log below keeps its file line at level 2);
//  3. it runs at the END of the startup chain (:448), AFTER `initPrivateRequestFilter` (:348) and the
//     banner (:446). So startup lines are NOT gated by it, and this file deliberately does not gate them:
//     gating them would silence output that pinned prints. The calls routed through this gate are the ones
//     made while serving requests -- the access log's console line, the account recovery/reset code lines
//     and the host-whitelist warning -- which is exactly the set a user sees change when they raise the
//     level.
//
// GoTavern has no central logger to install a level into; the honest equivalent of "replace console.info"
// is a per-call gate at the places that emit a pinned console line while the server is running.

import (
	"fmt"
	"io"
	"math"
	"sync/atomic"
)

// The pinned severity numbers (src/constants.js:517-522).
const (
	consoleLevelDebug = 0
	consoleLevelInfo  = 1
	consoleLevelWarn  = 2
	consoleLevelError = 3
)

// consoleMinLevelBits holds the installed minimum level as math.Float64bits. The zero value is +0.0, i.e.
// the pinned default (`LOG_LEVELS.DEBUG`), so a handler built without the setting behaves exactly as it did
// before this file existed and no existing console assertion changes meaning.
//
// It is a FLOAT and not an int because the pinned predicate is a numeric comparison against a configured
// number: at `logging.minLogLevel: 2.5` only ERROR survives (`2.5 <= 2` is false, `2.5 <= 3` is true), and a
// NaN or +Inf value silences everything for the same reason. Truncating the configured value would invent a
// different gate.
var consoleMinLevelBits atomic.Uint64

// configureConsoleMinLevel installs `logging.minLogLevel`.
func configureConsoleMinLevel(level float64) {
	consoleMinLevelBits.Store(math.Float64bits(level))
}

// consoleLevelEnabled is pinned's `logLevel <= LEVEL ? real : noop`.
func consoleLevelEnabled(level int) bool {
	return math.Float64frombits(consoleMinLevelBits.Load()) <= float64(level)
}

// consoleInfof is a gated `console.info(format, ...)`; consoleWarnf and consoleErrorf are the other two
// levels the running server uses. A nil writer is silence, matching a nil-stream option.
func consoleInfof(writer io.Writer, format string, arguments ...any) {
	if writer == nil || !consoleLevelEnabled(consoleLevelInfo) {
		return
	}
	_, _ = fmt.Fprintf(writer, format, arguments...)
}

func consoleWarnf(writer io.Writer, format string, arguments ...any) {
	if writer == nil || !consoleLevelEnabled(consoleLevelWarn) {
		return
	}
	_, _ = fmt.Fprintf(writer, format, arguments...)
}

func consoleErrorf(writer io.Writer, format string, arguments ...any) {
	if writer == nil || !consoleLevelEnabled(consoleLevelError) {
		return
	}
	_, _ = fmt.Fprintf(writer, format, arguments...)
}
