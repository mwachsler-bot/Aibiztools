# ============================================================
# Script 2: Pull Gmail + Google Calendar data and generate
#           an Annie AI work pattern report (JSON)
# Run AFTER Script 1 and after placing client_secret.json
# ============================================================

param(
    [int]$DaysBack = 90,       # How many days of email history to pull
    [int]$MaxEmails = 500      # Max emails to scan (keeps it fast)
)

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$credFile    = Join-Path $scriptDir "client_secret.json"
$tokenFile   = Join-Path $scriptDir "gmail_token.json"
$reportDir   = Join-Path $scriptDir "reports"
$openAiKey   = $env:OPENAI_API_KEY   # set this env var or paste key below
# $openAiKey = "sk-..."              # ← uncomment and paste if not using env var

# ── Preflight checks ────────────────────────────────────────
if (-not (Test-Path $credFile)) {
    Write-Host "ERROR: client_secret.json not found. Run Script 1 first." -ForegroundColor Red
    exit 1
}
if (-not $openAiKey) {
    Write-Host "ERROR: OPENAI_API_KEY not set." -ForegroundColor Red
    Write-Host "Either set the environment variable or paste your key into the script." -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir | Out-Null }

# ── Load credentials ────────────────────────────────────────
$cred     = Get-Content $credFile | ConvertFrom-Json
$clientId = $cred.installed.client_id
$clientSecret = $cred.installed.client_secret
$redirectUri  = "urn:ietf:wg:oauth:2.0:oob"
$scopes       = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly"

# ── OAuth: get or refresh token ─────────────────────────────
function Get-AccessToken {
    if (Test-Path $tokenFile) {
        $token = Get-Content $tokenFile | ConvertFrom-Json
        # Refresh if we have a refresh token
        if ($token.refresh_token) {
            Write-Host "Refreshing access token..." -ForegroundColor Gray
            $body = @{
                client_id     = $clientId
                client_secret = $clientSecret
                refresh_token = $token.refresh_token
                grant_type    = "refresh_token"
            }
            $response = Invoke-RestMethod -Uri "https://oauth2.googleapis.com/token" -Method POST -Body $body
            $token | Add-Member -MemberType NoteProperty -Name "access_token" -Value $response.access_token -Force
            $token | ConvertTo-Json | Set-Content $tokenFile
            return $response.access_token
        }
    }

    # First-time auth: open browser for consent
    $authUrl = "https://accounts.google.com/o/oauth2/auth?" + `
               "client_id=$clientId" + `
               "&redirect_uri=$([System.Uri]::EscapeDataString($redirectUri))" + `
               "&response_type=code" + `
               "&scope=$([System.Uri]::EscapeDataString($scopes))" + `
               "&access_type=offline" + `
               "&prompt=consent"

    Write-Host ""
    Write-Host "Opening browser for Google sign-in..." -ForegroundColor Yellow
    Start-Process $authUrl
    Write-Host ""
    Write-Host "After signing in, Google will show you a code." -ForegroundColor White
    $code = Read-Host "Paste the code here"

    $body = @{
        client_id     = $clientId
        client_secret = $clientSecret
        code          = $code
        redirect_uri  = $redirectUri
        grant_type    = "authorization_code"
    }
    $response = Invoke-RestMethod -Uri "https://oauth2.googleapis.com/token" -Method POST -Body $body
    $response | ConvertTo-Json | Set-Content $tokenFile
    Write-Host "Token saved." -ForegroundColor Green
    return $response.access_token
}

$accessToken = Get-AccessToken
$headers = @{ Authorization = "Bearer $accessToken" }

# ── Get Gmail profile (who is this?) ────────────────────────
Write-Host ""
Write-Host "Fetching Gmail profile..." -ForegroundColor Cyan
$profile = Invoke-RestMethod -Uri "https://gmail.googleapis.com/gmail/v1/users/me/profile" -Headers $headers
$email   = $profile.emailAddress
Write-Host "Connected as: $email" -ForegroundColor Green

# ── Pull emails ──────────────────────────────────────────────
Write-Host "Pulling last $DaysBack days of email (up to $MaxEmails)..." -ForegroundColor Cyan

$afterDate    = (Get-Date).AddDays(-$DaysBack).ToString("yyyy/MM/dd")
$searchQuery  = "after:$afterDate"
$emailList    = @()
$nextPageToken = $null

do {
    $url = "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=$([System.Uri]::EscapeDataString($searchQuery))"
    if ($nextPageToken) { $url += "&pageToken=$nextPageToken" }
    $page = Invoke-RestMethod -Uri $url -Headers $headers
    if ($page.messages) { $emailList += $page.messages }
    $nextPageToken = $page.nextPageToken
    Write-Host "  Fetched $($emailList.Count) messages so far..." -ForegroundColor Gray
} while ($nextPageToken -and $emailList.Count -lt $MaxEmails)

$emailList = $emailList | Select-Object -First $MaxEmails

# ── Fetch email metadata (subject, from, to, date) ──────────
Write-Host "Reading email metadata..." -ForegroundColor Cyan
$emails = @()
$i = 0
foreach ($msg in $emailList) {
    $i++
    if ($i % 50 -eq 0) { Write-Host "  Processed $i / $($emailList.Count)..." -ForegroundColor Gray }
    try {
        $detail = Invoke-RestMethod -Uri "https://gmail.googleapis.com/gmail/v1/users/me/messages/$($msg.id)?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date" -Headers $headers
        $hdrs = @{}
        foreach ($h in $detail.payload.headers) { $hdrs[$h.name] = $h.value }
        $emails += [PSCustomObject]@{
            id      = $msg.id
            date    = $hdrs["Date"]
            from    = $hdrs["From"]
            to      = $hdrs["To"]
            subject = $hdrs["Subject"]
            labels  = $detail.labelIds -join ","
        }
    } catch { }
}

# ── Analyse email patterns locally ──────────────────────────
Write-Host "Analysing patterns..." -ForegroundColor Cyan

$sent = $emails | Where-Object { $_.labels -match "SENT" }
$received = $emails | Where-Object { $_.labels -notmatch "SENT" }

# Top domains emailed
$sentDomains = $sent | ForEach-Object {
    if ($_.to -match "@([\w.-]+)") { $matches[1].ToLower() }
} | Where-Object { $_ } | Group-Object | Sort-Object Count -Descending | Select-Object -First 10

# Recurring subject patterns (strip Re:/Fwd:)
$subjectClusters = $sent.subject + $received.subject | ForEach-Object {
    $_ -replace "^(Re|Fwd|FW|RE|FWD):\s*", "" -replace "\s+", " "
} | Where-Object { $_.Length -gt 5 } | Group-Object | Sort-Object Count -Descending | Select-Object -First 20

# Day-of-week activity
$dayActivity = $sent | ForEach-Object {
    try { [datetime]::Parse($_.date).DayOfWeek.ToString() } catch { }
} | Where-Object { $_ } | Group-Object | Sort-Object Count -Descending

# ── Pull Google Calendar events ──────────────────────────────
Write-Host "Fetching calendar events..." -ForegroundColor Cyan
$calStart = (Get-Date).AddDays(-$DaysBack).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$calEnd   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$calUrl   = "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=$calStart&timeMax=$calEnd&maxResults=500&singleEvents=true&orderBy=startTime"

$calResponse = Invoke-RestMethod -Uri $calUrl -Headers $headers
$events = $calResponse.items

# Recurring meetings
$recurringEvents = $events | Where-Object { $_.recurringEventId } |
    Group-Object summary | Sort-Object Count -Descending | Select-Object -First 10

# Total meeting hours
$totalMeetingMinutes = 0
foreach ($ev in $events) {
    try {
        if ($ev.start.dateTime -and $ev.end.dateTime) {
            $duration = ([datetime]$ev.end.dateTime - [datetime]$ev.start.dateTime).TotalMinutes
            $totalMeetingMinutes += $duration
        }
    } catch { }
}
$totalMeetingHours = [math]::Round($totalMeetingMinutes / 60, 1)

# ── Build data summary for GPT ───────────────────────────────
$dataSummary = @"
EMPLOYEE EMAIL: $email
ANALYSIS PERIOD: Last $DaysBack days
TOTAL EMAILS SCANNED: $($emails.Count)
EMAILS SENT: $($sent.Count)
EMAILS RECEIVED: $($received.Count)
AVERAGE EMAILS SENT PER DAY: $([math]::Round($sent.Count / $DaysBack, 1))

TOP DOMAINS EMAILED TO:
$(($sentDomains | ForEach-Object { "  - $($_.Name): $($_.Count) emails" }) -join "`n")

MOST RECURRING EMAIL SUBJECTS (likely repeating workflows):
$(($subjectClusters | Select-Object -First 15 | ForEach-Object { "  - [$($_.Count)x] $($_.Name)" }) -join "`n")

EMAIL ACTIVITY BY DAY OF WEEK:
$(($dayActivity | ForEach-Object { "  - $($_.Name): $($_.Count) sent" }) -join "`n")

CALENDAR: TOTAL MEETING HOURS (last $DaysBack days): $totalMeetingHours hrs
RECURRING MEETINGS:
$(($recurringEvents | ForEach-Object { "  - [$($_.Count)x] $($_.Name)" }) -join "`n")
"@

Write-Host ""
Write-Host "Sending to GPT-4o for analysis..." -ForegroundColor Cyan

# ── Send to GPT-4o for report generation ────────────────────
$systemPrompt = @"
You are an AI business analyst helping identify automation opportunities for employees.
You will be given a summary of an employee's email and calendar activity.
Your job is to produce a structured work pattern report that will be fed into an AI audit system (Annie AI).

Output a JSON object with this exact structure:
{
  "employee_email": "...",
  "analysis_period_days": 90,
  "summary": "2-3 sentence plain English overview of how this person works",
  "daily_email_volume": "e.g. ~12 emails/day sent",
  "top_communication_domains": ["domain1.com", "domain2.com"],
  "recurring_workflows": [
    {
      "name": "Short name for the workflow",
      "evidence": "What in the data suggests this is recurring",
      "frequency": "e.g. daily / weekly / ad hoc",
      "automation_potential": "high / medium / low",
      "automation_note": "What an agent could do here"
    }
  ],
  "meeting_burden": {
    "total_hours_per_period": 0,
    "weekly_average_hours": 0,
    "assessment": "e.g. Heavy meeting load — possible async replacement candidates"
  },
  "agent_opportunities": [
    {
      "opportunity": "Plain English description",
      "trigger": "What kicks this off",
      "what_agent_does": "Step by step what the agent handles",
      "estimated_time_saved_per_week": "e.g. 2-3 hours",
      "priority": "high / medium / low"
    }
  ],
  "annie_context_note": "A single paragraph Annie AI can inject into its interview system prompt to ask sharper, more targeted questions based on this data"
}
"@

$userMessage = "Here is the employee activity data:`n`n$dataSummary"

$requestBody = @{
    model    = "gpt-4o"
    messages = @(
        @{ role = "system"; content = $systemPrompt },
        @{ role = "user";   content = $userMessage }
    )
    response_format = @{ type = "json_object" }
} | ConvertTo-Json -Depth 10

$gptResponse = Invoke-RestMethod `
    -Uri "https://api.openai.com/v1/chat/completions" `
    -Method POST `
    -Headers @{ Authorization = "Bearer $openAiKey"; "Content-Type" = "application/json" } `
    -Body $requestBody

$reportJson = $gptResponse.choices[0].message.content

# ── Save report ──────────────────────────────────────────────
$safeEmail  = $email -replace "[^a-zA-Z0-9]", "_"
$timestamp  = Get-Date -Format "yyyyMMdd_HHmmss"
$reportFile = Join-Path $reportDir "report_${safeEmail}_${timestamp}.json"
$reportJson | Set-Content $reportFile

# ── Print summary to console ─────────────────────────────────
Write-Host ""
Write-Host "=======================================" -ForegroundColor Green
Write-Host "  REPORT COMPLETE" -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor Green
Write-Host ""

$report = $reportJson | ConvertFrom-Json

Write-Host "Employee:  $($report.employee_email)" -ForegroundColor White
Write-Host "Summary:   $($report.summary)" -ForegroundColor White
Write-Host ""
Write-Host "Agent Opportunities Found:" -ForegroundColor Yellow
foreach ($opp in $report.agent_opportunities) {
    $color = if ($opp.priority -eq "high") { "Red" } elseif ($opp.priority -eq "medium") { "Yellow" } else { "Gray" }
    Write-Host "  [$($opp.priority.ToUpper())] $($opp.opportunity)" -ForegroundColor $color
    Write-Host "         Saves: $($opp.estimated_time_saved_per_week)/week" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Annie Context Note:" -ForegroundColor Cyan
Write-Host $report.annie_context_note -ForegroundColor Gray
Write-Host ""
Write-Host "Full report saved to:" -ForegroundColor White
Write-Host "  $reportFile" -ForegroundColor Green
Write-Host ""
Write-Host "Feed this JSON into Annie AI as participant pre-context." -ForegroundColor Cyan
