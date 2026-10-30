#!/usr/bin/env bash
set -euo pipefail

# Installs this fork from GitHub (it is not published to npm) and builds it with
# Bun. HOPSQL_SOURCE_DIR installs from a local checkout instead of downloading.
HOPSQL_REPO="${HOPSQL_REPO:-kylepantall/hopsql}"

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

# Runs a noisy command quietly, showing its output only if it fails.
quiet() {
  local log="$HOPSQL_INSTALL_TEMP/step.log"
  if ! "$@" >"$log" 2>&1; then
    sed 's/^/    | /' "$log" >&2
    return 1
  fi
}

main() {
  local ref='main' register_claude=false force=false
  while (($#)); do
    case "$1" in
      --help | -h)
        printf 'Usage: bash install.sh [--claude [--force]] [REF]\n'
        printf 'Builds %s (branch, tag or commit; default main) under ~/.local/share/hopsql\n' "$HOPSQL_REPO"
        printf 'with a launcher in ~/.local/bin. --claude also registers it with Claude Code (user scope).\n'
        printf 'An existing "hopsql" or legacy "omnisql" entry is kept and the installer stops; --force\n'
        printf 'replaces it, dropping its env (allowlist, config file).\n'
        printf 'Override with HOPSQL_INSTALL_DIR, HOPSQL_BIN_DIR, HOPSQL_REPO and HOPSQL_SOURCE_DIR.\n'
        return
        ;;
      --claude) register_claude=true ;;
      --force) force=true ;;
      -*) printf 'Unknown option: %s\n' "$1" >&2; return 1 ;;
      *) ref="$1" ;;
    esac
    shift
  done
  if [[ ! "$ref" =~ ^[A-Za-z0-9._/-]+$ || "$ref" == *..* || "$ref" == /* || "$ref" == */ ]]; then
    printf 'Invalid ref: %s\n' "$ref" >&2
    return 1
  fi
  [[ -n "${HOME:-}" ]] || { printf 'HOME must be set.\n' >&2; return 1; }
  local source_label="$HOPSQL_REPO@$ref"
  [[ -z "${HOPSQL_SOURCE_DIR:-}" ]] || source_label="$HOPSQL_SOURCE_DIR"
  printf 'Hopsql installer — %s\n' "$source_label"

  HOPSQL_INSTALL_TEMP="$(mktemp -d)"
  local temp_dir="$HOPSQL_INSTALL_TEMP"
  trap 'rm -rf -- "$HOPSQL_INSTALL_TEMP"' EXIT

  # Check before building: replacing an entry drops its env, which can hold the
  # connection allowlist, so only do it when asked.
  local existing_entries=()
  if [[ "$register_claude" == true ]]; then
    step 'Checking Claude Code registration'
    command -v claude >/dev/null 2>&1 || { printf 'claude CLI not found; install without --claude, or install Claude Code first.\n' >&2; return 1; }
    for name in hopsql omnisql; do
      if claude mcp get "$name" >"$temp_dir/entry-$name" 2>&1; then
        existing_entries+=("$name")
        if [[ "$name" == omnisql ]]; then
          info 'Found "omnisql": an entry from before the rename to Hopsql.'
        else
          info 'Found an existing "hopsql" entry.'
        fi
        grep -E '^ *(Scope|Command|Args|Environment|[A-Z][A-Z0-9_]+=)' "$temp_dir/entry-$name" | sed 's/=.*/=…/; s/^ */      /' || true
      fi
    done
    if ((${#existing_entries[@]})); then
      if [[ "$force" != true ]]; then
        printf '\nStopped without changing anything. --force replaces %s with a fresh "hopsql" entry;\n' "${existing_entries[*]}" >&2
        printf 'any environment shown above (connection allowlist, config file) is not carried over.\n' >&2
        printf 'If that is fine, rerun with:\n  curl -fsSL https://raw.githubusercontent.com/%s/main/scripts/install.sh | bash -s -- --claude --force\n' "$HOPSQL_REPO" >&2
        return 1
      fi
      info "--force: will replace ${existing_entries[*]} after a successful build."
    else
      info 'No existing entry.'
    fi
  fi
  local install_dir="${HOPSQL_INSTALL_DIR:-$HOME/.local/share/hopsql}"
  local bin_dir="${HOPSQL_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$install_dir" "$bin_dir"
  install_dir="$(cd "$install_dir" && pwd)"
  bin_dir="$(cd "$bin_dir" && pwd)"

  step 'Bun runtime'
  local bun_bin
  if command -v bun >/dev/null 2>&1 &&
    bun -e 'process.exit(Bun.semver.satisfies(Bun.version, ">=1.4.3") ? 0 : 1)' >/dev/null 2>&1; then
    bun_bin="$(command -v bun)"
    info "Using $bun_bin ($("$bun_bin" --version))"
  elif [[ -x "$install_dir/runtime/bun-1.4.3/bun" ]]; then
    bun_bin="$install_dir/runtime/bun-1.4.3/bun"
    info "Using private Bun 1.4.3 from a previous install"
  else
    command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; return 1; }
    command -v unzip >/dev/null 2>&1 || { printf 'unzip is required.\n' >&2; return 1; }
    local platform arch
    case "$(uname -s)" in
      Darwin) platform=darwin ;;
      Linux) platform=linux ;;
      *) printf 'Install Bun 1.4.3+, then rerun this installer.\n' >&2; return 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) arch=aarch64 ;;
      x86_64|amd64) arch=x64-baseline ;;
      *) printf 'Unsupported architecture. Install Bun 1.4.3+ first.\n' >&2; return 1 ;;
    esac
    if [[ "$platform" == linux ]] && ldd --version 2>&1 | grep -qi musl; then
      arch="${arch/x64-baseline/x64-musl-baseline}"
      [[ "$arch" != aarch64 ]] || arch=aarch64-musl
    fi
    local archive expected actual runtime_dir
    archive="bun-$platform-$arch.zip"
    info "Downloading a private Bun 1.4.3 ($archive) and verifying its checksum"
    curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 1 https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/SHASUMS256.txt -o "$temp_dir/SHASUMS256.txt"
    expected="$(awk -v file="$archive" '$2 == file || $2 == ("*" file) {print $1; exit}' "$temp_dir/SHASUMS256.txt")"
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { printf 'Bun archive checksum not found.\n' >&2; return 1; }
    curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 1 "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/$archive" -o "$temp_dir/$archive"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$temp_dir/$archive" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$temp_dir/$archive" | awk '{print $1}')"
    else
      printf 'sha256sum or shasum is required to verify Bun.\n' >&2
      return 1
    fi
    [[ "$actual" == "$expected" ]] || { printf 'Bun checksum mismatch.\n' >&2; return 1; }
    unzip -q "$temp_dir/$archive" -d "$temp_dir"
    runtime_dir="$install_dir/runtime/bun-1.4.3"
    mkdir -p "$runtime_dir"
    cp "$temp_dir/${archive%.zip}/bun" "$runtime_dir/.bun-new"
    chmod +x "$runtime_dir/.bun-new"
    mv -f "$runtime_dir/.bun-new" "$runtime_dir/bun"
    bun_bin="$runtime_dir/bun"
    info "Installed to $bun_bin"
  fi

  # Build into a fresh directory and swap it in, so a failed build leaves the
  # working install untouched.
  local staging="$install_dir/app.new"
  rm -rf -- "$staging"
  mkdir -p "$staging"
  step 'Fetching source'
  if [[ -n "${HOPSQL_SOURCE_DIR:-}" ]]; then
    info "Copying $HOPSQL_SOURCE_DIR"
    (cd "$HOPSQL_SOURCE_DIR" && git ls-files -z --cached --others --exclude-standard |
      xargs -0 tar -cf - --) | tar -xf - -C "$staging"
  else
    command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; return 1; }
    info "Downloading github.com/$HOPSQL_REPO ($ref)"
    curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 1 \
      "https://codeload.github.com/$HOPSQL_REPO/tar.gz/$ref" -o "$temp_dir/source.tar.gz"
    tar -xzf "$temp_dir/source.tar.gz" -C "$staging" --strip-components 1
  fi

  step 'Installing dependencies'
  # --ignore-scripts skips the husky git hook, which needs a git checkout.
  (cd "$staging" && quiet "$bun_bin" install --frozen-lockfile --ignore-scripts)
  info 'Done'

  step 'Building'
  (cd "$staging" && PATH="$(dirname "$bun_bin"):$PATH" quiet "$bun_bin" scripts/build.mjs)
  rm -rf -- "$install_dir/app.old"
  [[ ! -d "$install_dir/app" ]] || mv "$install_dir/app" "$install_dir/app.old"
  mv "$staging" "$install_dir/app"
  rm -rf -- "$install_dir/app.old"
  info "Built into $install_dir/app"

  step 'Installing launcher'
  local launcher
  launcher="$(mktemp "$bin_dir/.hopsql.XXXXXX")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'export HOPSQL_LAUNCHER=%q\n' "$bin_dir/hopsql"
    printf 'exec %q %q "$@"\n' "$bun_bin" "$install_dir/app/dist/index.js"
  } > "$launcher"
  chmod +x "$launcher"
  mv -f "$launcher" "$bin_dir/hopsql"
  info "$bin_dir/hopsql (version $("$bin_dir/hopsql" --version 2>&1))"

  if [[ "$register_claude" == true ]]; then
    step 'Registering with Claude Code'
    # ${a[@]+...} keeps bash 3.2 (macOS) happy with an empty array under set -u.
    for name in ${existing_entries[@]+"${existing_entries[@]}"}; do
      if claude mcp remove "$name" >/dev/null 2>&1; then
        info "Removed \"$name\""
      else
        info "Could not remove \"$name\"; remove it with: claude mcp remove $name --scope <scope>"
      fi
    done
    if ! quiet claude mcp add --transport stdio --scope user hopsql -- "$bin_dir/hopsql"; then
      printf 'Claude registration failed. Re-add it with:\n  claude mcp add --transport stdio --scope user hopsql -- %q\n' "$bin_dir/hopsql" >&2
      return 1
    fi
    info 'Added "hopsql" (user scope). Start a new Claude session to load it.'
  fi

  printf '\n✓ Hopsql installed: %s/hopsql\n' "$bin_dir"
  [[ "$register_claude" == true ]] || printf '  Register it with: %s/hopsql install claude\n' "$bin_dir"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf '  For terminal use, add this to your shell profile:\n    export PATH="%s:$PATH"\n' "$bin_dir" ;;
  esac
}
main "$@"
