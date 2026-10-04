#!/bin/bash
# Cloud environment setup script for Arbareto. Paste it into the environment's "Setup script" field.
# It installs Git 2.55 or newer from the git-core PPA and Bun 1.4.2, then runs "bun install --frozen-lockfile".
# It installs specify-cli 1.0.12 from PyPI with "uv tool install", or with "pip install --user" when uv is absent. A failed install does not stop the session.
# It installs CodeGraph 1.6.0 from the upstream GitHub release and builds the index with "codegraph init -y". A failed step does not stop the session.
# The CodeGraph bundle contains its own Node runtime. The script does not install Node.
# It writes .specify/feature.json, which Git ignores, when the file is absent. The Spec Kit scripts read the active feature from it.
# It is not verified locally, because the development host is Windows.
# It does not install a Rust shell toolchain. The Tauri shell uses Win32 APIs and builds only on Windows.
# Hosts on the default Trusted allowlist: archive.ubuntu.com, keyserver.ubuntu.com, ppa.launchpad.net, github.com, release-assets.githubusercontent.com, registry.npmjs.org, pypi.org, files.pythonhosted.org.
# The PPA source uses http://ppa.launchpad.net. add-apt-repository writes ppa.launchpadcontent.net, which is not on the allowlist. Apt verifies the PPA signature with the pinned key.
set -euo pipefail

GIT_PPA_KEY=E1DD270288B4E6030699E45FA1715D88E1DF1F24
BUN_VERSION=1.4.2
BUN_ZIP_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
CODEGRAPH_VERSION=1.6.0
CODEGRAPH_TGZ_SHA256=de3391f79ed42622d937e6cd5b7642a7ea8bb7d1473607e80b879ba73ef216b0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip

curl -fsSL -o "$work/git-core.asc" "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${GIT_PPA_KEY}"
gpg --show-keys --with-colons "$work/git-core.asc" | grep -qx "fpr:::::::::${GIT_PPA_KEY}:"
install -D -m 0644 "$work/git-core.asc" /etc/apt/keyrings/git-core-ppa.asc
echo "deb [signed-by=/etc/apt/keyrings/git-core-ppa.asc] http://ppa.launchpad.net/git-core/ppa/ubuntu noble main" > /etc/apt/sources.list.d/git-core-ppa.list
apt-get update
apt-get install -y --no-install-recommends git

curl -fsSL -o "$work/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
echo "${BUN_ZIP_SHA256}  $work/bun.zip" | sha256sum -c -
unzip -q -o "$work/bun.zip" -d "$work/bun"
install -m 0755 "$work/bun/bun-linux-x64/bun" /usr/local/bin/bun
ln -sf /usr/local/bin/bun /usr/local/bin/bunx
hash -r

git --version
dpkg --compare-versions "$(git --version | awk '{print $3}')" ge 2.55 || { echo "Git 2.55 or newer is required." >&2; exit 1; }
test "$(/usr/local/bin/bun --version)" = "$BUN_VERSION"
# The image ships its own Bun. Its location is not documented.
[ "$(command -v bun)" = /usr/local/bin/bun ] || echo "Warning: 'bun' on PATH is $(command -v bun), not /usr/local/bin/bun." >&2

# Bash ignores "set -e" on the left side of "||". Each step must chain with "&&".
# The bin/codegraph launcher resolves its symlink to find the bundle.
codegraph_dir="/opt/codegraph-${CODEGRAPH_VERSION}"
{ curl -fsSL -o "$work/codegraph.tar.gz" "https://github.com/colbymchenry/codegraph/releases/download/v${CODEGRAPH_VERSION}/codegraph-linux-x64.tar.gz" \
  && echo "${CODEGRAPH_TGZ_SHA256}  $work/codegraph.tar.gz" | sha256sum -c - \
  && rm -rf "$codegraph_dir" && mkdir -p "$codegraph_dir" \
  && tar -xzf "$work/codegraph.tar.gz" -C "$codegraph_dir" --strip-components=1 \
  && ln -sf "$codegraph_dir/bin/codegraph" /usr/local/bin/codegraph \
  && test "$(/usr/local/bin/codegraph --version)" = "$CODEGRAPH_VERSION"; } || echo "CodeGraph ${CODEGRAPH_VERSION} install failed. The codegraph MCP server is not available." >&2

# The docs do not state the setup script's working directory.
# The docs report Bun proxy problems with package fetching. A failed install must not block the session.
if repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  (cd "$repo_root" && /usr/local/bin/bun install --frozen-lockfile) || echo "bun install failed. Run 'bun install --frozen-lockfile' in the session." >&2
  # telemetry.getcodegraph.com is not on the allowlist.
  if [ -x /usr/local/bin/codegraph ]; then
    (cd "$repo_root" && CODEGRAPH_TELEMETRY=0 /usr/local/bin/codegraph init -y) || echo "codegraph init failed. Run 'codegraph init -y' in the session." >&2
  fi
  if [ ! -e "$repo_root/.specify/feature.json" ]; then
    printf '%s\n' '{"feature_directory": "specs/001-desktop-qualification"}' > "$repo_root/.specify/feature.json" || echo "Could not write .specify/feature.json." >&2
  fi
else
  echo "Repository root not found from $(pwd). Run 'bun install --frozen-lockfile' in the session." >&2
fi

if command -v uv >/dev/null 2>&1; then
  uv tool install specify-cli==1.0.12 || echo "uv tool install specify-cli==1.0.12 failed. Install it in the session." >&2
else
  python3 -m pip install --user specify-cli==1.0.12 || echo "pip install --user specify-cli==1.0.12 failed. Install it in the session." >&2
fi
