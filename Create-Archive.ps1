# Create-Archive.ps1
# Creates a full ZIP backup of all files under the configured source directory.
# Includes hidden files, .git, build outputs, node_modules, logs, ZIPs, and all other files.
#
# Default source:
#   D:\My Projects\FlexOps\flexops-cli
#
# Default output:
#   D:\My Projects\FlexOps\Libraries\Archive\flexops-cli\
#   flexops-cli_Archive_{yyyyMMdd}-{N}.zip

[CmdletBinding()]
param(
    [string]$SourceDir = "D:\My Projects\FlexOps\flexops-cli",
    [string]$OutputDir = $null
)

$ErrorActionPreference = "Stop"

# Resolve and validate source directory.
if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    throw "Source directory does not exist: $SourceDir"
}

$sourceDir = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\')
$dirName = Split-Path $sourceDir -Leaf

# Default output: D:\My Projects\FlexOps\Libraries\Archive\{dirName}\
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path "D:\My Projects\FlexOps\Libraries\Archive" $dirName
}

# Ensure the archive output directory exists.
if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -Path $OutputDir -ItemType Directory -Force | Out-Null
    Write-Host "Created archive directory: $OutputDir" -ForegroundColor Yellow
}

$outputDir = (Resolve-Path -LiteralPath $OutputDir).Path

# Prevent recursive self-backup if somebody points OutputDir inside SourceDir.
$outputDirInsideSource = $outputDir.StartsWith(
    $sourceDir + '\',
    [System.StringComparison]::OrdinalIgnoreCase
)

# Create archive name based on directory name + date.
$dateString = Get-Date -Format "yyyyMMdd"
$baseArchiveName = "${dirName}_Archive_${dateString}"

# Determine next available archive number.
$existingZips = @(
    Get-ChildItem -LiteralPath $outputDir -Filter "${baseArchiveName}*.zip" -File -Force -ErrorAction SilentlyContinue
)

$maxIndex = 0
$escapedBase = [regex]::Escape($baseArchiveName)
foreach ($f in $existingZips) {
    if ($f.Name -match "^${escapedBase}-(\d+)\.zip$") {
        $n = [int]$Matches[1]
        $maxIndex = [math]::Max($maxIndex, $n)
    }
}

$next = $maxIndex + 1
$outputZip = Join-Path $outputDir "${baseArchiveName}-${next}.zip"

Write-Host "Creating FULL archive from:" -ForegroundColor Cyan
Write-Host "  Source: $sourceDir" -ForegroundColor White
Write-Host "  Output: $outputZip" -ForegroundColor White
Write-Host "  Mode: Include all files recursively" -ForegroundColor Green

Write-Host "`nScanning files..." -ForegroundColor Cyan

# Collect every file recursively, including hidden/system files.
# The only exception is OutputDir itself if it is located inside SourceDir,
# which avoids backing the archive into itself while it is being created.
$allItems = @(
    Get-ChildItem -LiteralPath $sourceDir -Recurse -File -Force -ErrorAction Stop |
        Where-Object {
            if (-not $outputDirInsideSource) {
                return $true
            }

            return -not $_.FullName.StartsWith(
                $outputDir + '\',
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
)

$fileCount = $allItems.Count
$totalBytes = ($allItems | Measure-Object -Property Length -Sum).Sum
if ($null -eq $totalBytes) { $totalBytes = 0 }

Write-Host "`nSummary:" -ForegroundColor Yellow
Write-Host "  Files to include: $fileCount" -ForegroundColor Green
Write-Host "  Source size: $([math]::Round($totalBytes / 1MB, 2)) MB" -ForegroundColor White
Write-Host "  Creating archive: $(Split-Path $outputZip -Leaf)" -ForegroundColor Cyan

$zip = $null
$archiveStream = $null
$createdArchive = $false

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    # Reserve the filename atomically; never replace another invocation's backup.
    $archiveStream = [System.IO.File]::Open($outputZip,
        [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $createdArchive = $true
    $zip = [System.IO.Compression.ZipArchive]::new(
        $archiveStream, [System.IO.Compression.ZipArchiveMode]::Create)

    $filesProcessed = 0

    foreach ($file in $allItems) {
        $relativePath = $file.FullName.Substring($sourceDir.Length).TrimStart('\')
        $entryPath = $relativePath.Replace('\', '/')

        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip,
            $file.FullName,
            $entryPath,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null

        $filesProcessed++

        if ($filesProcessed % 500 -eq 0) {
            Write-Host "  ... added $filesProcessed of $fileCount files" -ForegroundColor Gray
        }
    }

    $zip.Dispose()
    $zip = $null

    $archiveSize = (Get-Item -LiteralPath $outputZip).Length / 1MB

    Write-Host "`nArchive created successfully!" -ForegroundColor Green
    Write-Host "  File: $(Split-Path $outputZip -Leaf)" -ForegroundColor White
    Write-Host "  Size: $([math]::Round($archiveSize, 2)) MB" -ForegroundColor White
    Write-Host "  Files: $filesProcessed" -ForegroundColor White
    Write-Host "  Location: $outputZip" -ForegroundColor Gray
}
catch {
    if ($null -ne $zip) {
        $zip.Dispose()
    }

    if ($archiveStream) { $archiveStream.Dispose() }
    if ($createdArchive -and (Test-Path -LiteralPath $outputZip)) {
        Remove-Item -LiteralPath $outputZip -Force -ErrorAction SilentlyContinue
    }

    Write-Host "Error creating archive: $($_.Exception.Message)" -ForegroundColor Red
    throw
}
