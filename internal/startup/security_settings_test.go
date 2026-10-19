package startup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type securitySettingsOracle struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]struct {
		Inputs struct {
			Config map[string]any `json:"config"`
			Args   struct {
				Listen        bool `json:"listen"`
				BasicAuthMode bool `json:"basicAuthMode"`
				WhitelistMode bool `json:"whitelistMode"`
			} `json:"args"`
			Users []SecuritySettingsUser `json:"users"`
		} `json:"inputs"`
		Exit   *int                    `json:"exitCode"`
		Events []SecuritySettingsEvent `json:"events"`
	} `json:"scenarios"`
}

func TestVerifySecuritySettingsMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-security-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture securitySettingsOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected security-settings oracle baseline: %#v", fixture.Baseline)
	}
	if len(fixture.Scenarios) < 8 {
		t.Fatalf("security oracle has only %d scenarios", len(fixture.Scenarios))
	}

	for name, scenario := range fixture.Scenarios {
		t.Run(name, func(t *testing.T) {
			basicAuthUser, _ := scenario.Inputs.Config["basicAuthUser"].(map[string]any)
			input := SecuritySettingsInput{
				Listen:             scenario.Inputs.Args.Listen,
				BasicAuthMode:      scenario.Inputs.Args.BasicAuthMode,
				WhitelistMode:      scenario.Inputs.Args.WhitelistMode,
				EnableUserAccounts: scenario.Inputs.Config["enableUserAccounts"],
				SecurityOverride:   scenario.Inputs.Config["securityOverride"],
				PerUserBasicAuth:   scenario.Inputs.Config["perUserBasicAuth"],
				BasicAuthUsername:  basicAuthUser["username"],
				BasicAuthPassword:  basicAuthUser["password"],
				Users:              scenario.Inputs.Users,
			}
			got := VerifySecuritySettings(input)
			want := SecuritySettingsResult{ExitCode: scenario.Exit, Events: scenario.Events}
			if !reflect.DeepEqual(got, want) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(want, "", "  ")
				t.Fatalf("security gate differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}
