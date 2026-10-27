# Contract: Release Workflow, Release Files, and Application Changes

## 1. Workflow (`.github/workflows/release.yml`)

| Rule | Check |
| --- | --- |
| Workflow-level `permissions: {}`. | Workflow test. |
| Triggers: `push` tags `v*`, `push` branch `release-dry-run`, `workflow_dispatch`. No other trigger. | Workflow test. |
| `build`: `runs-on: windows-2025`, `permissions` exactly `contents: read` and `actions: read`, no `environment`. | Workflow test. |
| `publish`: `needs: build`, `environment: release`, `if` limited to tag pushes `refs/tags/v`, `permissions` exactly `contents: write`, `id-token: write`, `attestations: write`. | Workflow test. |
| Every `uses:` value is `<owner>/<repo>[/path]@<40 hex>`. | Workflow test. |
| No `actions/cache` and no `continue-on-error: true`. | Workflow test. |
| No `env` map at workflow, job, or step level has a `RUSTFLAGS` or `CARGO_ENCODED_RUSTFLAGS` key. Either key replaces the `/Brepro` flag of `.cargo/config.toml` (plan.md D1). | Workflow test. |
| Sign steps carry `if: vars.ARBARETO_SIGNING == 'signpath'`. | Workflow test. |
| No step writes below the checkout. Every output path starts with `${{ runner.temp }}` or `$env:RUNNER_TEMP`, except the Tauri target folder and the Git-ignored externalBin source folder `src-tauri/binaries/`. The NSIS bundler reads the sidecar from its externalBin source path (tauri-bundler 2.10.0 `nsis/mod.rs:864-866`), so the signed sidecar replaces the file there. | Workflow test, dry-run `git status` check. |

## 2. Script exit codes and output lines

| Script | Success | Failures (exit 1, one line on stderr) |
| --- | --- | --- |
| Workflow tool install | exit 0 | `RELEASE_CHECK pin <name or version line>` (Bun archive hash, `rustc`, `cargo tauri`, or `bun` version differs from its pin) |
| `check.ts` | exit 0 | `RELEASE_CHECK tag-version <tag> <version>`, `RELEASE_CHECK version-mismatch <cargo> <package.json>`, `RELEASE_CHECK config-version <file>` (`src-tauri/tauri.conf.json`, or `tauri.windows.conf.json` or `tauri.preview.conf.json` when present), `RELEASE_CHECK not-on-main`, `RELEASE_CHECK not-tag-commit` (`--mode release`: `HEAD^{commit}` is not `refs/tags/<tag>^{commit}`, spec FR-014), `RELEASE_CHECK git-failed <code>` (`git merge-base`, `git rev-parse`, or `git status`), `RELEASE_CHECK dirty`, `RELEASE_CHECK signing-value <value>`, `RELEASE_CHECK signing-missing <name>` (`SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, or `SIGNPATH_POLICY_SLUG` absent or empty; `SIGNPATH_API_TOKEN` when `SIGNPATH_TOKEN_SET` is not `true`), `RELEASE_CHECK cargo-failed <code>`, `RELEASE_CHECK input <file>` (`package.json` or a Tauri file absent, not JSON, or not the expected shape; `cargo-metadata` without exactly one `arbareto` package with a string `version`) |
| `sums.ts write` | exit 0, prints the sums file path | `RELEASE_SUMS name <JSON name>` (a non-file entry, or a name outside `[A-Za-z0-9._-]+`) |
| `sums.ts verify` | exit 0 | `RELEASE_SUMS mismatch <name>`, `RELEASE_SUMS missing <name>` (also `SHA256SUMS.txt` itself), `RELEASE_SUMS extra <name>`, `RELEASE_SUMS format SHA256SUMS.txt` (a line outside the §3 form, an unsorted or repeated name, or no final LF) |
| `hunspell-source.ts` | exit 0, prints the archive path | `RELEASE_SOURCE fetch <repo> <code>` (also a failed `git init`), `RELEASE_SOURCE commit <repo> <expected> <actual>` (`<actual>` is `none` when `rev-parse` fails), `RELEASE_SOURCE archive <repo> <code>`, `RELEASE_SOURCE tar <code>`; `<code>` is the exit code, or the signal name when the process has no exit code |
| `notes.ts` | exit 0, prints the notes path | `RELEASE_NOTES missing <version>`, `RELEASE_NOTES block <file>` (a block file of `.github/release-notes/` is absent) |
| `notices-text.ts` | exit 0, prints the file path | `RELEASE_NOTICES input <path>` (absent, not JSON, or not the notices.json shape) |
| publish release lookup | exit 0 | `RELEASE_CHECK exists <tag>` (a published release with the tag, or more than one draft), `RELEASE_CHECK private` |
| any script, wrong arguments | — | `RELEASE_CHECK usage` (not a `--signing` value, which gives `signing-value`), `RELEASE_SUMS usage`, `RELEASE_SOURCE usage`, `RELEASE_NOTES usage` (also a `--signing` value other than `off` or `signpath`), `RELEASE_NOTICES usage`, each followed by the usage text |

Tests assert the exit code and the first token pair, never free text.

## 3. Release files

See data-model.md §4. `SHA256SUMS.txt` lines: `^[0-9a-f]{64}  [A-Za-z0-9._-]+$`, sorted by name, LF line ends, one final LF.

## 4. Handshake change

- `buildIdentity`: `{ version: VersionText, commit: <unchanged regex>, channel: "local" | "preview" }`, strict object.
- `signing` is removed. Every reader changes in the same task: `src/contracts/channel.ts`, `src/contracts/envelope.ts`, `src-tauri/src/service.rs`, `src/frontend/about/AboutDialog.tsx`, `src/frontend/boot/BootView.tsx`, and their tests.
- `bun run export:schemas` regenerates the schema files. `bun run export:schemas --check` passes.

## 5. `open_release_link`

- Request: `{ "target": "hunspell-source" | "tag-source" }`. Any other value or key is a validation error.
- `preview` channel URLs, with `R` = `CARGO_PKG_REPOSITORY`, `V` = `CARGO_PKG_VERSION`, `C` = `ARBARETO_BUILD_IDENTITY`:
  - `hunspell-source`: `R/releases/download/vV/arbareto-V-hunspell-source.tar.gz`
  - `tag-source`: `R/tree/C`
- `local` channel: error `RELEASE_LINK_UNAVAILABLE`, no process start.
- Open failure (`ShellExecuteW` result 32 or less): error `RELEASE_LINK_OPEN_FAILED` with the result value.

## 6. About

- `preview`: the line `Preview`; button `Hunspell source` (opens `hunspell-source`); button `Source at this commit` (opens `tag-source`). Both buttons take focus with Tab and act on Enter and Space.
- `local`: the line `Unsigned local test package`; no release buttons.
- Boot view: the same marker rule.
