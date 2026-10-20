// Package mockprovider is deterministic test infrastructure for provider-wire
// differential capture.
//
// It is a recording HTTP provider that pinned SillyTavern and GoTavern are both
// pointed at. It records every request exactly as received - method, raw
// undecoded target, header names with their original casing and order, and the
// body bytes - and replays a scripted response, including fragmented streams,
// truncated streams and a response that never ends.
//
// The request is parsed from the connection rather than through net/http,
// because net/http canonicalises header names and loses header order, and a
// provider sees the bytes on the wire rather than a reconstruction of them.
// Recording a reconstruction would hide key order, duplicate keys, number
// formatting, encoding and header casing, which is precisely what a provider
// observes.
//
// It is not part of the GoTavern server: nothing under internal/ or cmd/ may
// import it, and it must never reach a release binary.
package mockprovider

import (
	"bytes"
	"fmt"
)

// VerifyTransparency checks that the recorder stored what a client actually
// sent. A recording proxy that altered the request would invalidate every
// capture silently, so this is asserted rather than assumed: the caller passes
// the bytes it wrote and the headers it set, and gets an error naming the first
// difference.
func VerifyTransparency(sentMethod, sentTarget string, sentHeaders []Header, sentBody []byte, recorded Request) error {
	if recorded.Method != sentMethod {
		return fmt.Errorf("recorded method %q, client sent %q", recorded.Method, sentMethod)
	}
	if recorded.RawTarget != sentTarget {
		return fmt.Errorf("recorded target %q, client sent %q", recorded.RawTarget, sentTarget)
	}
	if !bytes.Equal(decodedBody(recorded), sentBody) {
		return fmt.Errorf("recorded body of %d bytes does not equal the %d bytes the client sent", recorded.BodyLength, len(sentBody))
	}
	for _, header := range sentHeaders {
		found := false
		for _, received := range recorded.Headers {
			if received.Name == header.Name && received.Value == header.Value {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("header %q: %q was sent but not recorded verbatim", header.Name, header.Value)
		}
	}
	return nil
}

func decodedBody(recorded Request) []byte {
	if recorded.BodyText != nil {
		return []byte(*recorded.BodyText)
	}
	return nil
}
