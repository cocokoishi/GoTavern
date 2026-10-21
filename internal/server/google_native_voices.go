package server

// googleNativeVoices is the hardcoded Gemini native-TTS voice table from the pinned server,
// src/endpoints/google.js:317-348, in source order. Extracted from the pinned array literal rather
// than retyped, and verified against the recorded /api/google/list-native-voices response.
var googleNativeVoices = []googleNativeVoiceEntry{
	{name: "Zephyr", voiceID: "Zephyr", lang: "en-US", description: "Bright"},
	{name: "Puck", voiceID: "Puck", lang: "en-US", description: "Upbeat"},
	{name: "Charon", voiceID: "Charon", lang: "en-US", description: "Informative"},
	{name: "Kore", voiceID: "Kore", lang: "en-US", description: "Firm"},
	{name: "Fenrir", voiceID: "Fenrir", lang: "en-US", description: "Excitable"},
	{name: "Leda", voiceID: "Leda", lang: "en-US", description: "Youthful"},
	{name: "Orus", voiceID: "Orus", lang: "en-US", description: "Firm"},
	{name: "Aoede", voiceID: "Aoede", lang: "en-US", description: "Breezy"},
	{name: "Callirhoe", voiceID: "Callirhoe", lang: "en-US", description: "Easy-going"},
	{name: "Autonoe", voiceID: "Autonoe", lang: "en-US", description: "Bright"},
	{name: "Enceladus", voiceID: "Enceladus", lang: "en-US", description: "Breathy"},
	{name: "Iapetus", voiceID: "Iapetus", lang: "en-US", description: "Clear"},
	{name: "Umbriel", voiceID: "Umbriel", lang: "en-US", description: "Easy-going"},
	{name: "Algieba", voiceID: "Algieba", lang: "en-US", description: "Smooth"},
	{name: "Despina", voiceID: "Despina", lang: "en-US", description: "Smooth"},
	{name: "Erinome", voiceID: "Erinome", lang: "en-US", description: "Clear"},
	{name: "Algenib", voiceID: "Algenib", lang: "en-US", description: "Gravelly"},
	{name: "Rasalgethi", voiceID: "Rasalgethi", lang: "en-US", description: "Informative"},
	{name: "Laomedeia", voiceID: "Laomedeia", lang: "en-US", description: "Upbeat"},
	{name: "Achernar", voiceID: "Achernar", lang: "en-US", description: "Soft"},
	{name: "Alnilam", voiceID: "Alnilam", lang: "en-US", description: "Firm"},
	{name: "Schedar", voiceID: "Schedar", lang: "en-US", description: "Even"},
	{name: "Gacrux", voiceID: "Gacrux", lang: "en-US", description: "Mature"},
	{name: "Pulcherrima", voiceID: "Pulcherrima", lang: "en-US", description: "Forward"},
	{name: "Achird", voiceID: "Achird", lang: "en-US", description: "Friendly"},
	{name: "Zubenelgenubi", voiceID: "Zubenelgenubi", lang: "en-US", description: "Casual"},
	{name: "Vindemiatrix", voiceID: "Vindemiatrix", lang: "en-US", description: "Gentle"},
	{name: "Sadachbia", voiceID: "Sadachbia", lang: "en-US", description: "Lively"},
	{name: "Sadaltager", voiceID: "Sadaltager", lang: "en-US", description: "Knowledgeable"},
	{name: "Sulafat", voiceID: "Sulafat", lang: "en-US", description: "Warm"},
}

// googleNativeVoiceEntry mirrors one `{name, voice_id, lang, description}` object of the pinned table.
type googleNativeVoiceEntry struct {
	name        string
	voiceID     string
	lang        string
	description string
}
