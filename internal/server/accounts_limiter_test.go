package server

import (
	"strconv"
	"testing"
	"time"
)

// limiterEntryCount reads the limiter's live window count under its own lock. The map is the memory this
// test exists to bound, and it is unexported, so the assertion lives in package server.
func limiterEntryCount(limiter *memoryLoginLimiter) int {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	return len(limiter.entries)
}

// TestMemoryLoginLimiterEvictsExpiredWindows is the C-H1 red-first test.
//
// PINNED ORACLE: every login/recover/reset limiter is a rate-limiter-flexible RateLimiterMemory, whose
// MemoryStorage deletes EACH key with its own setTimeout(duration) when the window is created
// (SillyTavern/node_modules/rate-limiter-flexible/lib/component/MemoryStorage/MemoryStorage.js:30-50).
// Pinned's state is therefore bounded by the windows created in the last `duration`; before the fix the
// GoTavern map only lost a key when that same key was touched again after its window ended, so an
// attacker spraying distinct keys (the key is client IP, and X-Real-IP/X-Forwarded-For is attacker
// controlled when rateLimiting.preferRealIpHeader is on) grew the map for the process lifetime.
func TestMemoryLoginLimiterEvictsExpiredWindows(t *testing.T) {
	const keys = 10000
	limiter := &memoryLoginLimiter{points: 5, duration: time.Minute, entries: make(map[string]loginAttemptWindow)}
	start := time.Unix(1700000000, 0)
	for index := 0; index < keys; index++ {
		key := "198.51.100." + strconv.Itoa(index)
		allowed, wait := limiter.consume(key, start)
		if !allowed || wait != 0 {
			t.Fatalf("consume(%q, first attempt) = (%t, %v), want (true, 0)", key, allowed, wait)
		}
	}
	if got := limiterEntryCount(limiter); got != keys {
		t.Fatalf("live windows right after %d distinct keys = %d, want %d (the fixture must insert all keys)", keys, got, keys)
	}

	// Advance past the window duration without touching most keys, then make one ordinary request. Pinned
	// has deleted every one of those keys by now, so only the key touched by this request may remain.
	later := start.Add(time.Minute)
	allowed, wait := limiter.consume("192.0.2.7", later)
	if !allowed || wait != 0 {
		t.Fatalf("consume on a new key after every earlier window expired = (%t, %v), want (true, 0)", allowed, wait)
	}
	if got := limiterEntryCount(limiter); got > 1 {
		t.Fatalf("after all 10000 windows expired, the limiter still holds %d entries; pinned's MemoryStorage deletes each key with a per-key timeout at expiry, so this map must be bounded by the active windows (want 1, the key just touched)", got)
	}

	// The same must hold for a key whose window expired and is touched again: it behaves as a fresh
	// window, and its stale window must not resurrect the other 9999.
	allowed, wait = limiter.consume("198.51.100.9", later)
	if !allowed || wait != 0 {
		t.Fatalf("consume on an expired key = (%t, %v), want a fresh window (true, 0)", allowed, wait)
	}
	if got := limiterEntryCount(limiter); got > 2 {
		t.Fatalf("after touching an expired key, live windows = %d, want at most the two keys touched since expiry", got)
	}
}

// TestMemoryLoginLimiterHonestKeyWindowsAndClear pins the semantics that must not change while the
// eviction is added: an honest client gets exactly `points` attempts per window, the blocked answer names
// the remaining window, a later attempt starts a fresh window, and clear drops the key.
func TestMemoryLoginLimiterHonestKeyWindowsAndClear(t *testing.T) {
	limiter := &memoryLoginLimiter{points: 5, duration: time.Minute, entries: make(map[string]loginAttemptWindow)}
	now := time.Unix(1700000000, 0)
	const key = "203.0.113.5"
	for attempt := 1; attempt <= 5; attempt++ {
		allowed, wait := limiter.consume(key, now)
		if !allowed || wait != 0 {
			t.Fatalf("consume #%d = (%t, %v), want (true, 0)", attempt, allowed, wait)
		}
	}
	if allowed, wait := limiter.consume(key, now); allowed || wait != time.Minute {
		t.Fatalf("sixth consume = (%t, %v), want (false, 1m)", allowed, wait)
	}
	if exceeded, wait := limiter.exceeded(key, now); !exceeded || wait != time.Minute {
		t.Fatalf("exceeded = (%t, %v), want (true, 1m)", exceeded, wait)
	}
	// A different key must not be affected by another key's exhausted window.
	if exceeded, _ := limiter.exceeded("203.0.113.6", now); exceeded {
		t.Fatal("exceeded for an untouched key, want false")
	}
	if got := limiterEntryCount(limiter); got != 1 {
		t.Fatalf("exceeded created %d live windows, want 1 (only the consumed key; pinned's get does not create state)", got)
	}
	// After the window, the same key starts over.
	if allowed, wait := limiter.consume(key, now.Add(time.Minute)); !allowed || wait != 0 {
		t.Fatalf("consume after expiry = (%t, %v), want a fresh window (true, 0)", allowed, wait)
	}
	// clear drops the key: the next consume is allowed and the map does not retain it.
	limiter.clear(key)
	if got := limiterEntryCount(limiter); got != 0 {
		t.Fatalf("live windows after clear = %d, want 0", got)
	}
	if allowed, wait := limiter.consume(key, now.Add(2*time.Minute)); !allowed || wait != 0 {
		t.Fatalf("consume after clear = (%t, %v), want (true, 0)", allowed, wait)
	}
}
