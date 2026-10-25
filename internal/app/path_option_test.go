package app

import "testing"

// hasExplicitPathOption decides whether the app boundary may reproduce pinned's chdir (server.js:11) or must honour
// a path the user named. Getting it wrong in the permissive direction scatters config.yaml and data/ into whatever
// directory the binary was launched from; getting it wrong in the strict direction ignores a path the user typed.
// Both are user-visible, so the spellings are pinned here rather than assumed.
func TestHasExplicitPathOption(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{name: "no arguments at all", args: nil, want: false},
		{name: "unrelated flags", args: []string{"--port", "8000", "--listen=false"}, want: false},
		{name: "configPath with a separated value", args: []string{"--configPath", "/srv/st/config.yaml"}, want: true},
		{name: "configPath with an equals sign", args: []string{"--configPath=/srv/st/config.yaml"}, want: true},
		{name: "the kebab spelling", args: []string{"--config-path=/srv/st/config.yaml"}, want: true},
		{name: "dataRoot with a separated value", args: []string{"--port", "8000", "--dataRoot", "/srv/st/data"}, want: true},
		{name: "dataRoot with an equals sign", args: []string{"--dataRoot=/srv/st/data"}, want: true},
		{name: "the kebab spelling of dataRoot", args: []string{"--data-root", "/srv/st/data"}, want: true},
		// A prefix that is NOT the flag must not be treated as one: "--configPathX" is somebody else's argument.
		{name: "a longer flag sharing the prefix", args: []string{"--configPathX=1"}, want: false},
		{name: "a value that merely contains the word", args: []string{"--port", "configPath"}, want: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := hasExplicitPathOption(testCase.args); got != testCase.want {
				t.Fatalf("hasExplicitPathOption(%q) = %v, want %v", testCase.args, got, testCase.want)
			}
		})
	}
}
