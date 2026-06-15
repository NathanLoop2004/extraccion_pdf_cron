param(
    [int]$Limit = 25,
    [int]$MaxAttempts = 3,
    [switch]$DryRun,
    [switch]$KeepFiles,
    [switch]$NoOcr,
    [switch]$ForceOcr,
    [switch]$MaxQuality,
    [switch]$RequireTarget,
    [string]$OcrLang = "",
    [int]$OcrMaxPages = -1,
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

if ($DryRun) {
    $jobArgs += "--dry-run"
}

if ($KeepFiles) {
    $jobArgs += "--keep-files"
}

if ($NoOcr) {
    $jobArgs += "--no-ocr"
}

if ($ForceOcr) {
    $jobArgs += "--force-ocr"
}

if ($MaxQuality) {
    $jobArgs += "--max-quality"
}

if ($RequireTarget) {
    $jobArgs += "--require-target"
}

if ($OcrLang) {
    $jobArgs += "--ocr-lang=$OcrLang"
}

if ($OcrMaxPages -ge 0) {
    $jobArgs += "--ocr-max-pages=$OcrMaxPages"
}

if ($TargetTextChars -ge 0) {
    $jobArgs += "--target-text-chars=$TargetTextChars"
}

& node @jobArgs
exit $LASTEXITCODE
