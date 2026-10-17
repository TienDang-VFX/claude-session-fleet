# Installs session-fleet for Claude Code on this Windows machine.
#   .\install.ps1 -ProjectMarker MyGame.uproject        (finds the project folder and names the machine by itself)
#   .\install.ps1 -Machine 5080 -ProjectRoot D:\Work\mygame
#   .\install.ps1 -ProjectMarker MyGame.uproject -RegistryGit ""            (registry: this machine only)
#   .\install.ps1 -ProjectMarker MyGame.uproject -RegistryDir \\nas\share\session-fleet
param(
    [string]$Machine = "",
    [string]$ProjectRoot = "",
    [string]$ProjectMarker = "",
    [string]$RegistryDir = "",
    [string]$RegistryGit = "https://github.com/TienDang-VFX/claude-session-registry.git",
    [switch]$NoEnforce
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$claudeDir = Join-Path $env:USERPROFILE ".claude"
New-Item -ItemType Directory -Force $claudeDir | Out-Null

# Machine name: the GPU model number (RTX 3090 -> 3090), else the computer name.
if (-not $Machine) {
    $gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match '(RTX|GTX|RX)\s*(\d{3,4})' } | Select-Object -First 1
    $Machine = if ($gpu -and $gpu.Name -match '(RTX|GTX|RX)\s*(\d{3,4})') { $Matches[2] } else { $env:COMPUTERNAME }
}
Write-Host "Machine name: $Machine"

# Project folder: the folder holding $ProjectMarker, up to two levels below the root of each local fixed drive.
if (-not $ProjectRoot) {
    if (-not $ProjectMarker) { throw "Pass -ProjectRoot <folder> or -ProjectMarker <file that marks the project folder, e.g. MyGame.uproject>" }
    $skip = '^(\$Recycle\.Bin|Windows|Program Files.*|ProgramData|System Volume Information|Recovery|PerfLogs)$'
    $found = @()
    $drives = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "$($_.DeviceID)\" }
    foreach ($drive in $drives) {
        foreach ($one in Get-ChildItem $drive -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch $skip }) {
            if (Test-Path (Join-Path $one.FullName $ProjectMarker)) { $found += $one.FullName }
            foreach ($two in Get-ChildItem $one.FullName -Directory -ErrorAction SilentlyContinue) {
                if (Test-Path (Join-Path $two.FullName $ProjectMarker)) { $found += $two.FullName }
            }
        }
    }
    if ($found.Count -eq 0) { throw "No folder holding $ProjectMarker found on the local drives; pass -ProjectRoot." }
    Write-Host "Folders holding ${ProjectMarker}:"; $found | ForEach-Object { Write-Host "  $_" }
    # Several copies: prefer a full git clone (.git folder, not a worktree file), then the most recently changed one.
    $ProjectRoot = $found |
        Sort-Object @{ e = { Test-Path (Join-Path $_ '.git') -PathType Container }; Descending = $true },
                    @{ e = { (Get-Item $_).LastWriteTime }; Descending = $true } |
        Select-Object -First 1
}
Write-Host "Project folder: $ProjectRoot"

if ($RegistryGit -and -not $RegistryDir) { $RegistryDir = Join-Path $claudeDir "session-fleet-registry" }
if ($RegistryGit) {
    if (Get-Command gh -ErrorAction SilentlyContinue) { gh auth setup-git }
    if (-not (Test-Path (Join-Path $RegistryDir ".git"))) {
        git clone $RegistryGit $RegistryDir
        if ($LASTEXITCODE -ne 0) { throw "git clone $RegistryGit failed (is this machine signed in to GitHub? run: gh auth login)" }
    }
    git -C $RegistryDir config user.name "session-fleet $Machine"
    git -C $RegistryDir config user.email "session-fleet@$Machine.local"
}

$config = [ordered]@{
    machineName   = $Machine
    projectRoot   = $ProjectRoot
    registryDir   = $RegistryDir
    enforceFolder = -not $NoEnforce
} | ConvertTo-Json
$configPath = Join-Path $claudeDir "session-fleet.json"
[IO.File]::WriteAllText($configPath, $config, (New-Object Text.UTF8Encoding($false)))
Write-Host "Wrote $configPath"

claude plugin marketplace add $here
claude plugin install session-fleet@session-fleet-local --scope user
if ($LASTEXITCODE -ne 0) { throw "claude plugin install failed" }

Write-Host ""
Write-Host "Done. Two things left by hand on this machine:"
Write-Host "  1. Claude desktop app: Settings > Claude Code > 'Connect new sessions to Remote Control' = On"
Write-Host "  2. Terminal sessions: add  `"remoteControlAtStartup`": true  to $claudeDir\settings.json"
Write-Host "Then open a new session: its title starts with [$Machine]."
