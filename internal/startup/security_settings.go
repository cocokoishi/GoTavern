package startup

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

type SecuritySettingsUser struct {
	Handle   string `json:"handle"`
	Password any    `json:"password"`
	Admin    any    `json:"admin"`
	Enabled  any    `json:"enabled"`
}

type SecuritySettingsInput struct {
	Listen             bool
	BasicAuthMode      bool
	WhitelistMode      bool
	EnableUserAccounts any
	SecurityOverride   any
	PerUserBasicAuth   any
	BasicAuthUsername  any
	BasicAuthPassword  any
	Users              []SecuritySettingsUser
}

type SecuritySettingsEvent struct {
	Level string   `json:"level"`
	Args  []string `json:"args"`
}

type SecuritySettingsResult struct {
	ExitCode *int                    `json:"exitCode"`
	Events   []SecuritySettingsEvent `json:"events"`
}

// VerifySecuritySettings reproduces the pinned startup security gate as an
// ordered list of console events and an optional process exit status. The
// caller decides how to present events and terminate the startup process.
func VerifySecuritySettings(input SecuritySettingsInput) SecuritySettingsResult {
	result := SecuritySettingsResult{Events: make([]SecuritySettingsEvent, 0)}
	if !input.Listen {
		return result
	}
	accountsEnabled := nodeConfigBoolean(input.EnableUserAccounts)
	securityOverride := nodeConfigBoolean(input.SecurityOverride)
	perUserBasicAuth := nodeConfigBoolean(input.PerUserBasicAuth)
	securityAlert := func(message string) bool {
		if input.BasicAuthMode || input.WhitelistMode {
			return false
		}
		result.Events = append(result.Events, securityEvent("error", message))
		if securityOverride {
			result.Events = append(result.Events, securityEvent("warn", "Security has been overridden. If it's not a trusted network, change the settings."))
			return false
		}
		exitCode := 1
		result.ExitCode = &exitCode
		return true
	}

	if !accountsEnabled && securityAlert("Your current SillyTavern configuration is insecure (listening to non-localhost). Enable whitelisting, basic authentication or user accounts.") {
		return result
	}

	users := make([]SecuritySettingsUser, 0, len(input.Users))
	if accountsEnabled {
		for _, user := range input.Users {
			if nodeTruthy(user.Enabled) {
				users = append(users, user)
			}
		}
	}
	unprotected := make([]SecuritySettingsUser, 0)
	unprotectedAdmins := make([]SecuritySettingsUser, 0)
	for _, user := range users {
		if nodeTruthy(user.Password) {
			continue
		}
		unprotected = append(unprotected, user)
		if nodeTruthy(user.Admin) {
			unprotectedAdmins = append(unprotectedAdmins, user)
		}
	}
	if len(unprotected) > 0 {
		result.Events = append(result.Events, securityEvent("warn", "A friendly reminder that the following users are not password protected:"))
		for _, user := range unprotected {
			adminLabel := ""
			if nodeTruthy(user.Admin) {
				adminLabel = "(admin)"
			}
			result.Events = append(result.Events, securityEvent("warn", fmt.Sprintf("%s %s", user.Handle, adminLabel)))
		}
		result.Events = append(result.Events, securityEvent("log"))
		result.Events = append(result.Events, securityEvent("warn", "Consider setting a password in the admin panel or by using the recover.js script."))
		result.Events = append(result.Events, securityEvent("log"))
		if len(unprotectedAdmins) > 0 && securityAlert("If you are not using basic authentication or whitelisting, you should set a password for all admin users.") {
			return result
		}
	}

	if input.BasicAuthMode {
		if perUserBasicAuth && !accountsEnabled {
			result.Events = append(result.Events, securityEvent("error", "Per-user basic authentication is enabled, but user accounts are disabled. This configuration may be insecure."))
		} else if !perUserBasicAuth && (!nodeTruthy(input.BasicAuthUsername) || !nodeTruthy(input.BasicAuthPassword)) {
			result.Events = append(result.Events, securityEvent("warn", "Basic Authentication is enabled, but username or password is not set or empty!"))
		}
	}
	return result
}

func securityEvent(level string, args ...string) SecuritySettingsEvent {
	if args == nil {
		args = []string{}
	}
	return SecuritySettingsEvent{Level: level, Args: args}
}

func nodeConfigBoolean(value any) bool {
	if text, ok := value.(string); ok {
		switch strings.ToLower(strings.TrimSpace(text)) {
		case "true":
			return true
		case "false":
			return false
		}
	}
	return nodeTruthy(value)
}

func nodeTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	case float32:
		return typed != 0 && !math.IsNaN(float64(typed))
	case int:
		return typed != 0
	case int8:
		return typed != 0
	case int16:
		return typed != 0
	case int32:
		return typed != 0
	case int64:
		return typed != 0
	case uint:
		return typed != 0
	case uint8:
		return typed != 0
	case uint16:
		return typed != 0
	case uint32:
		return typed != 0
	case uint64:
		return typed != 0
	case json.Number:
		number, err := typed.Float64()
		return err == nil && number != 0 && !math.IsNaN(number)
	default:
		// JavaScript arrays and objects are truthy even when empty.
		return true
	}
}
