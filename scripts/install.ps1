# Installs this fork from GitHub (it is not published to npm) and builds it with
# Bun, on Windows. HOPSQL_SOURCE_DIR installs from a local checkout instead.
#
#   irm https://raw.githubusercontent.com/kylepantall/hopsql/main/scripts/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/hopsql/main/scripts/install.ps1))) -Claude
[CmdletBinding()]
param(
  [string]$Ref = 'main',
  [switch]$Claude,
  [switch]$Force,
  [switch]$Help
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# claude writes "not found" to stderr, which Windows PowerShell 5.1 turns into a
# terminating error under 'Stop'; only the exit status matters here.
function Get-ClaudeEntry([string]$Name) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & claude mcp get $Name 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -eq 0) { return , @($output) }
    return $null
  } finally { $ErrorActionPreference = $previous }
}

function Write-Step([string]$Text) { Write-Host "`n==> $Text" }
function Write-Info([string]$Text) { Write-Host "    $Text" }

# Runs a noisy native command quietly, showing its output only if it fails.
function Invoke-Quiet([string]$What, [scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Command 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) {
    $output | ForEach-Object { Write-Host "    | $_" }
    throw "$What failed."
  }
}

function Install-Hopsql {
  $repo = if ($env:HOPSQL_REPO) { $env:HOPSQL_REPO } else { 'kylepantall/hopsql' }
  if ($Help) {
    Write-Host "Usage: install.ps1 [-Ref <branch|tag|commit>] [-Claude [-Force]]"
    Write-Host "Builds $repo (default main) under %LOCALAPPDATA%\hopsql with a launcher in its bin folder."
    Write-Host "-Claude also registers it with Claude Code (user scope). An existing 'hopsql' or legacy 'omnisql' entry"
    Write-Host "is kept and the installer stops; -Force replaces it, dropping its env (allowlist, config file)."
    Write-Host "Override with HOPSQL_INSTALL_DIR, HOPSQL_BIN_DIR, HOPSQL_REPO and HOPSQL_SOURCE_DIR."
    return
  }
  if ($Ref -notmatch '^[A-Za-z0-9._/-]+$' -or $Ref.Contains('..') -or $Ref.StartsWith('/') -or $Ref.EndsWith('/')) {
    throw "Invalid ref: $Ref"
  }

  $sourceLabel = if ($env:HOPSQL_SOURCE_DIR) { $env:HOPSQL_SOURCE_DIR } else { "$repo@$Ref" }
  Write-Host "Hopsql installer - $sourceLabel"

  # Check before building: replacing an entry drops its env, which can hold the
  # connection allowlist, so only do it when asked.
  $existingEntries = @()
  if ($Claude) {
    Write-Step 'Checking Claude Code registration'
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'claude CLI not found; install without -Claude, or install Claude Code first.' }
    foreach ($name in @('hopsql', 'omnisql')) {
      $entry = Get-ClaudeEntry $name
      if ($null -eq $entry) { continue }
      $existingEntries += $name
      if ($name -eq 'omnisql') { Write-Info 'Found "omnisql": an entry from before the rename to Hopsql.' }
      else { Write-Info 'Found an existing "hopsql" entry.' }
      # Show what would be lost, with environment values masked.
      $entry | Where-Object { $_ -match '^\s*(Scope|Command|Args|Environment|[A-Z][A-Z0-9_]+=)' } |
        ForEach-Object { Write-Host ('      ' + ($_.Trim() -replace '=.*', '=...')) }
    }
    if ($existingEntries.Count -gt 0) {
      if (-not $Force) {
        Write-Host "`nStopped without changing anything. -Force replaces $($existingEntries -join ', ') with a fresh 'hopsql' entry;"
        Write-Host 'any environment shown above (connection allowlist, config file) is not carried over.'
        Write-Host 'If that is fine, rerun with:'
        Write-Host "  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/$repo/main/scripts/install.ps1))) -Claude -Force"
        throw 'Existing Claude Code entry left unchanged.'
      }
      Write-Info "-Force: will replace $($existingEntries -join ', ') after a successful build."
    } else {
      Write-Info 'No existing entry.'
    }
  }

  $installDir = if ($env:HOPSQL_INSTALL_DIR) { $env:HOPSQL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'hopsql' }
  $binDir = if ($env:HOPSQL_BIN_DIR) { $env:HOPSQL_BIN_DIR } else { Join-Path $installDir 'bin' }
  New-Item -ItemType Directory -Force -Path $installDir, $binDir | Out-Null
  $installDir = (Resolve-Path -LiteralPath $installDir).Path.TrimEnd('\')
  $binDir = (Resolve-Path -LiteralPath $binDir).Path.TrimEnd('\')
  $temp = Join-Path ([IO.Path]::GetTempPath()) ("hopsql-install-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $temp | Out-Null

  try {
    Write-Step 'Bun runtime'
    $bun = $null
    $privateBun = Join-Path $installDir 'runtime\bun-1.4.3\bun.exe'
    $existing = Get-Command bun -ErrorAction SilentlyContinue
    if ($existing) {
      & $existing.Source -e 'process.exit(Bun.semver.satisfies(Bun.version, ">=1.4.3") ? 0 : 1)' 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $bun = $existing.Source; Write-Info "Using $bun" }
    }
    if (-not $bun -and (Test-Path $privateBun)) {
      $bun = $privateBun
      Write-Info 'Using private Bun 1.4.3 from a previous install'
    }
    if (-not $bun) {
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x64-baseline' }
      $archive = "bun-windows-$arch.zip"
      $base = 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.3'
      Write-Info "Downloading a private Bun 1.4.3 ($archive) and verifying its checksum"
      Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile (Join-Path $temp 'SHASUMS256.txt') -UseBasicParsing
      $line = Get-Content (Join-Path $temp 'SHASUMS256.txt') | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1
      if (-not $line) { throw 'Bun archive checksum not found.' }
      $expected = ($line -split '\s+')[0].ToLower()
      $zip = Join-Path $temp $archive
      Invoke-WebRequest "$base/$archive" -OutFile $zip -UseBasicParsing
      if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Bun checksum mismatch.' }
      Expand-Archive $zip -DestinationPath $temp -Force
      $runtimeDir = Join-Path $installDir 'runtime\bun-1.4.3'
      New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
      Copy-Item (Join-Path $temp "$($archive -replace '\.zip$','')\bun.exe") (Join-Path $runtimeDir 'bun.exe') -Force
      $bun = Join-Path $runtimeDir 'bun.exe'
      Write-Info "Installed to $bun"
    }

    # Build into a fresh directory and swap it in, so a failed build leaves the
    # working install untouched.
    $staging = Join-Path $installDir 'app.new'
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    Write-Step 'Fetching source'
    if ($env:HOPSQL_SOURCE_DIR) {
      Write-Info "Copying $env:HOPSQL_SOURCE_DIR"
      New-Item -ItemType Directory -Path $staging | Out-Null
      Push-Location $env:HOPSQL_SOURCE_DIR
      try {
        foreach ($file in (git ls-files --cached --others --exclude-standard)) {
          $target = Join-Path $staging $file
          New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
          Copy-Item $file $target
        }
      } finally { Pop-Location }
    } else {
      Write-Info "Downloading github.com/$repo ($Ref)"
      $sourceZip = Join-Path $temp 'source.zip'
      Invoke-WebRequest "https://codeload.github.com/$repo/zip/$Ref" -OutFile $sourceZip -UseBasicParsing
      $extract = Join-Path $temp 'source'
      Expand-Archive $sourceZip -DestinationPath $extract -Force
      Move-Item (Get-ChildItem $extract -Directory | Select-Object -First 1).FullName $staging
    }

    Push-Location $staging
    try {
      Write-Step 'Installing dependencies'
      # --ignore-scripts skips the husky git hook, which needs a git checkout.
      Invoke-Quiet 'bun install' { & $bun install --frozen-lockfile --ignore-scripts }
      Write-Info 'Done'
      Write-Step 'Building'
      $env:PATH = (Split-Path $bun) + ';' + $env:PATH
      Invoke-Quiet 'Build' { & $bun scripts/build.mjs }
    } finally { Pop-Location }

    $app = Join-Path $installDir 'app'
    if (Test-Path $app) { Remove-Item $app -Recurse -Force }
    Move-Item $staging $app
    Write-Info "Built into $app"

    Write-Step 'Installing launcher'

    # cmd.exe reads a .cmd file in the OEM code page, so an ASCII file cannot hold
    # a non-ASCII %LOCALAPPDATA%. In the default layout (bin inside the install
    # dir) paths are written relative to the launcher via %~dp0; a moved bin dir
    # or an external Bun falls back to absolute paths in the OEM code page.
    $launcher = Join-Path $binDir 'hopsql.cmd'
    $relative = $binDir -ieq (Join-Path $installDir 'bin')
    $toLauncherPath = {
      param([string]$Path)
      if ($relative -and $Path.StartsWith($installDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
        return '%~dp0..' + $Path.Substring($installDir.Length)
      }
      return $Path
    }
    $lines = @(
      '@echo off',
      'set "HOPSQL_LAUNCHER=%~f0"',
      "`"$(& $toLauncherPath $bun)`" `"$(& $toLauncherPath (Join-Path $app 'dist\index.js'))`" %*"
    )
    $oem = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    [IO.File]::WriteAllLines($launcher, [string[]]$lines, $oem)
    $version = (& $launcher --version 2>&1 | ForEach-Object { "$_" }) -join ' '
    Write-Info "$launcher (version $version)"

    if ($Claude) {
      Write-Step 'Registering with Claude Code'
      # Windows PowerShell 5.1 turns claude's stderr into an error; the add below reports failures.
      foreach ($name in $existingEntries) {
        $removed = $false
        try { & claude mcp remove $name 2>$null | Out-Null; $removed = $LASTEXITCODE -eq 0 } catch { }
        if ($removed) { Write-Info "Removed `"$name`"" }
        else { Write-Info "Could not remove `"$name`"; remove it with: claude mcp remove $name --scope <scope>" }
      }
      try {
        & claude mcp add --transport stdio --scope user hopsql -- cmd /c $launcher 2>&1 | Out-Null
        $added = $LASTEXITCODE -eq 0
      } catch { $added = $false }
      if (-not $added) {
        Write-Host "Re-add it with:`n  claude mcp add --transport stdio --scope user hopsql -- cmd /c `"$launcher`""
        throw 'Claude registration failed.'
      }
      Write-Info 'Added "hopsql" (user scope). Start a new Claude session to load it.'
    }

    Write-Host "`nHopsql installed: $launcher"
    if (-not $Claude) { Write-Host "  Register it with: `"$launcher`" install claude" }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $binDir) {
      Write-Host "  For terminal use, add $binDir to your user PATH."
    }
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-Hopsql
