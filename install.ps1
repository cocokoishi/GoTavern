# GoTavern release installer for Windows.
# Downloads a prebuilt GitHub Release asset. It never installs Go/Node or compiles source.

[CmdletBinding()]
param(
    # THE DEFAULT IS THE CALLER'S CURRENT WORKING DIRECTORY, and it is deliberately NOT $PSScriptRoot.
    #
    # A user who runs this in the directory they want GoTavern in -- `cd D:\Apps\GoTavern` then
    # `.\install.ps1 -Version v0.1.0-alpha.8` -- must get GoTavern THERE, not in $HOME\GoTavern and not
    # beside the script. The two differ whenever the script is invoked by path from somewhere else
    # (`C:\Tools\install.ps1` run from `D:\Target` means `D:\Target`), so the value has to come from
    # `Get-Location`, which is evaluated in the caller's session before this script runs.
    #
    # `-InstallDir` still overrides it, for anyone laying several installs out deliberately.
    [string]$InstallDir = (Get-Location).Path,
    [string]$Version = 'latest'
)

$ErrorActionPreference = 'Stop'
$Repo = 'cocokoishi/GoTavern'

# NORMALISE THE INSTALL DIRECTORY, because three inputs are legal and only one of them is already a full
# path: a defaulted or empty value (the current directory, or `-InstallDir ''`), a relative one
# (`-InstallDir .\games\tavern`), and an absolute one. GetFullPath resolves all three against the process
# working directory, which is what a relative path means to the person who typed it.
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = (Get-Location).Path }
$currentLocation = Get-Location
if ($currentLocation.Provider.Name -ne 'FileSystem') {
    throw "The current PowerShell location ($($currentLocation.Provider.Name):$($currentLocation.Path)) is not a filesystem directory, so there is no directory to install into. Run the installer from a filesystem location, or pass -InstallDir <path>."
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
} catch {
    $arch = $env:PROCESSOR_ARCHITECTURE.ToLowerInvariant()
}

switch ($arch) {
    'x64'   { $releaseArch = 'amd64' }
    'amd64' { $releaseArch = 'amd64' }
    'arm64' { $releaseArch = 'arm64' }
    default {
        throw "Unsupported Windows architecture: $arch. Download a supported release archive manually."
    }
}

$asset = "gotavern-windows-$releaseArch.zip"
if ($Version -eq 'latest') {
    $defaultBaseUrl = "https://github.com/$Repo/releases/latest/download"
    $releaseLabel = 'latest stable'
} else {
    $defaultBaseUrl = "https://github.com/$Repo/releases/download/$Version"
    $releaseLabel = $Version
}

# MIRROR / AIR-GAPPED INSTALL (docs/INSTALLATION.md section 3.1), the same seam install.sh has: when
# GOTAVERN_RELEASES_BASE_URL is set it REPLACES the computed base URL for BOTH forms, so a mirror must
# serve `<base>/latest/download/` and `<base>/<tag>/` with the canonical asset names and a
# `checksums.txt` in sha256sum format. Checksum verification below stays mandatory and has no bypass.
# `Invoke-WebRequest` has NO --https-only equivalent -- plain http already works -- so unlike install.sh
# there is no flag to drop here; that is stated rather than invented.
$mirrorBaseUrl = $env:GOTAVERN_RELEASES_BASE_URL
if ($mirrorBaseUrl) {
    # THE VARIABLE IS THE RELEASES ROOT, NOT THE FINAL BASE URL (the same contract as install.sh).
    #
    # Assigning the root directly asked a mirror for `<root>/checksums.txt`, which no mirror serves:
    # the documented layout is `<root>/latest/download/` and `<root>/<tag>/`. install.sh carried the
    # same defect until the qualification job ran the installer for the first time and reported
    # "no usable GoTavern qual-a release metadata was found"; the fix is recorded in both files so the
    # next reader does not reintroduce it from the other one.
    if ($Version -eq 'latest') {
        $baseUrl = "$($mirrorBaseUrl.TrimEnd('/'))/latest/download"
    } else {
        $baseUrl = "$($mirrorBaseUrl.TrimEnd('/'))/$Version"
    }
} else {
    $baseUrl = $defaultBaseUrl
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gotavern-install-" + [Guid]::NewGuid().ToString('N'))
$archive = Join-Path $tempRoot $asset
$checksums = Join-Path $tempRoot 'checksums.txt'
$extracted = Join-Path $tempRoot 'extracted'

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $extracted -Force | Out-Null

try {
    Write-Host 'GoTavern installer'
    Write-Host "  release: $releaseLabel"
    Write-Host "  target:  windows/$releaseArch"
    Write-Host "  dir:     $InstallDir"
    Write-Host

    Write-Host 'Downloading checksums...'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/checksums.txt" -OutFile $checksums
    } catch {
        throw "No usable GoTavern $releaseLabel release metadata was found. The project may not have published its first prebuilt release yet, or the tag is invalid. This installer will not fall back to compiling source. Original error: $($_.Exception.Message)"
    }

    Write-Host "Downloading $asset..."
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $archive
    } catch {
        throw "Release asset $asset is unavailable for $releaseLabel. This installer will not fall back to compiling source. Original error: $($_.Exception.Message)"
    }

    $expected = $null
    foreach ($line in Get-Content -LiteralPath $checksums) {
        if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $asset) {
            $expected = $Matches[1].ToLowerInvariant()
            break
        }
    }
    if (-not $expected) {
        throw "checksums.txt does not contain an entry for $asset"
    }

    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "SHA-256 verification failed for $asset. Expected $expected, got $actual."
    }
    Write-Host 'Checksum verified.'

    Expand-Archive -LiteralPath $archive -DestinationPath $extracted -Force
    $sourceExe = Join-Path $extracted 'gotavern.exe'
    if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
        throw 'Release archive is missing gotavern.exe at archive root.'
    }
    # src/tokenizers/ is REQUIRED, for the same reason as in install.sh: cmd/gotavern reads it from
    # <InstallRoot>/src/tokenizers and `gotavern assets verify` hashes that directory on disk, so without it
    # the tokenizer routes silently fall back to guesstimates. This installer used to omit the tree entirely.
    #
    # THE PATH IS src/tokenizers BECAUSE THAT IS THE PINNED LAYOUT: upstream reads these files server-side by a
    # relative path (`new SentencePieceTokenizer('src/tokenizers/llama.model')`,
    # src/endpoints/tokenizers.js:251-254). An installation made by release v0.1.0-alpha.1 has them at
    # tokenizers/ instead, and the runtime still falls back to that path, so an existing tree is left alone.
    $sourceTokenizers = Join-Path $extracted 'src/tokenizers'
    if (-not (Test-Path -LiteralPath $sourceTokenizers -PathType Container)) {
        throw 'Release archive is missing src/tokenizers/. GoTavern needs that directory beside the binary; without it tokenizer counts silently fall back.'
    }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $targetExe = Join-Path $InstallDir 'gotavern.exe'
    $newExe = Join-Path $InstallDir ('.gotavern.new.' + [Guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $sourceExe -Destination $newExe -Force

    try {
        Move-Item -LiteralPath $newExe -Destination $targetExe -Force
    } catch {
        Remove-Item -LiteralPath $newExe -Force -ErrorAction SilentlyContinue
        throw "Could not replace $targetExe. If GoTavern is currently running, stop it and re-run the installer. Original error: $($_.Exception.Message)"
    }

    $launcher = @'
@echo off
setlocal
cd /d "%~dp0"
"%~dp0gotavern.exe" %*
'@
    Set-Content -LiteralPath (Join-Path $InstallDir 'Start.cmd') -Value $launcher -Encoding Ascii

    foreach ($name in @('LICENSE', 'THIRD_PARTY_NOTICES.txt', 'BUILD-INFO.txt')) {
        $source = Join-Path $extracted $name
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $InstallDir $name) -Force
        }
    }

    # Replace the immutable tokenizer tree at src/tokenizers. Staged inside src/ and swapped, so an interrupted
    # install leaves either the old tree or the new one rather than a half-copied directory.
    $srcDirectory = Join-Path $InstallDir 'src'
    New-Item -ItemType Directory -Path $srcDirectory -Force | Out-Null
    $tokenizersNew = Join-Path $srcDirectory ('.tokenizers.new.' + [Guid]::NewGuid().ToString('N'))
    $tokenizersOld = Join-Path $srcDirectory ('.tokenizers.old.' + [Guid]::NewGuid().ToString('N'))
    Copy-Item -LiteralPath $sourceTokenizers -Destination $tokenizersNew -Recurse -Force
    $tokenizersTarget = Join-Path $srcDirectory 'tokenizers'
    if (Test-Path -LiteralPath $tokenizersTarget) {
        Move-Item -LiteralPath $tokenizersTarget -Destination $tokenizersOld
    }
    Move-Item -LiteralPath $tokenizersNew -Destination $tokenizersTarget
    Remove-Item -LiteralPath $tokenizersOld -Recurse -Force -ErrorAction SilentlyContinue

    # THE SUMMARY NAMES THE THREE THINGS A USER NEEDS: what was installed, WHERE it went, and how to start
    # it. The directory is printed as an absolute path, because the default is the caller's working directory
    # and "installed successfully" without a location leaves the user hunting for it.
    $displayVersion = 'latest stable release'
    if ($Version -ne 'latest') { $displayVersion = $Version }
    Write-Host
    Write-Host "GoTavern $displayVersion installed successfully."
    Write-Host
    Write-Host 'Install directory:'
    Write-Host "  $InstallDir"
    Write-Host
    Write-Host 'Start GoTavern with:'
    Write-Host "  $(Join-Path $InstallDir 'Start.cmd')"

    # RUNTIME STATE IS NAMED, NOT SUMMARISED. "Existing runtime state was preserved" makes a reader check
    # the installer's code to learn what that means; naming the files that were found is the answer.
    $runtimeState = @()
    if (Test-Path -LiteralPath (Join-Path $InstallDir 'config.yaml') -PathType Leaf) { $runtimeState += 'config.yaml' }
    if (Test-Path -LiteralPath (Join-Path $InstallDir 'data') -PathType Container) { $runtimeState += 'data/' }
    Write-Host
    if ($runtimeState.Count -gt 0) {
        Write-Host ("Existing {0} preserved." -f ($runtimeState -join ' and '))
    } else {
        Write-Host 'No runtime state exists yet. The first server start will initialize the pinned SillyTavern-compatible defaults.'
    }
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
