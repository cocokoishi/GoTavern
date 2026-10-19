package startup

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// DataStartupOptions contains the inputs that SillyTavern derives from its
// command line and config before serving requests. Defaults are supplied by
// the caller so this package does not silently guess config behavior.
type DataStartupOptions struct {
	InstallRoot              string
	DataRoot                 string
	LegacyCookieSecret       string
	Security                 SecuritySettingsInput
	Seed                     SeedOptions
	CharacterDiskCache       bool
	SettingsBackupRetention  int
	Now                      time.Time
	WaitBeforeLegacyDataMove func(time.Duration)
}

// StartupDiagnostic records an error that SillyTavern catches and reports
// while continuing through its startup chain.
type StartupDiagnostic struct {
	Stage string
	Err   error
}

// DataStartupResult contains the state needed by the later server setup and
// the diagnostics from startup operations whose failures are caught upstream.
type DataStartupResult struct {
	CookieSecret       string
	CookieSecretSource CookieSecretResult
	Handles            []string
	Directories        []UserDirectories
	Security           SecuritySettingsResult
	Seed               SeedResult
	Statistics         StatisticsInitialization
	Diagnostics        []StartupDiagnostic
}

// SecurityGateError reports that the pinned startup security check requested
// process termination. The caller should present Security.Events and exit
// with ExitCode rather than continuing to bind a listener.
type SecurityGateError struct {
	ExitCode int
}

func (e SecurityGateError) Error() string {
	return fmt.Sprintf("startup security check requested exit status %d", e.ExitCode)
}

// InitializeDataStartup runs the pinned SillyTavern startup data chain in
// order, stopping at the same awaited failure boundaries. It covers the
// startup work before plugin loading, HTTP middleware setup, and listener
// creation; it does not claim those later server behaviors are implemented.
func InitializeDataStartup(options DataStartupOptions) (DataStartupResult, error) {
	var result DataStartupResult
	if options.InstallRoot == "" || options.DataRoot == "" {
		return result, errors.New("startup requires install and data roots")
	}

	secret, secretSource, err := InitializeCookieSecret(options.DataRoot, options.LegacyCookieSecret)
	if err != nil {
		return result, fmt.Errorf("initialize cookie secret: %w", err)
	}
	result.CookieSecret = secret
	result.CookieSecretSource = secretSource
	if err := ensureUploadsDirectory(options.DataRoot); err != nil {
		return result, fmt.Errorf("initialize upload staging directory: %w", err)
	}

	handles, err := InitializeUserStorage(options.DataRoot)
	if err != nil {
		return result, fmt.Errorf("initialize user storage: %w", err)
	}
	result.Handles = handles

	directories, err := EnsureDirectories(options.InstallRoot, options.DataRoot, handles)
	if err != nil {
		return result, fmt.Errorf("ensure startup directories: %w", err)
	}
	result.Directories = directories

	userDataErrors, err := MigrateUserData(options.InstallRoot, options.DataRoot, options.WaitBeforeLegacyDataMove)
	if err != nil {
		return result, fmt.Errorf("migrate legacy user data: %w", err)
	}
	result.addDiagnostics("user-data migration", userDataErrors)

	systemPromptErrors, err := MigrateSystemPrompts(options.DataRoot, directories)
	if err != nil {
		return result, fmt.Errorf("migrate system prompts: %w", err)
	}
	result.addDiagnostics("system-prompt migration", systemPromptErrors)

	publicOverrideErrors, err := MigratePublicOverrides(options.InstallRoot, options.DataRoot)
	if err != nil {
		return result, fmt.Errorf("migrate public overrides: %w", err)
	}
	result.addDiagnostics("public-override migration", publicOverrideErrors)

	securitySettings := options.Security
	if securitySettings.Users == nil && nodeConfigBoolean(securitySettings.EnableUserAccounts) {
		securitySettings.Users, err = readSecuritySettingsUsers(options.DataRoot)
		if err != nil {
			return result, fmt.Errorf("read users for startup security check: %w", err)
		}
	}
	result.Security = VerifySecuritySettings(securitySettings)
	if result.Security.ExitCode != nil {
		return result, SecurityGateError{ExitCode: *result.Security.ExitCode}
	}

	groupMetadataErrors, err := MigrateGroupChatsMetadataFormat(directories)
	if err != nil {
		return result, fmt.Errorf("migrate group-chat metadata: %w", err)
	}
	result.addDiagnostics("group-chat metadata migration", groupMetadataErrors)

	seed, err := SeedDefaultContent(options.DataRoot, directories, options.Seed)
	if err != nil {
		return result, fmt.Errorf("seed default content: %w", err)
	}
	result.Seed = seed

	result.addDiagnostics("character disk-cache verification", VerifyCharacterDiskCache(options.DataRoot, directories, options.CharacterDiskCache))
	result.addDiagnostics("flat-secret migration", MigrateFlatSecrets(directories))
	result.addDiagnostics("upload cleanup", CleanUploads(options.DataRoot).Errors)
	result.addDiagnostics("access-log migration", MigrateAccessLog(options.InstallRoot, options.DataRoot).Errors)
	result.addDiagnostics("settings backup", BackupSettings(directories, options.SettingsBackupRetention))

	result.Statistics = InitializeStatistics(directories, options.Now)
	result.addDiagnostics("statistics initialization", result.Statistics.Errors)
	return result, nil
}

func (result *DataStartupResult) addDiagnostics(stage string, errs []error) {
	for _, err := range errs {
		if err != nil {
			result.Diagnostics = append(result.Diagnostics, StartupDiagnostic{Stage: stage, Err: err})
		}
	}
}

func ensureUploadsDirectory(dataRoot string) error {
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return fmt.Errorf("resolve data root: %w", err)
	}
	uploadsDirectory := filepath.Join(absoluteRoot, "_uploads")
	if err := ensureContained(absoluteRoot, uploadsDirectory); err != nil {
		return fmt.Errorf("invalid upload staging path: %w", err)
	}
	if err := os.MkdirAll(uploadsDirectory, 0o777); err != nil {
		return err
	}
	if err := ensureResolvedContained(absoluteRoot, uploadsDirectory); err != nil {
		return fmt.Errorf("upload staging directory escapes data root: %w", err)
	}
	return nil
}
