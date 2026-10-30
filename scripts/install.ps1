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
function Test-ClaudeEntry([string]$Name) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & claude mcp get $Name *> $null
    return $LASTEXITCODE -eq 0
  } finally { $ErrorActionPreference = $previous }
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

  # Check before building: replacing an entry drops its env, which can hold the
  # connection allowlist, so only do it when asked.
  $existingEntries = @()
  if ($Claude) {
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'claude CLI not found; skipping registration.' }
    $existingEntries = @(@('hopsql', 'omnisql') | Where-Object { Test-ClaudeEntry $_ })
    if ($existingEntries.Count -gt 0 -and -not $Force) {
      Write-Host "Claude Code already has an MCP entry named: $($existingEntries -join ', ')"
      Write-Host "Left unchanged. To replace it (its env is not kept), rerun with -Claude -Force,"
      Write-Host "or edit it with 'claude mcp remove' and 'claude mcp add'."
      throw 'Existing Claude Code entry left unchanged.'
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
    $bun = $null
    $existing = Get-Command bun -ErrorAction SilentlyContinue
    if ($existing) {
      & $existing.Source -e 'process.exit(Bun.semver.satisfies(Bun.version, ">=1.4.3") ? 0 : 1)' 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $bun = $existing.Source }
    }
    if (-not $bun) {
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x64-baseline' }
      $archive = "bun-windows-$arch.zip"
      $base = 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.3'
      Write-Host 'Installing a private Bun 1.4.3 runtime...'
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
    }

    # Build into a fresh directory and swap it in, so a failed build leaves the
    # working install untouched.
    $staging = Join-Path $installDir 'app.new'
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    if ($env:HOPSQL_SOURCE_DIR) {
      Write-Host "Copying $env:HOPSQL_SOURCE_DIR..."
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
      Write-Host "Downloading $repo@$Ref..."
      $sourceZip = Join-Path $temp 'source.zip'
      Invoke-WebRequest "https://codeload.github.com/$repo/zip/$Ref" -OutFile $sourceZip -UseBasicParsing
      $extract = Join-Path $temp 'source'
      Expand-Archive $sourceZip -DestinationPath $extract -Force
      Move-Item (Get-ChildItem $extract -Directory | Select-Object -First 1).FullName $staging
    }

    Write-Host 'Building...'
    Push-Location $staging
    try {
      # --ignore-scripts skips the husky git hook, which needs a git checkout.
      & $bun install --frozen-lockfile --ignore-scripts | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'bun install failed.' }
      $env:PATH = (Split-Path $bun) + ';' + $env:PATH
      & $bun scripts/build.mjs | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    } finally { Pop-Location }

    $app = Join-Path $installDir 'app'
    if (Test-Path $app) { Remove-Item $app -Recurse -Force }
    Move-Item $staging $app

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
    & $launcher --version

    if ($Claude) {
      # Windows PowerShell 5.1 turns claude's stderr into an error; the add below reports failures.
      foreach ($name in $existingEntries) { try { & claude mcp remove --scope user $name 2>$null | Out-Null } catch { } }
      try {
        & claude mcp add --transport stdio --scope user hopsql -- cmd /c $launcher
        $added = $LASTEXITCODE -eq 0
      } catch { $added = $false }
      if (-not $added) {
        Write-Host "Re-add it with:`n  claude mcp add --transport stdio --scope user hopsql -- cmd /c `"$launcher`""
        throw 'Claude registration failed.'
      }
      Write-Host 'Registered with Claude Code. Start a new session to load it.'
    }

    Write-Host "`nInstalled: $launcher"
    if (-not $Claude) { Write-Host "Register it with: `"$launcher`" install claude" }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $binDir) {
      Write-Host "For terminal use, add $binDir to your user PATH."
    }
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-Hopsql
