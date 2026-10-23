# Implementation Plan: WSL Parity and Commit Message Spell Check

**Branch**: `006-wsl-parity-spellcheck` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-wsl-parity-spellcheck/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md) | Mockup (approved 2026-10-22): https://claude.ai/artifact/WX74LFkBZsAvyvFCPFiRJs

## Summary

The commit message editor marks misspelled words with a wavy underline. Hunspell in WebAssembly (`hunspell-wasm` 0.3.0) runs in module Web Workers, one check worker per loaded language. English ships with the application. The Spelling page in Settings downloads, imports, selects, orders, and removes the other wooorm/dictionaries languages. Every dictionary file must match a SHA-256 catalog that ships with the release. The Global Git settings save works in a WSL repository, through Git in the distro with `/` as its working folder. The WSL tests run the 004 rows that had no WSL case, and Add worktree through the service. Fresh Git listings, HTTP status codes, file sizes, and SHA-256 values decide every outcome. No message text decides anything.

Eight facts drive the design (research R2 to R11):
- Hunspell in Edge 155 (V8 15.5.9.7), one dictionary per process in a dedicated worker, measured on 2026-10-22 (R2): Ukrainian loaded in 348 to 376 ms with a process-tree peak increase of at most 82.5 MiB, French in 87 to 146 ms with at most 34.2 MiB, and Hebrew in 236 to 245 ms with at most 64.0 MiB. Russian, Turkish, and English also loaded. nspell needed about 6.2 s and 349 MiB for Ukrainian, and it could not load Hebrew (V8 `RangeError`). So the user chose Hunspell on 2026-10-22.
- 1,000 Hunspell checks took up to about 20 ms (Ukrainian), and one suggestion list up to about 300 ms (Turkish). So a full round of 10,000 words takes about 200 ms, above the 100 ms budget of SC-004, and a suggestion call would block a check round. So each round checks only the changed lines (D9), and each language gets a second worker for suggestions (D9).
- WebAssembly needs `'wasm-unsafe-eval'` in `script-src`: in Edge 155, `WebAssembly.compile` throws under `script-src 'self'`. With the CSP on the worker, the fetch of `hunspell.wasm` also fails unless `connect-src` admits the app origin (R6). Tauri 2.12.1 sets the CSP header only on `.html` assets (`tauri-2.12.1/src/manager/mod.rs:422-439`), so a worker gets no CSP today. The plan does not rely on that: the CSP names both sources (D9, contract Δ7).
- The pinned commit `8cfea406b505e4d7df52d5a19bce525df98c54ab` is still the head of wooorm/dictionaries (GitHub API, 2026-10-22). It holds 92 dictionaries. el, el-polyton, ko, mn, and rw exceed 12 MiB, so at most 86 catalog entries remain without `en`. `oc` has both a `license` and a `licence` file. `eu` and `et` have neither (R3).
- raw.githubusercontent.com sends `Content-Encoding: gzip` with the gzip length in `Content-Length` (3,086-byte `en/index.aff`: 1,003 bytes on the wire, 2026-10-22). So the byte bound counts the decoded body, and `Content-Length` decides nothing (D4).
- Bun `fetch` reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` unless the request names a `proxy` option (Bun docs). The user decided on 2026-10-22 that Download uses no proxy. So the service passes `proxy: false` (D4).
- The service already writes files (`index-lock.ts`) and starts with the application launch folder as its working folder (`service.rs:240`). So the service downloads, checks, and stores the dictionaries itself, with no new private request (D5).
- Inside a repository, Git applies that repository's `core.sharedRepository` to a new lock file (Git 2.56 `repo_create_tempfile_mode` → `adjust_shared_perm` → `repo_settings_get_shared_repository`). Outside a repository, only the global and system configuration count. So the WSL Global save runs Git with `-C /`, built as the shell's WSL clone target (D13, R9).

## Technical Context

**Language/Version**: The 001 to 005 versions stay: TypeScript `7.0.2`, Bun `1.4.3` (exact), Rust/Cargo `1.98.0`.

**Primary Dependencies**: New runtime packages: `hunspell-wasm` `^0.3.0` (0.3.0, published 2024-10-31; no dependencies; `package.json` licence `(LGPL-2.0 OR GPL-2.0 OR MPL-1.1)`; Arbareto uses Hunspell under LGPL-2.1; npm integrity `sha512-D7/QLaeekJYYlE37D7KBq5v38vL4tQutTFIUBOUGBl0g9la8OUgfSd8+XbwNPV5uYMHS13umXR9MtdAxStpHJg==`) and `dictionary-en` `^4.0.0` (`(MIT AND BSD)`, published 2023-11-03), npm registry, read on 2026-10-22 (research R2). The 001 to 005 packages stay: React `19.3.0`, `@base-ui/react` `^1.8.0`, `@tanstack/react-virtual` `^3.14.13`, `@hugeicons/core-free-icons` `4.3.5` as installed, Tauri `2.12.0` (lock 2.12.1). No new Rust crate. The shell uses the installed `windows` crate features `Win32_UI_Shell` (`ShellExecuteW`) and `Win32_System_Com` (`CoInitializeEx`) (D12).

**Storage**: Downloaded and imported dictionaries go to `<launch directory>/dictionaries/<id>/`. The launch directory is the per-user app local data folder, or `<ARBARETO_PROFILE_ROOT>/data` (`service.rs:108-113`, `profile.rs:22-29`). The language selection is a shell setting in `settings.json`, as the Pull default (D11). The personal word list is the IndexedDB database `arbareto-spelling` of the WebView2 profile, beside `arbareto-drafts` (D10). The Ignore list lives in renderer memory for the window session. The WSL Global save writes only the reviewed keys through Git in the distro.

**Testing**: Bun tests with an injected `fetch` seam and synthetic dictionaries (`tests/git`, `tests/contracts`). Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). An early real-language report from a local cache outside the repository, one language per process, outside `tests/groups.json` (`tests/gate/dictionary-gate.test.ts`, D19). Windows packaged tests (`tests/windows`), the deciding gate among them. WSL tests in Ubuntu-26.04 with Git 2.55 (`tests/wsl/workbench-wsl.test.ts`). Cargo tests for the shell.

**Target Platform**: Windows 11 x64 with WebView2 and Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0.

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: Fixed before measurement (constitution VII; user confirmation of 2026-10-22). SC-004: English marks within 1 s after the first open of the commit editor; a mark update within 100 ms after a typed character for a 64 KiB message with every word marked; no interface stall above 50 ms; at most 256 MiB process-tree memory increase per loaded language. FR-017 gate per catalog language: the files at most 12 MiB (12,582,912 bytes), the load in the packaged WebView2 worker within 10 s, and the memory increase within 256 MiB, by the method of D3. FR-008: a run-time load ends within `DICTIONARY_LOAD_DEADLINE_MS` (30 s). FR-011: a download ends within 120 s. FR-028: the 001 SC-005 input targets hold during loads, checks, and downloads (95% of inputs within 100 ms, every input within 500 ms).

**Constraints**: Spell check never uses the network and never blocks a commit. Only Download and Retry use the network, and only HTTPS to catalog URLs, directly, with every redirect refused. The renderer sends language IDs, file names, offsets, and booleans only. It never sends a URL or a path. The renderer CSP becomes `script-src 'self' 'wasm-unsafe-eval'` and `connect-src ipc: http://ipc.localhost 'self'`. No Git configuration file changes except the reviewed keys of a Global save. The service log keeps its allowlist fields (`log.ts`): kind, operation ID, duration, code, and count.

**Scale/Scope**: A catalog of at most 86 languages plus bundled English. At most 3 selected languages. A commit message of at most 64 KiB (`COMMIT_MESSAGE_BYTES`), about 10,000 words. A personal word list of at most 10,000 words of at most 100 code points each. Dictionary files of at most 12 MiB per language.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` version 3.0.0, before research and again after Phase 1.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | The WSL Global save keeps the 004 review: it binds the exact origin and key-value bytes of each changed key, checks them again before each write, and lets the fresh listing decide (D13). Dictionary work touches only the app-owned folder `<launch directory>/dictionaries`. A downloaded file becomes a dictionary only after its size and SHA-256 match, through a rename of a checked staging folder (D5). Spell check never changes the text without a user selection, and never blocks a commit (D8). | Pass, note N-1 |
| II. TypeScript/Bun | The download, the checks, the storage, the word rules, and the spell engine glue are TypeScript. Hunspell runs as WebAssembly in the renderer. Rust adds only platform work: the folder picker title, the licence link open with `ShellExecuteW`, the shell setting, the CSP value, and the WSL `globalConfig` target (D12, D13). | Pass |
| III. Validated boundaries | Typed operations with zod and the strict decoder. The renderer names a language ID and a catalog file name, never a URL or a path. The shell takes the import folder from the native picker and the licence URL from the embedded catalog (D6, D12). Every download has a byte bound, a 120 s deadline, and Cancel. Every read has a chunk bound and Cancel (contract Δ2, Δ5). | Pass |
| IV. Real Git verification | Each WSL row compares HEAD, refs, the index, working files, configuration bytes, and the operation state with Git's own commands on a copy in the same distro (D14). The Global save test checks the owned global file bytes, its mode, and the SHA-256 of the real `~/.gitconfig` and XDG file (SC-005). | Pass |
| V. Untrusted repositories | No dictionary operation runs a Git process or a repository program. The WSL Global save runs no repository program and needs no trust approval (FR-021). Dictionary files are untrusted input: the catalog SHA-256 pins them, a worker parses them, and the licence text shows as plain text (D7, D12). `'wasm-unsafe-eval'` admits WebAssembly compilation only; it admits no `eval` of script text. | Pass, note N-2 |
| VI. Platform evidence | Packaged Windows evidence for the workers under the CSP, the marks at 100%, 150%, and 225% text scale, IME composition, a right-to-left line, the menu keys, one undo step, an offline run, and the SC-004 and FR-017 budgets (P8). WSL evidence on Ubuntu-26.04. The packaged WSL Global save stays unverified by design (FR-025). | Pass, note N-3 |
| VII. Accessible and measured | Every new control has a label or icon, a tooltip, an accessible name, visible focus, and a stated reason when unavailable (D16). The wave shape is the mark cue. The budgets and the gate method are fixed above and in D3, before measurement. | Pass |
| VIII. Locked dependencies | `hunspell-wasm` `^0.3.0` and `dictionary-en` `^4.0.0` enter `package.json` with caret ranges. `bun.lock` records the exact versions and integrity values, and a contract test checks the `hunspell-wasm` integrity value. Research R2 records the licence and upkeep review. No Rust crate and no `windows` feature is added. | Pass |
| IX. One planning process | All artifacts stay in `specs/006-wsl-parity-spellcheck`. The contract lists only deltas to 001 to 005. | Pass |

Notes from the second check:
- **N-1 (I, "Destructive actions … MUST require explicit confirmation")**: The user decided on 2026-10-22 that Remove of a dictionary and Remove of a personal word take no confirmation. This is the user's decision, not a plan default. Both remove app-owned data, never repository data. Download, Import, and Add to dictionary undo them. Both stay apart from routine actions, in their own column and in the Removed text style (FR-026, D16).
- **N-2 (V, "Logs and diagnostics MUST NOT contain credentials")**: Download uses no proxy, so no proxy credential reaches the service. No log line, response, or event holds a URL.
- **N-3 (VI, "Untested behavior MUST remain explicitly unverified")**: Research R12 lists every unverified point: the explicit `tls.ca` against `NODE_EXTRA_CA_CERTS` (F3), the Vite asset of `hunspell.wasm` (F14), `hunspell-wasm` under Bun (F15), the IME check without an installed Japanese IME (N5), the offline package run without Windows Sandbox (N6), the packaged WSL Global save, the XDG global file on WSL, the Q11 force note and the Q23 host line on WSL (D14), and the legal readings of a run-time download and of the LGPL-2.1 use (D18).
- **N-4 (Delivery Gates)**: Safety tests (SC-003, SC-005, the redirect and size refusals), trust boundaries (D2, FR-021), accessibility checks (SC-007), performance budgets (SC-004, FR-017, FR-028), and platform qualification (P8) are defined here.

No violation, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/006-wsl-parity-spellcheck/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   └── operations.md       # Phase 1: deltas to the 001 to 005 contracts
├── checklists/
└── tasks.md                # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
scripts/
├── dictionary-catalog.ts   # new: dev-time catalog build and local test cache; --offline rebuild from the cache
├── dictionary-gate.json    # new: the gate failures with their measured values
└── windows/measure-ram.ps1 # changed: -Json and -IntervalMs for the packaged gate sampler
src/
├── contracts/              # operations.ts, envelope.ts, errors.ts, limits.ts, schemas/
│                           # new: dictionaries.json, dictionaries.ts, spell-words.ts
├── git-service/            # session.ts, main.ts, git-settings.ts
│                           # new: dictionaries.ts, dictionary-store.ts
└── frontend/               # commit/CommitTray.tsx, settings/{SettingsView,SettingsDialog}.tsx, settings/git/{GitSettingsPage.tsx,texts.ts},
                            # about/AboutDialog.tsx, build/notices.ts, app/Workbench.tsx, bridge.ts; vite.config.ts (root)
                            # new: spelling/{engine.ts,spell-worker.ts,english.ts,word-list.ts,store.ts,SpellMirror.tsx,SpellMenu.tsx,SpellChip.tsx,texts.ts},
                            #      settings/{SpellingPage.tsx,LicencePanel.tsx}
src-tauri/
├── tauri.conf.json         # the CSP: 'wasm-unsafe-eval' and connect-src 'self'
└── src/                    # process_requests.rs, service.rs, settings.rs, dialogs.rs, ipc.rs, schema.rs, lib.rs; build.rs; capabilities/main.json
                            # new: links.rs
tests/
├── contracts/              # new: dictionary-catalog.test.ts, spelling-contract.test.ts, spell-words.test.ts, word-list.test.ts,
│                           #      network-sites.test.ts, spelling-editor.test.tsx, spelling-page.test.tsx; changed: workbench-settings.test.tsx
├── git/                    # new: dictionaries.test.ts, dictionary-facts.test.ts; changed: bun-runner.ts, service-harness.ts
├── gate/                   # new: dictionary-gate.test.ts, wasm-asset.test.ts (outside tests/groups.json, own command)
├── wsl/                    # changed: workbench-wsl.test.ts
├── windows/                # new: spelling-packaged.test.ts, spelling-perf.test.ts
└── vectors/
```

**Structure Decision**: The three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. The catalog `src/contracts/dictionaries.json` is the one source for the service, the renderer, and the shell. The word rules live in `src/contracts/spell-words.ts`, because spec FR-003 makes them part of the contract. That module has no runtime import, as `ignore-line.ts` and the 005 `tree-order.ts`.

## Design

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0.1 Catalog and early gate | new `scripts/dictionary-catalog.ts`, new `src/contracts/dictionaries.json`, new `tests/gate/dictionary-gate.test.ts` (WP1) | None. The script reads the pinned tree, downloads each dictionary once into the local cache, gates it by size, and records the Hunspell fixture result in Bun. | The early report loads one cached language per process and prints its time, memory, fixture result, and NFC state (F12, F13). A missing cache skips with its reason. | `hunspell-wasm` may not run under Bun 1.4.3 (F15). Then the packaged gate alone gives the fixture result. |
| P0.2 Download, engine, and build facts | new `tests/git/dictionary-facts.test.ts`, new `tests/gate/wasm-asset.test.ts` (WP1) | None. Records the Bun 1.4.3 `fetch` behavior that D4 depends on, with local servers only, whether `hunspell-wasm` runs under Bun, whether a Vite build emits `hunspell.wasm`, and where the Hunspell source of the published commit lies. | F1 to F7, F14, F15, and F16 of research R12. | A fact fails. Record it in research.md R13 and change the contract before P4 or P6. |
| P0.3 Packaged facts | WP6 runs N1 and N2 first on `bun run dev` (the real shell, CSP, and asset origin) before its suggestion and replace work. WP8 repeats F14 and N1 to N4 in `tests/windows/spelling-packaged.test.ts`. | None. | N1 to N4 of research R12: the workers and the wasm fetch under the CSP, `insertText` with one undo step, the menu keys, and the mirror alignment by UI Automation text ranges; F14 again on the `dist/` of the package. | `execCommand("insertText")` keeps no undo step in WebView2. Then D15 changes before P6 ends. |
| P1 Pure logic | new `src/contracts/spell-words.ts`, `src/contracts/dictionaries.ts` (WP2) | Algorithms only: the word segments and skip rules, NFC, the case rule, the line rounds and mark merge, the size text, and the catalog schema. | Unit tests with exact vectors (data-model §11 to §13). | ICU word breaks differ between Bun and WebView2 for some scripts. The vectors stay in scripts whose breaks UAX #29 fixes. |
| P2 Contracts | `src/contracts/{operations,envelope,errors,limits}.ts`, `schemas/`, `tests/vectors/` (WP2) | Adds the operations, the code, the reasons, the phase, the bounds, and the shell setting of contract Δ1 to Δ10. | Schema tests and golden vectors in Bun and Rust. | typify drops ranges. Keep explicit Rust checks (001 §1). |
| P3 Shell | `src-tauri/src/{process_requests,service,settings,dialogs,ipc,schema,lib}.rs`, new `links.rs`, `build.rs`, `capabilities/main.json`, `tauri.conf.json` (WP3) | The WSL `globalConfig` target, `setSpelling`, `openLicenceLink`, the `importDictionary` picker step, the forwarded dictionary commands, and the CSP. | Cargo tests for each target, refusal, setting round trip, the CSP value, and the WSL argv. | Local only. |
| P4 Service dictionaries | new `src/git-service/{dictionaries,dictionary-store}.ts`, `session.ts`, `main.ts` (WP5) | US3 service part: list, read, download, import, remove, and the release reconcile. | SC-002 (synthetic), SC-003, every FR-016 text cause, Cancel, the deadline, one run at a time. | A Windows rename of a folder that another process holds open fails. The result then names the folder. |
| P5 WSL parity | `src/git-service/git-settings.ts`, `tests/git/bun-runner.ts`, `tests/wsl/workbench-wsl.test.ts` (WP4) | US2 service part, and the US4 rows. | SC-005, SC-006, the control mutation of D14. | `wslParts` of the UNC root for `/` (research R10). |
| P6 Editor spell check | new `src/frontend/spelling/*`, `commit/CommitTray.tsx`, `vite.config.ts`, `bridge.ts` (WP6) | US1. | SC-001, SC-008, the menu, the case rule, the word list bounds, Ignore, the load deadline. | The mirror alignment and the round time at 64 KiB. |
| P7 Settings | new `settings/{SpellingPage,LicencePanel}.tsx`, `settings/SettingsView.tsx`, `settings/git/{GitSettingsPage.tsx,texts.ts}`, `about/AboutDialog.tsx`, `app/Workbench.tsx` (WP7) | US3 UI, the US2 Global header, and the Hunspell note in About. | Component tests per FR. | 87 rows by keyboard. The grid keys of D16 bound it. |
| P8 Qualification | `tests/windows/{spelling-packaged,spelling-perf}.test.ts`, `scripts/windows/measure-ram.ps1`, one full WSL run (WP8) | None (tests), then the offline catalog rebuild. | SC-004, SC-007, SC-009, the FR-017 packaged gate, FR-028, the offline run. | The IME needs an installed Japanese IME, and the offline run needs Windows Sandbox, else a capability skip. |

Each step writes its tests first. P0.1 and P0.2 are the riskiest proofs and run first in WP1.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. Summary:
- New service operations: `listDictionaries`, `readDictionary`, `downloadDictionary`, `removeDictionary`, and the native-first `importDictionary` (D3 to D7).
- New shell-only operations: `setSpelling` (D11) and `openLicenceLink` (D12). The 003 `readSyncSettings` result gains `spelling`.
- New code `DICTIONARY_UNAVAILABLE` with its reasons (contract Δ9). The 001 codes `DEADLINE`, `CANCELED`, `INVALID_REQUEST`, `BUSY`, and `PICKER_FAILED` keep their meaning.
- New progress phase `dictionary` with the counters `received` and `total`.
- The renderer CSP gains `'wasm-unsafe-eval'` in `script-src` and `'self'` in `connect-src` (contract Δ7).
- The 004 `globalConfig` context gains its WSL form (contract Δ6, Δ11). The `config-save` precheck drops its WSL refusal.
- No new private native process request. The service reads and writes only the app-owned folder and the folder that the shell picker returns.

### D2 Process model and outcomes

- A dictionary operation names no repository. It runs no Git process. It never waits for a Git operation, and a Git operation never waits for it (spec FR-011). It does not enter the 001 read scheduler, the mutation exclusion, or `MUTATIONS`.
- Each dictionary operation gets an operation ID from the 001 operation registry, as every 001 operation does (`session.ts` `registry.start`). The 001 `cancel {operationId}` cancels it. `CANCELED` arises only from such a request, for example when a language leaves the selection during its load.
- Release reconcile (spec FR-017, data-model §3): one reconcile per service process, started by the first dictionary operation. Every dictionary operation, `listDictionaries` and `readDictionary` included, waits for that one reconcile before its own work.
- One dictionary run at a time: a `downloadDictionary` or `importDictionary` holds the service run lock for its whole run. A second one gets `DICTIONARY_UNAVAILABLE` reason `busy` before any byte moves. `removeDictionary` of the language under a run gets `busy` too. `listDictionaries` and `readDictionary` never take the run lock.
- Cancel: the abort reaches the `fetch` and the file steps of the run. The response is `canceled`, and the staging folder goes. Cancel is never rollback (001 FR-023).
- Deadline: one timer of `DICTIONARY_DOWNLOAD_DEADLINE_MS` (120 s, equal to `REGISTERED_DEADLINE_CAP_MS`) per download or import. Its own flag records the cause before the abort, so `DEADLINE` and `CANCELED` never depend on an error object.
- `readDictionary`: at most `SPELLING_LANGUAGES` (3) run at the same time. A fourth gets `BUSY`. Each call checks the manifest and the requested file, and returns one chunk (D7).
- Progress: phase `dictionary` with `received` and `total`, at most `DICTIONARY_PROGRESS_EVENTS_PER_SECOND` (4) events per second. Events carry no URL, path, or name.
- Close: a dictionary run is no mutation, so `requestClose` lists none. A service exit during a run leaves a staging folder, and the next reconcile removes it (D5).
- Logs: only the allowlist fields of `log.ts`: `kind`, `operationId`, `durationMs`, `code`, and `count` (the byte count). No language, reason, status, URL, or path.

### D3 Catalog and gate

- File `src/contracts/dictionaries.json` (data-model §1, §2). `scripts/dictionary-catalog.ts` makes it at dev time from the pinned commit. Only an application release changes it (spec FR-017). The script reads only `api.github.com` (the tree) and `raw.githubusercontent.com` (the files), as the user allowed on 2026-10-22.
- Source facts (research R3): the GitHub tree of `8cfea406b505e4d7df52d5a19bce525df98c54ab` lists each `dictionaries/<id>/` folder with its files and sizes. The script stores that tree as `tree.json` in the cache, downloads each file once from `https://raw.githubusercontent.com/wooorm/dictionaries/<commit>/dictionaries/<id>/<name>` into the cache, and computes the SHA-256 there. With `--offline`, the script reads only the cache and makes the same JSON without a network request.
- Licence documents: every file named `license` or `licence` of that folder, in that order. A folder with neither uses `readme.md` (`eu`, `et`). So `oc` gets two licence documents (user decision, 2026-10-22). The row link names the first document.
- Licence value: the `license` field of the folder's `package.json`, as given (spec FR-015). `en` gives `(MIT AND BSD)`, `eu` gives `GPL-2.0`, `et` gives `LGPL-2.1`, and `oc` gives `GPL-2.0` (read on 2026-10-22).
- Name: `Intl.DisplayNames("en", {type: "language"})` of the ID, in Bun 1.4.4 at script time (research R13, WP1). A result that equals the ID itself fails the script, and the script then takes the name from its reviewed override table. The JSON stores the name, so the run-time ICU version changes nothing.
- Order: by name, with the 005 `compareNames` over the UTF-8 bytes. No locale compare.
- Gate (spec FR-017), each entry:
  1. The files together are at most 12,582,912 bytes. This drops el, el-polyton, ko, mn, and rw (research R3). The script decides this step.
  2. Hunspell loads `index.aff` and `index.dic`, and the language fixture passes (data-model §16).
  3. The packaged WebView2 load ends within 10 s.
  4. The packaged memory increase stays within 256 MiB.
  Steps 2 to 4 decide in `tests/windows/spelling-perf.test.ts` (P8). `tests/gate/dictionary-gate.test.ts` gives an early report of step 2 in Bun, and the NFC state of each file (F13). Bun is not the product runtime (spec SC-002), so a Bun time decides nothing. A failure of any step enters `scripts/dictionary-gate.json` with its measured values.
- Packaged gate method (fixed before the measurement):
  - Reference PC: the 004 reference PC (AMD Ryzen 7 4800H, 16 logical processors, Windows 11 10.0.26300). Each run records the WebView2 runtime version, the Arbareto build, and the CPU.
  - Metric: the sum of the private bytes (`PrivateMemorySize64`) of the `msedgewebview2.exe` processes in the `arbareto.exe` process tree, by the tree rule of `scripts/windows/measure-ram.ps1` (a child must start after its parent). WP8 adds `-Json` and `-IntervalMs` to that script, so it prints one JSON line per sample.
  - Setup per run: a fresh copy of a scratch profile (`ARBARETO_PROFILE_ROOT`) with the fixture repository as the last repository, the cached files and their `entry.json` in `<root>/data/dictionaries/<id>/`, and `settings.json` `spelling` set to `{enabled: false, languages: [<id>]}`. The package starts, opens the repository, and shows the commit editor. The test writes the fixture text (data-model §16) into the editor with the UI Automation `ValuePattern`.
  - Baseline: 10 s after the editor shows, the sampler takes 3 samples 1 s apart. The baseline is their median.
  - Load timer: it starts when the UI Automation `Toggle` of the Spell check switch on the Spelling page returns. It ends at the first 50 ms poll after the return to the Commit view that finds the chip name "Spelling: <Language>". The time includes the chunk reads, so it is stricter than the worker load alone.
  - Peak: the sampler runs every 250 ms from the baseline until 5 s after the load timer ends, and then until 5 s after the spelling menu of the first negative fixture word shows its suggestions. So the peak includes the check worker and the suggestion worker of the language. The increase is the peak sample minus the baseline.
  - Fixture: after the load, the count text must equal the number of negative fixture words.
  - Runs: 3 runs per language, each with a new app process and a fresh profile copy. A language passes when all 3 runs end within 10 s, stay within 256 MiB, and give the exact fixture count. Each run records its values in research.md R13. A failed language enters `scripts/dictionary-gate.json`.
  - Rebuild: after the gate, WP8 runs `bun scripts/dictionary-catalog.ts --offline`, which leaves out each failed entry, and then `bun test tests/contracts/dictionary-catalog.test.ts`. The shipped catalog holds only entries that passed all four steps.
- `en` stays out of `entries`: the bundled `dictionary-en` 4.0.0 files equal the pinned `dictionaries/en` files (3,086, 551,762, and 15,731 bytes). The catalog record `bundled` holds their names, sizes, SHA-256 values, URLs, and the licence data, and a contract test checks them against `node_modules/dictionary-en` (research R3).
- Load at start: the service, the renderer, and the shell parse the JSON with the `Catalog` schema of `src/contracts/dictionaries.ts`. A schema failure stops the service start, the renderer build, and the shell build. Every URL must equal `https://raw.githubusercontent.com/wooorm/dictionaries/<commit>/dictionaries/<id>/<name>` exactly.
- Local test cache: the script fills `<ARBARETO_DICTIONARY_CACHE>/<commit>/` with `tree.json` and `<id>/<name>`, each `package.json` included. The folder must lie outside the repository. Tests read it only, and skip with "dictionary cache absent: set ARBARETO_DICTIONARY_CACHE" without it (spec SC-002).

### D4 Download

- Request `downloadDictionary {language}` (contract Δ3). `language` must be a catalog ID. Spec FR-010: only a user selection of Download or Retry sends it.
- Steps, after the reconcile and under the run lock:
  1. For each file of the entry, in catalog order: `new URL(url).protocol` must be `https:`, else reason `not-https` and no request.
  2. `fetch(url, {redirect: "manual", proxy: false, tls: {rejectUnauthorized: true, ca: tls.rootCertificates}, signal, keepalive: false})`. `proxy: false` makes Bun read no proxy variable (Bun docs "Proxying requests"; F2), as the user decided. The explicit `ca` keeps `NODE_EXTRA_CA_CERTS` out, and `rejectUnauthorized: true` keeps `NODE_TLS_REJECT_UNAUTHORIZED` out (F3, unverified until F3 runs).
  3. Status: 200 goes on. 300 to 399 gives reason `redirect`, also for the same host (spec FR-010, F1). 404 gives `http-not-found`. 429 gives `http-rate-limit`. Any other status gives `http-status` with `status`. A rejected `fetch` or a rejected body read that is not this run's abort gives `transport`. The run's own flags decide Cancel and the deadline (D2).
  4. Body: the service reads the decoded stream and counts the bytes. It writes only the first `size` bytes to the staging file. When the stream yields byte `size + 1`, the service cancels the stream (F4), and the file gives reason `mismatch`. It hashes the written bytes with `Bun.CryptoHasher("sha256")`. A byte count or SHA-256 other than the catalog gives reason `mismatch`. `Content-Length` and `Content-Encoding` decide nothing (research R4).
  5. After every file matches: the manifest `entry.json` (data-model §3), then the install of D5.
- Each failure and Cancel removes the staging folder, so no file stays (spec FR-011, SC-003). A failed removal stays for the next reconcile.
- A write error (`ENOSPC`, `EACCES`, `EPERM`, `EIO`, or any other `node:fs` rejection) gives reason `save` with `folder`, the Windows path of `<launch directory>\dictionaries\<id>`.
- Progress: `received` counts the decoded bytes of all files up to their sizes, `total` is the sum of the catalog sizes.
- Result `{language, state: "ready"}` (data-model §5).

### D5 Dictionary folder, install, and release reconcile

- Folder `<launch directory>/dictionaries`. The service takes the launch directory from its working folder at start, which the shell sets (`service.rs:240`). `createSession` takes `dictionaryFolder` as an option, so tests own their folder.
- Layout: `<id>/index.aff`, `<id>/index.dic`, each licence document, and `<id>/entry.json`. The manifest `{version: 1, entry}` holds the catalog entry that the files came from (spec FR-017). The service reads at most `DICTIONARY_MANIFEST_BYTES` (64 KiB) of it. A larger or unparsable manifest counts as no valid manifest.
- Install: the run writes into `.staging-<id>-<32 hex>/`. After the checks, it removes an existing `<id>/` and renames the staging folder to `<id>/`. A crash between the removal and the rename leaves no `<id>/`, so the row shows Not downloaded, and the next reconcile removes the staging folder.
- Release reconcile, once per service process (data-model §3):
  - Each entry whose name starts with `.staging-` goes.
  - A folder whose name is a catalog ID: its manifest equals the current entry, so it stays. A manifest that differs: the folder goes, and the notice `catalog-changed` for that ID holds for this service process (spec FR-017 text).
  - A folder whose name is no catalog ID and whose manifest parses with that ID: the folder goes, and the notice `catalog-removed` with the manifest name holds for this service process.
  - Any other entry stays untouched. Arbareto never guesses whose it is.
- Removal uses `rm` with `recursive: true`, which removes a link and never follows it (Node API that Bun implements; F7).

### D6 Import

- `importDictionary {language}` is native-first (contract Δ3). The shell checks the ID against the embedded catalog and shows the 004 folder picker with the title of D17. Cancel gives `canceled`. A picker failure gives `rejected` `PICKER_FAILED`. The shell forwards `{language, folder}`. The renderer never sends a path.
- Service steps, after the reconcile and under the run lock: for each catalog file name, `stat` of `<folder>/<name>` must give a regular file with the catalog size. The service reads at most the size plus one byte, writes the first `size` bytes to the staging file, and hashes them. A missing file, another type, another size, or another SHA-256 gives reason `import-mismatch` (spec FR-012). A read error other than `ENOENT` gives reason `import-unreadable` with `folder`. Then the install of D5. No network request runs.
- A picked folder in a WSL distro is read through its UNC path. The files hold at most 12 MiB.

### D7 Read and the load check

- `readDictionary {language, file, offset}` (contract Δ3). `file` is one file name of the catalog entry. `offset` is a multiple of `DICTIONARY_CHUNK_BYTES` (1 MiB) below the file size, or 0.
- Steps, after the reconcile: an absent `<id>/` gives reason `absent`. An absent or invalid manifest, a manifest other than the entry, a missing requested file, or a size other than the catalog gives `changed`. The service reads the requested file whole and hashes it. A SHA-256 other than the catalog gives `changed` (spec FR-013). Then it returns the chunk at `offset` as base64, with the size. The other files of the language get the same check when the renderer reads them.
- Each call checks the requested file whole, so every chunk comes from bytes that equal the catalog. The renderer joins the chunks of one file. The service keeps no load state.
- Cost: 1 MiB chunks keep each response near 1.4 MB of JSON, so the main thread parses each one in a few milliseconds (FR-028). An 8.5 MB `index.dic` takes 9 calls, and each hashes 8.5 MB again (research R5).
- `listDictionaries {}` gives the state of every catalog language with the full file check of data-model §3 for each installed language, the running download or import, and the session notices (data-model §4).

### D8 Spell check in the commit message editor

- Scope (spec FR-002): only the `CommitTray.tsx` message `textarea`. It serves Commit, Amend last commit, and Commit and push. The merge message, file content, diffs, and names get no check.
- The textarea stays a plain `textarea` with `spellCheck={false}`, its drafts flow, its 72-column guide (`guideStyle`), and its key rules (spec FR-007).
- Box: a wrapper `div` takes the 1 px Control border, the 4 px radius, the Surface fill, and the focus ring through `:has(textarea:focus-visible)`. The textarea and the mirror take border 0, `padding: 4px 8px`, the code font at 12/18 px, and a transparent fill. The mirror sits behind the textarea at the same origin. Its width is the textarea `clientWidth`, read with a `ResizeObserver` and after each input, so a scrollbar changes both wraps alike. The mirror copies `white-space`, `overflow-wrap`, `direction`, `unicode-bidi`, `tab-size`, and the font settings from the computed style of the textarea. It sets `scrollTop` from each textarea `scroll` event. It has `aria-hidden="true"` and `pointer-events: none`.
- Mirror content: text nodes and one `span` per mark, built with `replaceChildren` from the shown marks. React owns the mirror element, not its children. The spans add no bidi isolation, so the bidi layout equals the textarea layout (SC-009).
- Mark style: `text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: var(--removed); text-decoration-thickness: 1px; text-underline-offset: 3px; text-decoration-skip-ink: none`. The mirror text stays transparent. The wave shape is the cue (spec FR-001).
- Mark updates (data-model §13): each input rebuilds the mirror text at once. Marks in lines before the changed lines keep their offsets, marks in lines after them move by the length change, and marks in the changed lines go until the next merge. Typing never waits for a worker (FR-008).
- IME (SC-009): `compositionstart` hides every mark. `compositionend` starts a new round for the changed lines. The mirror never marks composed text.
- Count: the editor `aria-describedby` gains the count element after the 004 elements: "No possible misspellings", "1 possible misspelling", or "<n> possible misspellings" with the en-US thousands separator. The count element exists only while spell check is on, at least one language is loaded, and no composition runs.
- Chip (spec FR-001, Main board): after "Commit message" and before the Summary counter, with a 12 px gap. It is static text with a tooltip, not a control. Its tooltip lines also join the editor description, so a keyboard user hears them.
- Above `COMMIT_MESSAGE_BYTES` (65,536 UTF-8 bytes): no round runs, and no mark shows. The chip tooltip states the D17 limit text.

### D9 Spell engine and workers

- Engine: `hunspell-wasm` 0.3.0 (user decision, 2026-10-22). Each worker imports `createHunspellFromStrings` from the package. The package loads `hunspell.wasm` (811,567 bytes, SHA-256 `72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0`) once per worker through `new URL("hunspell.wasm", import.meta.url)` and `WebAssembly.instantiateStreaming`, and writes the `.aff` and `.dic` text into its in-memory file system. The WebAssembly memory can grow to 2,048 MiB (`hunspell.js`). The Vite build emits `hunspell.wasm` as an app asset beside the worker chunk (F14, first in a throwaway build of WP1, then on the `dist/` of the package in WP8). The WP1 dependency test checks the `bun.lock` integrity value and the SHA-256 of `node_modules/hunspell-wasm/wasm/hunspell.wasm`, and F14 checks that the emitted asset has the same bytes.
- CSP (contract Δ7): `script-src 'self' 'wasm-unsafe-eval'` and `connect-src ipc: http://ipc.localhost 'self'`. Edge 155 refuses `WebAssembly.compile` without `'wasm-unsafe-eval'`, and the asset fetch needs `'self'` once a worker has the CSP (research R6). `'self'` is the app origin, which the shell serves from the bundle, so it opens no network access.
- Workers per loaded language (module workers, the Vite `?worker&url` form of `PatchPool.tsx:4,10`):
  - The check worker. The engine creates it only when the commit editor first shows with spell check on (FR-008). It answers check rounds only.
  - The suggestion worker. The engine creates it at the first spelling menu of that language in the window session, and loads it with the same chunks through `readDictionary` again. It answers suggestion requests only. So a suggestion call never delays a check round (plan review, 2026-10-22). The menu shows "Finding suggestions…" while it loads.
  - Spell check Off, Remove, or a cleared selection terminates both workers of that language.
- English: the worker of `en` imports `dictionary-en` `index.aff` and `index.dic` with `?raw` through a Vite `resolve.alias` to the package folder, in a dynamic `import()` (004 R20). No request leaves the app, because `?raw` inlines the text into the worker chunk.
- A downloaded language: the main thread reads the chunks with `readDictionary` and posts each base64 chunk string to the worker. The worker decodes the bytes with `TextDecoder("utf-8", {fatal: true})` and calls `createHunspellFromStrings(aff, dic)`. A decode failure, a thrown error, or a failed create gives `load-failed`.
- Load deadline (spec FR-008): `DICTIONARY_LOAD_DEADLINE_MS` (30,000 ms, equal to `READ_DEADLINE_MS`) from the first `readDictionary` call of the language, or from `init` for `en`, until `loaded`. At the deadline, the engine sends `cancel` for a running read, calls `worker.terminate()`, and marks the language failed with the FR-016 load text. The suggestion worker load has the same deadline, and its failure only removes that language from the suggestions.
- Load order: the selection order. The engine reads one language at a time. Each check worker answers rounds as soon as it has loaded.
- Rounds (data-model §13, §14): a round carries the changed lines of one text version. After a load, the first round of that worker carries every line. A worker that is busy gets only the newest round when it ends. Each worker segments its lines with `spell-words.ts`, checks each word with `testSpelling`, and replies with the refused ranges as a `Uint32Array` (transferred). The engine merges a round only when every check worker that was loaded at the round start replied to it. It never merges a partial round. A newer round drops an older one.
- Round cost: 1,000 checks took up to about 20 ms in Edge 155 (research R2). A typed character changes one line, so its round checks one line. A paste of many lines, or a single line of many words, rechecks those lines and can exceed 100 ms. SC-004 states this limit.
- Merge (spec FR-004): a word gets a mark only when all of these hold. Spell check is on. At least one language is loaded. Every loaded language refused the word. Neither the personal word list nor the Ignore list accepts it under the case rule (data-model §12). A worker that loads later joins at the next round. Until then, the chip names only the loaded languages, and its tooltip names each language that still loads.
- Suggestions (spec FR-005, data-model §15): the menu sends `suggest {id, word}` to the suggestion worker of each loaded language, in selection order. Each worker calls `getSpellingSuggestions` and replies with at most 5 strings. A newer request replaces a queued one. A running call ends, and the engine drops its stale reply by `id`. The engine joins the lists in selection order, drops repeats by exact string equality after NFC, and keeps the first 5. Each list shows as soon as its worker answers.
- A worker `error` event, a `load-failed` reply, or the deadline marks that language failed for the window session. The chip and the row then show the FR-016 load text. Spell check uses the other languages.

### D10 Personal word list and Ignore list

- Database `arbareto-spelling`, version 1, store `words` with key path `word`. Each record is `{word}` (data-model §9). The drafts database `arbareto-drafts` stays at version 1 (`draft-store.ts:34`).
- Add (spec FR-006): one `readwrite` transaction with `durability: "strict"`. It counts the store, refuses at 10,000, and then calls `add`. A `ConstraintError` means the word is already there. Add never calls `put` and never rewrites other records.
- Bounds: at most 10,000 words, each NFC, 1 to 100 code points. A longer word makes Add unavailable with its D17 reason.
- Read at the first editor show and on the Spelling page: `getAll(null, 10_001)`. More than 10,000 records, a record that fails the bounds, or a read error give the state `unreadable`. Arbareto then writes nothing to the store, the listed words get marks, and Add is unavailable with "Arbareto could not read the personal word list." A failed `open` gives the state `unavailable`.
- Remove on the Spelling page: `delete` of that key, with no confirmation (user decision, 2026-10-22). The list then reads again.
- Ignore list: a renderer `Set` of NFC words for the window session, across repositories. A restart clears it. Ignore re-merges at once without a round.
- Case rule (spec FR-006, data-model §12): a listed word `w` also accepts `upper(first code point of w) + rest of w` and `upper(w)`, with `String.prototype.toUpperCase`, the Unicode default case mapping. The Ignore list uses the same rule.
- Order on the Spelling page: the 005 `compareNames` over the UTF-8 bytes of each word.

### D11 Language selection setting

- Shell setting `spelling: {enabled, languages}` in `settings.json` (data-model §8), beside `defaultPullAction` and `switchChoice`. The default is `{enabled: true, languages: ["en"]}` (spec Assumptions).
- `setSpelling {enabled, languages}` is shell-only, as `setSwitchChoice` (004 Δ3). It answers the `readSyncSettings` result with `spelling`. The shell refuses with `INVALID_REQUEST`: more than 3 languages, a repeat, or an ID that is not `en` and not a catalog ID of the embedded catalog.
- At load, the shell drops each stored ID that is not `en` and not a catalog ID. So a release that removes a language also removes it from the selection (spec FR-017). The renderer then saves nothing.
- The renderer sends `setSpelling` for each change on the Spelling page at once, with no Save footer (O-3). A failure shows the existing 004 text "The setting did not change: <code>".

### D12 Licence link and licence text

- The row licence value is a link. Its `href` is the catalog URL of the first licence document, so the tooltip and the accessible name name the URL (spec FR-015). Activation prevents the WebView2 navigation and sends `openLicenceLink {language}`.
- `openLicenceLink` is shell-only. The shell takes the URL from the embedded catalog (`include_str!` of `src/contracts/dictionaries.json`, as `git_env.rs:24` reads `git-environment.json`). The new `links.rs` starts a dedicated thread, calls `CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)`, then `ShellExecuteW(None, "open", url, None, None, SW_SHOWNORMAL)`, then `CoUninitialize`. Microsoft Learn `ShellExecuteW` asks for COM initialization before the call, because Shell extensions can run through COM. A return value of 32 or less gives `failed` with reason `link`. The renderer never sends a URL.
- Show licence: English reads the bundled `dictionary-en/license` text through `?raw`. Another language reads each licence document with `readDictionary`. The panel decodes the bytes with `TextDecoder("utf-8")` and shows them as `textContent`, never as markup or Markdown (spec FR-015). `oc` shows both documents.

### D13 WSL Global Git settings save

- Service (`git-settings.ts`): the `config-save` precheck drops `if (p.scope === "global" && w.wsl !== undefined) return { refused: "INVALID_REQUEST" }`. The review, the stale check, the run, and the fresh listing stay unchanged (spec FR-019). The run already writes in the `globalConfig` context (`git-settings.ts:245`). `saveFiles` keeps `files.global` null for a WSL workspace (`git-settings.ts:156`). On WSL, null now means "Git's `--global` rule applies inside the distro" (spec FR-020).
- Shell (`process_requests.rs` `Kind::GlobalConfig`): a Windows Git keeps its launch folder target. A WSL installation gets `program: wsl::wsl_program()`, `git_identity: None`, `wsl: Some((installation, "/"))`, as `Kind::Clone` (`process_requests.rs:1874-1884`). `global_config_fits` stays, because `wsl.rs:519` adds `-C /` after `--no-lazy-fetch`. So the distro runs `--no-lazy-fetch -C / config set --global -- <key> <value>` and `--no-lazy-fetch -C / config unset --global -- <key>`, under policy `integrate`. The wrapper exports `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR=:`, and the WSL anchor starts before the Git process (`process_requests.rs:1699-1709`). `WSLENV` stays empty (`wsl.rs:123-133`), so no Windows variable reaches the distro (spec FR-021).
- Reads stay in the registered WSL context: the `config list --show-scope --show-origin -z` listing, the `--global` file listing, and `git var`.
- Renderer (`GitSettingsPage.tsx`): the Global rows unlock when the workspace is WSL, also with `files.global` null. `scopeFile` shows the FR-020 text in place of `TEXTS.noGlobalFile` for a WSL Global scope. `emptyRemoves` shows for that scope too. The `SettingsView` prop `wsl: boolean` becomes `wslDistro: string | null`, from `workspace.location.distro` (`envelope.ts:750-754`).
- Outcomes: the 004 texts stay (Settings view): "Git saved the settings.", "Save did not complete: Git did not write <key> (exit <n>).", the bounded output tail, "<key> changed before its write, so Arbareto did not write it.", and "A setting changed after Arbareto read it. Arbareto read the values again. Check them, then save again.". A cancel can leave `config.lock`. The fresh listing decides, and the next save shows Git's refusal (spec Edge Cases).
- The status bar keeps the 001 text "Git <version> (WSL: <distro>)" (`Workbench.tsx:584`). The WslGlobal board draft "Git 2.55.0 in Ubuntu-26.04" does not replace it (O-6).

### D14 WSL test double and WSL rows

- Precondition (spec "Open 005 point"): after 005 merges, WP4 checks whether `wsl.rs` and `wsl-process.json` still hold the `append` mode and whether `tests/wsl/workbench-wsl.test.ts` still holds the T081 `fileAppend` block. A leftover goes to the orchestrator as a 005 follow-up. 006 adds no `append` route.
- New double routes (`tests/git/bun-runner.ts`, spec FR-023):
  - `globalConfig` with a WSL Git: the target of D13, with `cwd` the UNC root of `/` of that distro. It refuses with `INVALID_REQUEST` "WSL globalConfig without wslGlobalConfig" when the option `wslGlobalConfig` is absent, before any process.
  - `worktreeAdd` with a WSL Git: the bound path must be a UNC path of the same distro. `wslParts` gives the Linux path for the argument check. The `cwd` is the repository worktree root. It refuses without `wslGlobalConfig`.
  - `destinationFacts` of a WSL `worktreeAdd` binding: the `wslFiles` text in mode `destination` through the wrapper in `probe` mode, with the Linux path on stdin, as `wsl.rs:1480-1505`.
  - No control mutation may drop the `wslGlobalConfig` forwarding.
- Before the first write, each Global case reads `git var GIT_CONFIG_GLOBAL` through the double and requires the owned path (spec FR-023).
- Global cases (Q21, SC-005): save and remove each FR-060 key of 004 in Global; the owned global file changes only in that key, and every other configuration byte stays; a multi-valued key and an included value stay read only; Cancel; a stale value before the review gives the 004 `changedOutside` path, and a change after the review gives `stale`. The mode case sets `core.sharedRepository=0660` in the repository, removes the owned global file, reads the umask with the wrapper in mode `integrate` around `/bin/sh -c umask`, and refuses to run when `0666 & ~umask` equals 0660. After the save, `stat -c %a` of the new global file must equal `0666 & ~umask`. The test reads the SHA-256 of the real `~/.gitconfig` and of the real XDG file inside the distro before and after, without the forwarding (spec FR-025). An XDG global file cannot run through the double, because `GIT_CONFIG_GLOBAL` wins (research R9), so it stays unverified on WSL.
- Safe control mutation: the double runs the Global write in `registered(w)` instead of `globalConfig`. The mode case must fail with 0660.
- R21 rows (spec FR-024), each against Git's own commands on a copy in the same distro, with the Windows test as the source of the cases:

| Row | Cases | Windows source | WSL need |
|---|---|---|---|
| Q8 | A remote branch with two mapping refspecs | `tests/git/switch.test.ts` | none |
| Q9 | Delete a branch of another worktree; a branch that moved after the review | `tests/git/branch-ops.test.ts` | none |
| Q10 | Every merge option and allowed combination | `tests/git/merge-rebase.test.ts` | none |
| Q11 | The force note for the push tracking ref | `tests/git/merge-rebase.test.ts` | a bare remote in the owned distro folder (unverified until it runs) |
| Q13 | AU, UA, UD, DD, and the symlink stage | `tests/git/resolve.test.ts` | none |
| Q15 | A folder, all changes, one refused file, `STALE_SELECTION` | `tests/git/multi-stage.test.ts` | none |
| Q16 | Added and removed hunks, and the refusals | `tests/git/line-stage.test.ts` | none |
| Q20 | Open worktree; remove a locked worktree and the main worktree; Add worktree through the service | `tests/git/worktrees.test.ts` | the WSL `worktreeAdd` and `destination` routes |
| Q21 | The Global saves above | `tests/git/git-settings.test.ts` | the WSL `globalConfig` route |
| Q22 | Not now, Stop trusting, the version 1 record | `tests/git/trust-v2.test.ts` | none |
| Q23 | A refusal, the host line, Retry, Cancel | `tests/git/submodule-scope.test.ts` | the host line needs an SSH server that the distro reaches (003 T008 rule, unverified until it runs) |

- Each cancel or close case ends with no Git process and no `arbareto-*` scope in the distro (SC-006).
- A row that needs a resource the harness lacks records `OBSERVATION T<id> unverified <cause>` and stays unverified (spec FR-024).

### D15 Frontend architecture

- `src/frontend/spelling/store.ts`: the selection (from `readSyncSettings` `spelling`), the language states, the word list state, the Ignore list, and the subscriptions. It follows the 001 latest-wins rule.
- `engine.ts`: the workers, the loads and their deadline, the rounds, the merge, and the suggestions (D9). `word-list.ts`: the IndexedDB store with an injected `IDBFactory`, as `draft-store.ts`.
- `SpellMirror.tsx`, `SpellChip.tsx`, and `SpellMenu.tsx`: used by `CommitTray.tsx`. `SpellMenu` renders the house `ActionMenu` with `anchor` at the mark span.
- Menu opening (spec FR-005): a `contextmenu` event whose point lies inside a client rect of a mark span opens the menu and calls `preventDefault`. Shift+F10 and the Menu key on `keydown` with `selectionStart === selectionEnd` and the caret at an offset o with `start ≤ o ≤ end` of a mark open it with `byKey`, as `ChangesPane.tsx:717`. Every other event keeps the default, so the built-in menu with Cut, Copy, Paste, and Select all opens (004 FR-085, `suppressPageMenu`).
- Suggestion: the engine checks that the textarea text in the mark range still equals the raw text of that range in the round's text (data-model §13 `raw`), not the NFC form. Then `setSelectionRange(start, end)` and `document.execCommand("insertText", false, suggestion)` replace only that word as one undo step (N2). A changed range or a `false` return changes nothing and shows the D17 replace text.
- Cut and Copy: `document.execCommand("cut")` and `("copy")` on the textarea selection. With an empty selection, they are unavailable with their D17 reason. Select all: `textarea.select()`.
- `settings/SpellingPage.tsx` and `LicencePanel.tsx`: D16. `SettingsView.tsx` adds "Spelling" to `APP_PAGES` after "Branch switch".
- `about/AboutDialog.tsx`: shows the `hunspell-wasm` note of D18 beside its licence texts.
- `bridge.ts`: the five service operations and the two shell-only operations, with progress for `downloadDictionary`.

### D16 UI layout, keys, and tokens

- Tokens: the 001 and 004 tokens only. The mockup values equal `index.css:80-97`: Canvas `#191B1F`/`#F4F5F7`, Surface `#26292F`/`#FFFFFF`, Text `#DADDE3`/`#20242C`, Muted `#9EA4AF`/`#576171`, Divider `#353A42`/`#DDE0E6`, Control border `#6E7682`/`#778294`, Accent `#7AA7F0`/`#245CB5`, Hover `#31353C`/`#EBECEF`, Selected `#2B3A50`/`#DCE8FA`, Added `#7FD19B`/`#17613B` with fill `#1C3326`/`#E9F5ED`, Removed `#F09999`/`#9F2636` with fill `#3D2328`/`#FCECEE`, Warning `#E2C06E`/`#765500` with fill `#3A321C`/`#FFF4D4`, title bar `#202227` (Dark/Light). The Ink and Warm palettes keep their own Removed value (`index.css:163`, `:186`). No new color token.
- Fonts: the UI font at 12/18 px; the code font for the editor, the mirror, the words of the personal list, file names, and the licence text.
- Commit editor (Main board): the D8 box; the chip 18 px high, 1 px border, radius 4, padding 0 4 px, gap 4 px, the 12 px `SpellCheckIcon`. Normal: Accent border and text. Off: Control border and Muted text, no icon. No language loaded and a failed selected language: Warning border and text, and the 12 px `Alert02Icon`.
- Spelling menu (Main board): the house `ActionMenu` (004 D15, D16), 28 px items, groups with separators: the suggestions (labels only, the icon slot empty); "Ignore" (`ViewOffSlashIcon`) and "Add to dictionary" (`BookPlusIcon`); "Cut" (`ScissorIcon`, Ctrl+X), "Copy" (`Copy01Icon`, Ctrl+C), "Select all" (`TextSelectIcon`, Ctrl+A). With no suggestion, the first group is absent (SpellingEdges board, cell 6).
- Spelling page (SpellingPage board): the content padding 16 px 28 px 16 px 16 px, gap 12 px. The heading row: "Spelling" (14/600) and the switch (40 × 20 px, `role="switch"`), its label, and "On" or "Off" in Muted text, gap 16 px. The 004 app setting note follows the heading row (O-9). Then a grid `minmax(0, 1fr) 312px` with a 16 px gap. Panels: 1 px Divider edge, radius 4, Canvas fill, a 32 px header with padding 0 8 px 0 12 px, the 12/600 heading, and the Muted count.
- Languages table: header cells 28 px, Muted 600; rows 32 px, padding 4 px 6 px, a 1 px Divider rule; the checkbox column 28 px; Size with tabular numbers; the message row under its row with padding 0 6 px 8 px 40 px, and no rule between the two. Row buttons 24 px high with padding 0 8 px: "Download" (`Download04Icon`), "Retry" (`RefreshIcon`), "Cancel", "Import…", "Show licence". Remove sits in its own last column in the Removed text with `Delete02Icon`. The progress bar is 64 × 4 px, radius 2, the Hover track, and the Accent fill. Selected rows show the name at weight 600. The panel scrolls by itself.
- Selected languages panel: the limit note (padding 8 px 12 px 4 px); 28 px rows with padding 0 4 px 0 12 px: the position number (16 px, Muted, tabular), the name, and 24 px icon buttons Move up (`ArrowUp01Icon`) and Move down (`ArrowDown01Icon`). The selected row has the Selected fill and the 2 × 16 px Accent marker. Then the chip preview line in Muted text.
- Personal word list panel: the count line; 28 px rows with the word in the code font and a 24 px Remove icon button in the Removed text. The list is virtual (`@tanstack/react-virtual`) and scrolls by itself.
- Licence view (LicenceView board): while a licence shows, the Languages panel shows the compact form at 340 px wide (Language, State, Show licence) with 32 px rows, and the licence panel takes the rest of the width. The panel header holds the language name (12/600), the licence value and the file name (code font) in Muted text, the byte count, and the 28 px close button (`Cancel01Icon`). The `readme.md` note row has the Warning fill and `InformationCircleIcon`, padding 8 px 12 px. The text region uses the code font, `white-space: pre-wrap`, `overflow-wrap: anywhere`, padding 8 px 24 px 8 px 12 px, its own scrollbar, `tabindex="0"`, and `role="document"`. One licence shows at a time. `oc` shows its two documents one after the other, each with its file name and byte count.
- Dictionary failures (DictionaryFailures board): each FR-016 text shows in the message row under its row, as `role="status"`. The release removal notice shows above the Languages table with the Warning fill and `InformationCircleIcon`.
- WSL Global header (WslGlobal board): the FR-020 text in the scope-file slot of the 004 header, cut with an ellipsis, with the full text in its tooltip. `GIT_CONFIG_GLOBAL` and `~/.gitconfig` use the code font in the Text color.
- Keys (spec FR-026, SC-007; conflict check against 001 to 005):

| Key | Action | Scope | Conflict check |
|---|---|---|---|
| Shift+F10, Menu key | Spelling menu | Message editor, caret in a marked word | 004: elsewhere the built-in menu opens. |
| Escape | Close the menu | Spelling menu | Base UI default. |
| Up, Down, Home, End | Move between rows | Languages table, Selected languages, Personal word list | 001 roving focus rule. |
| Left, Right | Move between the controls of a row | Languages table, Selected languages, Personal word list | None. |
| Space | Select or clear the language | Languages table, checkbox | None. |
| Alt+Up, Alt+Down | Move the language up or down | Selected languages row | 005 Alt+Up and Alt+Down act only in the History diff. |
| Escape | Close the licence text | Licence panel | 004 Escape closes Settings. The panel takes it first. |

- Each of the three lists is one Tab stop with roving focus. F6 keeps the 004 Settings order: the page list, then the page, where the Languages table, Selected languages, Personal word list, and the licence panel follow in that order.
- Forced colors (ForcedColors board): the wave uses `CanvasText`, so the shape stays the cue. The focused menu item uses Highlight with HighlightText. Menus, panels, and the chip keep a 1 px CanvasText edge. Unavailable items use GrayText. The progress bar takes `forced-color-adjust: auto`, and the "Downloading <n>%" text stays. Notice fills disappear, and their icons stay.
- Light (Light board): the 001 Light tokens. The Light title bar value stays open (004 O-13).
- Motion: none on marks, typing, selection, arrow keys, or the progress bar. The menu and the tooltips open with the 004 popover motion. Nothing moves under `prefers-reduced-motion: reduce`.

### D17 Texts

Every visible text of this feature comes from this list. `<Language>` is the catalog name, `<word>` the marked word, `<folder>` a Windows path, `<status>` an HTTP status number, and `<n>` a count with the en-US thousands separator.

- Commit editor:
  - Chip: "Spelling: <languages>" (the loaded languages in selection order, joined by ", "), "Spelling: Off", "Spelling: No language loaded".
  - Chip tooltip: the chip text; then one line per selected language that cannot load: "Arbareto cannot load the <Language> dictionary. Spell check uses the other languages."; one line per language that still loads: "Arbareto still loads the <Language> dictionary."; above 64 KiB: "Spell check covers at most 64 KiB of text."
  - Count: "No possible misspellings", "1 possible misspelling", "<n> possible misspellings".
  - Menu name: "Spelling of <word>". Items: each suggestion; "Finding suggestions…" (unavailable, while a worker computes); "Ignore"; "Add to dictionary"; "Cut" (Ctrl+X); "Copy" (Ctrl+C); "Select all" (Ctrl+A).
  - Unavailable reasons: Add at 10,000 words: "The personal word list holds 10,000 words. Remove a word first."; Add above 100 code points: "A word in the personal word list can have at most 100 characters."; Add with an unreadable list: "Arbareto could not read the personal word list."; Add without storage: "Arbareto cannot save words, because the app storage is not available."; Cut and Copy without a selection: "Select text first."
  - Notices in the tray (`role="status"`): a failed Add: "Arbareto could not save the word. The commit and the draft are not affected."; a failed replace: "Arbareto could not replace the word. The text stays unchanged."
- Spelling page:
  - Page name "Spelling". Heading "Spelling". Note: "Arbareto setting for all repositories. Not stored in Git configuration." (004 `TEXTS.appSetting`).
  - Switch: label "Spell check", state "On" or "Off".
  - Loading: "The dictionary states are still loading…". Failure: "The dictionary states did not load: <code>."
  - Languages panel: heading "Languages", the row count, and "Download counts as acceptance of the licence.". Column headers: "Selected" (hidden), "Language", "Size", "Licence", "State", "Actions" (hidden), "Remove" (hidden).
  - Size: "<x.xx> MB", with x.xx = floor((bytes + 5,000) / 10,000) / 100.
  - Licence link: the `package.json` licence value as given. Tooltip: "Full licence text" and, on a second line, the URL.
  - States: "Bundled", "Not downloaded", "Downloading <n>%" with n = floor(100 × received / total), "Importing…", "Ready", "Changed", "Failed".
  - Buttons and their accessible names: "Download" ("Download <Language>"), "Retry" ("Retry <Language>"), "Cancel" ("Cancel the <Language> download"), "Import…" ("Import… <Language>"), "Show licence" ("Show licence of <Language>"), "Remove" ("Remove <Language>"). Checkbox: "Select <Language>". Progress bar: "Download <Language>".
  - Message rows, `eu` and `et`: "This dictionary has no licence file. Its readme names the licence."
  - Message rows, the FR-016 texts (spec FR-016, copied here):
    - `transport`: "Arbareto could not download the <Language> dictionary. Check the connection, then select Retry, or use Import."
    - `http-not-found`: "The download host has no <Language> dictionary file at the pinned source. Use Import, or update Arbareto."
    - `http-rate-limit`: "The download host limits downloads now (HTTP 429). Select Retry later, or use Import."
    - `http-status`: "The download host answered HTTP <status> for the <Language> dictionary. Arbareto kept no file."
    - `redirect`: "The download host moved the <Language> dictionary file. Arbareto stopped the download. Use Import, or update Arbareto."
    - `not-https`: "The <Language> catalog entry has no HTTPS URL. Arbareto did not download it."
    - `DEADLINE`: "The <Language> download did not end within 120 seconds. Arbareto kept no file. Select Retry, or use Import."
    - `mismatch`: "The downloaded <Language> file does not match the catalog. Arbareto deleted it."
    - Cancel: "Download canceled. Arbareto kept no file."
    - `save`: "Arbareto could not save the <Language> dictionary in <folder>."
    - `changed`: "The <Language> dictionary files changed. Download the dictionary again."
    - `import-mismatch`: "These files are not the <Language> files of the catalog. Arbareto did not import them."
    - A load failure, a load deadline, and `absent` of a selected language: "Arbareto cannot load the <Language> dictionary. Spell check uses the other languages." The chip tooltip and the row show it.
    - `catalog-changed`: "This Arbareto release has new <Language> dictionary files. Download the dictionary again."
    - `catalog-removed` (above the table): "This Arbareto release has no <Language> dictionary. Arbareto removed it."
    - `busy`: "Another dictionary download or import runs. Wait for it to end."
    - A word list read failure: "Arbareto could not read the personal word list."
  - Message rows, plan texts: `import-unreadable`: "Arbareto could not read the <Language> files in <folder>."; `remove`: "Arbareto could not remove the <Language> dictionary from <folder>."; `link`: "Windows could not open the link. The address is <url>."
  - Selection: the note "Select at most 3 languages. English counts as one."; the limit reason "You can select at most 3 languages. Clear one first."; the not-ready reason "Download or import the <Language> dictionary first."
  - Selected languages panel: heading "Selected languages" and the count; Move up: name "Move <Language> up", tooltip "Move up (Alt+Up)", reason "<Language> is already first."; Move down: name "Move <Language> down", tooltip "Move down (Alt+Down)", reason "<Language> is already last."; preview "Chip: Spelling: <languages>"; empty: "No language is selected. Spell check marks no word."
  - Personal word list panel: heading "Personal word list" and the count; "<n> of 10,000 words"; Remove: name "Remove <word>", tooltip "Remove"; empty: "No words yet. Add a word from the spelling menu of the commit message."; read failure: "Arbareto could not read the personal word list."; no storage: "Arbareto cannot save words, because the app storage is not available."; a failed Remove: "Arbareto could not remove <word> from the personal word list."
  - Import picker title: "Choose the folder with the <Language> dictionary files".
  - Licence panel: the language name; the licence value; the file name; "<n> bytes" ("1 byte"); close button name and tooltip "Close the licence text (Esc)"; text region name "Licence text of <Language>", or "Readme text of <Language>" for `readme.md`; the readme note "This dictionary has no licence file. Its readme names the licence."; read failure "Arbareto could not read the licence text: <code>."
- About: the `hunspell-wasm` note of D18.
- WSL Global header: "Git in <distro> writes its global file. It uses GIT_CONFIG_GLOBAL when set, else ~/.gitconfig, or the XDG file when only that exists."
- Copy rule: "Label (Key)" in tooltips. "…" only when a further step follows: "Import…" opens the picker. "Downloading", "Importing…", and "Finding suggestions…" are states.

### D18 Licences and notices

- `hunspell-wasm`: its `package.json` names `(LGPL-2.0 OR GPL-2.0 OR MPL-1.1)`. The tarball holds `COPYING` (GPL 2), `COPYING.LESSER` (LGPL 2.1), and `COPYING.MPL` (MPL 1.1), and the TypeScript wrapper source, but no Hunspell C++ source (research R2). Arbareto uses Hunspell under LGPL-2.1, which AGPL-3.0-or-later code may use (GNU licence list).
- Notices (WP1): `src/frontend/build/notices.ts` `LICENSE_NAMES` gains `copying.lesser` and `copying.mpl`, so the inventory holds all three texts. Today it takes only `COPYING`. A fixed note for `hunspell-wasm` joins the inventory: "Arbareto uses Hunspell under LGPL-2.1. Source: https://github.com/rotemdan/hunspell-wasm (commit 8f755ef64e8b047b77b676f9698b3dfa5cb1887d) and https://github.com/hunspell/hunspell." The commit is the `gitHead` of the 0.3.0 registry record. About shows the note (WP7).
- Source link obligation: LGPL 2.1 section 6 asks that the user can get the library source. The tarball has none, so the note links the source. WP1 records whether that repository commit holds the Hunspell sources and the build files that made `hunspell.wasm` (F16). The legal reading of LGPL-2.1 Hunspell embedded in the application bundle stays a user and lawyer item.
- `dictionary-en` ships with the application, so the 004 notices inventory takes its `license` file from `bun.lock` (004 R20). WP1 checks that the full text appears in the generated inventory.
- Downloaded and imported dictionaries do not ship with the release. Each keeps its licence documents next to its files (spec FR-015). The catalog filters no licence. The legal readings of a run-time download and of the LGPL-2.1 use stay unverified.

### D19 Tests and fixtures

- Oracles: Git's own commands on a copy for the WSL rows (D14). The catalog bytes and SHA-256 values for every dictionary outcome. Exact word vectors for `spell-words.ts`. Hunspell itself for the language fixtures.
- Network: no test uses the network. Service tests inject `fetch`. P0.2 uses local `Bun.serve` servers on 127.0.0.1 only. Only `scripts/dictionary-catalog.ts` uses the network, at dev time, as the user allowed.
- Synthetic dictionaries: committed tests build small `index.aff` and `index.dic` texts in the test, and a synthetic catalog that `createSession` takes as an option. The repository holds no third-party dictionary (spec Assumptions).
- Early gate report: `tests/gate/dictionary-gate.test.ts` starts one Bun process per cached language with a 60 s timeout and kills it by PID at the end. It lies outside the `tests/groups.json` roots, so `bun run test:all` never runs it. Its command `bun test tests/gate` enters README "Development" only after it runs green.
- No-network evidence for SC-001 (O-13):
  - In `tests/contracts`, stubs of `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `navigator.sendBeacon` count zero calls during the spell check cases.
  - `tests/contracts/network-sites.test.ts` scans the source: `src/frontend` holds no `fetch(` call, and `src/git-service` holds exactly one, in `dictionaries.ts`, which only `downloadDictionary` reaches.
  - In the package, US1 passes in a Windows Sandbox with `<Networking>Disable</Networking>`, as `scripts/windows/clean-install.wsb` runs the package. There, Download shows the `transport` text and keeps no file (N6). Without Windows Sandbox, a capability skip records N6 as unverified.
- Each new test file under the `tests/groups.json` roots adds its line there. Timing tests go into `serial`. `tests/windows` and `tests/gate` files stay out of `tests/groups.json`.
- Control mutations copy the 001 rule: one control mutation turns each oracle red (tasks.md lists them per batch).
- A green run from a worktree prints where it imported the code under test (global rule). The 001 harness rules and the full-run tick rule stay in force.

### Invariants

| Invariant | Evidence |
|---|---|
| The pinned commit is the head of wooorm/dictionaries, with 92 dictionaries. el, el-polyton, ko, mn, and rw exceed 12 MiB. 87 dictionaries pass, 184.4 MiB together. | GitHub API tree of `8cfea406`, read 2026-10-22 (research R3) |
| `eu` and `et` have no `license` or `licence` file. `oc` has both. | Same tree |
| The `dictionary-en` 4.0.0 file sizes equal the pinned `dictionaries/en` sizes. | npm registry and the tree, 004 R20 and research R3 |
| raw.githubusercontent.com sends `Content-Encoding: gzip` with the encoded length in `Content-Length`. | Request of 2026-10-22 (research R4) |
| Bun `fetch` reads the proxy variables only without a `proxy` option. | Bun docs "Proxying requests" (research R4); F2 |
| A Bun connection failure rejects with a `TypeError` whose `code` is the socket error. | Bun docs "Error handling"; F6 |
| `hunspell-wasm` loads uk, fr, he, ru, tr, and en within 386 ms, with a process-tree peak increase of at most 82.5 MiB, in Edge 155. | `scratchpad\f006-wasm\runs\results.jsonl`, engine `hw` (research R2) |
| `WebAssembly.compile` throws under `script-src 'self'` and works with `'wasm-unsafe-eval'`. A worker with the CSP cannot fetch the wasm asset without the app origin in `connect-src`. | `scratchpad\f006-wasm\runs\csp.jsonl` (research R6) |
| Tauri 2.12.1 sets the CSP header only on `.html` assets. | `tauri-2.12.1/src/manager/mod.rs:422-439` |
| `Intl.Segmenter` gives "don't" as one word and "follow-up" as two. | Bun 1.4.3 run, 2026-10-21 and 2026-10-22 (research R6) |
| Inside a repository, Git applies `core.sharedRepository` to a new lock file. Outside, only the global and system configuration count. | Git 2.56 tempfile.c:135-152, path.c:739-789, repo-settings.c:196-208 (research R9) |
| `wsl.rs` adds `-C <directory>` after `--no-lazy-fetch` and keeps `WSLENV` empty. | `wsl.rs:519`, `:123-133` |
| A WSL mutation-class run starts its anchor before its first Git process. | `process_requests.rs:1699-1709` |
| `ShellExecuteW` returns a value above 32 on success and needs COM initialized before the call. | Microsoft Learn `ShellExecuteW` |
| The service log admits only `kind`, `operationId`, `durationMs`, `code`, `cause`, `count`, and `effects`. | `log.ts:23-52` |

## Open items and reviewer defaults

- **O-1 Engine and gate values.** Decided (user, 2026-10-22): Hunspell through `hunspell-wasm` 0.3.0. The 256 MiB and 10 s values stay. The packaged gate makes the final catalog cut (D3).
- **O-2 Two licence documents of `oc`.** Decided (user, 2026-10-22): both `license` and `licence` download and show. The row link names `license`.
- **O-3 Apply at once.** Reviewer default: each Spelling page change applies at once, as the 004 Pull default and switch choice do. No Save footer (SpellingPage board open point).
- **O-4 Filter field.** Reviewer default: no filter field for the Languages table. The spec has none. The grid keys of D16 reach every row (SpellingPage board open point). The user may ask for a filter.
- **O-5 Move labels.** Reviewer default: "Move <Language> up" and "Move <Language> down" with the tooltips "Move up (Alt+Up)" and "Move down (Alt+Down)" (SpellingPage board open point).
- **O-6 WSL status bar.** Decided by fact: the status bar keeps "Git <version> (WSL: <distro>)" (`Workbench.tsx:584`). The board draft does not change it.
- **O-7 Board texts marked TBD.** Reviewer default: the D17 texts for the 10,000-word limit, the 100-character limit, the storage failure, the word count line, and the licence close tooltip.
- **O-8 Licence layout.** Reviewer default: one licence panel at a time, with the compact language list beside it (LicenceView board). The board shows two panels as two examples.
- **O-9 App setting note.** Reviewer default: the note "Arbareto setting for all repositories. Not stored in Git configuration." follows the Spelling heading row, as on the 004 app pages. The SpellingPage board shows it in the Settings header.
- **O-10 Selection storage.** Reviewer default: the shell settings file, as the Pull default (spec FR-009). A smaller option is the renderer `localStorage` beside `arbareto.preferences.v1`, which needs no Rust change.
- **O-11 Proxy.** Decided (user, 2026-10-22): no proxy. Download connects directly with `proxy: false`. Import is the fallback behind a company proxy.
- **O-12 Root certificates.** Reviewer default: `tls.ca` is `tls.rootCertificates`, so `NODE_EXTRA_CA_CERTS` adds nothing (spec FR-010). F3 verifies it. If F3 fails, the shell adds `NODE_EXTRA_CA_CERTS` to its removed variables, and research R13 records the change.
- **O-13 No-network evidence.** Decided by fact: the 003 no-network harness (003 T079, `tests/windows/no-network.test.ts`) is not on main. 006 uses the D19 evidence.
- **O-14 Spell check above 64 KiB.** Reviewer default: no round runs above `COMMIT_MESSAGE_BYTES`. Such a message cannot commit anyway (001 contract §5).
- **O-15 Cut and Copy without a selection.** Reviewer default: unavailable with "Select text first.", as the Windows menus disable them.
- **O-16 English link.** Reviewer default: the English row links the pinned `dictionaries/en/license` URL, because the bundled files equal those files (D3).
- **O-17 Remove without confirmation.** Decided (user, 2026-10-22): Remove of a dictionary and of a personal word take no confirmation (constitution check N-1).
- **O-18 Suggestion worker.** Reviewer default (plan review, 2026-10-22): a second worker per language keeps suggestions off the check path. The smaller option is one worker per language with a recorded SC-004 gap of up to one suggestion call (about 300 ms) after a menu closes.

## Phases

### Batches

| Batch | Steps | Tracks that run in parallel | Content |
|---|---|---|---|
| 0 | P0.1, P0.2, P1, P2 | WP1, then WP2. | This plan, the catalog, the download and build facts, the pure logic, and the contracts. |
| 1 | P3, P4, P6, P0.3 (N1 and N2 on `bun run dev`) | A: WP3 (local Rust). B: WP5. C: WP6 (frontend; N1 and N2 after the WP3 CSP and before the WP6 suggestion and replace work). | The shell, the service dictionaries, the editor spell check, and the early facts N1 and N2. |
| 2 | P5, P7 | A: WP4 (local WSL, after WP3). B: WP7 (after WP5 and WP6). | The WSL parity and the Settings page. While WP4 runs its WSL tests, no other track runs tests: WP7 pauses its test runs until WP4 reports the end of its WSL run. |
| 3 | P8, P0.3 (in the package) | WP8 (WSL alone, then packaged, then the offline catalog rebuild). | Qualification, with F14 and N1 to N4 in the package. |

User stories by priority: P1 is US1 and US2 (WP2, WP3, WP4, WP6, WP7). P2 is US3 (WP1, WP3, WP5, WP7). P3 is US4 (WP4).

### Work packages, in run order

| WP | Agent | Files | Steps |
|---|---|---|---|
| WP0 | orchestrator | `specs/006-wsl-parity-spellcheck/{spec.md, plan.md, research.md, data-model.md, contracts/operations.md, quickstart.md, tasks.md}` | This plan. Then `/speckit-tasks` and `/speckit-analyze`. The 001 to 005 specs stay unchanged (spec "Changes to earlier requirements"). |
| WP1 | implementer (the F16 lookup by scout) | new `scripts/dictionary-catalog.ts` (with `--offline`), new `scripts/dictionary-gate.json`, new `src/contracts/dictionaries.json`, new `src/contracts/dictionaries.ts` (the `Catalog` schema only), `package.json` and `bun.lock` (`hunspell-wasm` `^0.3.0`, `dictionary-en` `^4.0.0`; WP1 is their only owner), `src/frontend/build/notices.ts` (the licence names and the `hunspell-wasm` note), `tests/contracts/notices.test.ts`, new `tests/gate/dictionary-gate.test.ts`, new `tests/gate/wasm-asset.test.ts` (F14), new `tests/git/dictionary-facts.test.ts` (F3 makes its test CA, server certificate, and key at test time with the openssl of the selected Git, so the repository holds no key), new `tests/contracts/dictionary-catalog.test.ts` (with the dependency test of contract Δ10: the `hunspell-wasm` integrity value in `bun.lock` and the `hunspell.wasm` SHA-256), `tests/groups.json`, `README.md` "Development" (the catalog and gate commands, only after they ran green), `src/frontend/highlight/guard.ts` and its call in `vite.config.ts` with `tests/contracts/highlight.test.ts` (the bundle check admits only the reviewed `hunspell.wasm` bytes, F14) | P0.1, P0.2. The script may read `api.github.com` and `raw.githubusercontent.com` (user decision, 2026-10-22). |
| WP2 | implementer | `src/contracts/{operations,envelope,errors,limits}.ts`, `src/contracts/dictionaries.ts` (types and helpers), new `src/contracts/spell-words.ts`, `src/contracts/schemas/`, `tests/vectors/`, new `tests/contracts/{spelling-contract,spell-words}.test.ts`; the ripple in `src-tauri/src/schema.rs`, `src/frontend/bridge.ts`, and the existing contract tests | P1, P2. After WP1. |
| WP3 | implementer-xhigh | `src-tauri/src/{process_requests,service,settings,dialogs,ipc,schema,lib}.rs`, new `src-tauri/src/links.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/main.json`, `src-tauri/tauri.conf.json` (the CSP, with its cargo test), and `src-tauri/src/env_sanitize.rs` only when F3 fails (O-12) | P3. `Local: Rust`. After WP2. |
| WP4 | implementer-xhigh | `src/git-service/git-settings.ts`, `tests/git/bun-runner.ts`, `tests/wsl/workbench-wsl.test.ts`, `tests/wsl/fixtures.ts` | P5. `Local: WSL`. After WP3. Its WSL runs run alone on Ubuntu-26.04, with no other test run on the host. |
| WP5 | implementer | new `src/git-service/{dictionaries,dictionary-store}.ts`, `src/git-service/{session,main}.ts`, new `tests/git/dictionaries.test.ts`, `tests/git/service-harness.ts` (the `dictionaryFolder`, `catalog`, and `fetch` options), new `tests/contracts/network-sites.test.ts`, `tests/gate/dictionary-gate.test.ts` (the SC-002 service path), `tests/groups.json` | P4. After WP2. Parallel with WP3 and WP6. |
| WP6 | frontend-implementer (loads arbareto-ux, vercel-react-best-practices, web-design-guidelines; the N1 and N2 run on `bun run dev` by scout) | new `src/frontend/spelling/{engine.ts,spell-worker.ts,english.ts,word-list.ts,store.ts,SpellMirror.tsx,SpellMenu.tsx,SpellChip.tsx,texts.ts}`, `src/frontend/commit/CommitTray.tsx`, `vite.config.ts` (the `dictionary-en` alias, the `hunspell.wasm` asset), `src/frontend/bridge.ts`, `src/frontend/app/Workbench.tsx` (the spelling store), new `tests/contracts/{spelling-editor.test.tsx,word-list.test.ts}`, `tests/groups.json` | P6. After WP2. Parallel with WP3 and WP5. It uses the WP1 packages and never edits `package.json` or `bun.lock`. |
| WP7 | frontend-implementer | new `src/frontend/settings/{SpellingPage,LicencePanel}.tsx`, `src/frontend/settings/{SettingsView,SettingsDialog}.tsx`, `src/frontend/settings/git/{GitSettingsPage.tsx,texts.ts}`, `src/frontend/about/AboutDialog.tsx` (the `hunspell-wasm` note), `src/frontend/app/Workbench.tsx` (the `wslDistro` prop), `src/frontend/bridge.ts`, new `tests/contracts/spelling-page.test.tsx`, `tests/contracts/workbench-settings.test.tsx`, `tests/contracts/platform-label.test.tsx` (the About note), `tests/groups.json` | P7. After WP5 and WP6. It pauses its test runs during the WP4 WSL runs. |
| WP8 | implementer writes, scout runs (WSL alone, then packaged) | new `tests/windows/{spelling-packaged,spelling-perf}.test.ts`, `scripts/windows/measure-ram.ps1` (`-Json`, `-IntervalMs`), `scripts/dictionary-gate.json` (the packaged gate results), `src/contracts/dictionaries.json` (the offline rebuild) | P0.3 in the package (F14, N1 to N4), then P8. Last step: `bun scripts/dictionary-catalog.ts --offline`, then `bun test tests/contracts/dictionary-catalog.test.ts`. |

Parallel tracks use disjoint files in separate worktrees. These files are not disjoint:
- `src/frontend/bridge.ts`: WP2 (ripple), then WP6, then WP7.
- `src/frontend/app/Workbench.tsx`: WP6, then WP7.
- `src/contracts/dictionaries.ts`: WP1 (schema), then WP2 (types and helpers).
- `src/contracts/dictionaries.json`: WP1 makes it. WP8 rebuilds it offline after the gate.
- `package.json` and `bun.lock`: WP1 only.
- `tests/gate/dictionary-gate.test.ts`: WP1 (the early report), then WP5 (the SC-002 service path).
- `tests/support/language-fixture.ts`: the data-model §16 fixture code. The first of WP5 (T023) and WP8 (T042) moves it there from `tests/gate/dictionary-gate.test.ts`.
- `src/contracts/envelope.ts`, `errors.ts`, `limits.ts`, `operations.ts`, and `schemas/`: WP2 owns them. A later package that needs a schema change reports it, and the orchestrator merges it.
- `src-tauri/`: only WP3 edits it, except the WP2 ripple in `schema.rs`.
- `tests/groups.json`: every WP appends its lines. The orchestrator resolves merge conflicts.
- `tests/git/bun-runner.ts`: only WP4. `tests/git/service-harness.ts`: only WP5.
- `src/git-service/log.ts`: no owner, because no package changes it (D2).

Dependencies: feature 005 merges first (spec Dependencies). 006 uses the 005 `compareNames` of `src/contracts/tree-order.ts` and the 005 public request bound. The 004 WSL rows and the 004 folder picker are on main.

## Agent context

Spec Kit v1.0.12 in this repository has no `update-agent-context` script, and `setup-plan.ps1` changes no agent file. So this step changes no `CLAUDE.md`. The new packages `hunspell-wasm` and `dictionary-en` need no CLAUDE.md rule. The catalog and gate commands enter README "Development" only after they run green (CLAUDE.md "Tool boundaries"). A CLAUDE.md change goes through `claude-md-management:claude-md-improver`.

## Complexity Tracking

No Constitution Check violation. The table stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
