#!/bin/bash
# Cloud environment setup script for Arbareto. The SessionStart hook in .claude/settings.json runs it through .claude/session-start.ts at each session start and resume.
# The hook keeps every session on the checked-out script. Each install step skips when its pinned version is present, so a repeated run is short.
# The environment's "Setup script" field can stay empty. To warm the environment cache, it can hold: ARBARETO_FORCE_CLOUD_SETUP=1 bash "${CLAUDE_PROJECT_DIR:-/home/user/arbareto}/.claude/cloud-setup.sh"
# The script exits at once unless CLAUDE_CODE_REMOTE is "true". Set ARBARETO_FORCE_CLOUD_SETUP=1 to run it by hand.
# Set ARBARETO_LOCAL_TOOLS=1 to install neither Bun nor Rust. The script then requires Bun 1.4.2 and cargo on PATH, and uses them.
# The repository steps run each time.
# Hook stdout enters the session context. So the full output goes to ${TMPDIR:-/tmp}/arbareto-cloud-setup.log, and only the script's own messages go to stdout.
# It installs Git 2.55 or newer from the git-core PPA and Bun 1.4.2, then runs "bun install --frozen-lockfile".
# It installs specify-cli 1.0.12 from PyPI with "uv tool install", or with "pip install --user" when uv is absent. A failed install does not stop the session.
# It installs CodeGraph 1.6.0 from the upstream GitHub release. It builds the index with "codegraph init -y", or runs "codegraph sync" when .codegraph/codegraph.db exists. A failed step does not stop the session.
# The CodeGraph bundle contains its own Node runtime. The script does not install Node.
# It runs "bun .claude/skills/ponytail-review/update.ts --check". Only a "behind" result prints a line to stdout.
# It writes .specify/feature.json, which Git ignores, when the file is absent. The Spec Kit scripts read the active feature from it.
# The cloud runs it as root. A normal user needs sudo for the system steps.
# Rust is opt-in, so the default setup stays short and the environment cache can keep it. The Rust steps run only with ARBARETO_CLOUD_RUST=1, or when /usr/local/bin/rustc exists.
# The Rust steps install Rust 1.98.0 (rustc, cargo, rust-std) from the static.rust-lang.org tarball, and the Tauri Linux build libraries from apt. They run "cargo fetch" for the Linux target. A failed install or fetch does not stop the session.
# The T289 and T291 sessions run "ARBARETO_CLOUD_RUST=1 ARBARETO_FORCE_CLOUD_SETUP=1 bash .claude/cloud-setup.sh" once at their start.
# The Rust toolchain is only for the Linux portability check "cargo check --target x86_64-unknown-linux-gnu". The app supports only Windows.
# When CLAUDE_ENV_FILE is set, it adds one PATH line that puts /usr/local/bin first for later Bash tool calls.
# Hosts on the default Trusted allowlist: archive.ubuntu.com, keyserver.ubuntu.com, ppa.launchpad.net, github.com, release-assets.githubusercontent.com, registry.npmjs.org, pypi.org, files.pythonhosted.org, static.rust-lang.org, index.crates.io, static.crates.io, api.github.com, raw.githubusercontent.com.
# The PPA source uses http://ppa.launchpad.net. add-apt-repository writes ppa.launchpadcontent.net, which is not on the allowlist. Apt verifies the PPA signature with the pinned key. The PPA suite is VERSION_CODENAME from /etc/os-release.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != true ] && [ "${ARBARETO_FORCE_CLOUD_SETUP:-}" != 1 ]; then
  exit 0
fi

# Launchpad signs the git-core PPA InRelease with this rsa4096 key. Ubuntu 26.04 apt rejects the older rsa1024 key.
GIT_PPA_KEY=F911AB184317630C59970973E363C90F8F1B6217
BUN_VERSION=1.4.2
BUN_ZIP_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
CODEGRAPH_VERSION=1.6.0
CODEGRAPH_TGZ_SHA256=de3391f79ed42622d937e6cd5b7642a7ea8bb7d1473607e80b879ba73ef216b0
RUST_VERSION=1.98.0
# The Rust release key 108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE signs the .asc file of this tarball.
RUST_TXZ_SHA256=ed8ee2df70909c88cbaf87a6cfa3920dac00b537de12a6abe6906641e0f5952f
APT_PACKAGES=(ca-certificates curl gnupg unzip)
# xz-utils unpacks only the Rust tarball.
RUST_APT_PACKAGES=(xz-utils build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev)
local_tools=0
if [ "${ARBARETO_LOCAL_TOOLS:-}" = 1 ]; then
  local_tools=1
fi
rust=0
if [ "${ARBARETO_CLOUD_RUST:-}" = 1 ] || [ -e /usr/local/bin/rustc ]; then
  rust=1
  APT_PACKAGES+=("${RUST_APT_PACKAGES[@]}")
fi
PATH_LINE='export PATH="/usr/local/bin:$PATH"'

log="${TMPDIR:-/tmp}/arbareto-cloud-setup.log"
exec 3>&1 4>&2 >>"$log" 2>&1
echo "Arbareto cloud setup started. Log: $log" >&3
work="$(mktemp -d)"
trap 'status=$?; rm -rf "$work"; [ "$status" -eq 0 ] || { echo "Arbareto cloud setup failed with exit status $status. Read $log." | tee /dev/fd/4 >&3; }' EXIT

bun_bin=/usr/local/bin/bun
cargo_bin=/usr/local/bin/cargo
if [ "$local_tools" = 1 ]; then
  found_bun="not on PATH"
  if command -v bun >/dev/null 2>&1; then
    found_bun="$(bun --version 2>/dev/null || true)"
  fi
  [ "$found_bun" = "$BUN_VERSION" ] || { echo "ARBARETO_LOCAL_TOOLS=1 requires Bun ${BUN_VERSION} on PATH. Found: ${found_bun}." >&3; exit 1; }
  command -v cargo >/dev/null 2>&1 || { echo "ARBARETO_LOCAL_TOOLS=1 requires cargo on PATH. Found: not on PATH." >&3; exit 1; }
  bun_bin="$(command -v bun)"
  cargo_bin="$(command -v cargo)"
fi

as_root=()
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || { echo "Run this script as root, or install sudo." >&3; exit 1; }
  as_root=(sudo)
fi
# sudo resets the environment.
apt_get=("${as_root[@]}" env DEBIAN_FRONTEND=noninteractive apt-get)
if ! dpkg -s "${APT_PACKAGES[@]}" >/dev/null 2>&1; then
  "${apt_get[@]}" update
  "${apt_get[@]}" install -y --no-install-recommends "${APT_PACKAGES[@]}"
fi

git_ok() { command -v git >/dev/null 2>&1 && dpkg --compare-versions "$(git --version | awk '{print $3}')" ge 2.55; }
if ! git_ok; then
  curl -fsSL -o "$work/git-core.asc" "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${GIT_PPA_KEY}"
  gpg --show-keys --with-colons "$work/git-core.asc" | grep -qx "fpr:::::::::${GIT_PPA_KEY}:"
  codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  [ -n "$codename" ] || { echo "VERSION_CODENAME is missing in /etc/os-release. The git-core PPA suite is unknown." >&3; exit 1; }
  "${as_root[@]}" install -D -m 0644 "$work/git-core.asc" /etc/apt/keyrings/git-core-ppa.asc
  echo "deb [signed-by=/etc/apt/keyrings/git-core-ppa.asc] http://ppa.launchpad.net/git-core/ppa/ubuntu ${codename} main" | "${as_root[@]}" tee /etc/apt/sources.list.d/git-core-ppa.list >/dev/null
  "${apt_get[@]}" update
  "${apt_get[@]}" install -y --no-install-recommends git
fi
git --version
git_ok || { echo "Git 2.55 or newer is required." >&3; exit 1; }

if [ "$local_tools" = 0 ]; then
  if [ "$(/usr/local/bin/bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
    curl -fsSL -o "$work/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
    echo "${BUN_ZIP_SHA256}  $work/bun.zip" | sha256sum -c -
    unzip -q -o "$work/bun.zip" -d "$work/bun"
    "${as_root[@]}" install -m 0755 "$work/bun/bun-linux-x64/bun" /usr/local/bin/bun
  fi
  [ "$(readlink /usr/local/bin/bunx 2>/dev/null || true)" = /usr/local/bin/bun ] || "${as_root[@]}" ln -sf /usr/local/bin/bun /usr/local/bin/bunx
  hash -r
  test "$(/usr/local/bin/bun --version)" = "$BUN_VERSION"
  # The image ships its own Bun in /root/.bun/bin, before /usr/local/bin on PATH. Point its bun and bunx at the pinned Bun.
  image_bun=/root/.bun/bin/bun
  if [ -e "$image_bun" ] && [ "$("$image_bun" --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
    echo "Warning: $image_bun is not Bun ${BUN_VERSION}. It and bunx now link to /usr/local/bin/bun." >&3
    ln -sf /usr/local/bin/bun "$image_bun"
    ln -sf /usr/local/bin/bun /root/.bun/bin/bunx
    hash -r
  fi
  # The image can link /usr/local/bin/bun to /root/.bun/bin/bun. Compare resolved paths on both sides.
  [ "$(readlink -f "$(command -v bun)")" = "$(readlink -f /usr/local/bin/bun)" ] || echo "Warning: 'bun' on PATH is $(command -v bun), not /usr/local/bin/bun." >&3
fi

# Bash ignores "set -e" on the left side of "||". Each step must chain with "&&".
# The bin/codegraph launcher resolves its symlink to find the bundle.
codegraph_dir="/opt/codegraph-${CODEGRAPH_VERSION}"
if [ "$(/usr/local/bin/codegraph --version 2>/dev/null || true)" != "$CODEGRAPH_VERSION" ]; then
  { curl -fsSL -o "$work/codegraph.tar.gz" "https://github.com/colbymchenry/codegraph/releases/download/v${CODEGRAPH_VERSION}/codegraph-linux-x64.tar.gz" \
    && echo "${CODEGRAPH_TGZ_SHA256}  $work/codegraph.tar.gz" | sha256sum -c - \
    && "${as_root[@]}" rm -rf "$codegraph_dir" && "${as_root[@]}" mkdir -p "$codegraph_dir" \
    && "${as_root[@]}" tar -xzf "$work/codegraph.tar.gz" -C "$codegraph_dir" --strip-components=1 \
    && "${as_root[@]}" ln -sf "$codegraph_dir/bin/codegraph" /usr/local/bin/codegraph \
    && test "$(/usr/local/bin/codegraph --version)" = "$CODEGRAPH_VERSION"; } || echo "CodeGraph ${CODEGRAPH_VERSION} install failed. The codegraph MCP server is not available." >&3
fi

rust_name="rust-${RUST_VERSION}-x86_64-unknown-linux-gnu"
if [ "$local_tools" = 0 ] && [ "$rust" = 1 ]; then
  case "$(/usr/local/bin/rustc --version 2>/dev/null || true)" in
    "rustc ${RUST_VERSION} "*) ;;
    *)
      { curl -fsSL -o "$work/rust.tar.xz" "https://static.rust-lang.org/dist/${rust_name}.tar.xz" \
        && echo "${RUST_TXZ_SHA256}  $work/rust.tar.xz" | sha256sum -c - \
        && tar -xJf "$work/rust.tar.xz" -C "$work" \
        && "${as_root[@]}" "$work/$rust_name/install.sh" --prefix=/usr/local --disable-ldconfig --components=rustc,cargo,rust-std-x86_64-unknown-linux-gnu; } || echo "Rust ${RUST_VERSION} install failed. The Linux portability check is not available." >&3
      ;;
  esac
fi
if [ "$local_tools" = 0 ] && [ "$rust" = 1 ] && [ -x /usr/local/bin/rustc ]; then
  rustc_version="$(/usr/local/bin/rustc --version)"
  echo "$rustc_version"
  case "$rustc_version" in
    "rustc ${RUST_VERSION} "*) ;;
    *) echo "Rust ${RUST_VERSION} is required in /usr/local/bin." >&3; exit 1 ;;
  esac
  # The image can ship rustup in ~/.cargo/bin. Its toolchain is not pinned.
  [ "$(command -v cargo)" = /usr/local/bin/cargo ] || echo "Warning: 'cargo' on PATH is $(command -v cargo), not /usr/local/bin/cargo." >&3
fi

# The hook sets CLAUDE_PROJECT_DIR. The docs do not state the working directory of the setup-script field.
# The docs report Bun proxy problems with package fetching. A failed install must not block the session.
if repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" && [ -n "$repo_root" ]; then
  (cd "$repo_root" && "$bun_bin" install --frozen-lockfile) || echo "bun install failed. Run 'bun install --frozen-lockfile' in the session." >&3
  # telemetry.getcodegraph.com is not on the allowlist.
  if [ -x /usr/local/bin/codegraph ]; then
    # Git tracks .codegraph/.gitignore, so the folder always exists. Only the database marks an index.
    if [ -e "$repo_root/.codegraph/codegraph.db" ]; then
      (cd "$repo_root" && CODEGRAPH_TELEMETRY=0 /usr/local/bin/codegraph sync) || echo "codegraph sync failed. Run 'codegraph sync' in the session." >&3
    else
      (cd "$repo_root" && CODEGRAPH_TELEMETRY=0 /usr/local/bin/codegraph init -y) || echo "codegraph init failed. Run 'codegraph init -y' in the session." >&3
    fi
  fi
  if [ "$rust" = 1 ] && [ -x "$cargo_bin" ]; then
    (cd "$repo_root" && "$cargo_bin" fetch --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu) || echo "cargo fetch failed. Run 'cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu' in the session." >&3
  fi
  # Exit 3 means the vendored skill is behind the latest upstream release. Other exit codes only reach the log.
  ponytail_status=0
  (cd "$repo_root" && "$bun_bin" .claude/skills/ponytail-review/update.ts --check) || ponytail_status=$?
  echo "ponytail-review check exit status: $ponytail_status"
  [ "$ponytail_status" -ne 3 ] || echo "ponytail-review copy is behind upstream: run \`bun .claude/skills/ponytail-review/update.ts\`, review the SKILL.md diff, and commit." >&3
  if [ ! -e "$repo_root/.specify/feature.json" ]; then
    printf '%s\n' '{"feature_directory": "specs/001-desktop-qualification"}' > "$repo_root/.specify/feature.json" || echo "Could not write .specify/feature.json." >&3
  fi
else
  echo "Repository root not found from $(pwd). Run 'bun install --frozen-lockfile' in the session." >&3
fi

if command -v uv >/dev/null 2>&1; then
  uv tool install specify-cli==1.0.12 || echo "uv tool install specify-cli==1.0.12 failed. Install it in the session." >&3
else
  python3 -m pip install --user specify-cli==1.0.12 || echo "pip install --user specify-cli==1.0.12 failed. Install it in the session." >&3
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  grep -qxF "$PATH_LINE" "$CLAUDE_ENV_FILE" 2>/dev/null || printf '%s\n' "$PATH_LINE" >> "$CLAUDE_ENV_FILE"
fi
echo "Arbareto cloud setup finished." >&3
