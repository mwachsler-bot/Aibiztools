# ============================================================
# Script 1: Google Cloud Setup for Annie AI
# Run this ONCE to create your Google Cloud project and OAuth credentials
# Requires: Google account, browser
# ============================================================

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Annie AI - Google Cloud Setup" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Open Google Cloud Console ──────────────────────
Write-Host "STEP 1: Create a Google Cloud Project" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Opening Google Cloud Console in your browser..."
Start-Process "https://console.cloud.google.com/projectcreate"
Write-Host ""
Write-Host "2. In the browser:" -ForegroundColor White
Write-Host "   - Project name: AnnieAI" -ForegroundColor Gray
Write-Host "   - Click CREATE and wait for it to finish" -ForegroundColor Gray
Write-Host ""
Read-Host "Press ENTER when your project is created"

# ── Step 2: Enable Gmail API ────────────────────────────────
Write-Host ""
Write-Host "STEP 2: Enable Gmail API" -ForegroundColor Yellow
Write-Host ""
Write-Host "Opening Gmail API page..."
Start-Process "https://console.cloud.google.com/apis/library/gmail.googleapis.com"
Write-Host ""
Write-Host "   - Make sure your AnnieAI project is selected at the top" -ForegroundColor Gray
Write-Host "   - Click ENABLE" -ForegroundColor Gray
Write-Host ""
Read-Host "Press ENTER when Gmail API is enabled"

# ── Step 3: Enable Google Calendar API ──────────────────────
Write-Host ""
Write-Host "STEP 3: Enable Google Calendar API" -ForegroundColor Yellow
Write-Host ""
Write-Host "Opening Google Calendar API page..."
Start-Process "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"
Write-Host ""
Write-Host "   - Click ENABLE" -ForegroundColor Gray
Write-Host ""
Read-Host "Press ENTER when Calendar API is enabled"

# ── Step 4: Configure OAuth Consent Screen ──────────────────
Write-Host ""
Write-Host "STEP 4: Configure OAuth Consent Screen" -ForegroundColor Yellow
Write-Host ""
Write-Host "Opening OAuth consent screen..."
Start-Process "https://console.cloud.google.com/apis/credentials/consent"
Write-Host ""
Write-Host "   - User Type: select EXTERNAL, click CREATE" -ForegroundColor Gray
Write-Host "   - App name: AnnieAI" -ForegroundColor Gray
Write-Host "   - User support email: your email" -ForegroundColor Gray
Write-Host "   - Developer contact: your email" -ForegroundColor Gray
Write-Host "   - Click SAVE AND CONTINUE through all steps" -ForegroundColor Gray
Write-Host "   - On the 'Test users' step, add the Gmail accounts you want to test with" -ForegroundColor Gray
Write-Host "   - Click SAVE AND CONTINUE then BACK TO DASHBOARD" -ForegroundColor Gray
Write-Host ""
Read-Host "Press ENTER when OAuth consent screen is configured"

# ── Step 5: Create OAuth Credentials ────────────────────────
Write-Host ""
Write-Host "STEP 5: Create OAuth 2.0 Credentials" -ForegroundColor Yellow
Write-Host ""
Write-Host "Opening credentials page..."
Start-Process "https://console.cloud.google.com/apis/credentials"
Write-Host ""
Write-Host "   - Click CREATE CREDENTIALS > OAuth client ID" -ForegroundColor Gray
Write-Host "   - Application type: Desktop app" -ForegroundColor Gray
Write-Host "   - Name: AnnieAI Desktop" -ForegroundColor Gray
Write-Host "   - Click CREATE" -ForegroundColor Gray
Write-Host "   - Click DOWNLOAD JSON on the popup that appears" -ForegroundColor Gray
Write-Host "   - Save the file as: client_secret.json" -ForegroundColor Gray
Write-Host ""
Read-Host "Press ENTER when you have downloaded client_secret.json"

# ── Step 6: Move credentials file ───────────────────────────
Write-Host ""
Write-Host "STEP 6: Place your credentials file" -ForegroundColor Yellow
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$credPath = Join-Path $scriptDir "client_secret.json"

Write-Host "Move your downloaded client_secret.json to:" -ForegroundColor White
Write-Host "  $scriptDir" -ForegroundColor Green
Write-Host ""
Read-Host "Press ENTER when client_secret.json is in that folder"

# ── Verify file exists ───────────────────────────────────────
if (Test-Path $credPath) {
    $cred = Get-Content $credPath | ConvertFrom-Json
    $clientId = $cred.installed.client_id
    Write-Host ""
    Write-Host "SUCCESS! Credentials found." -ForegroundColor Green
    Write-Host "Client ID: $clientId" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "You are ready to run Script 2: 2-Pull-GmailReport.ps1" -ForegroundColor White
} else {
    Write-Host ""
    Write-Host "WARNING: client_secret.json not found at expected location." -ForegroundColor Red
    Write-Host "Please move the file to: $scriptDir" -ForegroundColor Yellow
    Write-Host "Then run Script 2 once it's in place." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Cyan
