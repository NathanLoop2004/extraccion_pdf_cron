param(
    [int]$Limit = 1,
    [int]$MaxAttempts = 3,
    [switch]$SinMaxQuality,
    [switch]$RequireTarget,
    [int]$TargetTextChars = -1
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$jobArgs = @(
    ".\documentos-pdf-job.mjs",
    "--limit=$Limit",
    "--max-attempts=$MaxAttempts"
)

if (-not $SinMaxQuality) {
    $jobArgs += "--max-quality"
}

if ($RequireTarget) {
    $jobArgs += "--require-target"
}

if ($TargetTextChars -ge 0) {
    $jobArgs += "--target-text-chars=$TargetTextChars"
}

Write-Host "MODO REAL: actualiza cs_documentos. Limit=$Limit MaxQuality=$(-not $SinMaxQuality)"
& node @jobArgs
exit $LASTEXITCODE
