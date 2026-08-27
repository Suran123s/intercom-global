# install.ps1 - One-Click PowerShell Installer for Intercom Global
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "🚀 Installing Intercom Global (Multi-Agent Intercom & Auto-Wake)" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan

$CurrentDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. Run npm install
Write-Host "`n📦 Installing dependencies..." -ForegroundColor Yellow
Set-Location -Path $CurrentDir
npm install

# 2. Link globally
Write-Host "`n🔗 Linking global CLI commands (intercom, intercom-wake, intercom-mcp)..." -ForegroundColor Yellow
npm link

Write-Host "`n✅ Installation Complete!" -ForegroundColor Green
Write-Host "You can now run:" -ForegroundColor Cyan
Write-Host "  intercom --help" -ForegroundColor White
Write-Host "  intercom send --from suran --to madhav --msg 'Hello!'" -ForegroundColor White
Write-Host "  intercom wake --to keshav --msg 'Check test suite'" -ForegroundColor White
Write-Host "  intercom pi list" -ForegroundColor White
