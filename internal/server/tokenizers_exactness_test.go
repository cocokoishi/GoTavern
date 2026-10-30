package server

// The four properties this file proves, one test each. They exist because the rank-5 gap is
// "an inexact token count is indistinguishable from an exact one", and the pinned server has no
// exact-vs-estimate distinction at all: docs/tokenizer-parity-plan.md:153-155 records the
// fallback as `ceil(byteLength / 3.35)`, and plan section 9.1 records that a boundary pair
// compared against a server answering that way is evidence for arithmetic rather than for
// tokenization. So the gate below REFUSES such a server instead of comparing against it.
//
//  1. DISCOVERY ORDER, EXECUTED, NOT TRANSCRIBED. Three trees, each holding a DIFFERENT real
//     tokenizer under the SAME file name the route loads, so the response BODY identifies which
//     level answered. Each expectation is the pinned recording for that tokenizer, so this is
//     not a restatement of tokenizerAssetCandidates: inverting the order turns it red on a named
//     assertion. Both a legacy-only tree and a development-only tree must resolve, and
//     src/tokenizers must win when present -- that order is what makes a release archive's
//     src/tokenizers/ layout loadable.
//
//  2. ONE EXACT COUNT FROM THE ORACLE. GoTavern's count AND ids for a recorded input equal the
//     recording, and two recorded message lists whose PINNED counts differ by exactly one token
//     straddle a context boundary at a budget taken from the recording. The expectation is never
//     hand-derived: the numbers come out of tests/oracle/sillytavern-1.19.0-tokenizers.json.
//
//  3. THE FALLBACK IS VISIBLE AND REFUSED, as two SEPARATE assertions. A server with no
//     tokenizer tree says so (response headers plus a stable log marker), the boundary gate
//     refuses it, and the gate performs ZERO comparisons while refusing -- so "green because it
//     silently skipped" is impossible. The same gate on an exact server must accept and compare,
//     so a gate that refuses everything cannot pass either.
//
//  4. A RELEASE-SHAPED TREE IS NOT THE PROMISED ONE. An unpacked-release tree with no tokenizer
//     data is not reported exact and is refused; a tree that resolves from the LEGACY level is
//     exact but reports the level it used, so the archive's promise (src/tokenizers/) cannot be
//     satisfied silently by something else. That legacy case is exact ON PURPOSE -- see the
//     comment in tokenizers.go: an installation made from release v0.1.0-alpha.1 must keep
//     tokenizing exactly after only the binary is updated.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/tokenizers"
)

// tokenizerExactCountModel is the tokenizer the exact-count and boundary assertions use. It is
// SentencePiece, so the count is the plain sum over the message values with no chat overhead,
// and its whole recorded corpus is exact -- see the "what the recording can and cannot support"
// note in TestTokenizerExactCountAndIDsMatchTheOracleAtAContextBoundary.
const tokenizerExactCountModel = "llama"

// The two recorded message lists the boundary assertion straddles: same message SHAPE
// ({role, content, name}), so the one-token difference is attributable to the content value
// alone, and both counts are pinned recordings rather than derivations.
const (
	tokenizerBoundaryShortCase = "openai/count#llama#numeric_then_name" // pinned token_count 8
	tokenizerBoundaryLongCase  = "openai/count#llama#array_then_name"   // pinned token_count 9
)

// errTokenizerBoundaryRefused is the sentinel every refusal from the boundary gate wraps. A test
// asserts errors.Is against it, so "the gate returned an error" cannot pass for a refusal on an
// unrelated ground (a route returning 500, a missing fixture, ...).
var errTokenizerBoundaryRefused = errors.New("tokenizer boundary gate refused")

// --- recorded pinned cases ---------------------------------------------------------------

// tokenizerRecordedCase is one case from the pinned capture: the request the probe sent and the
// response the pinned server answered with.
type tokenizerRecordedCase struct {
	Name    string
	Path    string
	Query   map[string]string
	Request json.RawMessage
	Status  int
	Body    json.RawMessage
}

func tokenizerRecordedCaseFor(t *testing.T, fixture tokenizerRouteFixture, name string) tokenizerRecordedCase {
	t.Helper()
	capture, ok := fixture.Responses[name]
	if !ok {
		t.Fatalf("the pinned recording has no case %q; the oracle this file depends on has moved", name)
	}
	recorded := tokenizerRecordedCase{
		Name:    name,
		Path:    capture.Request.Path,
		Query:   capture.Request.Query,
		Request: capture.Request.Body,
		Status:  capture.Status,
		Body:    capture.Body,
	}
	if recorded.Status != http.StatusOK {
		t.Fatalf("%s: recorded status %d, want 200", name, recorded.Status)
	}
	if len(recorded.Request) == 0 || len(recorded.Body) == 0 {
		t.Fatalf("%s: recorded request or body is empty", name)
	}
	return recorded
}

// target reconstructs the request target the pinned probe used, including the dispatch model.
func (recorded tokenizerRecordedCase) target() string {
	if model := recorded.Query["model"]; model != "" {
		return recorded.Path + "?model=" + url.QueryEscape(model)
	}
	return recorded.Path
}

// tokenizerEncodeBody is the pinned encode response shape, kept separate from the handler's own
// struct so a handler change cannot silently redefine the expectation.
type tokenizerEncodeBody struct {
	IDs    []int    `json:"ids"`
	Count  int      `json:"count"`
	Chunks []string `json:"chunks"`
}

func (recorded tokenizerRecordedCase) encode(t *testing.T) tokenizerEncodeBody {
	t.Helper()
	var body tokenizerEncodeBody
	if err := json.Unmarshal(recorded.Body, &body); err != nil {
		t.Fatalf("%s: recorded encode body is not the pinned shape: %v", recorded.Name, err)
	}
	if body.Count != len(body.IDs) {
		t.Fatalf("%s: the recording's own count %d does not match its %d ids", recorded.Name, body.Count, len(body.IDs))
	}
	return body
}

// pinnedCount decodes the recorded `token_count` of a count-route case.
func (recorded tokenizerRecordedCase) pinnedCount(t *testing.T) int {
	t.Helper()
	var body struct {
		Count *int `json:"token_count"`
	}
	if err := json.Unmarshal(recorded.Body, &body); err != nil || body.Count == nil {
		t.Fatalf("%s: recorded body is not a count response: %v (%s)", recorded.Name, err, recorded.Body)
	}
	return *body.Count
}

// tokenizerOracleBoundaryAnchor builds the one-token boundary anchor from the recording alone.
func tokenizerOracleBoundaryAnchor(t *testing.T, fixture tokenizerRouteFixture) tokenizerBoundaryAnchor {
	t.Helper()
	short := tokenizerRecordedCaseFor(t, fixture, tokenizerBoundaryShortCase)
	long := tokenizerRecordedCaseFor(t, fixture, tokenizerBoundaryLongCase)
	return tokenizerBoundaryAnchor{
		Model: tokenizerExactCountModel,
		Short: tokenizerBoundaryCase{Name: short.Name, Body: short.Request, Count: short.pinnedCount(t)},
		Long:  tokenizerBoundaryCase{Name: long.Name, Body: long.Request, Count: long.pinnedCount(t)},
	}
}

// --- route plumbing ----------------------------------------------------------------------

// postTokenizerRecorded replays one recorded case against the handler under test, with the
// recorded request body sent VERBATIM (the §6.1 surrogate cases depend on that).
func postTokenizerRecorded(t *testing.T, handler http.Handler, recorded tokenizerRecordedCase) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, recorded.target(), bytes.NewReader(recorded.Request))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("%s: status = %d, want the pinned 200: %s", recorded.Name, response.Code, response.Body.String())
	}
	return response
}

// tokenizerCountForBody asks the pinned count route for the count of one message-list body,
// returning an error rather than failing, so the boundary gate can decide what a refusal is.
func tokenizerCountForBody(handler http.Handler, model string, body []byte) (int, error) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/tokenizers/openai/count?model="+url.QueryEscape(model), bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		return 0, fmt.Errorf("the count route answered HTTP %d: %s", response.Code, response.Body.String())
	}
	var answer struct {
		Count *int `json:"token_count"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &answer); err != nil {
		return 0, fmt.Errorf("the count route answered a body that is not a count response: %v (%s)", err, response.Body.String())
	}
	if answer.Count == nil {
		return 0, fmt.Errorf("the count route answered no token_count: %s", response.Body.String())
	}
	return *answer.Count, nil
}

// newTokenizerTestHandler builds the handler under test for one install root. The warning writer
// is substituted so the stable marker is asserted from bytes rather than assumed to be printed.
func newTokenizerTestHandler(t *testing.T, installRoot string, console io.Writer) http.Handler {
	t.Helper()
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot:      installRoot,
		DataRoot:         t.TempDir(),
		DisableCSRF:      true,
		tokenizerConsole: console,
	})
}

// tokenizerStatusFromHeaders reads the exactness observable off a response, and REFUSES to guess
// when it is absent: an unlabelled response is never treated as exact.
func tokenizerStatusFromHeaders(t *testing.T, response *httptest.ResponseRecorder) tokenizerStatus {
	t.Helper()
	status, err := tokenizerStatusFromHeaderValues(response.Header().Get(tokenizerExactHeader), response.Header().Get(tokenizerLayoutHeader))
	if err != nil {
		t.Fatalf("%v (headers: %v)", err, response.Header())
	}
	return status
}

// tokenizerStatusFromHeaderValues is the one decoder both the test assertions and the gate use,
// so a response that satisfies the test cannot be rejected by the gate for a different reason.
func tokenizerStatusFromHeaderValues(exact, layout string) (tokenizerStatus, error) {
	switch exact {
	case "true":
		return tokenizerStatus{Exact: true, Layout: layout}, nil
	case "false":
		return tokenizerStatus{Exact: false, Layout: layout}, nil
	case "":
		return tokenizerStatus{}, fmt.Errorf("%w: the tokenizer route answered with no %s header, so an exact count was not claimed and must not be assumed",
			errTokenizerBoundaryRefused, tokenizerExactHeader)
	default:
		return tokenizerStatus{}, fmt.Errorf("%w: %s = %q is neither \"true\" nor \"false\"",
			errTokenizerBoundaryRefused, tokenizerExactHeader, exact)
	}
}

// tokenizerExactnessOf asks the server itself whether it can tokenize exactly: one POST to a
// tokenizer route, and the answer comes from the response headers the route stamps.
func tokenizerExactnessOf(handler http.Handler) (tokenizerStatus, error) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/tokenizers/llama/encode", strings.NewReader(`{"text":"a"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		return tokenizerStatus{}, fmt.Errorf("%w: the exactness probe answered HTTP %d, so this server's tokenizer state is unknown",
			errTokenizerBoundaryRefused, response.Code)
	}
	return tokenizerStatusFromHeaderValues(response.Header().Get(tokenizerExactHeader), response.Header().Get(tokenizerLayoutHeader))
}

// requireExactTokenizerServer is the gate every boundary/parity assertion must pass through
// before it compares a boundary pair. It fails loudly, naming what the server reported, instead
// of letting the comparison run against estimates.
func requireExactTokenizerServer(t *testing.T, handler http.Handler) tokenizerStatus {
	t.Helper()
	status, err := tokenizerExactnessOf(handler)
	if err != nil {
		t.Fatalf("%v", err)
	}
	if !status.Exact {
		t.Fatalf("REFUSED: this server reports %s=false %s=%q, so its counts are the pinned fallback %s "+
			"(ceil(bytes/3.35)) rather than tokenizer output, and a context boundary measured here is not evidence",
			tokenizerExactHeader, tokenizerLayoutHeader, status.Layout, tokenizerGuesstimateMarker)
	}
	return status
}

// --- the boundary gate ------------------------------------------------------------------

// tokenizerBoundaryCase is one recorded message list and its pinned count.
type tokenizerBoundaryCase struct {
	Name  string
	Body  json.RawMessage
	Count int
}

// tokenizerBoundaryAnchor is a recorded context-boundary pair: two message lists one pinned token
// apart. The gate refuses to compare anything else.
type tokenizerBoundaryAnchor struct {
	Model string
	Short tokenizerBoundaryCase
	Long  tokenizerBoundaryCase
}

// tokenizerBoundaryMeasurement is what the gate measured, and how much of it.
type tokenizerBoundaryMeasurement struct {
	Exact         tokenizerStatus
	Compared      int // boundary pairs actually compared; 0 means the gate refused before measuring
	ShortTokens   int
	LongTokens    int
	ShortRecorded int
	LongRecorded  int
}

// tokenizerBoundaryGate is the boundary/parity gate itself. On an exact server it measures the
// anchored pair and returns the counts; on a server that cannot tokenize exactly it REFUSES and
// compares nothing, because a pair compared against ceil(bytes/3.35) is not a context boundary.
func tokenizerBoundaryGate(handler http.Handler, anchor tokenizerBoundaryAnchor) (tokenizerBoundaryMeasurement, error) {
	measurement := tokenizerBoundaryMeasurement{
		ShortRecorded: anchor.Short.Count,
		LongRecorded:  anchor.Long.Count,
	}
	status, err := tokenizerExactnessOf(handler)
	if err != nil {
		return measurement, err
	}
	measurement.Exact = status
	if !status.Exact {
		return measurement, fmt.Errorf("%w: the server reports %s=false %s=%q, so the counts it would answer are the pinned "+
			"fallback estimate (ceil(bytes/3.35), docs/tokenizer-parity-plan.md:153); comparing the recorded one-token pair "+
			"against it would measure the estimate's arithmetic, not the tokenizer's",
			errTokenizerBoundaryRefused, tokenizerExactHeader, tokenizerLayoutHeader, status.Layout)
	}
	if anchor.Long.Count != anchor.Short.Count+1 {
		return measurement, fmt.Errorf("%w: the anchor cases %q (%d) and %q (%d) are not one token apart, so comparing them "+
			"is not a boundary comparison", errTokenizerBoundaryRefused, anchor.Short.Name, anchor.Short.Count, anchor.Long.Name, anchor.Long.Count)
	}
	measurement.ShortTokens, err = tokenizerCountForBody(handler, anchor.Model, anchor.Short.Body)
	if err != nil {
		return measurement, fmt.Errorf("measuring %q: %w", anchor.Short.Name, err)
	}
	measurement.LongTokens, err = tokenizerCountForBody(handler, anchor.Model, anchor.Long.Body)
	if err != nil {
		return measurement, fmt.Errorf("measuring %q: %w", anchor.Long.Name, err)
	}
	measurement.Compared = 1
	if measurement.ShortTokens != anchor.Short.Count || measurement.LongTokens != anchor.Long.Count {
		return measurement, fmt.Errorf("the recorded one-token pair %q (%d) / %q (%d) is answered as %d / %d",
			anchor.Short.Name, anchor.Short.Count, anchor.Long.Name, anchor.Long.Count,
			measurement.ShortTokens, measurement.LongTokens)
	}
	return measurement, nil
}

// --- plumbing for building tokenizer trees ------------------------------------------------

// vendoredTokenizerBytes reads one file of the vendored development tree.
func vendoredTokenizerBytes(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "upstream", "tokenizers", name))
	if err != nil {
		t.Fatalf("read the vendored %s: %v", name, err)
	}
	return raw
}

// writeTokenizerTreeLevel puts the bytes of a real vendored tokenizer at <root>/<layout>/<file>.
// The bytes are copied, never synthesized: a fixture model would prove nothing about the loader.
func writeTokenizerTreeLevel(t *testing.T, root, layout, file, vendoredModel string) {
	t.Helper()
	directory := filepath.Join(root, filepath.FromSlash(layout))
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("create %s: %v", directory, err)
	}
	raw := vendoredTokenizerBytes(t, vendoredModel+".model")
	if err := os.WriteFile(filepath.Join(directory, file), raw, 0o644); err != nil {
		t.Fatalf("write %s: %v", file, err)
	}
}

// TestTokenizerTreeDiscoveryOrderIsProvenByTheTokenizerItLoads executes the discovery order.
//
// Three candidate levels each receive a DIFFERENT real model under the single file name the
// `llama/encode` route loads, so the answer identifies the level: gemma's bytes at
// src/tokenizers, mistral's at the legacy root tree, and llama's own at the development level.
// Every expectation is the pinned recording for the tokenizer whose bytes are in place, so the
// test measures what the server loaded rather than what the search function says it looks for.
func TestTokenizerTreeDiscoveryOrderIsProvenByTheTokenizerItLoads(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	request := tokenizerRecordedCaseFor(t, fixture, "llama/encode#ascii")

	levels := []struct {
		layout string
		model  string
	}{
		{"src/tokenizers", "gemma"},
		{"tokenizers", "mistral"},
		{"upstream/tokenizers", "llama"},
	}
	pinnedBodies := map[string]tokenizerEncodeBody{}
	for _, level := range levels {
		pinnedBodies[level.model] = tokenizerRecordedCaseFor(t, fixture, level.model+"/encode#ascii").encode(t)
	}

	// DISCRIMINATION FIRST. If two levels tokenized this input identically, the test could not
	// tell them apart and would pass for the wrong reason (AGENTS.md rule 15 applied to the
	// fixture), so that is a failure of the test rather than of the implementation. The recorded
	// COUNTS alone would not discriminate -- all three count 4 -- which is why the whole body,
	// ids included, is what has to differ.
	for index, level := range levels {
		for _, other := range levels[index+1:] {
			if tokenizerEncodeBodiesEqual(pinnedBodies[level.model], pinnedBodies[other.model]) {
				t.Fatalf("the pinned recordings for %s and %s are identical for %q, so the three levels cannot be told apart",
					level.model, other.model, request.Name)
			}
		}
	}
	for _, level := range levels {
		t.Logf("pinned %s answer for %q: count %d ids %v", level.model, "Hello, world!", pinnedBodies[level.model].Count, pinnedBodies[level.model].IDs)
	}

	root := t.TempDir()
	for _, level := range levels {
		writeTokenizerTreeLevel(t, root, level.layout, "llama.model", level.model)
	}

	phases := []struct {
		name        string
		remove      []string
		wantLayout  string
		wantModel   string
		wantMessage string
	}{
		{
			name:        "all three levels present",
			wantLayout:  "src/tokenizers",
			wantModel:   "gemma",
			wantMessage: "src/tokenizers must win over both the legacy root tree and the development tree when all three exist",
		},
		{
			name:        "legacy and development levels only",
			remove:      []string{"src/tokenizers"},
			wantLayout:  "tokenizers",
			wantModel:   "mistral",
			wantMessage: "with src/tokenizers absent the legacy root tree must win, so an installation made from the old release keeps tokenizing exactly",
		},
		{
			name:        "development level only",
			remove:      []string{"src/tokenizers", "tokenizers"},
			wantLayout:  "upstream/tokenizers",
			wantModel:   "llama",
			wantMessage: "a tree at the development level must still resolve, which is what a repository checkout has",
		},
	}
	for _, phase := range phases {
		for _, layout := range phase.remove {
			if err := os.RemoveAll(filepath.Join(root, filepath.FromSlash(layout))); err != nil {
				t.Fatalf("%s: remove %s: %v", phase.name, layout, err)
			}
		}
		handler := newTokenizerTestHandler(t, root, io.Discard)
		response := postTokenizerRecorded(t, handler, request)

		// CONTENT FIRST: which tokenizer's bytes answered. This is the assertion a precedence
		// inversion must break, and it is measured from the response body, not from the search
		// function's own label.
		var got tokenizerEncodeBody
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: response is not an encode object: %v", phase.name, err)
		}
		want := pinnedBodies[phase.wantModel]
		if !tokenizerEncodeBodiesEqual(got, want) {
			t.Fatalf("%s: %s; got ids %v count %d chunks %q, the pinned %s answer is ids %v count %d chunks %q",
				phase.name, phase.wantMessage, got.IDs, got.Count, got.Chunks, phase.wantModel, want.IDs, want.Count, want.Chunks)
		}
		// And the OTHER levels' tokenizers must NOT be what answered, so the assertion above is
		// about precedence rather than about "some tokenizer answered".
		for _, level := range levels {
			if level.model == phase.wantModel {
				continue
			}
			if tokenizerEncodeBodiesEqual(got, pinnedBodies[level.model]) {
				t.Fatalf("%s: the response equals the pinned %s answer, so the %s level won instead of %q",
					phase.name, level.model, level.layout, phase.wantLayout)
			}
		}

		// THEN the reported layout, so a server that loads the right tree but names a different
		// level is also caught.
		status := tokenizerStatusFromHeaders(t, response)
		if !status.Exact {
			t.Fatalf("%s: the server reports %s=false %s=%q although a tokenizer tree exists at %q",
				phase.name, tokenizerExactHeader, tokenizerLayoutHeader, status.Layout, filepath.Join(root, phase.wantLayout))
		}
		if status.Layout != phase.wantLayout {
			t.Fatalf("%s: %s = %q, want %q", phase.name, tokenizerLayoutHeader, status.Layout, phase.wantLayout)
		}
	}

	// Finally: with no tree at all the answer is the pinned guesstimate. This is the collision
	// that makes the marker necessary -- ceil(13 bytes / 3.35) is 4, which is EXACTLY the pinned
	// llama count for "Hello, world!", so a client reading only `count` cannot tell an exact
	// count from an estimate on this input. Only the ids (and the marker) distinguish them.
	for _, layout := range []string{"src/tokenizers", "tokenizers", "upstream/tokenizers"} {
		if err := os.RemoveAll(filepath.Join(root, filepath.FromSlash(layout))); err != nil {
			t.Fatal(err)
		}
	}
	handler := newTokenizerTestHandler(t, root, io.Discard)
	empty := postTokenizerRecorded(t, handler, request)
	status := tokenizerStatusFromHeaders(t, empty)
	if status.Exact || status.Layout != tokenizerLayoutNone {
		t.Fatalf("with every tokenizer level removed the server reports %s=%t %s=%q, want false/%q",
			tokenizerExactHeader, status.Exact, tokenizerLayoutHeader, status.Layout, tokenizerLayoutNone)
	}
	var estimated tokenizerEncodeBody
	if err := json.Unmarshal(empty.Body.Bytes(), &estimated); err != nil {
		t.Fatal(err)
	}
	if estimated.Count != tokenizers.Guesstimate("Hello, world!") {
		t.Fatalf("the tree-less answer counts %d, want the pinned guesstimate %d", estimated.Count, tokenizers.Guesstimate("Hello, world!"))
	}
	// THE COLLISION, measured rather than described: for this input ceil(13 bytes / 3.35) is 4,
	// which is EXACTLY the pinned llama count, so `count` is the same number whether the server
	// tokenized or estimated. A client reading only `count` therefore cannot tell an exact answer
	// from an estimate -- which is the whole reason the exactness observable exists, and the
	// reason a boundary assertion must refuse instead of trusting the number.
	if estimated.Count != pinnedBodies["llama"].Count {
		t.Fatalf("the tree-less estimate %d and the pinned llama count %d differ on this input; the collision this "+
			"test records no longer exists, so re-derive the argument in the file header rather than deleting the check",
			estimated.Count, pinnedBodies["llama"].Count)
	}
	if equalIntSlicesRoute(estimated.IDs, pinnedBodies["llama"].IDs) {
		t.Fatalf("the tree-less answer carries the pinned ids %v, so it is not the guesstimate", estimated.IDs)
	}
	t.Logf("measured: the tree-less answer is count %d ids[] and the pinned llama answer is count %d ids %v -- the COUNT is "+
		"identical, so only the observable can distinguish exact from inexact",
		estimated.Count, pinnedBodies["llama"].Count, pinnedBodies["llama"].IDs)
}

func tokenizerEncodeBodiesEqual(left, right tokenizerEncodeBody) bool {
	return equalIntSlicesRoute(left.IDs, right.IDs) && left.Count == right.Count && equalStringSlicesRoute(left.Chunks, right.Chunks)
}

// TestTokenizerExactCountAndIDsMatchTheOracleAtAContextBoundary anchors one exact count and its
// token ids to the pinned recording, then uses two recorded counts one token apart as the
// context boundary.
//
// WHAT THE RECORDING CAN SUPPORT, precisely. It carries exact counts for message-array bodies
// and exact ids for the encode routes, for every recorded tokenizer. It CANNOT support an exact
// count where the pinned server itself answered the guesstimate: the object-body cases
// (`openai/count#llama#object_body`, `..._long`) are recorded `token_count`s of
// ceil(bytes/3.35), and replaying them as an "exact count" expectation would assert the estimate,
// not the tokenizer -- those cases belong to the pinned fallback and are asserted as that
// elsewhere. It also cannot support an exact count for the HF family's unpaired-surrogate class,
// which plan section 9.1 records as `partial`. llama is chosen because its whole corpus is exact,
// and every expectation below is read out of the recording rather than derived.
func TestTokenizerExactCountAndIDsMatchTheOracleAtAContextBoundary(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	anchor := tokenizerOracleBoundaryAnchor(t, fixture)

	// The pair must straddle the boundary by exactly one pinned token, or the boundary assertion
	// below would be testing something else.
	if anchor.Long.Count != anchor.Short.Count+1 {
		t.Fatalf("the recorded pair %q (%d) / %q (%d) is not one token apart",
			anchor.Short.Name, anchor.Short.Count, anchor.Long.Name, anchor.Long.Count)
	}
	// And an estimate must not produce either recorded count, or an inexact server could satisfy
	// the count assertions by accident. This is the discriminating check for the assertion below.
	for _, boundary := range []tokenizerBoundaryCase{anchor.Short, anchor.Long} {
		estimate := tokenizers.Guesstimate(compactJSONText(boundary.Body))
		if estimate == boundary.Count {
			t.Fatalf("%s: the guesstimate of the recorded body (%d) equals the pinned count, so the exact-count assertion cannot distinguish exact from inexact on this input", boundary.Name, estimate)
		}
	}

	// THE GATE, on an exact server: it must accept and compare the anchored pair.
	handler := tokenizerRouteHandler(t)
	measurement, err := tokenizerBoundaryGate(handler, anchor)
	if err != nil {
		t.Fatalf("the boundary gate could not measure the anchored one-token pair on an exact server: %v", err)
	}
	if measurement.Compared != 1 {
		t.Fatalf("the boundary gate compared %d pairs, want 1", measurement.Compared)
	}
	if measurement.ShortTokens != anchor.Short.Count || measurement.LongTokens != anchor.Long.Count {
		t.Fatalf("the gate measured %d / %d tokens for a pair the recording pins at %d / %d",
			measurement.ShortTokens, measurement.LongTokens, anchor.Short.Count, anchor.Long.Count)
	}
	t.Logf("pinned pair measured exactly: %q = %d tokens, %q = %d tokens (one token apart)",
		anchor.Short.Name, anchor.Short.Count, anchor.Long.Name, anchor.Long.Count)

	// THE EXACT COUNT, and the ids the recording carries for the same input and tokenizer.
	encodeCase := tokenizerRecordedCaseFor(t, fixture, tokenizerExactCountModel+"/encode#ascii")
	wantEncode := encodeCase.encode(t)
	var gotEncode tokenizerEncodeBody
	response := postTokenizerRecorded(t, handler, encodeCase)
	if err := json.Unmarshal(response.Body.Bytes(), &gotEncode); err != nil {
		t.Fatalf("%s: response is not an encode object: %v", encodeCase.Name, err)
	}
	if !equalIntSlicesRoute(gotEncode.IDs, wantEncode.IDs) {
		t.Fatalf("the exact token ids for %q under %s are %v, pinned %v: a guesstimating server has no ids at all",
			"Hello, world!", tokenizerExactCountModel, gotEncode.IDs, wantEncode.IDs)
	}
	if gotEncode.Count != wantEncode.Count {
		t.Fatalf("the exact count for %q under %s is %d, pinned %d",
			"Hello, world!", tokenizerExactCountModel, gotEncode.Count, wantEncode.Count)
	}
	if !equalStringSlicesRoute(gotEncode.Chunks, wantEncode.Chunks) {
		t.Fatalf("the exact chunks for %q are %q, pinned %q", "Hello, world!", gotEncode.Chunks, wantEncode.Chunks)
	}

	// THE BOUNDARY: budgets come from the RECORDING, the counts from the SERVER, so the two sides
	// never share an expectation.
	shortBudget := anchor.Short.Count
	shortTokens, err := tokenizerCountForBody(handler, anchor.Model, anchor.Short.Body)
	if err != nil {
		t.Fatal(err)
	}
	longTokens, err := tokenizerCountForBody(handler, anchor.Model, anchor.Long.Body)
	if err != nil {
		t.Fatal(err)
	}
	if shortTokens != shortBudget {
		t.Fatalf("the count of %q is %d, pinned %d", anchor.Short.Name, shortTokens, shortBudget)
	}
	if longTokens != anchor.Long.Count {
		t.Fatalf("the count of %q is %d, pinned %d", anchor.Long.Name, longTokens, anchor.Long.Count)
	}
	// A budget of exactly the shorter count admits the shorter message and drops the longer one.
	if shortTokens > shortBudget {
		t.Fatalf("the message the recording counts as %d does not fit a budget of %d", shortBudget, shortBudget)
	}
	if longTokens <= shortBudget {
		t.Fatalf("the one-token-longer message fits a budget of %d, so the recorded pair does not straddle the boundary", shortBudget)
	}
	// And one token of budget later it fits: the flip is at exactly one token, not somewhere else.
	longBudget := anchor.Long.Count
	if longTokens > longBudget {
		t.Fatalf("the one-token-longer message still does not fit a budget of %d, so the boundary is somewhere else", longBudget)
	}
	// The provider-style payloads differ by exactly that message: the admitted history carries it,
	// the refused one is empty rather than truncated to a different message.
	admitted := anchor.Long.Body
	refused := json.RawMessage("[]")
	if bytes.Equal(admitted, refused) {
		t.Fatalf("the admitted and refused payloads are identical")
	}
	if count, err := tokenizerCountForBody(handler, anchor.Model, admitted); err != nil || count != longTokens {
		t.Fatalf("the admitted payload counts %d (err %v), want %d", count, err, longTokens)
	}
	if count, err := tokenizerCountForBody(handler, anchor.Model, refused); err != nil || count != 0 {
		t.Fatalf("the refused (empty) payload counts %d (err %v), want 0", count, err)
	}
}

// TestTokenizerGuesstimateIsReportedAndTheBoundaryGateRefusesIt asserts BOTH halves separately:
// the marker appears, and the gate refuses without comparing. A single assertion here would let
// "the gate is green because it silently skipped" through.
func TestTokenizerGuesstimateIsReportedAndTheBoundaryGateRefusesIt(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	anchor := tokenizerOracleBoundaryAnchor(t, fixture)

	root := t.TempDir()
	var warnings bytes.Buffer
	handler := newTokenizerTestHandler(t, root, &warnings)
	encodeCase := tokenizerRecordedCaseFor(t, fixture, tokenizerExactCountModel+"/encode#ascii")

	// HALF ONE (log): the operator-visible marker is emitted, with the paths that were tried.
	if !strings.Contains(warnings.String(), tokenizerGuesstimateMarker) {
		t.Fatalf("a server with no tokenizer tree printed no %q marker; the operator log is %q",
			tokenizerGuesstimateMarker, warnings.String())
	}
	t.Logf("warning line: %s", strings.TrimSpace(warnings.String()))

	// HALF ONE (HTTP): the response says it, and the body still carries the pinned guesstimate,
	// so the marker describes what the response actually is.
	response := postTokenizerRecorded(t, handler, encodeCase)
	status := tokenizerStatusFromHeaders(t, response)
	if status.Exact {
		t.Fatalf("a server with no tokenizer tree reports %s=true %s=%q; an inexact count is then indistinguishable from an exact one",
			tokenizerExactHeader, tokenizerLayoutHeader, status.Layout)
	}
	if status.Layout != tokenizerLayoutNone {
		t.Fatalf("%s = %q, want %q", tokenizerLayoutHeader, status.Layout, tokenizerLayoutNone)
	}
	var estimated tokenizerEncodeBody
	if err := json.Unmarshal(response.Body.Bytes(), &estimated); err != nil {
		t.Fatal(err)
	}
	if estimated.Count != tokenizers.Guesstimate("Hello, world!") || len(estimated.IDs) != 0 {
		t.Fatalf("the tree-less answer is ids %v count %d, want no ids and the pinned guesstimate %d",
			estimated.IDs, estimated.Count, tokenizers.Guesstimate("Hello, world!"))
	}

	// HALF TWO: the gate REFUSES, and it compares NOTHING while doing so.
	measurement, err := tokenizerBoundaryGate(handler, anchor)
	if err == nil {
		t.Fatalf("the boundary gate accepted a guesstimating server (compared %d pairs, measured %d/%d)",
			measurement.Compared, measurement.ShortTokens, measurement.LongTokens)
	}
	if !errors.Is(err, errTokenizerBoundaryRefused) {
		t.Fatalf("the boundary gate failed for a reason that is not a refusal: %v", err)
	}
	if measurement.Compared != 0 {
		t.Fatalf("the gate refused but still compared %d boundary pairs: a refused comparison is not evidence for anything",
			measurement.Compared)
	}
	if measurement.ShortTokens != 0 || measurement.LongTokens != 0 {
		t.Fatalf("the gate measured %d/%d tokens against a guesstimating server", measurement.ShortTokens, measurement.LongTokens)
	}
	if !strings.Contains(err.Error(), tokenizerGuesstimateMarker) && !strings.Contains(err.Error(), tokenizerExactHeader) {
		t.Fatalf("the refusal does not name the observable that produced it: %v", err)
	}
	t.Logf("gate refusal: %v", err)

	// THE GATE IS NOT A BLANKET REFUSAL: the same gate on an exact server accepts and compares.
	exactHandler := tokenizerRouteHandler(t)
	exactMeasurement, err := tokenizerBoundaryGate(exactHandler, anchor)
	if err != nil {
		t.Fatalf("the gate refused an exact server, so it would never compare anything: %v", err)
	}
	if exactMeasurement.Compared != 1 {
		t.Fatalf("the gate compared %d pairs on an exact server, want 1", exactMeasurement.Compared)
	}

	// AND THE REFUSAL IS DRIVEN BY THE MARKER, not by the handler being unusual: a handler that
	// answers the same route with the same body but WITHOUT the observable is refused too. This is
	// the assertion that goes red if the marker is removed from the route.
	mute := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		respondJSON(w, http.StatusOK, tokenizerEncodeResponse{IDs: []int{}, Count: 0, Chunks: []string{}})
	})
	muteMeasurement, err := tokenizerBoundaryGate(mute, anchor)
	if err == nil || !errors.Is(err, errTokenizerBoundaryRefused) {
		t.Fatalf("the gate accepted a tokenizer route that carries no %s observable: %v", tokenizerExactHeader, err)
	}
	if muteMeasurement.Compared != 0 {
		t.Fatalf("the gate compared %d pairs against an unobservable server", muteMeasurement.Compared)
	}
	if !strings.Contains(err.Error(), tokenizerExactHeader) {
		t.Fatalf("the refusal does not name the missing header: %v", err)
	}
}

// TestTokenizerReleaseShapedTreeWithoutSrcTokenizersIsNotReportedAsExact is the packaging claim
// from the other side. The release archive promises <root>/src/tokenizers/ (that is also the
// pinned layout, src/endpoints/tokenizers.js:251-264), so an unpacked tree that shape but
// without that data must not be presented as exact, and a tree that resolves from a DIFFERENT
// level must say so instead of hiding the difference.
func TestTokenizerReleaseShapedTreeWithoutSrcTokenizersIsNotReportedAsExact(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	anchor := tokenizerOracleBoundaryAnchor(t, fixture)
	encodeCase := tokenizerRecordedCaseFor(t, fixture, tokenizerExactCountModel+"/encode#ascii")
	wantEncode := encodeCase.encode(t)

	// A release-shaped tree: everything the archive ships EXCEPT src/tokenizers/. `src/` exists
	// and is empty of tokenizer data, which is the shape a packaging bug produces.
	root := t.TempDir()
	for _, file := range []string{
		"public/index.html",
		"public/scripts/st.js",
		"default/config.yaml",
		"config.yaml",
		"package.json",
		"data/default-user/settings.json",
	} {
		path := filepath.Join(root, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("release-shaped fixture\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "src", "tokenizers")); !os.IsNotExist(err) {
		t.Fatalf("the fixture was supposed to have no src/tokenizers but stat says otherwise: %v", err)
	}

	// (1) NO TOKENIZER DATA ANYWHERE: not exact, and the gate refuses.
	handler := newTokenizerTestHandler(t, root, io.Discard)
	status := tokenizerStatusFromHeaders(t, postTokenizerRecorded(t, handler, encodeCase))
	if status.Exact {
		t.Fatalf("a release-shaped tree with no tokenizer data anywhere reports %s=true %s=%q: the promised %q layout is missing and the server hid it",
			tokenizerExactHeader, tokenizerLayoutHeader, status.Layout, "src/tokenizers")
	}
	if status.Layout != tokenizerLayoutNone {
		t.Fatalf("%s = %q, want %q", tokenizerLayoutHeader, status.Layout, tokenizerLayoutNone)
	}
	if _, err := tokenizerBoundaryGate(handler, anchor); err == nil || !errors.Is(err, errTokenizerBoundaryRefused) {
		t.Fatalf("the boundary gate did not refuse a release-shaped tree with no tokenizer data: %v", err)
	}

	// (2) LEGACY LEVEL ONLY: exact on purpose (the documented precedence), but the level is
	// REPORTED, so the absence of the promised src/tokenizers is visible instead of folded into
	// the word "exact".
	writeTokenizerTreeLevel(t, root, "tokenizers", "llama.model", "llama")
	legacyHandler := newTokenizerTestHandler(t, root, io.Discard)
	legacyResponse := postTokenizerRecorded(t, legacyHandler, encodeCase)
	legacyStatus := tokenizerStatusFromHeaders(t, legacyResponse)
	if !legacyStatus.Exact {
		t.Fatalf("a tree at the legacy root layout resolved no tokenizer: %s=false %s=%q, but an installation made from the old release must keep tokenizing exactly",
			tokenizerExactHeader, tokenizerLayoutHeader, legacyStatus.Layout)
	}
	if legacyStatus.Layout == "src/tokenizers" {
		t.Fatalf("%s = %q while no src/tokenizers exists: the promised release layout must not be claimed by a different level",
			tokenizerLayoutHeader, legacyStatus.Layout)
	}
	if legacyStatus.Layout != "tokenizers" {
		t.Fatalf("%s = %q, want %q", tokenizerLayoutHeader, legacyStatus.Layout, "tokenizers")
	}
	var legacyBody tokenizerEncodeBody
	if err := json.Unmarshal(legacyResponse.Body.Bytes(), &legacyBody); err != nil {
		t.Fatal(err)
	}
	if !tokenizerEncodeBodiesEqual(legacyBody, wantEncode) {
		t.Fatalf("the legacy tree did not tokenize exactly: got ids %v count %d, pinned ids %v count %d",
			legacyBody.IDs, legacyBody.Count, wantEncode.IDs, wantEncode.Count)
	}
	if _, err := tokenizerBoundaryGate(legacyHandler, anchor); err != nil {
		t.Fatalf("the boundary gate refused an exact legacy tree: %v", err)
	}

	// (3) THE PROMISED LAYOUT: reported as such.
	writeTokenizerTreeLevel(t, root, "src/tokenizers", "llama.model", "llama")
	releaseHandler := newTokenizerTestHandler(t, root, io.Discard)
	releaseStatus := tokenizerStatusFromHeaders(t, postTokenizerRecorded(t, releaseHandler, encodeCase))
	if releaseStatus.Layout != "src/tokenizers" {
		t.Fatalf("with src/tokenizers present %s = %q, want %q", tokenizerLayoutHeader, releaseStatus.Layout, "src/tokenizers")
	}
	if !releaseStatus.Exact {
		t.Fatalf("the release layout resolved no tokenizer")
	}
}
