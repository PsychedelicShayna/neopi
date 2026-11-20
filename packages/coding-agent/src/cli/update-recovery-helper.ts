// Embedded verbatim in the compiled updater; only Windows PowerShell and .NET
// built-ins are needed to recover when the executable itself cannot be launched.
export const WINDOWS_RECOVERY_HELPER = String.raw`$ErrorActionPreference = 'Stop'
$target = $PSCommandPath.Substring(0, $PSCommandPath.Length - '.recover.ps1'.Length)
$parent = Split-Path -LiteralPath $target
$prefix = [IO.Path]::GetFileName($target) + '.update-transaction-'
$lock = $target + '.update-lock'
$marker = $null
function Regular([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return $false }
  $item = Get-Item -LiteralPath $p -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unsafe recovery file: $p" }
  return $true
}
function Verified([string]$p, [string]$hash) {
  return ((Regular $p) -and ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $hash))
}
function Save($dir, $journal) {
  $tmp = Join-Path $dir 'manifest.tmp'
  $bytes = [Text.Encoding]::UTF8.GetBytes(($journal | ConvertTo-Json -Compress))
  $stream = [IO.File]::Open($tmp, 'Create', 'Write', 'None')
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Replace($tmp, (Join-Path $dir 'manifest.json'), [System.Management.Automation.Language.NullString]::Value)
}
function Retire([string]$p, [string]$dir) {
  [IO.File]::Move($p, (Join-Path $dir ('discard-' + [Guid]::NewGuid().ToString())))
}
try {
  if (Test-Path -LiteralPath $lock) {
    $lockItem = Get-Item -LiteralPath $lock -Force
    if (-not $lockItem.PSIsContainer -or ($lockItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe updater lock' }
    $owners = @(Get-ChildItem -LiteralPath $lock -Force)
    if ($owners.Count -ne 1 -or $owners[0].Name -notmatch '^(\d+)-[a-f0-9-]+\.owner$') { throw 'Incomplete updater lock; confirm no updater is running before manually removing it' }
    $ownerPid = [int]$Matches[1]
    if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) { throw "Updater PID $ownerPid is still running" }
    [IO.File]::Delete($owners[0].FullName)
    [IO.Directory]::Delete($lock)
  }
  # Directory.CreateDirectory is not exclusive. New-Item without -Force is.
  $null = New-Item -ItemType Directory -Path $lock
  $marker = Join-Path $lock ($PID.ToString() + '-' + [Guid]::NewGuid().ToString() + '.owner')
  [IO.File]::WriteAllText($marker, '{}')
  foreach ($dir in @(Get-ChildItem -LiteralPath $parent -Directory -Force | Where-Object { $_.Name.StartsWith($prefix, [StringComparison]::Ordinal) })) {
    if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unsafe recovery directory: $dir" }
    $manifest = Join-Path $dir.FullName 'manifest.json'
    if (-not (Regular $manifest)) {
      $initial = @(Get-ChildItem -LiteralPath $dir.FullName -Force)
      if (@($initial | Where-Object { $_.Name -ne 'manifest.tmp' }).Count -ne 0) { throw "Missing recovery journal: $manifest" }
      foreach ($file in $initial) { Remove-Item -LiteralPath $file.FullName -Force }
      [IO.Directory]::Delete($dir.FullName)
      Write-Output "Recovered Windows update journal (initializing): $($dir.FullName)"
      continue
    }
    $j = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($j.version -ne 1 -or $j.target -cne $target -or $j.platform -cne 'win32' -or $j.phase -notin @('staging', 'replace', 'promote', 'committed', 'rolled-back') -or $j.hadPrevious -isnot [bool] -or $null -eq $j.windows -or $j.windows.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $j.windows.originalSha256 -cnotmatch '^[a-f0-9]{64}$' -or ($j.hadPrevious -and $j.windows.previousSha256 -cnotmatch '^[a-f0-9]{64}$')) { throw "Invalid recovery journal: $manifest" }
    $old = $target + '.old'
    $new = $target + '.new'
    $previous = $target + '.previous'
    $saved = Join-Path $dir.FullName 'previous'
    $phase = $j.phase
    if ($phase -in @('replace', 'promote')) {
      # Restore the old generation conservatively; never execute journal data.
      if (Verified $old $j.windows.originalSha256) {
        if (Regular $target) {
          if (-not (Verified $target $j.windows.sha256) -and -not (Verified $target $j.windows.originalSha256)) { throw 'Current executable changed; retaining recovery images' }
          Retire $target $dir.FullName
        }
        [IO.File]::Move($old, $target)
        Write-Output "Restored interrupted Windows executable replacement: $target"
      } elseif ((Regular $old) -or -not (Verified $target $j.windows.originalSha256)) {
        throw "No verified original image. Retain $old and $new for manual recovery."
      }
      if (Regular $saved) {
        if (-not $j.hadPrevious -or -not (Verified $saved $j.windows.previousSha256)) { throw 'Saved previous image failed verification' }
        if (Regular $previous) { Retire $previous $dir.FullName }
        $restore = Join-Path $dir.FullName ('restore-' + [Guid]::NewGuid().ToString())
        [IO.File]::Copy($saved, $restore, $false)
        [IO.File]::Move($restore, $previous)
      } elseif (-not $j.hadPrevious -and (Regular $previous)) {
        if (-not (Verified $previous $j.windows.originalSha256)) { throw 'Previous image changed; retaining it' }
        Retire $previous $dir.FullName
      }
      if (Regular $new) {
        if (-not (Verified $new $j.windows.sha256)) { throw 'Staged image changed; retain it' }
        [IO.File]::Move($new, (Join-Path $dir.FullName 'staged-leftover'))
      }
      $j.phase = 'rolled-back'
      Save $dir.FullName $j
    }
    try {
      if ($j.phase -eq 'committed' -and -not $j.windows.detached) {
        $retired = Join-Path $dir.FullName 'original'
        if (-not (Regular $retired) -and (Regular $old)) {
          if (-not (Verified $old $j.windows.originalSha256)) { throw 'Old image changed; retain it' }
          [IO.File]::Move($old, $retired)
        }
        $j.windows | Add-Member -NotePropertyName detached -NotePropertyValue $true -Force
        Save $dir.FullName $j
      }
      foreach ($file in @(Get-ChildItem -LiteralPath $dir.FullName -Force | Where-Object { $_.Name -ne 'manifest.json' })) { Remove-Item -LiteralPath $file.FullName -Recurse -Force }
      [IO.File]::Delete($manifest)
      [IO.Directory]::Delete($dir.FullName)
      Write-Output "Recovered Windows update journal ($phase): $($dir.FullName)"
    } catch { Write-Output "Recovery completed; cleanup retained for a later launch: $($dir.FullName): $_" }
  }
} finally {
  if ($null -ne $marker) {
    [IO.File]::Delete($marker)
    [IO.Directory]::Delete($lock)
  }
}
`;
