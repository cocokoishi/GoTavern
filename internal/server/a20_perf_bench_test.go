package server

// alpha.20 hotspot benchmark: the ordered-JSON MARSHAL step, on documents shaped like the two measured
// endpoints (a ~4 MiB world book made of thousands of nested entry objects, and an ~800 KiB chat with
// 2000 messages). Additive: no existing benchmark is modified; internal/server/bench_test.go keeps owning
// the HTTP-level baseline. The before/after comparison uses this file unchanged on both binaries.
//
// Run: go test ./internal/server -run '^$' -bench 'BenchmarkA20Marshal' -benchmem -count=5

import (
	"fmt"
	"strings"
	"testing"
)

var a20BenchSink []byte

func a20String(value string) orderedNodeJSON {
	return orderedNodeJSON{kind: 's', scalar: value}
}

func a20Bool(value bool) orderedNodeJSON {
	return orderedNodeJSON{kind: 'b', scalar: value}
}

func a20Number(value float64) orderedNodeJSON {
	return orderedNodeJSON{kind: 'v', scalar: value}
}

// a20WorldValue builds a world-book document whose shape mirrors the pinned world file: one object with
// thousands of numeric-keyed entry objects. contentBytes controls the per-entry prose size.
func a20WorldValue(entries, contentBytes int) orderedNodeJSON {
	filler := strings.Repeat("alpha.20 world entry prose ", contentBytes/24+2)
	world := nodeObject()
	world.setMember("name", a20String("A20 World"))
	nodes := nodeObject()
	for index := 0; index < entries; index++ {
		entry := nodeObject()
		entry.setMember("uid", a20Number(float64(index)))
		entry.setMember("key", orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{a20String(fmt.Sprintf("trigger-%04d", index))}})
		entry.setMember("keysecondary", orderedNodeJSON{kind: 'a'})
		entry.setMember("comment", a20String(""))
		entry.setMember("content", a20String(filler[:contentBytes]))
		entry.setMember("constant", a20Bool(false))
		entry.setMember("selective", a20Bool(true))
		entry.setMember("selectiveLogic", a20Number(0))
		entry.setMember("addMemo", a20Bool(true))
		entry.setMember("order", a20Number(100))
		entry.setMember("position", a20Number(0))
		entry.setMember("disable", a20Bool(false))
		entry.setMember("excludeRecursion", a20Bool(false))
		entry.setMember("preventRecursion", a20Bool(false))
		entry.setMember("probability", a20Number(100))
		entry.setMember("useProbability", a20Bool(true))
		entry.setMember("depth", a20Number(4))
		entry.setMember("group", a20String(""))
		entry.setMember("extensions", nodeObject())
		nodes.setMember(fmt.Sprintf("%d", index), entry)
	}
	world.setMember("entries", nodes)
	return world
}

// a20ChatValue builds a chat transcript shaped like the measured 2,000-message JSONL chat.
func a20ChatValue(messages, messageBytes int) orderedNodeJSON {
	filler := strings.Repeat("alpha.20 chat message prose ", messageBytes/26+2)
	items := make([]orderedNodeJSON, 0, messages)
	for index := 0; index < messages; index++ {
		message := nodeObject()
		message.setMember("name", a20String("A20 Character"))
		message.setMember("is_user", a20Bool(index%2 == 0))
		message.setMember("is_system", a20Bool(false))
		message.setMember("send_date", a20String("2026-01-01T00:00:00.000Z"))
		message.setMember("mes", a20String(filler[:messageBytes]))
		message.setMember("extra", nodeObject())
		items = append(items, message)
	}
	return orderedNodeJSON{kind: 'a', array: items}
}

func benchmarkA20Marshal(b *testing.B, value orderedNodeJSON) {
	b.Helper()
	probe, err := marshalOrderedNodeJSON(value)
	if err != nil {
		b.Fatalf("marshal probe: %v", err)
	}
	b.SetBytes(int64(len(probe)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		encoded, marshalErr := marshalOrderedNodeJSON(value)
		if marshalErr != nil {
			b.Fatalf("marshal: %v", marshalErr)
		}
		a20BenchSink = encoded
	}
}

func BenchmarkA20MarshalWorld4MB(b *testing.B) {
	benchmarkA20Marshal(b, a20WorldValue(1024, 4000))
}

func BenchmarkA20MarshalChat800KB(b *testing.B) {
	benchmarkA20Marshal(b, a20ChatValue(2000, 380))
}

// The HINTED arms measure the code path the world-info route actually uses: the serializer is told the size of
// the parsed source document (the world file's byte length), so it pre-sizes its one buffer instead of growing.
// They exist on the candidate only; the paired before/after rows are the unhinted benchmarks above, which both
// binaries can run. The allocation columns were identical across two runs of the same binary (world before
// 35,351,645-35,352,928 B/op, after 18,448,212-18,448,768 B/op), so the paired allocation claim is not noise.
func BenchmarkA20MarshalWorld4MBHinted(b *testing.B) {
	value := a20WorldValue(1024, 4000)
	probe, err := marshalOrderedNodeJSON(value)
	if err != nil {
		b.Fatalf("probe: %v", err)
	}
	benchmarkA20MarshalHint(b, value, len(probe))
}

func BenchmarkA20MarshalChat800KBHinted(b *testing.B) {
	value := a20ChatValue(2000, 380)
	probe, err := marshalOrderedNodeJSON(value)
	if err != nil {
		b.Fatalf("probe: %v", err)
	}
	benchmarkA20MarshalHint(b, value, len(probe))
}

func benchmarkA20MarshalHint(b *testing.B, value orderedNodeJSON, hint int) {
	b.Helper()
	probe, err := marshalOrderedNodeJSONHint(value, hint)
	if err != nil {
		b.Fatalf("hinted probe: %v", err)
	}
	b.SetBytes(int64(len(probe)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		encoded, marshalErr := marshalOrderedNodeJSONHint(value, hint)
		if marshalErr != nil {
			b.Fatalf("hinted marshal: %v", marshalErr)
		}
		a20BenchSink = encoded
	}
}
