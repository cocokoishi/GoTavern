package e2e

// THE SEEDED STATE-MACHINE QUALIFICATION DRIVER (alpha.16 M1/M3; execution-plan sections 3-4).
//
// WHAT THIS DRIVES. The REAL GoTavern server object, started in-process through `internal/app.Start` with
// `internal/app`'s own options and the SHIPPED handler, on a real data root under `t.TempDir()`. Every operation
// below goes through a real HTTP route on a loopback listener, writes real files under the data root, and is
// asserted against parsed disk bytes / parsed HTTP bodies / SHA-256 digests. There is no mock of the product and
// no provider request: the recipes declare `maxProviderRequests: 0`, and this lane makes none.
//
// WHY IN-PROCESS AND NOT THE SUBPROCESS HARNESS: `tests/e2e/harness_test.go` boots the shipped binary as a child
// because its subject is the PRODUCTION PROVIDER TRANSPORT, and internal/server's test binary pins the wire-exact
// client process-wide. This lane's subject is the state machine (routes + persistence + restart), not the
// provider transport, and `internal/app` is the same composition the binary runs (`cmd/gotavern` calls
// `app.Start`). Booting a child per seed would cost minutes; booting the real object per batch keeps the lane
// CI-sized while the object under test is still the shipped server. The restart leg kills the GO SERVER OBJECT
// (`RunningServer.Close`) and starts a new one on the same data root -- the plan's "kill the server object, start
// again, reload".
//
// THE SCALE. 100 seeds (1601..1700) x 10 declared operations, executed TWICE per seed, so 2,000 reproducible
// operation sequences and 2,000 action-log entries. Every seed runs as one of the E06 eight accounts and attempts
// a read inside the next account's session. Restart-resume runs after each 25-seed batch on the SAME data root.
//
// WHAT IS ASSERTED, per operation (never merely "a 200 happened"):
//   - settings save/get: the file on disk is valid JSON, and the marker round-trips through the product's own
//     route; the marker is then absent from every other account's settings.
//   - chat save/load/rename/delete: the JSONL on disk parses line by line and its ORDERED message texts equal
//     the plan; the renamed chat's messages are still there, and the deleted chat is gone.
//   - message append/order reload: five messages, exact order, proven from both the response and the disk bytes.
//   - multi-user isolation: a read inside another account's session answers 200 and contains none of the
//     subject's markers (a 403 would not prove isolation; a leak is the defect).
//   - unknown-file preservation: the planted binary file's SHA-256 is unchanged after every operation.
//   - JSON/JSONL validity: every operation's touched documents are re-parsed; the action-log entry records it.
//   - reproducibility: the two executions of the same seed's plan are compared entry by entry.
//   - restart-resume: the new instance is a different object on the SAME data root, and the settings markers,
//     preboot chat order and unknown-file digests all came back.
//
// THE ACTION LOG. Every operation appends one `smActionEntry`; at the end the log is written as JSONL (so it is
// actually machine-readable, not only in memory), re-parsed, and summarised with its digest.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
	"github.com/cocokoishi/gotavern/internal/longlivedfixture"
)

const (
	smSeedBase  = int64(1601)
	smSeedCount = 100
	smBatchSize = 25
	// smMessageCountAfterAppend is what the append leg leaves on disk.
	smMessageCountAfterAppend = 5
	// smFixedNowMs is the pinned boot clock: app.Start accepts a Now, so the boot does not read the wall clock.
	smFixedNowMs = int64(1735689600000)
)

// smSession is one account's authenticated session: the CSRF token and the cookie jar a browser would hold.
type smSession struct {
	handle string
	origin string
	client *http.Client
	cookie string
	token  string
}

func (session *smSession) doPost(t *testing.T, route, body string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, session.origin+route, strings.NewReader(body))
	if err != nil {
		t.Fatalf("build POST %s: %v", route, err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", session.cookie)
	request.Header.Set("X-CSRF-Token", session.token)
	response, err := session.client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", route, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read POST %s: %v", route, err)
	}
	return response.StatusCode, string(payload)
}

func (session *smSession) doGet(t *testing.T, route string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, session.origin+route, nil)
	if err != nil {
		t.Fatalf("build GET %s: %v", route, err)
	}
	request.Header.Set("Cookie", session.cookie)
	response, err := session.client.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", route, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read GET %s: %v", route, err)
	}
	return response.StatusCode, string(payload)
}

// smServer is one booted GoTavern server object plus its roots and sessions.
type smServer struct {
	t           *testing.T
	installRoot string
	dataRoot    string
	origin      string
	instance    int
	running     *app.RunningServer
	sessions    map[string]*smSession
}

func newSMServer(t *testing.T) *smServer {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	if err := os.MkdirAll(dataRoot, 0o777); err != nil {
		t.Fatalf("create the data root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), longlivedfixture.SeededInstallConfig(), 0o600); err != nil {
		t.Fatalf("write the install config: %v", err)
	}
	server := &smServer{t: t, installRoot: installRoot, dataRoot: dataRoot, sessions: map[string]*smSession{}}
	t.Cleanup(func() {
		if server.running != nil {
			_ = server.shutdown()
		}
	})
	return server
}

// boot starts a REAL server object on the current roots and refuses to continue if the boot did not bind the
// data root this lane planted, because a boot that resolved a different root would make every restart assertion
// vacuous.
func (server *smServer) boot() error {
	t := server.t
	port := freePort(t)
	arguments := []string{
		"--dataRoot", server.dataRoot,
		"--listenAddressIPv4", "127.0.0.1",
		"--enableIPv4", "true",
		"--enableIPv6", "false",
		"--listen", "false",
		"--port", strconv.Itoa(port),
		"--browserLaunchEnabled", "false",
		"--heartbeatInterval", "0",
	}
	options := app.StartOptions{
		Args:                     arguments,
		InstallRoot:              server.installRoot,
		WorkingDirectory:         server.installRoot,
		Now:                      time.UnixMilli(smFixedNowMs),
		WaitBeforeLegacyDataMove: func(time.Duration) {},
		InterfaceAddresses:       []net.Addr{},
		StartupTrace:             io.Discard,
	}
	running, err := app.Start(options)
	if err != nil {
		return fmt.Errorf("app.Start: %w", err)
	}
	resolved := running.CommandLine.Paths.RuntimeDataRoot
	if resolved != "" && !smSamePath(resolved, server.dataRoot) {
		_ = running.Close(context.Background())
		return fmt.Errorf("the boot resolved data root %q, the lane planted %q: every restart assertion would be about another tree", resolved, server.dataRoot)
	}
	server.running = running
	server.origin = "http://127.0.0.1:" + strconv.Itoa(port)
	server.instance++
	return nil
}

func (server *smServer) shutdown() error {
	if server.running == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := server.running.Close(ctx)
	server.running = nil
	return err
}

// restart kills the server object and starts a NEW one on the SAME data root, then re-authenticates every E06
// account. It returns the new instance number; the caller compares it with the witness to prove this was a
// restart and not the old object.
func (server *smServer) restart() (int, error) {
	if err := server.shutdown(); err != nil {
		return server.instance, fmt.Errorf("close the old server object: %w", err)
	}
	server.sessions = map[string]*smSession{}
	if err := server.boot(); err != nil {
		return server.instance, err
	}
	if err := server.loginAll(); err != nil {
		return server.instance, err
	}
	return server.instance, nil
}

// loginAll opens the browser-equivalent session for each of the eight E06 accounts. Accounts are enabled in the
// generated config, so every account's login goes through the product's own POST /api/users/login; the accounts
// are the node-persist records the generated preboot tree planted.
func (server *smServer) loginAll() error {
	for _, handle := range longlivedfixture.StateMachineUserHandles() {
		session, err := smLogin(server.t, server.origin, handle)
		if err != nil {
			return err
		}
		server.sessions[handle] = session
	}
	return nil
}

// smLogin performs the handshake a browser performs on an accounts-enabled install: GET /csrf-token, then POST
// /api/users/login with that token and cookie. The resulting session cookie is what every later write carries.
func smLogin(t *testing.T, origin, handle string) (*smSession, error) {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 120 * time.Second}
	csrfRequest, err := http.NewRequest(http.MethodGet, origin+"/csrf-token", nil)
	if err != nil {
		return nil, err
	}
	csrfResponse, err := client.Do(csrfRequest)
	if err != nil {
		return nil, fmt.Errorf("GET /csrf-token for %s: %w", handle, err)
	}
	csrfBody, readErr := io.ReadAll(csrfResponse.Body)
	_ = csrfResponse.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	if csrfResponse.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /csrf-token for %s = %d: %s", handle, csrfResponse.StatusCode, csrfBody)
	}
	token, ok := jsonStringMember(string(csrfBody), "token")
	if !ok || token == "" {
		return nil, fmt.Errorf("GET /csrf-token for %s carried no token: %s", handle, csrfBody)
	}
	csrfCookie := cookieHeader(csrfResponse.Header.Values("Set-Cookie"))
	if csrfCookie == "" {
		return nil, fmt.Errorf("GET /csrf-token for %s set no cookie", handle)
	}
	loginBody, err := json.Marshal(map[string]string{"handle": handle})
	if err != nil {
		return nil, err
	}
	loginRequest, err := http.NewRequest(http.MethodPost, origin+"/api/users/login", strings.NewReader(string(loginBody)))
	if err != nil {
		return nil, err
	}
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("Cookie", csrfCookie)
	loginRequest.Header.Set("X-CSRF-Token", token)
	loginResponse, err := client.Do(loginRequest)
	if err != nil {
		return nil, fmt.Errorf("POST /api/users/login for %s: %w", handle, err)
	}
	loginAnswer, readErr := io.ReadAll(loginResponse.Body)
	_ = loginResponse.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	if loginResponse.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("POST /api/users/login for %s = %d: %s", handle, loginResponse.StatusCode, loginAnswer)
	}
	loginCookie := cookieHeader(loginResponse.Header.Values("Set-Cookie"))
	if loginCookie == "" {
		return nil, fmt.Errorf("POST /api/users/login for %s set no session cookie: %s", handle, loginAnswer)
	}
	// The login response's session cookie REPLACES the pre-login one: it is the same cookie NAME, now carrying
	// the handle. Sending both would put two values for one name in the Cookie header, and the server would read
	// the pre-login session (no handle) -- every later write would answer a plain 403. That failure is exactly
	// why this pre-change state is not committed.
	return &smSession{
		handle: handle,
		origin: origin,
		client: client,
		cookie: loginCookie,
		token:  token,
	}, nil
}

// smSamePath compares two roots the way the host's filesystem does (case-insensitively on Windows).
func smSamePath(left, right string) bool {
	cleanedLeft := filepath.Clean(left)
	cleanedRight := filepath.Clean(right)
	if cleanedLeft == cleanedRight {
		return true
	}
	return strings.EqualFold(cleanedLeft, cleanedRight)
}

// smSeedPlan is one seed's deterministic operation plan: the account it runs as, the chat identity it uses and
// the message texts it will assert. Everything is derived from the seed.
type smSeedPlan struct {
	seed        int64
	recipe      *longlivedfixture.SeededRecipe
	user        string
	avatar      string
	chatFile    string
	renamedFile string
	marker      string
	messages    []string
	preboot     []string
}

func newSMSeedPlan(t *testing.T, seed int64) *smSeedPlan {
	t.Helper()
	recipe, err := longlivedfixture.SeededRecipeForSeed(seed)
	if err != nil {
		t.Fatalf("build the recipe for seed %d: %v", seed, err)
	}
	stem := strconv.FormatInt(seed, 10)
	plan := &smSeedPlan{
		seed:        seed,
		recipe:      recipe,
		user:        longlivedfixture.SeededSeedUser(seed),
		avatar:      "E_" + stem + ".png",
		chatFile:    "E_" + stem,
		renamedFile: "E_" + stem + "_renamed",
		marker:      "SM_SETTINGS_" + stem,
	}
	for index := 0; index < smMessageCountAfterAppend; index++ {
		plan.messages = append(plan.messages, "SEEDMSG_"+stem+"_"+strconv.Itoa(index))
	}
	for index := 0; index < 3; index++ {
		plan.preboot = append(plan.preboot, "PREBOOT_"+stem+"_"+strconv.Itoa(index))
	}
	return plan
}

func (plan *smSeedPlan) settingsPath(dataRoot string) string {
	return filepath.Join(dataRoot, plan.user, "settings.json")
}

func (plan *smSeedPlan) chatPath(dataRoot, file string) string {
	return filepath.Join(dataRoot, plan.user, "chats", "E_"+strconv.FormatInt(plan.seed, 10), file+".jsonl")
}

func (plan *smSeedPlan) unknownPath(dataRoot string) string {
	return filepath.Join(dataRoot, plan.user, "user", "files", "E_"+strconv.FormatInt(plan.seed, 10)+".bin")
}

// smBuildChatBody renders one /api/chats/save request body with exactly the messages the plan holds up to count.
func (plan *smSeedPlan) chatBody(dataRoot string, count int) (string, error) {
	messages := make([]map[string]any, 0, count)
	for index := 0; index < count; index++ {
		name := "E-series user"
		if index%2 == 1 {
			name = "E_" + strconv.FormatInt(plan.seed, 10)
		}
		messages = append(messages, map[string]any{
			"name":      name,
			"is_user":   index%2 == 0,
			"is_system": false,
			"send_date": "2026-11-06T00:00:00.000Z",
			"mes":       plan.messages[index],
			"extra":     map[string]any{"e_series_seed": plan.seed, "e_series_index": index},
		})
	}
	return marshalJSON(map[string]any{
		"avatar_url": plan.avatar,
		"file_name":  plan.chatFile,
		"chat":       messages,
	})
}

func (plan *smSeedPlan) settingsBody() (string, error) {
	return marshalJSON(map[string]any{
		"username":                  plan.user,
		"e_series_marker":           plan.marker,
		"e_series_seed":             plan.seed,
		"e_series_settings_version": 1,
	})
}

// smChatTextsFromDisk reads a JSONL chat and returns its ordered message texts, validating every line. It is how
// the driver asserts against the BYTES ON DISK rather than against the route's own claim.
func smChatTextsFromDisk(document []byte) ([]string, error) {
	if err := smCheckJSONL(document); err != nil {
		return nil, err
	}
	texts := make([]string, 0)
	for _, line := range strings.Split(string(document), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var message map[string]any
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			return nil, fmt.Errorf("jsonl-message-not-an-object")
		}
		text, ok := message["mes"].(string)
		if !ok {
			return nil, fmt.Errorf("jsonl-message-has-no-mes")
		}
		texts = append(texts, text)
	}
	return texts, nil
}

// smHealth is the per-operation JSON/JSONL and unknown-file check every operation ends with.
type smHealth struct {
	jsonValid    bool
	unknownRole  string
	unknownWants string
}

func (plan *smSeedPlan) checkHealth(t *testing.T, dataRoot string, step int) bool {
	t.Helper()
	valid := true
	settingsBody, err := os.ReadFile(plan.settingsPath(dataRoot))
	if err == nil {
		if jsonErr := smCheckJSONDocument(settingsBody); jsonErr != nil {
			t.Errorf("step %d: %v (settings.json)", step, jsonErr)
			valid = false
		}
	}
	for _, file := range []string{plan.chatFile, plan.renamedFile} {
		target := plan.chatPath(dataRoot, file)
		body, readErr := os.ReadFile(target)
		if readErr != nil {
			continue
		}
		if _, jsonErr := smChatTextsFromDisk(body); jsonErr != nil {
			t.Errorf("step %d: %v (%s)", step, jsonErr, target)
			valid = false
		}
	}
	unknownBody, readErr := os.ReadFile(plan.unknownPath(dataRoot))
	if readErr != nil {
		t.Errorf("step %d: the planted unknown file is gone: %v", step, readErr)
		return false
	}
	if err := smCheckUnknownFileDigest("unknown-file", plan.recipe.Preboot.Artifacts["unknown-file"], smObservableDigest(unknownBody)); err != nil {
		t.Errorf("step %d: %v", step, err)
		valid = false
	}
	return valid
}

func (server *smServer) record(entries *[]smActionEntry, plan *smSeedPlan, step int, op, method, route string, status int, before, after string, jsonValid bool, detail string) {
	*entries = append(*entries, smActionEntry{
		Seed:         plan.seed,
		Step:         step,
		Op:           op,
		User:         plan.user,
		Method:       method,
		Route:        route,
		Status:       status,
		BeforeDigest: before,
		AfterDigest:  after,
		JSONValid:    jsonValid,
		Instance:     server.instance,
		Detail:       detail,
	})
}

// runSeedSequence executes one seed's declared ten-operation plan against the live server and returns the
// action-log entries. `pass` is only used in failure messages: the sequence must produce identical observables
// in both passes, which is the reproducibility claim.
func (server *smServer) runSeedSequence(t *testing.T, plan *smSeedPlan, pass int) []smActionEntry {
	t.Helper()
	entries := make([]smActionEntry, 0, len(longlivedfixture.StateMachineOperations))
	session := server.sessions[plan.user]
	if session == nil {
		t.Fatalf("seed %d: no session for %s", plan.seed, plan.user)
	}
	dataRoot := server.dataRoot
	settingsPath := plan.settingsPath(dataRoot)

	// REPRODUCIBILITY PRECONDITION. Two executions of one seed's plan are comparable only if they START from the
	// same state. The reset goes through the product's own settings route (not a file write the product would not
	// make), and it uses the same body for both passes; a seed's own owned chat files are removed if a previous
	// failed run left them. This is harness precondition, not a product write: the operations that follow still
	// go through the routes and are still asserted against disk bytes.
	baseline, err := marshalJSON(map[string]any{"username": plan.user, "e_series_baseline": true})
	if err != nil {
		t.Fatal(err)
	}
	resetStatus, resetBody := session.doPost(t, "/api/settings/save", baseline)
	if resetStatus != http.StatusOK {
		t.Fatalf("seed %d pass %d: the reproducibility reset of %s answered %d: %s", plan.seed, pass, plan.user, resetStatus, resetBody)
	}
	for _, file := range []string{plan.chatFile, plan.renamedFile} {
		if removeErr := os.Remove(plan.chatPath(dataRoot, file)); removeErr != nil && !os.IsNotExist(removeErr) {
			t.Fatalf("seed %d pass %d: remove the seed's own chat file: %v", plan.seed, pass, removeErr)
		}
	}
	// The cross-account read creates a per-character chats directory ON DEMAND in the reading account's tree
	// (pinned's own behaviour). That side effect would make the second execution start from a different state,
	// so the harness precondition removes exactly that on-demand directory -- never the seeded PREBOOT chat.
	seedChatDirectory := "E_" + strconv.FormatInt(plan.seed, 10)
	for _, handle := range longlivedfixture.StateMachineUserHandles() {
		if handle == plan.user {
			continue
		}
		if removeErr := os.RemoveAll(filepath.Join(dataRoot, handle, "chats", seedChatDirectory)); removeErr != nil {
			t.Fatalf("seed %d pass %d: reset the on-demand chats directory for %s: %v", plan.seed, pass, handle, removeErr)
		}
	}

	// (1) settings-save: the settings document goes through the product's own write path.
	settingsJSON, err := plan.settingsBody()
	if err != nil {
		t.Fatal(err)
	}
	before, err := smFileDigestOrAbsent(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	status, body := session.doPost(t, "/api/settings/save", settingsJSON)
	if err := smCheckHTTPStatus("settings-save", "/api/settings/save", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	if !strings.Contains(body, `"result":"ok"`) && !strings.Contains(body, `"result": "ok"`) {
		t.Errorf("seed %d pass %d: settings-save answered without result:ok: %s", plan.seed, pass, body)
	}
	after, err := smFileDigestOrAbsent(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if after == "absent" {
		t.Errorf("seed %d pass %d: settings-save left no settings.json on disk", plan.seed, pass)
	}
	valid := plan.checkHealth(t, dataRoot, 0)
	server.record(&entries, plan, 0, "settings-save", http.MethodPost, "/api/settings/save", status, before, after, valid, "")

	// (2) settings-get: the marker round-trips through the product's own read path.
	before, err = smFileDigestOrAbsent(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	status, body = session.doPost(t, "/api/settings/get", "{}")
	if err := smCheckHTTPStatus("settings-get", "/api/settings/get", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	settingsDocument, err := smSettingsString(body)
	if err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
		settingsDocument = ""
	}
	if err := smCheckSettingsMarker(settingsDocument, plan.marker, true); err != nil {
		t.Errorf("seed %d pass %d: %v", plan.seed, pass, err)
	}
	after = smObservableDigest([]byte(settingsDocument))
	valid = plan.checkHealth(t, dataRoot, 1)
	if settingsDocument != "" && !json.Valid([]byte(settingsDocument)) {
		t.Errorf("seed %d pass %d: json-invalid (settings from /api/settings/get)", plan.seed, pass)
		valid = false
	}
	server.record(&entries, plan, 1, "settings-get", http.MethodPost, "/api/settings/get", status, before, after, valid, "")

	// (3) chat-save: three messages, and the JSONL on disk must carry exactly them in order.
	chatBody, err := plan.chatBody(dataRoot, 3)
	if err != nil {
		t.Fatal(err)
	}
	chatPath := plan.chatPath(dataRoot, plan.chatFile)
	before, err = smFileDigestOrAbsent(chatPath)
	if err != nil {
		t.Fatal(err)
	}
	status, body = session.doPost(t, "/api/chats/save", chatBody)
	if err := smCheckHTTPStatus("chat-save", "/api/chats/save", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	after, err = smFileDigestOrAbsent(chatPath)
	if err != nil {
		t.Fatal(err)
	}
	if recorded, jsonErr := os.ReadFile(chatPath); jsonErr != nil {
		t.Errorf("seed %d pass %d: chat-save wrote no chat file: %v", plan.seed, pass, jsonErr)
	} else if texts, parseErr := smChatTextsFromDisk(recorded); parseErr != nil {
		t.Errorf("seed %d pass %d: %v (chat file after save)", plan.seed, pass, parseErr)
	} else if msgErr := smCheckOrderedMessages(plan.messages[:3], texts); msgErr != nil {
		t.Errorf("seed %d pass %d: %v (chat file after save)", plan.seed, pass, msgErr)
	}
	valid = plan.checkHealth(t, dataRoot, 2)
	server.record(&entries, plan, 2, "chat-save", http.MethodPost, "/api/chats/save", status, before, after, valid, "")

	// (4) chat-load: the route returns the ordered messages, not merely bytes.
	loadBody, err := marshalJSON(map[string]any{"avatar_url": plan.avatar, "file_name": plan.chatFile})
	if err != nil {
		t.Fatal(err)
	}
	status, body = session.doPost(t, "/api/chats/get", loadBody)
	if err := smCheckHTTPStatus("chat-load", "/api/chats/get", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	loaded, decodeErr := smDecodeChatArray(body)
	if decodeErr != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, decodeErr, body)
		loaded = nil
	}
	if err := smCheckOrderedMessages(plan.messages[:3], loaded); err != nil {
		t.Errorf("seed %d pass %d: %v (/api/chats/get after save)", plan.seed, pass, err)
	}
	valid = plan.checkHealth(t, dataRoot, 3)
	server.record(&entries, plan, 3, "chat-load", http.MethodPost, "/api/chats/get", status, "", smObservableDigest([]byte(strings.Join(loaded, "\n"))), valid, "")

	// (5) message-append: save five messages; the persisted file must carry five, in order.
	chatBody, err = plan.chatBody(dataRoot, smMessageCountAfterAppend)
	if err != nil {
		t.Fatal(err)
	}
	before, err = smFileDigestOrAbsent(chatPath)
	if err != nil {
		t.Fatal(err)
	}
	status, body = session.doPost(t, "/api/chats/save", chatBody)
	if err := smCheckHTTPStatus("message-append", "/api/chats/save", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	after, err = smFileDigestOrAbsent(chatPath)
	if err != nil {
		t.Fatal(err)
	}
	if recorded, jsonErr := os.ReadFile(chatPath); jsonErr != nil {
		t.Errorf("seed %d pass %d: message-append wrote no chat file: %v", plan.seed, pass, jsonErr)
	} else if texts, parseErr := smChatTextsFromDisk(recorded); parseErr != nil {
		t.Errorf("seed %d pass %d: %v (chat file after append)", plan.seed, pass, parseErr)
	} else if len(texts) != smMessageCountAfterAppend {
		t.Errorf("seed %d pass %d: persisted-message-dropped:%d->%d", plan.seed, pass, smMessageCountAfterAppend, len(texts))
	}
	valid = plan.checkHealth(t, dataRoot, 4)
	server.record(&entries, plan, 4, "message-append", http.MethodPost, "/api/chats/save", status, before, after, valid, "")

	// (6) message-order-reload: read the five back and prove the order from both the route and the bytes.
	status, body = session.doPost(t, "/api/chats/get", loadBody)
	if err := smCheckHTTPStatus("message-order-reload", "/api/chats/get", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	reloaded, decodeErr := smDecodeChatArray(body)
	if decodeErr != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, decodeErr, body)
		reloaded = nil
	}
	if err := smCheckOrderedMessages(plan.messages, reloaded); err != nil {
		t.Errorf("seed %d pass %d: %v (/api/chats/get after append)", plan.seed, pass, err)
	}
	if recorded, jsonErr := os.ReadFile(chatPath); jsonErr != nil {
		t.Errorf("seed %d pass %d: the chat file disappeared: %v", plan.seed, pass, jsonErr)
	} else if texts, parseErr := smChatTextsFromDisk(recorded); parseErr != nil {
		t.Errorf("seed %d pass %d: %v (chat file on reload)", plan.seed, pass, parseErr)
	} else if err := smCheckOrderedMessages(plan.messages, texts); err != nil {
		t.Errorf("seed %d pass %d: %v (chat bytes on reload)", plan.seed, pass, err)
	}
	after, err = smFileDigestOrAbsent(chatPath)
	if err != nil {
		t.Fatal(err)
	}
	valid = plan.checkHealth(t, dataRoot, 5)
	server.record(&entries, plan, 5, "message-order-reload", http.MethodPost, "/api/chats/get", status, "", after, valid, "")

	// (7) chat-rename: pinned renames with its own sanitizer; the old path must be gone and the new one complete.
	renameBody, err := marshalJSON(map[string]any{
		"avatar_url":    plan.avatar,
		"original_file": plan.chatFile + ".jsonl",
		"renamed_file":  plan.renamedFile + ".jsonl",
	})
	if err != nil {
		t.Fatal(err)
	}
	before, err = smFileDigestOrAbsent(chatPath)
	if err != nil {
		t.Fatal(err)
	}
	status, body = session.doPost(t, "/api/chats/rename", renameBody)
	if err := smCheckHTTPStatus("chat-rename", "/api/chats/rename", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	renamedPath := plan.chatPath(dataRoot, plan.renamedFile)
	if oldDigest, digestErr := smFileDigestOrAbsent(chatPath); digestErr != nil || oldDigest != "absent" {
		t.Errorf("seed %d pass %d: chat-rename left the original file behind (%v)", plan.seed, pass, digestErr)
	}
	if recorded, jsonErr := os.ReadFile(renamedPath); jsonErr != nil {
		t.Errorf("seed %d pass %d: chat-rename wrote no renamed file: %v", plan.seed, pass, jsonErr)
	} else if texts, parseErr := smChatTextsFromDisk(recorded); parseErr != nil {
		t.Errorf("seed %d pass %d: %v (renamed chat)", plan.seed, pass, parseErr)
	} else if err := smCheckOrderedMessages(plan.messages, texts); err != nil {
		t.Errorf("seed %d pass %d: %v (renamed chat)", plan.seed, pass, err)
	}
	// The renamed chat must still LOAD through the route, not merely exist.
	renamedLoadBody, err := marshalJSON(map[string]any{"avatar_url": plan.avatar, "file_name": plan.renamedFile})
	if err != nil {
		t.Fatal(err)
	}
	status, body = session.doPost(t, "/api/chats/get", renamedLoadBody)
	if err := smCheckHTTPStatus("chat-rename", "/api/chats/get", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	renamedTexts, decodeErr := smDecodeChatArray(body)
	if decodeErr != nil {
		t.Errorf("seed %d pass %d: %v (renamed chat load): %s", plan.seed, pass, decodeErr, body)
		renamedTexts = nil
	}
	if err := smCheckOrderedMessages(plan.messages, renamedTexts); err != nil {
		t.Errorf("seed %d pass %d: %v (renamed chat load)", plan.seed, pass, err)
	}
	after, err = smFileDigestOrAbsent(renamedPath)
	if err != nil {
		t.Fatal(err)
	}
	valid = plan.checkHealth(t, dataRoot, 6)
	server.record(&entries, plan, 6, "chat-rename", http.MethodPost, "/api/chats/rename", status, before, after, valid, "")

	// (8) chat-load-preexisting: the history planted before boot opens, in order, and its bytes are the ones the
	// recipe declared.
	prebootLoadBody, err := marshalJSON(map[string]any{"avatar_url": plan.avatar, "file_name": "PREBOOT"})
	if err != nil {
		t.Fatal(err)
	}
	status, body = session.doPost(t, "/api/chats/get", prebootLoadBody)
	if err := smCheckHTTPStatus("chat-load-preexisting", "/api/chats/get", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	prebootTexts, decodeErr := smDecodeChatArray(body)
	if decodeErr != nil {
		t.Errorf("seed %d pass %d: %v (preboot chat): %s", plan.seed, pass, decodeErr, body)
		prebootTexts = nil
	}
	if err := smCheckOrderedMessages(plan.preboot, prebootTexts); err != nil {
		t.Errorf("seed %d pass %d: %v (preboot chat)", plan.seed, pass, err)
	}
	if err := smCheckPrebootArtifacts(plan.seed, dataRoot, plan.recipe); err != nil {
		t.Errorf("seed %d pass %d: %v", plan.seed, pass, err)
	}
	prebootPath := plan.chatPath(dataRoot, "PREBOOT")
	before, err = smFileDigestOrAbsent(prebootPath)
	if err != nil {
		t.Fatal(err)
	}
	after = smObservableDigest([]byte(strings.Join(prebootTexts, "\n")))
	valid = plan.checkHealth(t, dataRoot, 7)
	server.record(&entries, plan, 7, "chat-load-preexisting", http.MethodPost, "/api/chats/get", status, before, after, valid, "")

	// (9) cross-user-isolation: the SAME routes inside the next account's session must not leak this seed's
	// settings or chat. A 200 with no marker is the assertion; a 403 would not prove isolation.
	handles := longlivedfixture.StateMachineUserHandles()
	index := 0
	for candidate, handle := range handles {
		if handle == plan.user {
			index = candidate
			break
		}
	}
	otherUser := handles[(index+1)%len(handles)]
	otherSession := server.sessions[otherUser]
	status, otherSettingsBody := otherSession.doPost(t, "/api/settings/get", "{}")
	if err := smCheckHTTPStatus("cross-user-isolation", "/api/settings/get", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, otherSettingsBody)
	}
	otherSettings, err := smSettingsString(otherSettingsBody)
	if err != nil {
		t.Errorf("seed %d pass %d: %v (other account's settings): %s", plan.seed, pass, err, otherSettingsBody)
		otherSettings = ""
	}
	if err := smCheckSettingsMarker(otherSettings, plan.marker, false); err != nil {
		t.Errorf("seed %d pass %d: %v (reader %s)", plan.seed, pass, err, otherUser)
	}
	status, otherChatBody := otherSession.doPost(t, "/api/chats/get", renamedLoadBody)
	if err := smCheckHTTPStatus("cross-user-isolation", "/api/chats/get", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, otherChatBody)
	}
	for _, marker := range []string{"SEEDMSG_" + strconv.FormatInt(plan.seed, 10) + "_", "PREBOOT_" + strconv.FormatInt(plan.seed, 10) + "_"} {
		if err := smCheckCrossUserRead(otherChatBody, marker); err != nil {
			t.Errorf("seed %d pass %d: %v (reader %s)", plan.seed, pass, err, otherUser)
		}
	}
	after = smObservableDigest([]byte(otherSettings + "\x00" + otherChatBody))
	valid = plan.checkHealth(t, dataRoot, 8)
	server.record(&entries, plan, 8, "cross-user-isolation", http.MethodPost, "/api/chats/get", status, "", after, valid, otherUser)

	// (10) chat-delete: the renamed chat is removed, and the settings write from step (1) stays.
	deleteBody, err := marshalJSON(map[string]any{"avatar_url": plan.avatar, "chatfile": plan.renamedFile})
	if err != nil {
		t.Fatal(err)
	}
	before, err = smFileDigestOrAbsent(renamedPath)
	if err != nil {
		t.Fatal(err)
	}
	status, body = session.doPost(t, "/api/chats/delete", deleteBody)
	if err := smCheckHTTPStatus("chat-delete", "/api/chats/delete", status, http.StatusOK); err != nil {
		t.Errorf("seed %d pass %d: %v: %s", plan.seed, pass, err, body)
	}
	after, err = smFileDigestOrAbsent(renamedPath)
	if err != nil {
		t.Fatal(err)
	}
	if after != "absent" {
		t.Errorf("seed %d pass %d: chat-delete left the chat file on disk", plan.seed, pass)
	}
	if _, statErr := os.Stat(settingsPath); statErr != nil {
		t.Errorf("seed %d pass %d: chat-delete removed settings.json, which it must never touch: %v", plan.seed, pass, statErr)
	}
	valid = plan.checkHealth(t, dataRoot, 9)
	server.record(&entries, plan, 9, "chat-delete", http.MethodPost, "/api/chats/delete", status, before, after, valid, "")

	if err := smCheckActionPlan(plan.recipe, entries); err != nil {
		t.Errorf("seed %d pass %d: %v", plan.seed, pass, err)
	}
	return entries
}

// smCaptureWitness samples the durable state before a restart.
func (server *smServer) captureWitness(t *testing.T, markers map[string]string, executed []int64) smRestartWitness {
	t.Helper()
	witness := smRestartWitness{
		Instance:     server.instance,
		DataRoot:     server.dataRoot,
		UserMarkers:  map[string]string{},
		PrebootSeed:  executed[len(executed)-1],
		UnknownFiles: map[string]string{},
	}
	for user, marker := range markers {
		witness.UserMarkers[user] = marker
	}
	for _, seed := range executed {
		plan := newSMSeedPlan(t, seed)
		relative := filepath.ToSlash(filepath.Join(plan.user, "user", "files", "E_"+strconv.FormatInt(seed, 10)+".bin"))
		digest, err := smFileDigestOrAbsent(filepath.Join(server.dataRoot, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatalf("seed %d: digest the unknown file before restart: %v", seed, err)
		}
		witness.UnknownFiles[relative] = digest
	}
	witness.PrebootChat = server.readChatTexts(t, newSMSeedPlan(t, witness.PrebootSeed), "PREBOOT")
	return witness
}

// smCaptureObservation samples the same durable state after the restart, through the product's routes where a
// route exists and through the bytes where it does not.
func (server *smServer) captureObservation(t *testing.T, witness smRestartWitness) smRestartObservation {
	t.Helper()
	observation := smRestartObservation{
		Instance:     server.instance,
		DataRoot:     server.dataRoot,
		UserSettings: map[string]string{},
		UnknownFiles: map[string]string{},
	}
	for _, handle := range longlivedfixture.StateMachineUserHandles() {
		session := server.sessions[handle]
		status, body := session.doPost(t, "/api/settings/get", "{}")
		if status != http.StatusOK {
			t.Fatalf("restart: POST /api/settings/get for %s = %d: %s", handle, status, body)
		}
		settings, err := smSettingsString(body)
		if err != nil {
			t.Fatalf("restart: %v for %s", err, handle)
		}
		observation.UserSettings[handle] = settings
	}
	plan := newSMSeedPlan(t, witness.PrebootSeed)
	prebootLoad, err := marshalJSON(map[string]any{"avatar_url": plan.avatar, "file_name": "PREBOOT"})
	if err != nil {
		t.Fatal(err)
	}
	status, body := server.sessions[plan.user].doPost(t, "/api/chats/get", prebootLoad)
	if status != http.StatusOK {
		t.Fatalf("restart: preboot chat load = %d: %s", status, body)
	}
	observation.PrebootChat = body
	for relative := range witness.UnknownFiles {
		digest, err := smFileDigestOrAbsent(filepath.Join(server.dataRoot, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatalf("restart: digest %s: %v", relative, err)
		}
		observation.UnknownFiles[relative] = digest
	}
	return observation
}

// readChatTexts loads one chat through the product's route and returns its ordered texts.
func (server *smServer) readChatTexts(t *testing.T, plan *smSeedPlan, file string) []string {
	t.Helper()
	body, err := marshalJSON(map[string]any{"avatar_url": plan.avatar, "file_name": file})
	if err != nil {
		t.Fatal(err)
	}
	status, answer := server.sessions[plan.user].doPost(t, "/api/chats/get", body)
	if status != http.StatusOK {
		t.Fatalf("seed %d: load chat %s = %d: %s", plan.seed, file, status, answer)
	}
	texts, decodeErr := smDecodeChatArray(answer)
	if decodeErr != nil {
		t.Fatalf("seed %d: %v (chat %s)", plan.seed, decodeErr, file)
	}
	return texts
}

// TestSeededStateMachineQualification is the lane's gate: 100 seeds x 10 operations, executed twice each, over a
// real in-process server, with an eight-account isolation leg and four same-data-root restarts.
func TestSeededStateMachineQualification(t *testing.T) {
	if testing.Short() {
		t.Skip("the seeded state-machine qualification is bounded but not a unit test; -short skips it")
	}
	started := time.Now()
	server := newSMServer(t)

	seeds := make([]int64, 0, smSeedCount)
	for index := 0; index < smSeedCount; index++ {
		seeds = append(seeds, smSeedBase+int64(index))
	}
	environment, err := longlivedfixture.BuildSeededEnvironment(server.dataRoot, seeds, longlivedfixture.StateMachineUserCount)
	if err != nil {
		t.Fatalf("build the seeded preboot environment: %v", err)
	}
	if environment.Schema.Tree.Files == 0 || environment.Schema.Tree.SHA256 == "" {
		t.Fatalf("the seeded environment has no schema identity: %+v", environment.Schema.Tree)
	}
	t.Logf("seeded environment: %d seeds, %d users, %d files, %d bytes, tree %s",
		len(seeds), longlivedfixture.StateMachineUserCount, environment.Schema.Tree.Files, environment.Schema.Tree.Bytes, environment.Schema.Tree.SHA256)

	if err := server.boot(); err != nil {
		t.Fatalf("boot the real server on the seeded tree: %v", err)
	}
	if err := server.loginAll(); err != nil {
		t.Fatalf("authenticate the %d E06 accounts: %v", longlivedfixture.StateMachineUserCount, err)
	}

	actionLog := make([]smActionEntry, 0, smSeedCount*len(longlivedfixture.StateMachineOperations)*2)
	executed := make([]int64, 0, smSeedCount)
	markers := map[string]string{}
	seedEntries := make(map[int64][][]smActionEntry, smSeedCount)
	restartCount := 0
	for batch := 0; batch < smSeedCount/smBatchSize; batch++ {
		for index := batch * smBatchSize; index < (batch+1)*smBatchSize; index++ {
			seed := seeds[index]
			plan := newSMSeedPlan(t, seed)
			first := server.runSeedSequence(t, plan, 1)
			second := server.runSeedSequence(t, plan, 2)
			if err := smCheckReproducible(seed, first, second); err != nil {
				t.Errorf("%v", err)
			}
			// The action-log entries are appended in execution order, so the artifact is ordered data (rule 16).
			actionLog = append(actionLog, first...)
			actionLog = append(actionLog, second...)
			seedEntries[seed] = [][]smActionEntry{first, second}
			executed = append(executed, seed)
			markers[plan.user] = plan.marker
		}
		witness := server.captureWitness(t, markers, executed)
		instance, err := server.restart()
		if err != nil {
			t.Fatalf("restart after batch %d: %v", batch, err)
		}
		observation := server.captureObservation(t, witness)
		if observation.Instance != instance {
			t.Errorf("restart after batch %d: observation instance %d != booted instance %d", batch, observation.Instance, instance)
		}
		if err := smCheckRestartResume(witness, observation); err != nil {
			t.Errorf("restart after batch %d: %v", batch, err)
		}
		restartCount++
		actionLog = append(actionLog, smActionEntry{
			Seed:         0,
			Step:         -1,
			Op:           "restart-resume",
			User:         "*",
			Method:       http.MethodGet,
			Route:        "/version+restart",
			Status:       http.StatusOK,
			BeforeDigest: fmt.Sprintf("instance-%d", witness.Instance),
			AfterDigest:  fmt.Sprintf("instance-%d:%s", observation.Instance, environment.Schema.Tree.SHA256),
			JSONValid:    true,
			Instance:     observation.Instance,
			Detail:       fmt.Sprintf("batch-%d", batch),
		})
		t.Logf("restart %d after batch %d: instance %d -> %d on the same data root; %d seeds x 10 ops executed so far",
			restartCount, batch, witness.Instance, observation.Instance, len(executed))
	}

	// Scale and shape: 100 seeds x 10 operations x 2 executions is the plan's floor, measured, not asserted from
	// the loop bounds alone.
	operationEntries := 0
	for _, entries := range actionLog {
		if entries.Op != "restart-resume" {
			operationEntries++
		}
	}
	if operationEntries != smSeedCount*len(longlivedfixture.StateMachineOperations)*2 {
		t.Fatalf("the action log carries %d operation entries, the lane executed %d", operationEntries, smSeedCount*len(longlivedfixture.StateMachineOperations)*2)
	}
	if operationEntries < 1000 {
		t.Fatalf("operation entries = %d, the plan's floor is 1000", operationEntries)
	}
	// Every seed ran as its declared account, and all eight accounts were exercised.
	accounts := map[string]bool{}
	for seed := range seedEntries {
		accounts[longlivedfixture.SeededSeedUser(seed)] = true
	}
	if len(accounts) != longlivedfixture.StateMachineUserCount {
		t.Fatalf("%d of %d E06 accounts were exercised: %v", len(accounts), longlivedfixture.StateMachineUserCount, accounts)
	}

	// The action log must be MACHINE-READABLE as a file, not only in memory.
	logRoot := t.TempDir()
	logPath := filepath.Join(logRoot, "action-log.jsonl")
	var logBuffer strings.Builder
	for _, entry := range actionLog {
		line, err := json.Marshal(entry)
		if err != nil {
			t.Fatalf("marshal an action-log entry: %v", err)
		}
		logBuffer.Write(line)
		logBuffer.WriteByte('\n')
	}
	if err := os.WriteFile(logPath, []byte(logBuffer.String()), 0o600); err != nil {
		t.Fatalf("write the action log: %v", err)
	}
	written, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := smCheckJSONL(written); err != nil {
		t.Fatalf("the action log is not valid JSONL: %v", err)
	}
	t.Logf("action log: %d entries (%d operations + %d restarts), digest %s, file %s",
		len(actionLog), operationEntries, restartCount, smObservableDigest(written)[:16], logPath)
	t.Logf("seeded state-machine qualification executed %d seeds x %d operations = %d reproducible sequences, %d restarts, %d files planted; wall time %s",
		smSeedCount, len(longlivedfixture.StateMachineOperations), operationEntries, restartCount, environment.Schema.Tree.Files, time.Since(started).Round(time.Millisecond))
}
