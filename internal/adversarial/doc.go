// Package adversarial holds executable adversaries for the three user-visible
// P0 reports that the product contract (AGENTS.md rules 21-40) exists to answer:
//
//	P0-A  a provider is unreachable with a real key
//	P0-B  a boot hangs inside a working `node server.js` tree
//	P0-C  extensions/plugins are updated without being asked for
//
// Every case here is a NEGATIVE test: it states an invariant the shipped
// behaviour must hold under a hostile input or environment, runs the input
// against the product's own packages (no re-implementation of the subject), and
// reports whether the invariant held. A case is bounded (rule 24: every wait has
// a named bound) and a case that never returns is itself a violation.
//
// WHY A RATCHET INSTEAD OF PLAIN FAILING TESTS. Some invariants are known to be
// violated today. A suite that fails on `main` cannot be merged and would be
// deleted or skipped (rule 32 forbids weakening it), and a suite that asserts
// the WRONG behaviour would lock the defect in. So the measured verdicts are
// compared against `violations.golden` in both directions:
//
//   - a case that is violated and NOT in the golden file fails the run as a NEW
//     violation, naming its invariant and its reproducer;
//   - a case that is listed in the golden file but now HOLDS also fails the run,
//     because the entry is stale and the fix must be recorded (rule 7: never let
//     a step that appears to have happened stand unverified);
//   - a case that matches the golden file is green, and the violation is printed
//     with its reproducer so the report is a measurement rather than prose.
//
// The golden file is therefore the ranked violation list, and it cannot go
// stale in either direction without a red run.
//
// WHAT IS NOT HERE. No case asserts upstream (pinned Node) behaviour: the pinned
// server source is not vendored in this tree, so a parity claim here would be a
// derivation, not an oracle (rule 4). Each case instead asserts a CONTRACT
// invariant from AGENTS.md 21-40 or the observable consequence of the two
// measurement documents (docs/network-egress.md, docs/startup-state-machine.md),
// and the invariant text says which.
//
// CHECKLIST -> CASE MAP (the coverage test enforces both directions):
//
//	bad YAML                            config.bad-yaml
//	truncated YAML                      config.truncated-yaml
//	config with autoUpdate: null        config.autoupdate-null
//	config with an unparseable value    config.autoupdate-unparsed-value
//	stock config saying autoUpdate:true config.autoupdate-inherited-true (+ .fresh-install)
//	                                    extensions.boot-runs-no-git, extensions.gotavern-key-strict
//	legacy-only config                  config.legacy-only
//	config owned by another user /      config.readonly-directory
//	  read-only directory               config.parseable-config-rewritten
//	read-only install root              boot.readonly-install-root
//	config parent missing               config.parent-directory-missing
//	data-root parent missing            boot.data-root-parent-missing
//	stale lock file                     lock.stale-file-does-not-block
//	two concurrent boots                boot.two-concurrent
//	second boot mid-data-startup        boot.data-startup-lock-held
//	legacy tree: silent 10s + copies    boot.legacy-migration-cost
//	port already bound                  boot.port-already-bound
//	missing public/**                   boot.missing-public
//	missing tokenizers/**               boot.missing-tokenizers
//	foreign CWD                         boot.foreign-cwd-absolute-data-root
//	                                    boot.foreign-cwd-relative-data-root
//	$HOME that cannot exist             boot.missing-home
//	proxy that rejects CONNECT          transport.proxy-connect-ignored
//	TLS server with expired cert        transport.expired-certificate
//	provider closes mid-SSE             transport.mid-stream-close
//	provider returns 200 HTML           transport.html-200
//	API key with non-ASCII chars        transport.non-ascii-key
//	                                    transport.header-value-injection
//	compressing provider (gzip/br)      transport.gzip-response-unreadable
//	provider that redirects             transport.redirect-not-followed
package adversarial
