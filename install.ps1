<#
.SYNOPSIS
    agy-meme Windows installer for Antigravity Desktop.
.DESCRIPTION
    Syncs the agy-meme MCP plugin into %USERPROFILE%\.gemini\config\plugins\agy-meme,
    resolves Node.js in the installed mcp_config.json, seeds ~/.gemini/meme-packs,
    and overlays the Desktop renderer/IPC patch onto Antigravity Desktop resources.
#>
param(
    [switch]$PluginOnly,
    [string]$InstallDir = "",
    [switch]$NoKill
)

$ErrorActionPreference = "Stop"

$RepoDir = (Resolve-Path $PSScriptRoot).Path
$Patcher = Join-Path $RepoDir "scripts\meme_patcher.js"
if (-not (Test-Path $Patcher)) {
    throw "Patcher script not found: $Patcher"
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    $FallbackNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $FallbackNode) {
        $NodeBin = $FallbackNode
    } else {
        throw "Node.js v18+ is required. Please install Node.js and retry."
    }
} else {
    $NodeBin = $NodeCmd.Source
}

$PluginDst = Join-Path $env:USERPROFILE ".gemini\config\plugins\agy-meme"
New-Item -ItemType Directory -Force -Path $PluginDst | Out-Null

if ($RepoDir.TrimEnd('\') -ne $PluginDst.TrimEnd('\')) {
    Write-Host "[1/3] Syncing plugin files to $PluginDst ..."
    foreach ($file in @("plugin.json", "mcp_config.json", "server.mjs", "LICENSE", "README.md", "README.zh-CN.md")) {
        $srcFile = Join-Path $RepoDir $file
        if (Test-Path $srcFile) {
            Copy-Item -Force $srcFile (Join-Path $PluginDst $file)
        }
    }
    foreach ($dir in @("assets", "rules", "skills", "scripts")) {
        $srcDir = Join-Path $RepoDir $dir
        $dstDir = Join-Path $PluginDst $dir
        if (Test-Path $srcDir) {
            if (Test-Path $dstDir) { Remove-Item -Recurse -Force $dstDir }
            Copy-Item -Recurse -Force $srcDir $dstDir
        }
    }
    $PacksSrc = Join-Path $RepoDir "packs"
    $PacksDst = Join-Path $PluginDst "packs"
    if (Test-Path $PacksSrc) {
        New-Item -ItemType Directory -Force -Path $PacksDst | Out-Null
        Get-ChildItem -Directory $PacksSrc | ForEach-Object {
            $dstPack = Join-Path $PacksDst $_.Name
            if (Test-Path $dstPack) { Remove-Item -Recurse -Force $dstPack }
            Copy-Item -Recurse -Force $_.FullName $dstPack
        }
    }
}

$InstalledMcpCfg = Join-Path $PluginDst "mcp_config.json"
& $NodeBin -e '
const fs = require("fs");
const cfgPath = process.argv[1];
const nodeBin = process.argv[2];
const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
if (!raw.mcpServers) raw.mcpServers = {};
const entry = raw.mcpServers["agy-meme"] || {};
entry.command = nodeBin;
if (!Array.isArray(entry.args) || entry.args.length === 0) {
  entry.args = ["${PLUGIN_ROOT}/server.mjs"];
}
raw.mcpServers["agy-meme"] = entry;
fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
' $InstalledMcpCfg $NodeBin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$InstalledPatcher = Join-Path $PluginDst "scripts\meme_patcher.js"
& $NodeBin $InstalledPatcher --seed-only
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$AgyCmd = Get-Command agy -ErrorAction SilentlyContinue
if ($AgyCmd) {
    Write-Host "[2/3] Enabling agy-meme via agy CLI ..."
    try { & $AgyCmd.Source plugin enable agy-meme | Out-Null } catch {}
}

if ($PluginOnly) {
    Write-Host "[3/3] -PluginOnly specified: skipped Antigravity Desktop ASAR injection."
    exit 0
}

Write-Host "[3/3] Patching Antigravity Desktop ..."
$PatchArgs = @("--install")
if ($NoKill) { $PatchArgs += "--no-kill" }
if ($InstallDir -ne "") { $PatchArgs += @("--install-dir", $InstallDir) }

& $NodeBin $InstalledPatcher @PatchArgs
exit $LASTEXITCODE
