// Package e2e boots the SHIPPED GoTavern binary as a subprocess and drives real HTTP routes over a
// socket, which is the only way to observe the production provider transport: internal/server's test
// binary pins the wire-exact client process-wide (internal/server/transport_mode_test.go), and the
// route handlers are deliberately not exported for tests.
//
// This file exists so the directory is a buildable package rather than a test-only one.
package e2e
