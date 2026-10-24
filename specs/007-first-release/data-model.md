# Data Model: First Release (Preview v0.1.0)

## 1. Build channel

- Values: `local`, `preview`.
- Source: the build environment variable `ARBARETO_RELEASE_CHANNEL`, read by `src-tauri/build.rs`. Absent or empty gives `local`. Any other value fails the build.
- Rules: `preview` refuses a `-dirty` build identity. `local` keeps the `-dirty` suffix.
- Carried in: the handshake `buildIdentity.channel` (contracts/release.md §4).

## 2. Build identity (handshake `buildIdentity`)

| Field | Type | Rule |
| --- | --- | --- |
| `version` | string | `CARGO_PKG_VERSION`. |
| `commit` | string | 40 or 64 lowercase hex, optional `-dirty` (unchanged). Never `-dirty` for `preview`. |
| `channel` | `"local"` or `"preview"` | Replaces `signing: "unsigned"`. |

## 3. Release

| Field | Rule |
| --- | --- |
| tag | `v<version>`, `^v\d+\.\d+\.\d+$`. |
| tag commit | Contained in `origin/main` (`git merge-base --is-ancestor` exit 0). |
| version | Equals the `cargo metadata` version of package `arbareto` and `package.json` `version`. |
| title | `Arbareto Preview v<version>`. |
| pre-release | Always true. Never latest. |
| notes | `CHANGELOG.md` section plus the fixed blocks (plan.md D9). |
| signing state | `off` or `signpath`, from the repository variable `ARBARETO_SIGNING`. |

State transitions: absent → draft (created by the publish job) → published. A draft with all files and a passing `sums.ts verify` may become published. A published release never changes (immutable releases). A failed run leaves absent or draft. A rerun moves a draft to published.

## 4. Release file set

| File | Content | Check |
| --- | --- | --- |
| `Arbareto_<v>_x64-setup.exe` | The NSIS installer. | SHA-256 line, attestation. |
| `arbareto-<v>-third-party-notices.txt` | The rendering of `notices.json` from the same build. | Every package and text of the JSON appears once. |
| `arbareto-<v>-hunspell-source.tar.gz` | `hunspell/` at `edb6191…1135`, `hunspell-wasm/` at `8f755ef…887d`, `SOURCE.txt`. | Fetched commit IDs equal the pins. |
| `SHA256SUMS.txt` | `<hex>  <name>` per other file, sorted, LF. | `sums.ts verify` passes. |

## 5. Pins record (`scripts/release/pins.ts`)

| Key | Value |
| --- | --- |
| `bun` | `1.4.4` |
| `bunWindowsZipSha256` | `cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5` |
| `rust` | `1.99.0` |
| `tauriCli` | `2.12.0` |
| `nsis` | `v3.11` |
| `runner` | `windows-2025` |
| `hunspell` | `edb619100791110d3e34f09ec35392ad327c1135` |
| `hunspellWasm` | `8f755ef64e8b047b77b676f9698b3dfa5cb1887d` |

## 6. Signing switch

| Name | Kind | Values |
| --- | --- | --- |
| `ARBARETO_SIGNING` | repository variable | `off` (default when unset), `signpath`. Other values fail. |
| `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG` | repository variables | Required when `signpath`. |
| `SIGNPATH_API_TOKEN` | repository secret | Required when `signpath`. Never printed. |

## 7. Release link target (`open_release_link`)

- Values: `hunspell-source`, `tag-source`.
- URL rule: contracts/release.md §5. The renderer never sends a URL.
- A `local` build refuses with `RELEASE_LINK_UNAVAILABLE`.
