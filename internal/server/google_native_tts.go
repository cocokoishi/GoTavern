package server

// Pinned `/api/google/generate-native-tts` (google.js:356), all four auth branches.
//
// The envelope, the URL construction, the WAV wrapping, the error mapping and the fallback all live in the
// pinned server's own source, and the only external protocol is standard OAuth2 JWT-bearer, implemented
// here with the Go standard library only (crypto/rsa, crypto/x509, crypto/sha256, base64url, encoding/json).
// No dependency is added and no private protocol is copied.
//
// Pinned properties that a reasonable implementation would flatten, each of them recorded in the oracle:
//
//   - the AI Studio branch does NOT guard the key: with no secret it sends the request anyway and the
//     `x-goog-api-key` header goes out EMPTY (node-fetch serialises an undefined header value that way);
//   - `model` is interpolated into the path RAW, so a slash or a `?` changes the request target (rule 15);
//   - the Vertex FULL branch performs TWO requests per call, a token exchange and then the model call, and
//     it never caches the token: two calls produce two exchanges;
//   - the Vertex PROXY branch sends `Authorization: Bearer <proxy_password>`, while the AI Studio PROXY
//     branch puts the same password in `x-goog-api-key` and sends no Authorization header at all;
//   - a provider error propagates the PROVIDER status with `{error: <parsed .error.message>}`, but a
//     NON-JSON error body throws inside the catch and becomes 500 with a generic message;
//   - `audio/l16` is wrapped into a 44-byte RIFF/WAVE mono 16-bit header with the sample rate from
//     `rate=(\d+)`, defaulting to 24000, and any other mime type passes the bytes through untouched.

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	googleMakerSuiteDefaultURL = "https://generativelanguage.googleapis.com"
	googleVertexDefaultURL     = "https://{region}-aiplatform.googleapis.com"
	googleVertexGlobalURL      = "https://aiplatform.googleapis.com"
	googleOAuthDefaultURL      = "https://oauth2.googleapis.com"
	googleDefaultAPIVersion    = "v1beta"
	googleNativeTTSGenericFail = "Internal server error during TTS generation"
	googleNativeTTSNoAudio     = "No audio data found in response"
	googleNativeTTSFailed      = "TTS generation failed."
	googleDefaultSampleRate    = 24000
)

// googleNativeTTSNow is the clock the JWT claims are derived from. The pinned code uses Date.now(), and the
// oracle freezes it; the test overrides this to the same instant so the RS256 serialisation is comparable
// byte for byte.
var googleNativeTTSNow = time.Now

func googleMakerSuiteURL() string {
	return sdSeamURL("GOTAVERN_GOOGLE_MAKERSUITE_URL", googleMakerSuiteDefaultURL)
}

// googleVertexURLTemplate carries a {region} placeholder so one seam covers every region the pinned code
// can build, while the global region keeps its own prefix-less host.
func googleVertexURLTemplate() string {
	return sdSeamURL("GOTAVERN_GOOGLE_VERTEX_URL", googleVertexDefaultURL)
}

func googleVertexGlobalBaseURL() string {
	return sdSeamURL("GOTAVERN_GOOGLE_VERTEX_GLOBAL_URL", googleVertexGlobalURL)
}

func googleOAuthURL() string { return sdSeamURL("GOTAVERN_GOOGLE_OAUTH_URL", googleOAuthDefaultURL) }

type googleSafetySetting struct {
	category  string
	threshold string
}

var googleGeminiSafety = []googleSafetySetting{
	{"HARM_CATEGORY_HARASSMENT", "OFF"},
	{"HARM_CATEGORY_HATE_SPEECH", "OFF"},
	{"HARM_CATEGORY_SEXUALLY_EXPLICIT", "OFF"},
	{"HARM_CATEGORY_DANGEROUS_CONTENT", "OFF"},
	{"HARM_CATEGORY_CIVIC_INTEGRITY", "OFF"},
}

var googleVertexSafety = []googleSafetySetting{
	{"HARM_CATEGORY_IMAGE_HATE", "OFF"},
	{"HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT", "OFF"},
	{"HARM_CATEGORY_IMAGE_HARASSMENT", "OFF"},
	{"HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT", "OFF"},
	{"HARM_CATEGORY_JAILBREAK", "OFF"},
}

type googleAPIConfig struct {
	url string
	// baseURL is the <apiUrl>/<version> (AI Studio) or <vertexBase>/v1 prefix the VIDEO poll needs to
	// join a job name onto. It is returned rather than recomputed so the two cannot drift.
	baseURL string
	headers []outbound.Header
	apiName string
	safety  []googleSafetySetting
}

func (runtime *accountRuntime) googleAPIConfigFor(request *http.Request, directories startup.UserDirectories, options HTTPHandlerOptions, input map[string]json.RawMessage, model, endpoint string) (googleAPIConfig, error) {
	useVertex := false
	if raw, present := input["api"]; present && nodeTruthyJSON(raw) {
		useVertex = sdRawJavaScriptString(raw) == "vertexai"
	}
	region := "us-central1"
	if raw, present := input["vertexai_region"]; present && nodeTruthyJSON(raw) {
		region = sdRawJavaScriptString(raw)
	}
	config := googleAPIConfig{}
	config.safety = append(config.safety, googleGeminiSafety...)
	if useVertex {
		config.apiName = "Google Vertex AI"
		config.safety = append(config.safety, googleVertexSafety...)
	} else {
		config.apiName = "Google AI Studio"
	}

	reverseProxy := ""
	if raw, present := input["reverse_proxy"]; present && nodeTruthyJSON(raw) {
		reverseProxy = sdRawJavaScriptString(raw)
	}
	proxyPassword := ""
	if raw, present := input["proxy_password"]; present && nodeTruthyJSON(raw) {
		proxyPassword = sdRawJavaScriptString(raw)
	}

	if !useVertex {
		apiKey := ""
		if reverseProxy != "" {
			apiKey = proxyPassword
		} else {
			secret, err := startup.ReadSecretString(directories, "api_key_makersuite")
			if err != nil {
				return config, err
			}
			apiKey = secret
		}
		base := googleMakerSuiteURL()
		if reverseProxy != "" {
			base = reverseProxy
		}
		config.baseURL = strings.TrimRight(base, "/") + "/" + googleAPIVersion(options)
		config.url = config.baseURL + "/models/" + model + ":" + endpoint
		config.headers = []outbound.Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "x-goog-api-key", Value: apiKey},
		}
		return config, nil
	}

	authMode := "express"
	if raw, present := input["vertexai_auth_mode"]; present && nodeTruthyJSON(raw) {
		authMode = sdRawJavaScriptString(raw)
	}

	base := ""
	if region == "global" {
		base = googleVertexGlobalBaseURL() + "/v1"
	} else {
		base = strings.ReplaceAll(googleVertexURLTemplate(), "{region}", region) + "/v1"
	}
	config.baseURL = base

	if reverseProxy != "" {
		config.baseURL = strings.TrimRight(reverseProxy, "/") + "/v1"
		config.url = config.baseURL + "/publishers/google/models/" + model + ":" + endpoint
		config.headers = []outbound.Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Bearer " + proxyPassword},
		}
		return config, nil
	}

	switch authMode {
	case "express":
		secret, err := startup.ReadSecretString(directories, "api_key_vertexai")
		if err != nil {
			return config, err
		}
		if secret == "" {
			return config, errors.New("API key is required for Vertex AI Express mode")
		}
		projectID := ""
		if raw, present := input["vertexai_express_project_id"]; present && nodeTruthyJSON(raw) {
			projectID = sdRawJavaScriptString(raw)
		}
		if projectID != "" {
			config.url = base + "/projects/" + projectID + "/locations/" + region + "/publishers/google/models/" + model + ":" + endpoint
		} else {
			config.url = base + "/publishers/google/models/" + model + ":" + endpoint
		}
		config.headers = []outbound.Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "x-goog-api-key", Value: secret},
		}
		return config, nil
	case "full":
		serviceAccountJSON, err := startup.ReadSecretString(directories, "vertexai_service_account_json")
		if err != nil {
			return config, err
		}
		if serviceAccountJSON == "" {
			return config, errors.New("Service Account JSON is required for Vertex AI Full mode")
		}
		projectID, jwtToken, err := googleServiceAccountJWT(serviceAccountJSON, googleNativeTTSNow())
		if err != nil {
			return config, err
		}
		accessToken, err := googleExchangeAccessToken(request, jwtToken)
		if err != nil {
			return config, err
		}
		config.url = base + "/projects/" + projectID + "/locations/" + region + "/publishers/google/models/" + model + ":" + endpoint
		config.headers = []outbound.Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Bearer " + accessToken},
		}
		return config, nil
	default:
		return config, errors.New("Unsupported Vertex AI authentication mode: " + authMode)
	}
}

// googleServiceAccountJWT mints the pinned RS256 token: header and claims serialised in the pinned member
// order, base64url without padding, signed with PKCS#1 v1.5 over SHA-256. With the same key and clock the
// whole compact serialisation is deterministic, which is what the oracle compares.
func googleServiceAccountJWT(serviceAccountJSON string, now time.Time) (string, string, error) {
	var account struct {
		ProjectID   string `json:"project_id"`
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
	}
	if err := json.Unmarshal([]byte(serviceAccountJSON), &account); err != nil {
		return "", "", err
	}
	if account.ProjectID == "" {
		return "", "", errors.New("Project ID not found in service account JSON")
	}
	key, err := googleParsePrivateKey(account.PrivateKey)
	if err != nil {
		return "", "", err
	}
	issued := now.Unix()
	header := `{"alg":"RS256","typ":"JWT"}`
	claims := `{"iss":` + googleJSONString(account.ClientEmail) +
		`,"scope":"https://www.googleapis.com/auth/cloud-platform"` +
		`,"aud":"https://oauth2.googleapis.com/token"` +
		`,"iat":` + strconv.FormatInt(issued, 10) +
		`,"exp":` + strconv.FormatInt(issued+3600, 10) + `}`
	signingInput := base64.RawURLEncoding.EncodeToString([]byte(header)) + "." + base64.RawURLEncoding.EncodeToString([]byte(claims))
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", "", err
	}
	return account.ProjectID, signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func googleParsePrivateKey(pemText string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return nil, errors.New("service account private key is not PEM")
	}
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if key, ok := parsed.(*rsa.PrivateKey); ok {
			return key, nil
		}
		return nil, errors.New("service account private key is not RSA")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	return nil, errors.New("service account private key could not be parsed")
}

// googleExchangeAccessToken performs the pinned token exchange. There is NO cache: the pinned code calls
// this once per request, and reproducing that is a compatibility property rather than a defect.
func googleExchangeAccessToken(request *http.Request, jwtToken string) (string, error) {
	target := googleOAuthURL() + "/token"
	body := urlSearchParamsEncode([][2]string{
		{"grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"},
		{"assertion", jwtToken},
	})
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: hostOf(target)},
			{Name: "Content-Type", Value: "application/x-www-form-urlencoded"},
			{Name: "Content-Length", Value: strconvItoa(len(body))},
		},
		Body: []byte(body),
	}, 120*time.Second)
	if err != nil {
		return "", err
	}
	if !outboundOK(response) {
		return "", errors.New("Failed to get access token: " + string(response.Body))
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(response.Body, &payload); err != nil {
		return "", err
	}
	return payload.AccessToken, nil
}

var googleSampleRatePattern = regexp.MustCompile(`rate=(\d+)`)

// googleJSONString serialises a Go string the way JSON.stringify does: no HTML escaping, so a value
// containing <, > or & is not rewritten into a unicode escape that the pinned token would never contain.
func googleJSONString(value string) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return `""`
	}
	return strings.TrimRight(buffer.String(), "\n")
}

// googleWAVHeader builds the pinned 44-byte RIFF/WAVE mono 16-bit header.
func googleWAVHeader(dataSize, sampleRate int) []byte {
	header := make([]byte, 44)
	copy(header[0:], "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(36+dataSize))
	copy(header[8:], "WAVE")
	copy(header[12:], "fmt ")
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 1)
	binary.LittleEndian.PutUint16(header[22:], 1)
	binary.LittleEndian.PutUint32(header[24:], uint32(sampleRate))
	binary.LittleEndian.PutUint32(header[28:], uint32(sampleRate*1*16/8))
	binary.LittleEndian.PutUint16(header[32:], uint16(1*16/8))
	binary.LittleEndian.PutUint16(header[34:], 16)
	copy(header[36:], "data")
	binary.LittleEndian.PutUint32(header[40:], uint32(dataSize))
	return header
}

func respondGoogleTTSFailure(w http.ResponseWriter, message string) {
	answer := nodeObject()
	answer.setMember("error", nodeString(message))
	body, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusInternalServerError, body)
}

func (runtime *accountRuntime) serveGoogleGenerateNativeTTS(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		respondGoogleTTSFailure(w, googleNativeTTSGenericFail)
		return
	}
	model := sdRawJavaScriptString(input["model"])
	config, err := runtime.googleAPIConfigFor(request, directories, options, input, model, "generateContent")
	if err != nil {
		respondGoogleTTSFailure(w, googleNativeTTSGenericFail)
		return
	}

	speechConfig := nodeObject()
	voiceConfig := nodeObject()
	prebuilt := nodeObject()
	setRawMember(&prebuilt, "voiceName", input["voice"])
	voiceConfig.setMember("prebuiltVoiceConfig", prebuilt)
	speechConfig.setMember("voiceConfig", voiceConfig)
	modalities := nodeArray()
	modalities.array = append(modalities.array, nodeString("AUDIO"))
	generationConfig := nodeObject()
	generationConfig.setMember("responseModalities", modalities)
	generationConfig.setMember("speechConfig", speechConfig)
	contents := nodeArray()
	part := nodeObject()
	setRawMember(&part, "text", input["text"])
	parts := nodeArray()
	parts.array = append(parts.array, part)
	content := nodeObject()
	content.setMember("role", nodeString("user"))
	content.setMember("parts", parts)
	contents.array = append(contents.array, content)
	safety := nodeArray()
	for _, setting := range config.safety {
		entry := nodeObject()
		entry.setMember("category", nodeString(setting.category))
		entry.setMember("threshold", nodeString(setting.threshold))
		safety.array = append(safety.array, entry)
	}
	payload := nodeObject()
	payload.setMember("contents", contents)
	payload.setMember("generationConfig", generationConfig)
	payload.setMember("safetySettings", safety)
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		respondGoogleTTSFailure(w, googleNativeTTSGenericFail)
		return
	}

	headers := append([]outbound.Header{{Name: "Host", Value: hostOf(config.url)}}, config.headers...)
	headers = append(headers, outbound.Header{Name: "Content-Length", Value: strconvItoa(len(body))})
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:     config.url,
		Method:  http.MethodPost,
		Headers: headers,
		Body:    body,
	}, 120*time.Second)
	if err != nil {
		respondGoogleTTSFailure(w, googleNativeTTSGenericFail)
		return
	}
	if !outboundOK(response) {
		var providerError struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body, &providerError); err != nil {
			// The pinned code parses the error body inside the same try block, so a NON-JSON body throws
			// and becomes the generic 500 instead of propagating the provider status.
			respondGoogleTTSFailure(w, googleNativeTTSGenericFail)
			return
		}
		message := providerError.Error.Message
		if message == "" {
			message = googleNativeTTSFailed
		}
		answer := nodeObject()
		answer.setMember("error", nodeString(message))
		encoded, err := marshalCharacterJSON(answer)
		if err != nil {
			respondGoogleTTSFailure(w, googleNativeTTSGenericFail)
			return
		}
		respondJSONBytes(w, response.Status, encoded)
		return
	}

	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		respondGoogleTTSFailure(w, googleNativeTTSGenericFail)
		return
	}
	// `data?.candidates?.[0]?.content?.parts?.[0]`: nodeGet walks object members, so the array indexes are
	// taken here rather than through the path.
	audioPart := orderedNodeJSON{}
	if candidates := nodeGet(decoded, "candidates"); candidates.kind == 'a' && len(candidates.array) > 0 {
		if content, present := candidates.array[0].member("content"); present {
			if parts, hasParts := content.member("parts"); hasParts && parts.kind == 'a' && len(parts.array) > 0 {
				audioPart = parts.array[0]
			}
		}
	}
	if audioPart.kind != 'o' {
		respondGoogleTTSFailure(w, googleNativeTTSNoAudio)
		return
	}
	inline, hasInline := audioPart.member("inlineData")
	if !hasInline || inline.kind != 'o' {
		respondGoogleTTSFailure(w, googleNativeTTSNoAudio)
		return
	}
	audioData, hasData := "", false
	if value, present := inline.member("data"); present && jsTruthyNode(value) {
		if text, err := value.javascriptString(); err == nil {
			audioData = text
			hasData = true
		}
	}
	if !hasData {
		respondGoogleTTSFailure(w, googleNativeTTSNoAudio)
		return
	}
	mimeType := ""
	if value, present := inline.member("mimeType"); present && jsTruthyNode(value) {
		if text, err := value.javascriptString(); err == nil {
			mimeType = text
		}
	}
	audioBuffer, err := decodeBase64Node(audioData)
	if err != nil {
		respondGoogleTTSFailure(w, googleNativeTTSGenericFail)
		return
	}
	if mimeType != "" && strings.Contains(strings.ToLower(mimeType), "audio/l16") {
		sampleRate := googleDefaultSampleRate
		if match := googleSampleRatePattern.FindStringSubmatch(mimeType); match != nil {
			if parsed, err := strconv.Atoi(match[1]); err == nil {
				sampleRate = parsed
			}
		}
		wav := append(googleWAVHeader(len(audioBuffer), sampleRate), audioBuffer...)
		w.Header().Set("Content-Type", "audio/wav")
		respondBinary(w, http.StatusOK, wav)
		return
	}
	contentType := mimeType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	respondBinary(w, http.StatusOK, audioBuffer)
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerGoogleNativeTTSRoutes)
}

func registerGoogleNativeTTSRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/google/generate-native-tts", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveGoogleGenerateNativeTTS(w, r, options)
	})
}
