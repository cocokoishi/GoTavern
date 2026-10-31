#Requires -Version 7.0
<#
Qualify install.ps1 ON WINDOWS, where its Windows-only behaviour can actually execute.

WHY THIS EXISTS. release-qualification.yml runs install.ps1 under `pwsh` on a LINUX runner, which
proves the installer's download/checksum/install logic but cannot reach four behaviours at all. That
job names them as unexecuted, docs/INSTALLATION.md section 3.1 repeats the list, and two of them are
the ones a Windows user actually hits:

  1. REPLACING A RUNNING gotavern.exe. Windows locks a running image, so the pinned installer's
     `Move-Item -Force` onto `gotavern.exe` fails and it throws
     "Could not replace ... If GoTavern is currently running, stop it and re-run the installer."
     That promise -- refuse, name the cause, leave the working install intact -- had never been
     executed. THIS SCRIPT ASSERTS IT, and asserts the safety half too: the running process keeps
     running, the exe bytes are unchanged, no `.gotavern.new.*` staging file is left behind, and the
     server still answers afterwards.
  2. WINDOWS PATH SEPARATORS. The install directory here is a real `C:\...` path, so Join-Path
     produces `\`, and the assertion requires the installed tree to be reachable at the
     Join-Path-built path (assertion 6).
  3. THE REGISTRY AND SHORTCUTS. install.ps1 claims it does none of these. That is a NEGATIVE claim
     and is asserted as one: the Uninstall registry key's subkeys and the Start Menu Programs folder
     are snapshotted before and after every install and must be identical (assertion 8).
  4. cmd.exe ITSELF. Start.cmd was previously only asserted to be WRITTEN. Here it is LAUNCHED with
     `cmd /c`, with an argument, and its output must name the installed version (assertion 11) --
     which proves `cd /d "%~dp0"` and `"%~dp0gotavern.exe" %*` work under the real command
     processor.

EVERY ASSERTION RUNS BEFORE THE SUCCESS SUMMARY. The script prints `ok: <what>` as it goes and exits
non-zero on the FIRST failure, printing the captured installer output, the mirror log and the server
log for that step. There is no `exit 0` before the last assertion, and no assertion after the summary,
because a check placed after its own exit gate prints and cannot fail.

WHAT IS STILL NOT PROVEN, stated rather than implied, so this file does not overclaim:
  - the real github.com download path (every install here goes through the loopback mirror seam, and
    assertion 4 requires the mirror to have SERVED the requests, so an installer that ignored the
    seam would fail rather than silently succeed against the real release);
  - elevation / running as a different user: the runner is already an administrator and the installer
    asks for no elevation;
  - Windows ARM64 (this runs on x64; the installer's arch switch is a one-line mapping already
    exercised by the arm64 archive build);
  - proxy/TLS behaviour, and an update across DIFFERENT upstream baselines (both archives come from
    one commit).

Usage: scripts/qualify-install-windows.ps1 -DistDir <dir>
  <dir>/stage-older and <dir>/stage-newer hold the two staged trees the workflow built
  (gotavern.exe, src/tokenizers/, LICENSE, THIRD_PARTY_NOTICES.txt, BUILD-INFO.txt). The tokenizer tree
  ships at src/tokenizers/ in the archive, mirroring upstream SillyTavern, and the installer puts it at
  <InstallDir>/src/tokenizers/.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DistDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Native commands that write to stderr are DATA here (the installer's own failure text is an
# assertion input), not terminating errors: without this switch a `2>&1` capture of a failing pwsh
# child can throw before the assertion that reads it runs.
$PSNativeCommandUseErrorActionPreference = $false

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $RepoRoot 'install.ps1'
$AssetName = 'gotavern-windows-amd64.zip'
$WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('gotavern-qualify-win-' + [Guid]::NewGuid().ToString('N'))
if ($WorkRoot -match ' ') {
    # The cmd.exe assertion passes the launcher path on a command line, and a space there would make
    # that assertion depend on cmd's quoting rules rather than on the launcher. Fail rather than
    # quietly weaken it.
    Fail "the temporary path '$WorkRoot' contains a space; set TEMP to a space-free path so the cmd.exe assertion can pass the launcher unquoted"
}
$MirrorProcess = $null
$ServerProcess = $null

function Fail {
    param([string]$Message, [string[]]$Logs = @())
    Write-Host "FAIL: $Message" -ForegroundColor Red
    foreach ($log in $Logs) {
        if ($log -and (Test-Path -LiteralPath $log)) {
            Write-Host "--- $log ---" -ForegroundColor Yellow
            Get-Content -LiteralPath $log -Tail 120 | ForEach-Object { Write-Host $_ }
        }
    }
    exit 1
}

function Ok {
    param([string]$Message)
    Write-Host "ok: $Message"
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-BinaryTag {
    param([string]$Exe)
    $raw = & $Exe version --json 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "cannot read the version of $Exe (exit $LASTEXITCODE): $raw" }
    $parsed = ($raw -join "`n") | ConvertFrom-Json
    return [string]$parsed.gotavern_version
}

function Stop-QualificationServer {
    if ($script:ServerProcess -and -not $script:ServerProcess.HasExited) {
        Stop-Process -Id $script:ServerProcess.Id -Force -ErrorAction SilentlyContinue
        try { $script:ServerProcess.WaitForExit(30000) | Out-Null } catch { }
    }
    $script:ServerProcess = $null
}

function Stop-QualificationMirror {
    if ($script:MirrorProcess -and -not $script:MirrorProcess.HasExited) {
        Stop-Process -Id $script:MirrorProcess.Id -Force -ErrorAction SilentlyContinue
    }
    $script:MirrorProcess = $null
}

try {
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

    # ---- 1. the two staged trees -----------------------------------------------------------------
    $stageOlder = Join-Path $DistDir 'stage-older'
    $stageNewer = Join-Path $DistDir 'stage-newer'
    foreach ($stage in @($stageOlder, $stageNewer)) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage 'gotavern.exe') -PathType Leaf)) { Fail "$stage has no gotavern.exe" }
        if (-not (Test-Path -LiteralPath (Join-Path $stage 'src/tokenizers') -PathType Container)) { Fail "$stage has no src/tokenizers/ (the installer refuses such an archive, so nothing could be asserted)" }
    }
    Ok "both staged trees carry gotavern.exe at their root and src/tokenizers/ under src/"

    # ---- 2. the release tags come from the binaries, not from file names --------------------------
    $olderTag = Get-BinaryTag (Join-Path $stageOlder 'gotavern.exe')
    $newerTag = Get-BinaryTag (Join-Path $stageNewer 'gotavern.exe')
    if ([string]::IsNullOrWhiteSpace($olderTag) -or [string]::IsNullOrWhiteSpace($newerTag)) { Fail "a staged binary reports an empty version (older='$olderTag' newer='$newerTag')" }
    if ($olderTag -eq $newerTag) { Fail "both staged binaries report '$olderTag', so an update would move no immutable bytes and assertion 9 would be about nothing" }
    Ok "derived the release tags from the binaries themselves: older=$olderTag newer=$newerTag"

    # ---- 3. the canonical mirror -----------------------------------------------------------------
    $mirrorRoot = Join-Path $WorkRoot 'mirror'
    $olderZip = Join-Path $WorkRoot 'older.zip'
    $newerZip = Join-Path $WorkRoot 'newer.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stageOlder, $olderZip)
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stageNewer, $newerZip)
    foreach ($zip in @($olderZip, $newerZip)) {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
        try {
            $names = @($archive.Entries | ForEach-Object { $_.FullName })
        } finally {
            # Dispose it: an archive left open makes the NEXT zip fail with "used by another process",
            # which reads as a harness bug rather than as an assertion.
            $archive.Dispose()
        }
        if ($names -notcontains 'gotavern.exe') { Fail "$zip does not carry gotavern.exe at its archive root" }
        # @( ... ) IS LOAD-BEARING. Under Set-StrictMode -Version Latest a pipeline that matches NOTHING
        # collapses to $null, and `$null.Count` is a TERMINATING ERROR rather than 0 -- which is how the
        # duplicate-root check first failed in run 40063280918: it threw "The property 'Count' cannot be
        # found on this object" instead of naming the layout, the exact opposite of the point of these
        # assertions. An explicit array always has Count.
        if (@($names | Where-Object { $_ -like 'src/tokenizers/*' }).Count -eq 0) { Fail "$zip does not carry src/tokenizers/ (entries: $($names -join ', '))" }
        # The archive's ROOT must not carry the tree: the contract moves it under src/ and a second copy
        # would double the payload. `-like 'tokenizers/*'` anchors at the start, so src/tokenizers/ does
        # not match it.
        if (@($names | Where-Object { $_ -like 'tokenizers/*' }).Count -ne 0) { Fail "$zip carries a duplicate tokenizers/ tree at its root; the tree belongs at src/tokenizers/ only" }
    }
    Ok "built both payload zips with gotavern.exe at the root and src/tokenizers/ under src/"

    foreach ($pair in @(@($olderTag, $olderZip), @($newerTag, $newerZip))) {
        $tag = $pair[0]
        $zip = $pair[1]
        $tagDir = Join-Path $mirrorRoot $tag
        New-Item -ItemType Directory -Path $tagDir -Force | Out-Null
        Copy-Item -LiteralPath $zip -Destination (Join-Path $tagDir $AssetName) -Force
        $hash = Get-Sha256 (Join-Path $tagDir $AssetName)
        # sha256sum format: "<64 hex>  <asset>", two spaces, no "./" prefix -- the installer parses it.
        Set-Content -LiteralPath (Join-Path $tagDir 'checksums.txt') -Value "$hash  $AssetName" -Encoding Ascii
    }
    $latestDir = Join-Path $mirrorRoot 'latest/download'
    New-Item -ItemType Directory -Path $latestDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $mirrorRoot $newerTag) $AssetName) -Destination (Join-Path $latestDir $AssetName) -Force
    Copy-Item -LiteralPath (Join-Path (Join-Path $mirrorRoot $newerTag) 'checksums.txt') -Destination (Join-Path $latestDir 'checksums.txt') -Force
    Ok "built a canonical mirror: <base>/$olderTag/, <base>/$newerTag/ and <base>/latest/download/"

    # ---- 4. serve it on loopback, and keep the request log so an ignored seam is visible ----------
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
    $script:MirrorProcess = Start-Process -FilePath 'python' -ArgumentList @('-u', $serveScript, $mirrorRoot, $portFile) -PassThru -RedirectStandardError $mirrorLog -RedirectStandardOutput (Join-Path $WorkRoot 'mirror.out') -WindowStyle Hidden
    $mirrorPort = $null
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if (Test-Path -LiteralPath $portFile) {
            $candidate = (Get-Content -LiteralPath $portFile -Raw).Trim()
            if ($candidate) { $mirrorPort = $candidate; break }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $mirrorPort) { Fail 'the loopback mirror never wrote its port' }
    $mirrorBase = "http://127.0.0.1:$mirrorPort"
    Invoke-WebRequest -UseBasicParsing -Uri "$mirrorBase/$olderTag/checksums.txt" -OutFile (Join-Path $WorkRoot 'probe-checksums.txt') | Out-Null
    Ok "the loopback mirror answers on $mirrorBase"

    # The installer reads the seam as the RELEASES ROOT and appends /<tag> or /latest/download.
    $env:GOTAVERN_RELEASES_BASE_URL = $mirrorBase

    # ---- 5. what the installer must NOT touch (the registry/shortcut claim) ----------------------
    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    function Get-RegistryFootprint {
        if (-not (Test-Path $uninstallKey)) { return '' }
        return ((Get-ChildItem $uninstallKey | ForEach-Object { $_.PSChildName } | Sort-Object) -join '|')
    }
    function Get-StartMenuFootprint {
        if (-not (Test-Path -LiteralPath $startMenu)) { return '' }
        return ((Get-ChildItem -LiteralPath $startMenu | ForEach-Object { $_.Name } | Sort-Object) -join '|')
    }
    $registryBefore = Get-RegistryFootprint
    $startMenuBefore = Get-StartMenuFootprint
    Ok "snapshotted the Uninstall registry key and the Start Menu Programs folder before any install"

    # ---- 6. install the OLDER release through the TAG form --------------------------------------
    # A real Windows path: Join-Path below produces '\' and every later assertion uses that path, which
    # is what makes the path-separator behaviour EXECUTED rather than assumed.
    $installDir = Join-Path $WorkRoot 'install-root'
    $dataRoot = Join-Path $WorkRoot 'data-root'
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $installLog1 = Join-Path $WorkRoot 'install-older.log'
    & pwsh -NoProfile -File $Installer -InstallDir $installDir -Version $olderTag *> $installLog1
    if ($LASTEXITCODE -ne 0) { Fail "the installer failed for $olderTag (exit $LASTEXITCODE)" @($installLog1) }
    $installedExe = Join-Path $installDir 'gotavern.exe'
    if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { Fail "no gotavern.exe at the Join-Path-built install path $installedExe" @($installLog1) }
    if ($installDir -notmatch '\\') { Fail "the install directory '$installDir' is not a Windows path; the separator claim would be vacuous" }
    $installedTag = Get-BinaryTag $installedExe
    if ($installedTag -ne $olderTag) { Fail "the installed binary reports '$installedTag', expected '$olderTag'" @($installLog1) }
    Ok "installed $olderTag into a real Windows path ($installDir) through the TAG form"

    # ---- 7. assets verify FROM THE PREFIX, and the launcher's own bytes --------------------------
    Push-Location $installDir
    try {
        $verifyOutput = & $installedExe assets verify 2>&1
        $verifyStatus = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($verifyStatus -ne 0) { Fail "assets verify failed from the installed prefix (exit $verifyStatus): $verifyOutput" }
    Ok "assets verify passes from the installed prefix (src/tokenizers/ is installed under the prefix)"

    $launcher = Join-Path $installDir 'Start.cmd'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { Fail "the installer wrote no Start.cmd at $launcher" }
    $launcherText = Get-Content -LiteralPath $launcher -Raw
    if ($launcherText -notmatch [regex]::Escape('cd /d "%~dp0"')) { Fail "Start.cmd does not cd to its own directory: $launcherText" }
    if ($launcherText -notmatch [regex]::Escape('"%~dp0gotavern.exe" %*')) { Fail "Start.cmd does not run gotavern.exe from its own directory: $launcherText" }
    Ok 'the written Start.cmd cds to its own directory and runs "%~dp0gotavern.exe" %*'

    # ---- 8. the installer registered nothing and created no shortcut ----------------------------
    if ((Get-RegistryFootprint) -ne $registryBefore) { Fail 'the installer changed the Uninstall registry key, but docs/INSTALLATION.md says it does none of that' }
    if ((Get-StartMenuFootprint) -ne $startMenuBefore) { Fail 'the installer created a Start Menu entry, but docs/INSTALLATION.md says it does none of that' }
    Ok 'the installer registered nothing and created no shortcut (the Uninstall key and Start Menu are unchanged)'

    # ---- 9. START THE SERVER, THEN TRY TO REPLACE IT WHILE IT RUNS -------------------------------
    # This is the assertion the four-gap list named as unreachable on a Linux runner.
    # A free port, so a runner that already uses 8792 fails at the assertion and not on a bind error.
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $serverPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $serverLog = Join-Path $WorkRoot 'server.log'
    $script:ServerProcess = Start-Process -FilePath $installedExe -ArgumentList @('start', '--port', "$serverPort", '--dataRoot', $dataRoot, '--browserLaunchEnabled', 'false') -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $WorkRoot 'server.err') -WorkingDirectory $installDir -WindowStyle Hidden
    $answered = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($script:ServerProcess.HasExited) { Fail "the installed server exited before answering /version (exit $($script:ServerProcess.ExitCode))" @($serverLog) }
        try {
            $version = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$serverPort/version" -TimeoutSec 3
            if ($version.StatusCode -eq 200) { $answered = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (-not $answered) { Fail "the installed server never answered /version on port $serverPort" @($serverLog) }
    Ok "the installed server answers /version while holding a lock on $installedExe"

    $exeHashBefore = Get-Sha256 $installedExe
    $runningLog = Join-Path $WorkRoot 'install-running.log'
    & pwsh -NoProfile -File $Installer -InstallDir $installDir -Version $newerTag *> $runningLog
    $runningStatus = $LASTEXITCODE

    if ($runningStatus -eq 0) {
        Stop-QualificationServer
        Fail ("the installer REPLACED a running gotavern.exe (exit 0). That is not what docs/INSTALLATION.md and the installer's own throw message promise ('If GoTavern is currently running, stop it and re-run the installer'), so either the documented contract or the document is wrong -- this run cannot tell you which") @($runningLog)
    }
    Ok "the installer refuses to replace a RUNNING gotavern.exe (exit $runningStatus)"

    $runningText = Get-Content -LiteralPath $runningLog -Raw
    if ($runningText -notmatch [regex]::Escape('Could not replace')) { Fail 'the refusal does not name the replacement step' @($runningLog) }
    if ($runningText -notmatch [regex]::Escape('currently running')) { Fail 'the refusal does not tell the user that GoTavern is currently running' @($runningLog) }
    Ok 'the refusal names the replacement step AND tells the user that GoTavern is currently running'

    if ($script:ServerProcess.HasExited) { Fail "the refused install killed the running server (exit $($script:ServerProcess.ExitCode))" @($serverLog) }
    Ok 'the running server is still alive after the refused install'

    if ((Get-Sha256 $installedExe) -ne $exeHashBefore) { Fail 'the refused install modified gotavern.exe; a failed update must leave the working install intact' @($runningLog) }
    Ok 'gotavern.exe is byte-identical after the refused install'

    $leftovers = @(Get-ChildItem -LiteralPath $installDir -Force | Where-Object { $_.Name -like '.gotavern.new.*' })
    if ($leftovers.Count -ne 0) { Fail "the refused install left staging file(s) behind: $($leftovers.Name -join ', ')" @($runningLog) }
    Ok 'the refused install left no .gotavern.new.* staging file behind'

    try {
        $stillServing = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$serverPort/version" -TimeoutSec 5
        if ($stillServing.StatusCode -ne 200) { Fail "the running server stopped answering /version (status $($stillServing.StatusCode))" @($serverLog) }
    } catch {
        Fail "the running server stopped answering /version after the refused install: $($_.Exception.Message)" @($serverLog)
    }
    Ok 'the running server still answers /version after the refused install'

    # ---- 10. stop it and install the NEWER release through the LATEST form ----------------------
    Stop-QualificationServer
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $stillLocked = $false
        try {
            $stream = [System.IO.File]::Open($installedExe, 'Open', 'ReadWrite', 'None')
            $stream.Close()
        } catch { $stillLocked = $true }
        if (-not $stillLocked) { break }
        Start-Sleep -Seconds 1
    }
    $installLog2 = Join-Path $WorkRoot 'install-newer.log'
    & pwsh -NoProfile -File $Installer -InstallDir $installDir -Version 'latest' *> $installLog2
    if ($LASTEXITCODE -ne 0) { Fail "the installer failed once the server was stopped (exit $LASTEXITCODE)" @($installLog2) }
    if ((Get-Sha256 $installedExe) -eq $exeHashBefore) { Fail 'the installer reported success but gotavern.exe is unchanged, so the update moved no bytes' @($installLog2) }
    $updatedTag = Get-BinaryTag $installedExe
    if ($updatedTag -ne $newerTag) { Fail "after the update the installed binary reports '$updatedTag', expected '$newerTag' (mirror latest)" @($installLog2) }
    Ok "the stopped install replaced gotavern.exe: $olderTag -> $updatedTag, through the LATEST form"

    Push-Location $installDir
    try {
        $verifyOutput2 = & $installedExe assets verify 2>&1
        $verifyStatus2 = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($verifyStatus2 -ne 0) { Fail "assets verify failed after the update (exit $verifyStatus2): $verifyOutput2" }
    Ok 'assets verify passes from the prefix after the update'

    # ---- 11. cmd.exe actually runs the launcher ------------------------------------------------
    # `cmd /c` takes the rest of the line as its command, and $WorkRoot is asserted space-free above,
    # so the launcher path needs no quoting here -- the quoting under test is Start.cmd's own.
    $cmdOutput = & cmd /c $launcher version --json 2>&1
    $cmdStatus = $LASTEXITCODE
    if ($cmdStatus -ne 0) { Fail "cmd.exe could not run Start.cmd (exit ${cmdStatus}): $cmdOutput" }
    $cmdText = ($cmdOutput -join "`n")
    if ($cmdText -notmatch [regex]::Escape($newerTag)) { Fail "Start.cmd under cmd.exe did not report ${newerTag}: $cmdText" }
    Ok "cmd.exe runs Start.cmd, which reports $newerTag -- the launcher's cd /d and %~dp0 work"

    # ---- 12. the mirror served every request, so no install fell back to github.com --------------
    $mirrorText = if (Test-Path -LiteralPath $mirrorLog) { Get-Content -LiteralPath $mirrorLog -Raw } else { '' }
    foreach ($expected in @("/$olderTag/checksums.txt", "/$olderTag/$AssetName", "/$newerTag/checksums.txt", "/$newerTag/$AssetName", "/latest/download/checksums.txt", "/latest/download/$AssetName")) {
        if ($mirrorText -notmatch [regex]::Escape($expected)) { Fail "the loopback mirror never served $expected, so an install may have reached the real release URL instead of the seam" @($mirrorLog) }
    }
    Ok 'the loopback mirror served both release forms and both assets (the seam was honoured, not bypassed)'

    # The summary is LAST and there is no assertion after it: a check placed after its own exit gate
    # prints and cannot fail.
    Write-Host
    Write-Host 'ok: all Windows installer assertions passed'
    Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
} finally {
    Stop-QualificationServer
    Stop-QualificationMirror
}
