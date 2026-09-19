# Run with pwsh -File scripts/verify-archive.ps1. Uses synthetic files only.
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('flexops-archive-test-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $fixture 'source'
$output = Join-Path $source 'backups'
New-Item -ItemType Directory -Path (Join-Path $source '.git'), (Join-Path $source 'nested'), $output | Out-Null
Set-Content -LiteralPath (Join-Path $source 'plain.txt') -Value 'plain'
Set-Content -LiteralPath (Join-Path $source '.git/config') -Value 'synthetic'
Set-Content -LiteralPath (Join-Path $source 'nested/hidden.txt') -Value 'hidden'
if ($IsWindows) { (Get-Item (Join-Path $source 'nested/hidden.txt')).Attributes = 'Hidden' }
$helper = Join-Path $PSScriptRoot '../Create-Archive.ps1'
& $helper -SourceDir $source -OutputDir $output
& $helper -SourceDir $source -OutputDir $output
$archives = @(Get-ChildItem -LiteralPath $output -Filter '*.zip')
if ($archives.Count -ne 2) { throw 'Archive numbering failed.' }
foreach ($archive in $archives) {
    $zip = [IO.Compression.ZipFile]::OpenRead($archive.FullName)
    try {
        $names = @($zip.Entries.FullName)
        if ($names.Count -ne 3 -or $names -notcontains 'plain.txt' -or
            $names -notcontains '.git/config' -or $names -notcontains 'nested/hidden.txt') {
            throw "Archive contents or output-directory exclusion failed: $names"
        }
        $entry = $zip.GetEntry('plain.txt')
        $reader = [IO.StreamReader]::new($entry.Open())
        try { if ($reader.ReadToEnd().Trim() -ne 'plain') { throw 'Round-trip content mismatch.' } }
        finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
}
# Simulate another invocation claiming the next filename after enumeration.
function Get-ChildItem {
    param($LiteralPath, $Filter, [switch]$File, [switch]$Force, [switch]$Recurse, $ErrorAction)
    $items = @(Microsoft.PowerShell.Management\Get-ChildItem @PSBoundParameters)
    if ($Filter) {
        $claimed = Join-Path $LiteralPath ('source_Archive_' + (Get-Date -Format yyyyMMdd) + '-3.zip')
        [IO.File]::WriteAllText($claimed, 'concurrent-backup')
    }
    $items
}
$failed = $false
try { & $helper -SourceDir $source -OutputDir $output } catch { $failed = $true }
$claimed = Join-Path $output ('source_Archive_' + (Get-Date -Format yyyyMMdd) + '-3.zip')
if (-not $failed -or [IO.File]::ReadAllText($claimed) -ne 'concurrent-backup') {
    throw 'A competing archive was overwritten or removed.'
}
Write-Host "PASS: contents, hidden files, numbering, nested output exclusion, and concurrent filename safety. Fixture: $fixture"