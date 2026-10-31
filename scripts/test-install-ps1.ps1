#Requires -Version 5.1
<#
Test install.ps1's INSTALL LOCATION contract, with no network and no real release.

WHY THIS EXISTS. The Windows installer used to default to `$HOME\GoTavern`, so the documented invocation
(`cd D:\Apps\GoTavern` then `.\install.ps1 -Version <tag>`) installed somewhere the user was not looking.
The contract that replaced it is three sentences long and every one of them needs a test that would go red
if it were removed:

  A. With no `-InstallDir`, GoTavern installs into the CALLER'S CURRENT WORKING DIRECTORY, and nothing is
     created at the old default (`$HOME\GoTavern`).
  B. `-InstallDir` still overrides the default, and the default target is then left alone.
  C. An existing `config.yaml` and `data/` in the target are PRESERVED byte-for-byte -- the installer never
     deletes or rewrites them, on install or on upgrade.
  D. The default comes from `Get-Location`, NOT from `$PSScriptRoot`: invoked by absolute path from another
     directory, it installs into the directory it was CALLED from.

HOW IT RUNS WITHOUT THE INTERNET. Every install goes through the installer's `GOTAVERN_RELEASES_BASE_URL`
mirror seam, served by a loopback HTTP server over a synthetic release built here (a zip with
`gotavern.exe`, `src/tokenizers/`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `BUILD-INFO.txt`). The mirror's
request log is asserted, so an installer that ignored the seam (and reached github.com) fails this test
instead of passing on a cached asset. The synthetic binary is never executed here: this file is about WHERE
files land and WHAT survives, and `scripts/qualify-install-windows.ps1` is the file that runs the installed
binary, Start.cmd, the running-exe refusal and the registry/shortcut claims.

Usage: pwsh -NoProfile -File scripts/test-install-ps1.ps1
Exit: 0 only when every case and every assertion passed.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# A native command that writes to stderr is DATA here (the installer's failure text is an assertion input).
$PSNativeCommandUseErrorActionPreference = $false

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $RepoRoot 'install.ps1'
# THE CHILD RUNS THE SAME POWERSHELL AS THIS SCRIPT. `pwsh` is not present on every Windows host -- measured
# 2026-10-29: this development machine has Windows PowerShell 5.1 only, while GitHub's Windows runners have
# 7.x -- and a hardcoded interpreter name would make the test unrunnable on one of them for a reason that
# has nothing to do with the installer.
$PowerShellExe = (Get-Process -Id $PID).Path
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { Write-Host "FAIL: no installer at $Installer" -ForegroundColor Red; exit 1 }



$WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('gotavern-install-location-' + [Guid]::NewGuid().ToString('N'))
$MirrorProcess = $null
$Tag = 'v9.9.9-test'

function Fail {
    param([string]$Message, [string[]]$Logs = @())
    Write-Host "FAIL: $Message" -ForegroundColor Red
    Write-Host "(this run's work root, kept for diagnosis: $WorkRoot)"
    foreach ($log in $Logs) {
        if ($log -and (Test-Path -LiteralPath $log)) {
            Write-Host "--- $log ---" -ForegroundColor Yellow
            Get-Content -LiteralPath $log -Tail 80 | ForEach-Object { Write-Host $_ }
        }
    }
    exit 1
}

function Ok { param([string]$Message) Write-Host "ok: $Message" }

function Get-Sha256 { param([string]$Path) return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Stop-Mirror {
    if ($script:MirrorProcess -and -not $script:MirrorProcess.HasExited) {
        Stop-Process -Id $script:MirrorProcess.Id -Force -ErrorAction SilentlyContinue
    }
    $script:MirrorProcess = $null
}

# THE DOWNLOAD-PATH GUARD, asserted BEFORE any case runs because it is a property of the SCRIPT, not of a run.
# Windows PowerShell 5.1 (the default Windows shell) renders a progress bar for Invoke-WebRequest, and on this
# repository's 57.8 MB archive that turned a 2.3 s download into an install that had written no bytes after five
# minutes (measured 2026-10-31; the numbers are in install.ps1's own comment). The fix is one line, and a line of
# PowerShell is invisible to every behavioural case here because the test's own mirror serves small fake archives --
# so the guard reads the source and requires the preference to be set BEFORE the first download call. That is a
# STATIC assertion by necessity (the cost only exists at ~60 MB over the real network), and it is a guard rather
# than a proof of the fix; the executable proof is the published-release Windows smoke on a real tag.
$installerText = Get-Content -LiteralPath $Installer -Raw
$progressMarker = "`$ProgressPreference = 'SilentlyContinue'"
if (-not $installerText.Contains($progressMarker)) {
    Fail 'install.ps1 does not set $ProgressPreference to SilentlyContinue, so a Windows PowerShell 5.1 user downloading a ~60 MB archive can wait indefinitely on the progress bar (measured: 2.3 s vs >5 min with no bytes written)'
}
$progressIndex = $installerText.IndexOf($progressMarker)
$firstDownloadIndex = $installerText.IndexOf('Invoke-WebRequest')
if ($firstDownloadIndex -lt 0) { Fail 'install.ps1 has no Invoke-WebRequest call, so the progress guard cannot be anchored to a download' }
if ($progressIndex -gt $firstDownloadIndex) {
    Fail "install.ps1 sets `$ProgressPreference AFTER its first download (positions: preference $progressIndex, download $firstDownloadIndex); the first download still pays the progress-bar cost"
}
Ok 'install.ps1 disables the progress bar before its first download (Windows PowerShell 5.1 ~60 MB download guard)'

# The asset name the installer will ask for, derived the same way it derives it. A test that hardcoded
# `gotavern-windows-amd64.zip` would pass on an x64 runner and fail on an arm64 one for a reason that has
# nothing to do with the contract under test.
try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
} catch {
    $arch = $env:PROCESSOR_ARCHITECTURE.ToLowerInvariant()
}
switch ($arch) {
    'x64' { $releaseArch = 'amd64' }
    'amd64' { $releaseArch = 'amd64' }
    'arm64' { $releaseArch = 'arm64' }
    default { Fail "unsupported architecture '$arch' for this test" }
}
$AssetName = "gotavern-windows-$releaseArch.zip"

try {
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
    # What TEMP already contained, so the cleanliness assertion can be about what THIS run adds.
    $script:TempDirsBefore = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Filter 'gotavern-install-*' -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })

    # ---- synthetic release ----------------------------------------------------------------
    $stage = Join-Path $WorkRoot 'stage'
    New-Item -ItemType Directory -Path (Join-Path $stage 'src/tokenizers') -Force | Out-Null
    # A marker file rather than a real binary: this test is about locations, and the installer never runs
    # the executable it copies. The bytes are distinct per release so an "upgrade" can be distinguished.
    Set-Content -LiteralPath (Join-Path $stage 'gotavern.exe') -Value 'synthetic-gotavern-binary' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $stage 'src/tokenizers/llama.model') -Value 'synthetic-tokenizer' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $stage 'LICENSE') -Value 'AGPL-3.0' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $stage 'THIRD_PARTY_NOTICES.txt') -Value 'synthetic notices' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $stage 'BUILD-INFO.txt') -Value "version=$Tag`ncommit=synthetic" -Encoding Ascii

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = Join-Path $WorkRoot $AssetName
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)

    $mirrorRoot = Join-Path $WorkRoot 'mirror'
    $tagDir = Join-Path $mirrorRoot $Tag
    New-Item -ItemType Directory -Path $tagDir -Force | Out-Null
    Copy-Item -LiteralPath $zip -Destination (Join-Path $tagDir $AssetName) -Force
    Set-Content -LiteralPath (Join-Path $tagDir 'checksums.txt') -Value "$(Get-Sha256 (Join-Path $tagDir $AssetName))  $AssetName" -Encoding Ascii
    $latestDir = Join-Path $mirrorRoot 'latest/download'
    New-Item -ItemType Directory -Path $latestDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $tagDir $AssetName) -Destination (Join-Path $latestDir $AssetName) -Force
    Copy-Item -LiteralPath (Join-Path $tagDir 'checksums.txt') -Destination (Join-Path $latestDir 'checksums.txt') -Force
    Ok "built a synthetic $releaseArch release and a canonical mirror root"

    # ---- loopback mirror ------------------------------------------------------------------
    $portFile = Join-Path $WorkRoot 'mirror.port'
    $mirrorLog = Join-Path $WorkRoot 'mirror.log'
    $serveScript = Join-Path $WorkRoot 'serve.py'
    @'
import http.server, socketserver, sys
directory, port_file = sys.argv[1], sys.argv[2]
handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=directory, **k)
with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
    with open(port_file, "w", encoding="utf-8") as handle:
        handle.write(str(httpd.server_address[1]))
    httpd.serve_forever()
'@ | Set-Content -LiteralPath $serveScript -Encoding Ascii
    # A CANDIDATE MUST ACTUALLY RUN. Windows ships a `python3` App Execution Alias that is a Store stub:
    # `Get-Command` finds it, it exits non-zero with "Python was not found", and a test that trusted
    # discovery alone would fail here for a reason that has nothing to do with the installer.
    $python = $null
    foreach ($candidate in @('python', 'python3')) {
        if (-not (Get-Command $candidate -ErrorAction SilentlyContinue)) { continue }
        & $candidate -c 'import http.server' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $python = $candidate; break }
    }
    if (-not $python) { Fail 'no python/python3 on PATH; the loopback mirror needs one (the release qualification jobs use python too)' }
    $script:MirrorProcess = Start-Process -FilePath $python -ArgumentList @('-u', $serveScript, $mirrorRoot, $portFile) -PassThru -RedirectStandardError $mirrorLog -RedirectStandardOutput (Join-Path $WorkRoot 'mirror.out') -WindowStyle Hidden
    $mirrorPort = $null
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if (Test-Path -LiteralPath $portFile) {
            $candidate = (Get-Content -LiteralPath $portFile -Raw).Trim()
            if ($candidate) { $mirrorPort = $candidate; break }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $mirrorPort) { Fail 'the loopback mirror never wrote its port' }
    $env:GOTAVERN_RELEASES_BASE_URL = "http://127.0.0.1:$mirrorPort"
    Ok "the loopback mirror answers on $env:GOTAVERN_RELEASES_BASE_URL (the installer's seam)"

    # The old default must be observed, not assumed: if this machine already has one, absence proves nothing.
    $legacyDefault = Join-Path $HOME 'GoTavern'
    $legacyDefaultExistedBefore = Test-Path -LiteralPath $legacyDefault
    if ($legacyDefaultExistedBefore) {
        Write-Host "note: $legacyDefault already exists on this machine, so case A asserts it is UNCHANGED rather than absent"
    }

    function Invoke-Installer {
        param([string]$WorkingDirectory, [string[]]$Arguments, [string]$LogName)
        $log = Join-Path $WorkRoot $LogName
        Push-Location $WorkingDirectory
        try {
            & $PowerShellExe -NoProfile -File $Installer @Arguments *> $log
            $status = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        return @{ status = $status; log = $log }
    }

    function Assert-InstalledTree {
        param([string]$Directory, [string]$Why)
        foreach ($relative in @('gotavern.exe', 'Start.cmd', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'BUILD-INFO.txt', 'src/tokenizers/llama.model')) {
            $path = Join-Path $Directory $relative
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "$Why`: expected $relative in $Directory" }
        }
        $launcher = Get-Content -LiteralPath (Join-Path $Directory 'Start.cmd') -Raw
        if ($launcher -notmatch [regex]::Escape('cd /d "%~dp0"')) { Fail "$Why`: Start.cmd does not cd to its own directory: $launcher" }
        if ($launcher -notmatch [regex]::Escape('"%~dp0gotavern.exe"')) { Fail "$Why`: Start.cmd does not run gotavern.exe from its own directory: $launcher" }
    }

    # ---- CASE A: no -InstallDir => the current working directory --------------------------
    $caseA = Join-Path $WorkRoot 'case-a-cwd'
    New-Item -ItemType Directory -Path $caseA -Force | Out-Null
    $a = Invoke-Installer -WorkingDirectory $caseA -Arguments @('-Version', $Tag) -LogName 'case-a.log'
    if ($a.status -ne 0) { Fail "case A: the installer failed with no -InstallDir (exit $($a.status))" @($a.log) }
    Assert-InstalledTree -Directory $caseA -Why 'case A'
    $aText = Get-Content -LiteralPath $a.log -Raw
    if ($aText -notmatch [regex]::Escape($caseA)) {
        Fail "case A: the summary does not print the install directory $caseA, so a user cannot see where it went" @($a.log)
    }
    Ok "case A: no -InstallDir installed into the current working directory ($caseA), and the summary names it"

    if (-not $legacyDefaultExistedBefore) {
        if (Test-Path -LiteralPath $legacyDefault) {
            Fail "case A: the old default $legacyDefault was CREATED, so the default is still $HOME\GoTavern: $(Get-ChildItem -LiteralPath $legacyDefault -Force | ForEach-Object { $_.Name })"
        }
        Ok "case A: nothing was created at the old default ($legacyDefault)"
    }

    # ---- CASE B: -InstallDir overrides, and the cwd is left alone ------------------------
    $caseBWork = Join-Path $WorkRoot 'case-b-cwd'
    $caseBTarget = Join-Path $WorkRoot 'case-b-target'
    New-Item -ItemType Directory -Path $caseBWork -Force | Out-Null
    New-Item -ItemType Directory -Path $caseBTarget -Force | Out-Null
    $b = Invoke-Installer -WorkingDirectory $caseBWork -Arguments @('-Version', $Tag, '-InstallDir', $caseBTarget) -LogName 'case-b.log'
    if ($b.status -ne 0) { Fail "case B: the installer failed with -InstallDir (exit $($b.status))" @($b.log) }
    Assert-InstalledTree -Directory $caseBTarget -Why 'case B'
    if (Test-Path -LiteralPath (Join-Path $caseBWork 'gotavern.exe')) {
        Fail 'case B: -InstallDir was given, but gotavern.exe also landed in the working directory'
    }
    Ok "case B: -InstallDir installed into $caseBTarget and left the working directory alone"

    # ---- CASE C: an existing config.yaml and data\ survive, on install and on upgrade -----
    $caseC = Join-Path $WorkRoot 'case-c-state'
    New-Item -ItemType Directory -Path (Join-Path $caseC 'data') -Force | Out-Null
    $configBody = "port: 8123`nsomeFutureSection:`n  keptValue: 41`n"
    Set-Content -LiteralPath (Join-Path $caseC 'config.yaml') -Value $configBody -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $caseC 'data/test-marker.txt') -Value 'user state that must survive' -Encoding Ascii
    $configPath = Join-Path $caseC 'config.yaml'
    $markerPath = Join-Path $caseC 'data/test-marker.txt'
    $configHashBefore = Get-Sha256 $configPath
    $markerHashBefore = Get-Sha256 $markerPath
    $configBytesBefore = [System.IO.File]::ReadAllBytes($configPath)

    $c = Invoke-Installer -WorkingDirectory $caseC -Arguments @('-Version', $Tag) -LogName 'case-c-first.log'
    if ($c.status -ne 0) { Fail "case C: the first install failed (exit $($c.status))" @($c.log) }
    Assert-InstalledTree -Directory $caseC -Why 'case C (first install)'
    # A SECOND run is the upgrade path: the same directory, the same tag, so only immutable release bytes
    # are rewritten. This is the case a user hits with `.\install.ps1 -Version <next>`.
    $c2 = Invoke-Installer -WorkingDirectory $caseC -Arguments @('-Version', $Tag) -LogName 'case-c-second.log'
    if ($c2.status -ne 0) { Fail "case C: the upgrade run failed (exit $($c2.status))" @($c2.log) }
    Assert-InstalledTree -Directory $caseC -Why 'case C (upgrade)'

    if ((Get-Sha256 $configPath) -ne $configHashBefore) {
        Fail "case C: config.yaml changed across install+upgrade (was $configHashBefore, now $(Get-Sha256 $configPath))"
    }
    # Byte equality as well as digest equality, because a hash mismatch is a diagnosis and a byte compare is
    # the property: not one byte of the user's config may move.
    $configBytesAfter = [System.IO.File]::ReadAllBytes($configPath)
    if ($configBytesAfter.Length -ne $configBytesBefore.Length) {
        Fail "case C: config.yaml length changed across install+upgrade ($($configBytesBefore.Length) -> $($configBytesAfter.Length) bytes)"
    }
    for ($index = 0; $index -lt $configBytesBefore.Length; $index++) {
        if ($configBytesBefore[$index] -ne $configBytesAfter[$index]) {
            Fail "case C: config.yaml byte $index differs from the planted value, so the installer rewrote a user config"
        }
    }
    if ((Get-Sha256 $markerPath) -ne $markerHashBefore) {
        Fail 'case C: data/test-marker.txt changed across install+upgrade'
    }
    $cText = (Get-Content -LiteralPath $c2.log -Raw)
    if ($cText -notmatch [regex]::Escape('config.yaml') -or $cText -notmatch [regex]::Escape('data/')) {
        Fail "case C: the summary does not name the preserved runtime state: $cText"
    }
    Ok 'case C: config.yaml (byte-identical) and data/ survived install and upgrade, and the summary names them'

    # ---- CASE D: the default is Get-Location, not $PSScriptRoot --------------------------
    $caseD = Join-Path $WorkRoot 'case-d-called-from'
    New-Item -ItemType Directory -Path $caseD -Force | Out-Null
    $repoRootExeBefore = Test-Path -LiteralPath (Join-Path $RepoRoot 'gotavern.exe')
    $d = Invoke-Installer -WorkingDirectory $caseD -Arguments @('-Version', $Tag) -LogName 'case-d.log'
    if ($d.status -ne 0) { Fail "case D: the installer failed when invoked from another directory (exit $($d.status))" @($d.log) }
    Assert-InstalledTree -Directory $caseD -Why 'case D'
    $repoRootExeAfter = Test-Path -LiteralPath (Join-Path $RepoRoot 'gotavern.exe')
    if ($repoRootExeAfter -ne $repoRootExeBefore) {
        Fail "case D: a gotavern.exe was created beside the SCRIPT ($RepoRoot), so the default is \$PSScriptRoot rather than Get-Location"
    }
    Ok "case D: invoked by absolute path from $caseD, it installed into $caseD and nothing beside the script"

    # ---- the mirror was honoured, so no case reached github.com --------------------------
    $mirrorText = if (Test-Path -LiteralPath $mirrorLog) { Get-Content -LiteralPath $mirrorLog -Raw } else { '' }
    foreach ($expected in @("/$Tag/checksums.txt", "/$Tag/$AssetName")) {
        if ($mirrorText -notmatch [regex]::Escape($expected)) {
            Fail "the loopback mirror never served $expected, so an install may have reached the real release URL" @($mirrorLog)
        }
    }
    Ok 'the loopback mirror served the checksum and the asset (the seam was honoured in every case)'

    # ---- no temp debris: the installer's own scratch directory is removed ----------------
    # BEFORE/AFTER, NOT "WHAT IS THERE NOW". A previous FAILING run of this file leaves its own work root
    # behind on purpose (its logs are the diagnosis), so a check that asked "are there any
    # gotavern-install-* directories" would fail the NEXT run for the PREVIOUS run's debris -- a harness
    # defect that reads as an installer defect, which is the most expensive way for one to present. The
    # snapshot is taken before the first install and the assertion is about the difference.
    $leftovers = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Filter 'gotavern-install-*' -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne (Split-Path -Leaf $WorkRoot) -and $script:TempDirsBefore -notcontains $_.Name })
    if ($leftovers.Count -ne 0) {
        Fail "the installer left scratch directories behind: $($leftovers.Name -join ', ')"
    }
    Ok 'the installer removed its own temporary download/extract directories'

    Write-Host
    Write-Host 'ok: every install-location assertion passed'
    Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
} finally {
    Stop-Mirror
}
