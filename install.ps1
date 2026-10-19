# GoTavern release installer for Windows.
# Downloads a prebuilt GitHub Release asset. It never installs Go/Node or compiles source.

[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $HOME 'GoTavern'),
    [string]$Version = 'latest'
)

$ErrorActionPreference = 'Stop'
$Repo = 'cocokoishi/GoTavern'

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
    $baseUrl = "https://github.com/$Repo/releases/latest/download"
    $releaseLabel = 'latest stable'
} else {
    $baseUrl = "https://github.com/$Repo/releases/download/$Version"
    $releaseLabel = $Version
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

    Write-Host
    Write-Host "Installed GoTavern into: $InstallDir"
    Write-Host 'Start it with:'
    Write-Host "  $(Join-Path $InstallDir 'Start.cmd')"
    Write-Host

    if ((Test-Path -LiteralPath (Join-Path $InstallDir 'config.yaml')) -or
        (Test-Path -LiteralPath (Join-Path $InstallDir 'data') -PathType Container)) {
        Write-Host 'Existing runtime state was preserved.'
    } else {
        Write-Host 'No runtime state exists yet. The first server start will initialize the pinned SillyTavern-compatible defaults.'
    }
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
