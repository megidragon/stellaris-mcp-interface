# Install the AI Player MCP mod to the Stellaris mod directory
# Run from the project root: powershell -ExecutionPolicy Bypass -File scripts\install-mod.ps1

param(
    [string]$StellarisDocuments = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Paradox Interactive\Stellaris")
)
$ModName = "ai_player_mcp"
$ModDir = Join-Path $StellarisDocuments "mod\$ModName"
$ModDescriptor = Join-Path $StellarisDocuments "mod\$ModName.mod"
$SourceDir = Join-Path $PSScriptRoot "..\mod"

Write-Host "Installing AI Player MCP mod..." -ForegroundColor Cyan
Write-Host "Source: $SourceDir"
Write-Host "Target: $ModDir"
Write-Host ""

# Create mod directory
if (!(Test-Path $ModDir)) {
    New-Item -ItemType Directory -Path $ModDir -Force | Out-Null
}

# Copy mod files
Copy-Item -Path "$SourceDir\*" -Destination $ModDir -Recurse -Force

# Create the .mod descriptor
@"
name="AI Player MCP Bridge"
path="mod/$ModName"
tags={
	"Utilities"
}
supported_version="4.5.*"
"@ | Set-Content -Path $ModDescriptor -Encoding UTF8

Write-Host "Mod installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "To activate:" -ForegroundColor Yellow
Write-Host "  1. Open the Stellaris launcher"
Write-Host "  2. Go to Mods > All available mods"
Write-Host "  3. Enable 'AI Player MCP Bridge'"
Write-Host "  4. Start a new game or load a save (non-ironman)"
Write-Host ""
Write-Host "The mod will write state data to:" -ForegroundColor Yellow
Write-Host "  $StellarisDocuments\logs\game.log"
Write-Host "  Look for lines starting with 'AI_' prefix"
