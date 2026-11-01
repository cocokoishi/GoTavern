package server

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestCharactersMultipartAccumulatesRepeatedTextFields pins the multer-compatible
// accumulation of repeated multipart text fields.
//
// WHY THIS EXISTS. The Node->Go->Node gate sent two `alternate_greetings` parts to
// /api/characters/edit (the shape the unmodified frontend produces:
// public/script.js:9879 appends one part per greeting) and the stored card kept
// only the LAST one, because this parser called setMember for every part and
// overwrote the previous value. multer appends repeated plain fields into an array
// (append-field/lib/set-value.js), which is the shape charaFormatData expects
// (src/endpoints/characters.js:584-588). A card edited through GoTavern therefore
// lost alternate greetings the user never deleted.
//
// The test discriminates on the FIELD SHAPE, not merely the value: a single
// occurrence must stay a scalar string, and repeated occurrences must become an
// array in wire order. A parser that always builds an array would pass a
// value-only check but would not be equivalent to multer for every other route.
func TestCharactersMultipartAccumulatesRepeatedTextFields(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("ch_name", "Repeated Field Card"); err != nil {
		t.Fatal(err)
	}
	for _, greeting := range []string{"FIRST_GREETING", "SECOND_GREETING", "THIRD_GREETING"} {
		if err := writer.WriteField("alternate_greetings", greeting); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.WriteField("description", "single occurrence stays scalar"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/characters/edit", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	parsed, err := parseCharactersMultipart(request, t.TempDir())
	if err != nil {
		t.Fatalf("parseCharactersMultipart: %v", err)
	}

	greetings := nodeGet(parsed.body, "alternate_greetings")
	if greetings.kind != 'a' {
		t.Fatalf("repeated alternate_greetings parsed as kind %q, want an array (multer/append-field shape)", string(greetings.kind))
	}
	got := make([]string, 0, len(greetings.array))
	for _, item := range greetings.array {
		value, ok := item.scalar.(string)
		if !ok || item.kind != 's' {
			t.Fatalf("alternate_greetings entry has kind %q scalar %T, want a string", string(item.kind), item.scalar)
		}
		got = append(got, value)
	}
	want := []string{"FIRST_GREETING", "SECOND_GREETING", "THIRD_GREETING"}
	if len(got) != len(want) {
		t.Fatalf("alternate_greetings = %#v, want %#v (a parser that overwrites keeps only the last)", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("alternate_greetings[%d] = %q, want %q (wire order must be preserved)", index, got[index], want[index])
		}
	}

	// A field that appeared ONCE must remain a scalar: multer only promotes a
	// repeated field to an array, and the card writer type-switches on this shape.
	name := nodeGet(parsed.body, "ch_name")
	if name.kind != 's' || name.scalar != "Repeated Field Card" {
		t.Fatalf("single-occurrence ch_name = kind %q scalar %v, want the plain string %q", string(name.kind), name.scalar, "Repeated Field Card")
	}
}
