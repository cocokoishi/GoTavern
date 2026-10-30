//go:build !windows

package fsretry

// isTransient is always false off Windows: Unix renames replace an open file and opens never fail because
// of a concurrent rename, so retrying would only add latency to a real error.
func isTransient(error) bool { return false }
