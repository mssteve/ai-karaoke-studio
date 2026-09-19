param(
  [string]$SeedProfile = 'scripts\qa-artifacts\queue-history-seed\profile',
  [string]$FixtureRoot = 'scripts\qa-artifacts\queue-history-seed\fixtures',
  [string]$Output = 'scripts\qa-artifacts\queue-history-focused-rerun',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$previousLocation = Get-Location

function Assert-Contains([string]$Path, [string]$Pattern) {
  if (-not (Select-String -Path $Path -SimpleMatch $Pattern)) {
    throw "Missing '$Pattern' in $Path"
  }
}

try {
  Set-Location $root
  $seedFull = if ([IO.Path]::IsPathRooted($SeedProfile)) {
    [IO.Path]::GetFullPath($SeedProfile)
  } else {
    [IO.Path]::GetFullPath((Join-Path $root $SeedProfile))
  }
  $fixtureFull = if ([IO.Path]::IsPathRooted($FixtureRoot)) {
    [IO.Path]::GetFullPath($FixtureRoot)
  } else {
    [IO.Path]::GetFullPath((Join-Path $root $FixtureRoot))
  }
  if (-not (Test-Path (Join-Path $seedFull 'library.json'))) {
    & node scripts\create-qa-fixtures.mjs $fixtureFull
    if ($LASTEXITCODE -ne 0) { throw "Fixture generation failed with exit code $LASTEXITCODE" }
    & node scripts\create-queue-history-seed.mjs $fixtureFull $seedFull
    if ($LASTEXITCODE -ne 0) { throw "Seed generation failed with exit code $LASTEXITCODE" }
  }
  $outputFull = if ([IO.Path]::IsPathRooted($Output)) {
    [IO.Path]::GetFullPath($Output)
  } else {
    [IO.Path]::GetFullPath((Join-Path $root $Output))
  }
  $canonicalFull = [IO.Path]::GetFullPath((Join-Path $root 'scripts\qa-artifacts\queue-history-focused-2026-09-18'))

  if ($outputFull -eq $seedFull) { throw 'Output must not be the seed profile.' }
  if ($outputFull -eq $canonicalFull) { throw 'Refusing to overwrite canonical approved evidence.' }
  if (-not (Test-Path (Join-Path $seedFull 'library.json'))) {
    throw "Seed profile has no library.json: $seedFull"
  }

  $songs = Get-Content (Join-Path $seedFull 'library.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($songs.Count -lt 2) { throw 'Seed profile must contain at least two songs.' }
  foreach ($song in $songs[0..1]) {
    if (-not (Test-Path $song.sourcePath)) {
      throw "Song source is unavailable: $($song.sourcePath)"
    }
  }

  $sourceBefore = @($songs[0..1] | ForEach-Object {
    $item = Get-Item $_.sourcePath
    [pscustomobject]@{
      Path = $item.FullName
      Length = $item.Length
      LastWriteTimeUtc = $item.LastWriteTimeUtc
      Sha256 = (Get-FileHash $item.FullName -Algorithm SHA256).Hash
    }
  })

  if (-not $SkipBuild) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  }

  Assert-Contains 'electron\main.ts' "if (playlist.kind === 'history') throw new Error('Songs cannot be added directly to History.')"
  Assert-Contains 'dist-electron\main.js' "throw new Error('Songs cannot be added directly to History.')"
  Assert-Contains 'electron\main.ts' "if (queue.kind !== 'queue') throw new Error('Only Queue entries can be archived.')"
  Assert-Contains 'dist-electron\main.js' "throw new Error('Only Queue entries can be archived.')"
  Assert-Contains 'electron\main.ts' "ipcMain.handle('playlists:archive-queue-entry'"
  Assert-Contains 'dist-electron\main.js' "ipcMain.handle('playlists:archive-queue-entry'"
  foreach ($path in @('electron\main.ts', 'dist-electron\main.js')) {
    if (@(Select-String -Path $path -SimpleMatch 'history.entries.unshift').Count -ne 1) {
      throw "Expected exactly one History prepend site in $path"
    }
  }

  & node scripts\qa-queue-history.mjs `
    node_modules\electron\dist\electron.exe `
    dist-electron\main.js `
    $seedFull `
    $outputFull
  if ($LASTEXITCODE -ne 0) { throw "Focused Queue/History harness failed with exit code $LASTEXITCODE" }

  $reportPath = Join-Path $outputFull 'report.json'
  $report = Get-Content $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $requiredCases = @(
    'history-migration',
    'playback-control-placement',
    'ordinary-target-insertion',
    'natural-end-atomic-history',
    'next-atomic-history',
    'queue-history-navigation',
    'history-persistence',
    'renderer-clean'
  )
  $actualCases = @($report.cases | ForEach-Object id)
  if ($report.verdict -ne 'APPROVE' -or $report.cases.Count -ne 8) {
    throw "Expected APPROVE with 8 cases in $reportPath"
  }
  foreach ($id in $requiredCases) {
    $case = @($report.cases | Where-Object id -eq $id)
    if ($case.Count -ne 1 -or $case[0].status -ne 'passed') {
      throw "Required case did not pass exactly once: $id"
    }
  }
  if (@($report.cases | Where-Object status -ne 'passed').Count) {
    throw 'Focused report contains a non-passing case.'
  }
  foreach ($name in @('plus-menu-rendered', 'history-navigation')) {
    $shot = @($report.screenshots | Where-Object name -eq $name)
    if ($shot.Count -ne 1 -or -not (Test-Path $shot[0].path) -or (Get-Item $shot[0].path).Length -le 0) {
      throw "Required screenshot is missing or empty: $name"
    }
  }

  foreach ($before in $sourceBefore) {
    $after = Get-Item $before.Path
    $afterHash = (Get-FileHash $before.Path -Algorithm SHA256).Hash
    if ($after.Length -ne $before.Length -or
        $after.LastWriteTimeUtc -ne $before.LastWriteTimeUtc -or
        $afterHash -ne $before.Sha256) {
      throw "Imported source changed during QA: $($before.Path)"
    }
  }

  Write-Output "APPROVE: Queue/History runbook passed 8/8."
  Write-Output "Report: $reportPath"
  Write-Output "Screenshots: $(Join-Path $outputFull 'plus-menu-rendered.png'), $(Join-Path $outputFull 'history-navigation.png')"
} finally {
  Set-Location $previousLocation
}
