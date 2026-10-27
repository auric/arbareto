<p align="center"><img src="docs/assets/app-icon.png" alt="Arbareto app icon" width="128"></p>

# Arbareto

Fast, free and open-source Git GUI client.

Arbareto is a desktop Git client inspired by Git Extensions. It covers the full commit graph, hunk and line staging, branches, merge, rebase, worktrees, submodules, and WSL repositories. It runs on Tauri 2 and Rust, not Electron, and needs no account or cloud service.

## Screenshots

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/history-dark.png">
  <img src="docs/assets/screenshots/history-light.png" alt="Arbareto Git GUI history view: the commit graph with branch lanes, branch and tag labels, the references sidebar with branches, remotes, tags, and worktrees, and the details of the selected commit">
</picture>

<img src="docs/assets/screenshots/changes-light.png" alt="Arbareto Git client commit view: changed files in a folder tree, a diff with Stage hunk buttons, the staged files, and the commit message box with a 72-column guide, Amend last commit, and Commit and push">

## Status

- Arbareto is pre-release software. Expect missing features and changes.
- Arbareto is cross-platform by design. The frontend, the Git service, and the operation contracts are shared code. A thin Tauri shell layer holds the platform parts.
- Windows 11 x64 is the first platform that the project qualifies.
- Linux comes next. macOS comes later, because no Mac test hardware is available yet.
- WSL repositories work from the Windows app.
- No installer release exists yet. Build the app from source.

## Features

These features work on the `main` branch today.

- Git GUI history of the whole repository, with a commit graph in branch lanes and the details of the selected commit.
- Changed files of a commit in the history view, blame, file delete, and an ignore editor.
- Commit message search, with steps through the matches in the full graph.
- Working changes and a diff view. Stage and unstage files, folders, hunks, or selected lines.
- Commit, amend the last commit, and commit and push in one step.
- Fetch, pull, and push with the upstream branch. You choose the default pull mode. Ahead and behind counts show on each branch.
- Recovery from a rejected push, with force push with lease after a confirmation.
- Clone a repository.
- Branches: switch, create, rename, delete, merge, and rebase. Resolve a conflicted file, or open it in your merge tool.
- A sidebar with branches, remote-tracking branches, tags, worktrees, and submodules. Add and remove worktrees. Update submodules.
- Git settings by scope: system, global, and local.
- Repositories inside WSL 2 distros, through the Git of the distro.
- A repository trust prompt before Arbareto runs programs that the repository configures.
- Keyboard shortcuts and keyboard focus for the main actions.
- System, light, and dark themes, with three dark palettes. The interface supports Windows contrast themes.

### Planned

- Spell check of the commit message.
- Linux build and qualification, then macOS.

## Requirements

- Windows 11 x64. Windows 10 x64 also runs, with the label "Unqualified platform".
- Git for Windows 2.55.0.windows.3 or later.
- For WSL repositories: WSL 2 and Git 2.55.0 or later inside the distro. Arbareto refuses WSL 1 distros.
- The Microsoft Edge WebView2 Runtime. The installer does not install it.
- These requirements are for Windows. The Linux and macOS requirements come with their builds.

## Build from source

Install Bun 1.4.4, the Rust toolchain with the MSVC build tools, and the Tauri CLI (`cargo tauri`). Then use the commands in [Development](#development).

## Architecture

- A thin Tauri 2 shell in Rust. It owns the window, the native dialogs, and the process limits.
- A Git service in TypeScript, compiled with Bun into one executable. It runs the installed Git with argument arrays and bounded output.
- A React renderer. It has no shell access and sends only typed operations.
- Shared operation contracts with zod schemas. No Electron.

## Development

Run these commands from the repository root. Run `bun run build` before `cargo check`, because the Tauri build needs the frontend and the service binary.

- `bun install --frozen-lockfile`
- `bun run build`
- `bun run typecheck`
- `bun run export:schemas` writes the JSON Schema files in `src/contracts/schemas/` after a zod schema change. `bun run export:schemas --check` fails on a stale file.
- `bun run test:contracts`
- `bun run test:git`
- `bun run test:windows` (needs `bun run build:service` first; skips without the service binary)
- `bun run test:all` runs `tests/contracts`, `tests/git`, and `tests/wsl` in two steps: the parallel group, then the serial group of `tests/groups.json`. It fails when a test file is in no group or has no report. Set `ARBARETO_WSL_DISTRO` for the WSL tests. `ARBARETO_TEST_WORKERS` sets the worker count of the parallel step (default 8).
- `ARBARETO_HISTORY_FIXTURES` is a comma list of the large history fixtures that a run may build: `H200K`, `H1M`, or `H200K,H1M`. A named fixture builds when the cache does not hold it, and its cases run. When the variable does not name H200K, the H200K cases run only when the cache holds both H200K variants. When the variable does not name H1M, the H1M cases skip with the capability `history-fixture-h1m`. A skip never counts as a pass.
- `bun run test:fast` runs `tests/contracts` and the parser tests the same way, for edit loops.
- `bun scripts/dictionary-catalog.ts [--offline]` writes `src/contracts/dictionaries.json` from the pinned wooorm/dictionaries commit. Set `ARBARETO_DICTIONARY_CACHE` to a folder outside the repository. The script reads `api.github.com` and `raw.githubusercontent.com` into that cache. `--offline` reads only the cache.
- `bun test tests/gate` runs the early dictionary gate report and the `hunspell.wasm` build fact. Set `ARBARETO_DICTIONARY_CACHE` to the cache of the catalog script. Without it, the gate report skips. `bun run test:all` does not run these files.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- `cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu` (Linux portability check on a Linux host; on Windows, use "Linux check (WSL)")
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`
- Run the app for development: `bun run dev`
- `bun run package` builds an unsigned current-user NSIS installer in `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. It does not install it. Then it prints the `rustc`, `cargo`, `cargo tauri`, `bun`, and NSIS versions for the build record.
- `pwsh -File scripts/windows/measure-ram.ps1 [-RootPid <pid>]` prints the private working set, private bytes, and working set of each process in the running app's tree, with totals per group (Tauri, Bun, WebView2); the main number is the private working set (Task Manager "Memory").

Cloud sessions: paste [.claude/cloud-setup.sh](.claude/cloud-setup.sh) into the cloud environment's setup script field. The cloud runs Bun and TypeScript work and the Linux portability check.

### Linux check (WSL)

Run these commands on Windows. They check the shell for Linux in WSL `Ubuntu-26.04`. The first `cargo` call installs the toolchain of `rust-toolchain.toml`. Keep the clone inside the distro. Do not build from `/mnt`.

```sh
wsl -d Ubuntu-26.04 -u root -- sh -c "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config"
wsl -d Ubuntu-26.04 -- sh -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal"
wsl -d Ubuntu-26.04 -- bash -c 'cd ~ && git clone https://github.com/auric/arbareto.git arbareto-linux-check'
wsl -d Ubuntu-26.04 -- bash -c '. ~/.cargo/env && cd ~/arbareto-linux-check && cargo check --locked --manifest-path src-tauri/Cargo.toml'
```

To check a branch, add `--branch <name>` to `git clone`.

## Acknowledgements

The layout takes ideas from [Git Extensions](https://github.com/gitextensions/gitextensions) (GPL-3.0). Arbareto copies no code and no assets from Git Extensions.

## License

Arbareto is free software under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). See [LICENSE](LICENSE). [NOTICE.md](NOTICE.md) states the copyright and the section 7 additional terms. These terms require attribution and marked, renamed modified versions. They grant no trademark rights to the name "Arbareto". Third-party material keeps its own license. [third-party-licenses/](third-party-licenses/) holds the license texts that the shipped packages do not carry.

## Contributing and security

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.
- Report a vulnerability as [SECURITY.md](SECURITY.md) tells you. Do not open a public issue for it.
