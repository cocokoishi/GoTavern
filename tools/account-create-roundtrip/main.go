package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"

	"github.com/cocokoishi/gotavern/internal/server"
)

const cookieSecret = "gotavern-account-create-roundtrip-secret"

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: account-create-roundtrip <data-root> <install-root>")
		os.Exit(2)
	}
	dataRoot, installRoot := os.Args[1], os.Args[2]
	handler := server.NewHTTPHandlerWithOptions(server.HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})
	csrfResponse := serve(handler, http.MethodGet, "/csrf-token", nil, "", "")
	if csrfResponse.Code != http.StatusOK {
		fail("GET /csrf-token", csrfResponse)
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		panic(err)
	}
	csrfCookie := cookieHeader(csrfResponse.Header().Values("Set-Cookie"))
	loginBody, _ := json.Marshal(map[string]string{"handle": "default-user"})
	loginResponse := serve(handler, http.MethodPost, "/api/users/login", loginBody, csrfCookie, csrf.Token)
	if loginResponse.Code != http.StatusOK {
		fail("POST /api/users/login", loginResponse)
	}
	adminCookie := cookieHeader(loginResponse.Header().Values("Set-Cookie"))
	createBody, _ := json.Marshal(map[string]any{
		"handle": "Go Roundtrip", "name": "Go-created account", "password": "account-create-roundtrip-password", "admin": false,
	})
	createResponse := serve(handler, http.MethodPost, "/api/users/create", createBody, adminCookie, csrf.Token)
	if createResponse.Code != http.StatusOK || strings.TrimSpace(createResponse.Body.String()) != `{"handle":"go-roundtrip"}` {
		fail("POST /api/users/create", createResponse)
	}
	fmt.Println(`{"handle":"go-roundtrip"}`)
}

func serve(handler http.Handler, method, route string, body []byte, cookie, csrf string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, route, strings.NewReader(string(body)))
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func cookieHeader(cookies []string) string {
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
	}
	return strings.Join(parts, "; ")
}

func fail(label string, response *httptest.ResponseRecorder) {
	fmt.Fprintf(os.Stderr, "%s returned %d: %s\n", label, response.Code, response.Body.String())
	os.Exit(1)
}
