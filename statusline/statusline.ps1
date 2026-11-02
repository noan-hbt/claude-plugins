# Status line (Windows PowerShell 5.1): caveman badge, model, context, plan limits,
# and session cost from the token-usage plugin's ledger.
# Each part is optional: missing data hides that part, and it never blocks Claude Code.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$sep = ' ' + [char]0x00B7 + ' '
$esc = [char]27

function Format-Tokens([double]$n) {
    if ($n -ge 1000000) { return ('{0:0.0}M' -f ($n / 1000000)) }
    if ($n -ge 1000) { return ('{0:0}k' -f ($n / 1000)) }
    return ('{0:0}' -f $n)
}

# Green, then yellow from 50 %, red from 80 %.
function Format-Percent([string]$label, $value) {
    if ($null -eq $value) { return $null }
    $pct = [double]$value
    $color = if ($pct -ge 80) { 31 } elseif ($pct -ge 50) { 33 } else { 32 }
    return ('{0} {1}[{2}m{3:0}%{1}[0m' -f $label, $esc, $color, $pct)
}

$payload = $null
try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { $payload = $null }

$parts = New-Object System.Collections.ArrayList

if ($payload) {
    if ($payload.model.display_name) { [void]$parts.Add([string]$payload.model.display_name) }
    foreach ($p in @(
            (Format-Percent 'ctx' $payload.context_window.used_percentage),
            (Format-Percent '5h' $payload.rate_limits.five_hour.used_percentage),
            (Format-Percent '7d' $payload.rate_limits.seven_day.used_percentage))) {
        if ($p) { [void]$parts.Add($p) }
    }
}

# Written by the plugin's Stop/SubagentStop hooks, so it refreshes after each turn.
try {
    $ledgerDir = if ($env:TOKEN_USAGE_LEDGER_DIR) { $env:TOKEN_USAGE_LEDGER_DIR } else { Join-Path $HOME '.cache\token-usage' }
    $sessionId = ([string]$payload.session_id) -replace '[^A-Za-z0-9_-]', ''
    $ledgerPath = Join-Path $ledgerDir "$sessionId.json"
    if ($sessionId -and (Test-Path -LiteralPath $ledgerPath -PathType Leaf)) {
        $ledger = Get-Content -LiteralPath $ledgerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $text = '{0} out' -f (Format-Tokens $ledger.total.usage.output)
        if ($null -ne $ledger.total.cost_usd) {
            $text += [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}~${1:0.00}', $sep, [double]$ledger.total.cost_usd)
        }
        $top = $null
        $best = [double]::NegativeInfinity
        foreach ($prop in $ledger.by_label.PSObject.Properties) {
            if ($null -ne $prop.Value.cost_usd -and [double]$prop.Value.cost_usd -gt $best) {
                $best = [double]$prop.Value.cost_usd
                $top = $prop.Name
            }
        }
        if ($top) { $text += "$($sep)top: $($top -replace '[\x00-\x1F]', '')" }
        [void]$parts.Add($text)
    }
} catch {
    [void]$parts.Add('token-usage: ledger unreadable')
}

# The plugin path holds a version hash, so take the newest install. The script
# writes straight to the console, hence before our own output.
try {
    $caveman = Get-ChildItem (Join-Path $claudeDir 'plugins\cache\caveman\caveman') -Directory |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName 'src\hooks\caveman-statusline.ps1' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($caveman) {
        & $caveman
        [Console]::Write(' ')
    }
} catch {
    [void]$parts.Add('caveman: badge failed')
}

[Console]::Write(($parts -join $sep))
exit 0
