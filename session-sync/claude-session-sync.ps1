# claude-session-sync.ps1
# Keeps the Code-session list of every Claude account on this PC identical, WITHOUT junctions.
# The Claude app refuses to write into a session folder that is a junction/symlink
# ("PlantDetectedError: Refusing non-directory at private dir path"), so a bridge only ever
# works for one account. This script instead keeps every account folder a real folder and
# mirrors the session files between them: newest copy of each local_*.json wins, deleted_*
# markers are spread to every folder and remove the session they name. Nothing else is touched.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File claude-session-sync.ps1            # sync once (app may be open)
#   powershell -ExecutionPolicy Bypass -File claude-session-sync.ps1 -Status    # show folders and counts
#   powershell -ExecutionPolicy Bypass -File claude-session-sync.ps1 -Install   # sync every 5 h, hidden (Task Scheduler)
#   powershell -ExecutionPolicy Bypass -File claude-session-sync.ps1 -Uninstall # remove the scheduled task
# Optional: -Root "<path to claude-code-sessions>" if the folder is not found.
# Unofficial: not a Claude feature. Run -Status after an app update to check the root is still right.

param(
    [string]$Root,
    [switch]$Status,
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$taskName = 'ClaudeSessionSync'
$settleSeconds = 5   # skip files the app wrote in the last few seconds (may be half-written)

function Get-SessionRoot {
    if ($Root) { if (Test-Path -LiteralPath $Root) { return $Root }; throw "Session root not found: $Root" }
    $data = Join-Path $env:LOCALAPPDATA 'Claude-Data'
    if (Test-Path -LiteralPath $data) {
        foreach ($d in Get-ChildItem -LiteralPath $data -Directory -Filter 'claude_*' -ErrorAction SilentlyContinue) {
            $r = Join-Path $d.FullName 'claude-code-sessions'
            if (Test-Path -LiteralPath $r) { return $r }
        }
    }
    $pkg = Join-Path $env:LOCALAPPDATA 'Packages'
    if (Test-Path -LiteralPath $pkg) {
        foreach ($p in Get-ChildItem -LiteralPath $pkg -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue) {
            $r = Join-Path $p.FullName 'LocalCache\Roaming\Claude\claude-code-sessions'
            if (Test-Path -LiteralPath $r) { return $r }
        }
    }
    $r = Join-Path $env:APPDATA 'Claude\claude-code-sessions'
    if (Test-Path -LiteralPath $r) { return $r }
    return $null
}

# Real <account>\<org> folders only: junctions and *.before-bridge-* copies are left alone.
function Get-Leaves([string]$root) {
    foreach ($acct in Get-ChildItem -LiteralPath $root -Directory -Force) {
        if ($acct.Name -like '*.before-bridge-*' -or $acct.LinkType) { continue }
        Get-ChildItem -LiteralPath $acct.FullName -Directory -Force |
            Where-Object { $_.Name -notlike '*.before-bridge-*' -and -not $_.LinkType }
    }
}
function Rel([string]$root, [string]$full) { return $full.Substring($root.Length).TrimStart('\') }
function Count([string]$dir, [string]$filter) { return @(Get-ChildItem -LiteralPath $dir -File -Filter $filter -ErrorAction SilentlyContinue).Count }

# ---------- locate ----------
$root = Get-SessionRoot
if (-not $root) { throw 'No claude-code-sessions folder found. Open the Claude app, start one Code session, then run again (or pass -Root).' }
$leaves = @(Get-Leaves $root)
Write-Output "Session root : $root"
foreach ($l in $leaves) {
    Write-Output ("  {0,-80} {1,3} sessions, {2,2} deleted markers" -f (Rel $root $l.FullName), (Count $l.FullName 'local_*.json'), (Count $l.FullName 'deleted_*'))
}
foreach ($j in Get-ChildItem -LiteralPath $root -Recurse -Depth 1 -Directory -Force | Where-Object { $_.LinkType }) {
    Write-Output "  WARNING: $(Rel $root $j.FullName) is a $($j.LinkType); the app cannot save there. Remove it (claude-session-bridge.ps1 -Undo)."
}
Write-Output ''
if ($Status) { return }

# ---------- install / uninstall the scheduled task ----------
if ($Uninstall) {
    schtasks /Delete /TN $taskName /F | Out-Null
    Write-Output "Removed scheduled task $taskName."
    return
}
if ($Install) {
    $self = $MyInvocation.MyCommand.Path
    $ps   = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$self"""
    # $root (the found folder) shadows $Root, so read the -Root argument itself.
    if ($PSBoundParameters['Root']) { $ps += " -Root ""$($PSBoundParameters['Root'])""" }
    # powershell -WindowStyle Hidden still flashes a console; a VBS launcher with window style 0 shows nothing.
    $vbs = [IO.Path]::ChangeExtension($self, '.vbs')
    $vbsArg = $ps.Replace('"', '""')
    'CreateObject("WScript.Shell").Run "' + $vbsArg + '", 0, False' | Set-Content -LiteralPath $vbs -Encoding ASCII
    # Every 5 hours while logged on (an ONLOGON trigger would need an elevated prompt).
    schtasks /Create /F /TN $taskName /SC HOURLY /MO 5 /TR "wscript.exe //B //Nologo `"$vbs`"" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "schtasks failed ($LASTEXITCODE)" }
    Write-Output "Installed scheduled task $taskName (every 5 h, hidden). Running the first sync now."
    Write-Output ''
}

if ($leaves.Count -lt 2) { Write-Output 'Only one account folder: nothing to sync.'; return }
$cutoff = (Get-Date).AddSeconds(-$settleSeconds)
$copied = 0; $removed = 0

# ---------- deleted_* markers: spread to every folder, remove the session they name ----------
$markers = @{}
foreach ($l in $leaves) {
    foreach ($m in Get-ChildItem -LiteralPath $l.FullName -File -Filter 'deleted_*' -ErrorAction SilentlyContinue) {
        if (-not $markers.ContainsKey($m.Name) -or $m.LastWriteTime -gt $markers[$m.Name].LastWriteTime) { $markers[$m.Name] = $m }
    }
}
foreach ($name in $markers.Keys) {
    $src = $markers[$name]
    $id  = $name.Substring('deleted_'.Length)
    foreach ($l in $leaves) {
        $dest = Join-Path $l.FullName $name
        if (-not (Test-Path -LiteralPath $dest)) {
            if ($WhatIf) { Write-Output "Would copy marker $name -> $(Rel $root $l.FullName)" }
            else { Copy-Item -LiteralPath $src.FullName -Destination $dest }
            $copied++
        }
        $sess = Join-Path $l.FullName "local_$id.json"
        if (Test-Path -LiteralPath $sess) {
            $f = Get-Item -LiteralPath $sess
            # Only remove what is older than the deletion; a session touched after it was deleted elsewhere stays.
            if ($f.LastWriteTime -le $src.LastWriteTime) {
                if ($WhatIf) { Write-Output "Would remove deleted session $($f.Name) from $(Rel $root $l.FullName)" }
                else { Remove-Item -LiteralPath $sess }
                $removed++
            }
        }
    }
}

# ---------- local_*.json: newest copy wins ----------
$newest = @{}
foreach ($l in $leaves) {
    foreach ($f in Get-ChildItem -LiteralPath $l.FullName -File -Filter 'local_*.json' -ErrorAction SilentlyContinue) {
        if ($f.LastWriteTime -gt $cutoff) { continue }   # still being written
        if (-not $newest.ContainsKey($f.Name) -or $f.LastWriteTime -gt $newest[$f.Name].LastWriteTime) { $newest[$f.Name] = $f }
    }
}
foreach ($name in $newest.Keys) {
    $src = $newest[$name]
    if ($markers.ContainsKey('deleted_' + $name.Substring(6, $name.Length - 11))) { continue }
    foreach ($l in $leaves) {
        $dest = Join-Path $l.FullName $name
        if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).LastWriteTime -ge $src.LastWriteTime) { continue }
        if ($WhatIf) { Write-Output "Would copy $name ($($src.LastWriteTime.ToString('HH:mm:ss'))) -> $(Rel $root $l.FullName)" }
        else { Copy-Item -LiteralPath $src.FullName -Destination $dest -Force }
        $copied++
    }
}

Write-Output "$(if ($WhatIf) { 'Dry run: would copy' } else { 'Synced:' }) $copied file(s), remove $removed deleted session(s)."
