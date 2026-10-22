# Implementation Plan: WSL Parity and Commit Message Spell Check

**Branch**: `006-wsl-parity-spellcheck` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-wsl-parity-spellcheck/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md) | Mockup (approved 2026-10-22): https://claude.ai/artifact/WX74LFkBZsAvyvFCPFiRJs

## Summary

The commit message editor marks misspelled words with a wavy underline. nspell runs in Web Workers, one per loaded language. English ships with the application. The Spelling page in Settings downloads, imports, selects, orders, and removes the other wooorm/dictionaries languages. Every dictionary file must match a SHA-256 catalog that ships with the release. The Global Git settings save works in a WSL repository, through Git in the distro with `/` as its working folder. The WSL tests run the 004 rows that had no WSL case, and Add worktree through the service. Fresh Git listings, HTTP status codes, file sizes, and SHA-256 values decide every outcome. No message text decides anything.

Eight facts drive the design (research R2 to R11):
- nspell keeps every affixed word form in memory. Bun 1.4.3 measured the load cost of seven languages on 2026-10-22, one language per process (R2). English took 96 ms and 27.5 MiB. Ukrainian took 5.5 s and 488.8 MiB, and French 3.3 s and 348.8 MiB. The Hebrew load did not end within 180 s. So the 256 MiB and 10 s gate of spec FR-017 will remove some languages, Ukrainian probably among them (O-1).
- One nspell instance holds one language (nspell readme). A Ukrainian load blocks its worker for seconds. So each language gets its own worker, and English marks never wait for another language (D9).
- The pinned commit `8cfea406b505e4d7df52d5a19bce525df98c54ab` is still the head of wooorm/dictionaries (GitHub API, 2026-10-22). It holds 92 dictionaries. el, el-polyton, ko, mn, and rw exceed 12 MiB, so at most 86 catalog entries remain without `en`. `oc` has both a `license` and a `licence` file. `eu` and `et` have neither (R3).
- raw.githubusercontent.com sends `Content-Encoding: gzip` with the gzip length in `Content-Length` (3,086-byte `en/index.aff`: 1,003 bytes on the wire, 2026-10-22). So the byte bound counts the decoded body, and `Content-Length` decides nothing (D4).
- Bun `fetch` reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` unless the request names a `proxy` option (Bun docs). So the service passes `proxy` explicitly: the `HTTPS_PROXY` value, or `false` (D4).
- The service already writes files (`index-lock.ts`) and starts with the application launch folder as its working folder (`service.rs:240`). So the service downloads, checks, and stores the dictionaries itself, with no new private request (D5).
- Inside a repository, Git applies that repository's `core.sharedRepository` to a new lock file (Git 2.56 `repo_create_tempfile_mode` → `adjust_shared_perm` → `repo_settings_get_shared_repository`). Outside a repository, only the global and system configuration count. So the WSL Global save runs Git with `-C /` (D13, R9).
- The shell already builds the WSL clone target with `wsl::wsl_program()`, no Git identity, and `/` as the `-C` folder (`process_requests.rs:1874-1884`). The `globalConfig` target copies that form (D13).

## Technical Context

**Language/Version**: The 001 to 005 versions stay: TypeScript `7.0.2`, Bun `1.4.3` (exact), Rust/Cargo `1.98.0`.

**Primary Dependencies**: New runtime packages: `nspell` `^2.1.5` (MIT, last release 2021-01-17, one dependency `is-buffer` `^2.0.0`, which resolves to 2.0.5, MIT) and `dictionary-en` `^4.0.0` (`(MIT AND BSD)`, last release 2023-11-03), npm registry, read on 2026-10-22 (research R2). The 001 to 005 packages stay: React `19.3.0`, `@base-ui/react` `^1.8.0`, `@tanstack/react-virtual` `^3.14.13`, `@hugeicons/core-free-icons` `4.3.5` as installed, Tauri `2.12.0`. No new Rust crate. The shell uses the installed `windows` crate feature `Win32_UI_Shell` for `ShellExecuteW` (D12).

**Storage**: Downloaded and imported dictionaries go to `<launch directory>/dictionaries/<id>/`. The launch directory is the per-user app local data folder, or `<ARBARETO_PROFILE_ROOT>/data` (`service.rs:108-113`, `profile.rs:22-29`). The language selection is a shell setting in `settings.json`, as the Pull default (D11). The personal word list is the IndexedDB database `arbareto-spelling` of the WebView2 profile, beside `arbareto-drafts` (D10). The Ignore list lives in renderer memory for the window session. The WSL Global save writes only the reviewed keys through Git in the distro.

**Testing**: Bun tests with an injected `fetch` seam and synthetic dictionaries (`tests/git`, `tests/contracts`). Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Real-language gate tests from a local cache outside the repository, one language per process, skipped with a stated reason without the cache (`tests/git/dictionary-gate.test.ts`). Windows packaged tests (`tests/windows`). WSL tests in Ubuntu-26.04 with Git 2.55 (`tests/wsl/workbench-wsl.test.ts`). Cargo tests for the shell.

**Target Platform**: Windows 11 x64 with WebView2 and Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0.

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: Fixed before measurement (constitution VII, user confirmation of 2026-10-22). SC-004: English marks within 1 s after the first open of the commit editor; a mark update within 100 ms after a keystroke for a 64 KiB message with every word marked; no interface stall above 50 ms; at most 256 MiB process-tree memory increase per loaded language. FR-017 gate per catalog language: the files at most 12 MiB (12,582,912 bytes), the load in the packaged WebView2 worker within 10 s, and the memory increase within 256 MiB. FR-011: a download ends within 120 s. FR-028: the 001 SC-005 input targets hold during loads, checks, and downloads (95% of inputs within 100 ms, every input within 500 ms).

**Constraints**: Spell check never uses the network and never blocks a commit. Only Download and Retry use the network, and only HTTPS to catalog URLs, with every redirect refused. The renderer sends language IDs, file names, offsets, and booleans only. It never sends a URL or a path. The renderer CSP stays `connect-src ipc: http://ipc.localhost`. No Git configuration file changes except the reviewed keys of a Global save. Logs hold kinds, IDs, codes, HTTP status numbers, and byte counts only, never a proxy value.

**Scale/Scope**: A catalog of at most 86 languages plus bundled English. At most 3 selected languages. A commit message of at most 64 KiB (`COMMIT_MESSAGE_BYTES`), about 10,000 words. A personal word list of at most 10,000 words of at most 100 code points each. Dictionary files of at most 12 MiB per language.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` version 3.0.0, before research and again after Phase 1.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | The WSL Global save keeps the 004 review: it binds the exact origin and key-value bytes of each changed key, checks them again before each write, and lets the fresh listing decide (D13). Dictionary work touches only the app-owned folder `<launch directory>/dictionaries`. A downloaded file becomes a dictionary only after its size and SHA-256 match, through a rename of a checked staging folder (D5). Spell check never changes the text without a user selection, and never blocks a commit (D8). | Pass, note N-1 |
| II. TypeScript/Bun | The download, the checks, the storage, the word rules, and the spell engine are TypeScript. Rust adds only platform work: the folder picker title, the licence link open with `ShellExecuteW`, the shell setting, and the WSL `globalConfig` target (D12, D13). | Pass |
| III. Validated boundaries | Typed operations with zod and the strict decoder. The renderer names a language ID and a catalog file name, never a URL or a path. The shell takes the import folder from the native picker and the licence URL from the embedded catalog (D6, D12). Every download has a byte bound, a 120 s deadline, and Cancel. Every read has a chunk bound (contract Δ5). | Pass |
| IV. Real Git verification | Each WSL row compares HEAD, refs, the index, working files, configuration bytes, and the operation state with Git's own commands on a copy in the same distro (D14). The Global save test checks the owned global file bytes, its mode, and the SHA-256 of the real `~/.gitconfig` and XDG file (SC-005). | Pass |
| V. Untrusted repositories | No dictionary operation runs a Git process or a repository program. The WSL Global save runs no repository program and needs no trust approval (FR-021). Dictionary files are untrusted input: the catalog SHA-256 pins them, a worker parses them, and the licence text shows as plain text (D7). A `HTTPS_PROXY` value can hold credentials, so no log line holds it (D4). | Pass, note N-2 |
| VI. Platform evidence | Packaged Windows evidence for the worker under the CSP, the marks at 100%, 150%, and 225% text scale, IME composition, a right-to-left line, the menu keys, one undo step, no network request, and the SC-004 and FR-017 budgets (P8). WSL evidence on Ubuntu-26.04. The packaged WSL Global save stays unverified by design (FR-025). | Pass, note N-3 |
| VII. Accessible and measured | Every new control has a label or icon, a tooltip, an accessible name, visible focus, and a stated reason when unavailable (D16). The wave shape is the mark cue. The budgets are fixed above, before measurement. | Pass |
| VIII. Locked dependencies | `nspell` `^2.1.5` and `dictionary-en` `^4.0.0` enter `package.json` with caret ranges, and `bun.lock` records the exact versions. Research R2 records the licence and upkeep review. No Rust crate and no `windows` feature is added. | Pass |
| IX. One planning process | All artifacts stay in `specs/006-wsl-parity-spellcheck`. The contract lists only deltas to 001 to 005. | Pass |

Notes from the second check:
- **N-1 (I, "Destructive actions … MUST require explicit confirmation")**: Remove of a dictionary deletes app-owned downloaded files, and Remove of a personal word deletes one preference record. Neither touches a repository, and each is undone by Download, Import, or Add to dictionary. So they take no modal confirmation. They stay apart from routine actions in their own column, in the Removed text style (FR-026, D16).
- **N-2 (V, "Logs and diagnostics MUST NOT contain credentials")**: Bun takes proxy credentials from the proxy URL user information. The service reads `HTTPS_PROXY` only to pass it to `fetch`. No log line, response, or event holds the proxy value or a URL.
- **N-3 (VI, "Untested behavior MUST remain explicitly unverified")**: Research R12 lists every unverified point: the explicit `tls.ca` against `NODE_EXTRA_CA_CERTS` (F3), proxy authentication and `NO_PROXY`, the IME check without an installed Japanese IME (N5), the packaged WSL Global save, the XDG global file on WSL, the Q11 force note and the Q23 host line on WSL (D14), and the legal reading of a run-time download.
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
└── dictionary-catalog.ts   # new: dev-time catalog build and local test cache (network, user approval)
src/
├── contracts/              # operations.ts, envelope.ts, errors.ts, limits.ts, schemas/
│                           # new: dictionaries.json, dictionaries.ts, spell-words.ts
├── git-service/            # session.ts, main.ts, git-settings.ts
│                           # new: dictionaries.ts, dictionary-store.ts
└── frontend/               # commit/CommitTray.tsx, settings/{SettingsView,SettingsDialog}.tsx, settings/git/{GitSettingsPage.tsx,texts.ts},
                            # app/Workbench.tsx, bridge.ts, vite.config.ts (root)
                            # new: spelling/{engine.ts,spell-worker.ts,english.ts,word-list.ts,store.ts,SpellMirror.tsx,SpellMenu.tsx,SpellChip.tsx,texts.ts},
                            #      settings/{SpellingPage.tsx,LicencePanel.tsx}
src-tauri/
└── src/                    # process_requests.rs, service.rs, settings.rs, dialogs.rs, ipc.rs, schema.rs, lib.rs; build.rs; capabilities/main.json
                            # new: links.rs
tests/
├── contracts/              # new: dictionary-catalog.test.ts, spelling-contract.test.ts, spell-words.test.ts, word-list.test.ts,
│                           #      spelling-editor.test.tsx, spelling-page.test.tsx; changed: workbench-settings.test.tsx
├── git/                    # new: dictionaries.test.ts, dictionary-facts.test.ts, dictionary-gate.test.ts; changed: bun-runner.ts
├── wsl/                    # changed: workbench-wsl.test.ts
├── windows/                # new: spelling-packaged.test.ts, spelling-perf.test.ts
└── vectors/
```

**Structure Decision**: The three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. The catalog `src/contracts/dictionaries.json` is the one source for the service, the renderer, and the shell. The word rules live in `src/contracts/spell-words.ts`, because spec FR-003 makes them part of the contract. That module has no runtime import, as `ignore-line.ts` and the 005 `tree-order.ts`.

## Design

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0.1 Catalog and gate facts | new `scripts/dictionary-catalog.ts`, new `src/contracts/dictionaries.json`, new `tests/git/dictionary-gate.test.ts` (WP1) | None. The script reads the pinned tree, downloads each dictionary once into the local cache, and gates it: the 12 MiB bound, the nspell load, the language fixture, and NFC. | The gate test loads one cached language per process and records its time, memory, and fixture result (F12, F13). A missing cache skips with its reason. | Ukrainian, French, and Hebrew can fail the gate (O-1). Network at dev time needs the user's approval. |
| P0.2 Download facts | new `tests/git/dictionary-facts.test.ts` (WP1) | None. Records the Bun 1.4.3 `fetch` behavior that D4 depends on, with local servers only. | F1 to F7 of research R12. | A fact fails. Record it in research.md R13 and change the contract before P4. |
| P0.3 Packaged facts | `tests/windows/spelling-packaged.test.ts` first cases (WP8 starts them after WP6) | None. | N1 to N4 of research R12: the worker under the CSP, `insertText` with one undo step, the menu keys, and the mirror alignment by UI Automation text ranges. | `execCommand("insertText")` keeps no undo step in WebView2. Then D8 changes before P6 ends. |
| P1 Pure logic | new `src/contracts/spell-words.ts`, new `src/contracts/dictionaries.ts` (WP2) | Algorithms only: the word segments and skip rules, NFC, the case rule, the mark merge, the size text, and the catalog schema. | Unit tests with exact vectors (data-model §11 to §13). | ICU word breaks differ between Bun and WebView2 for some scripts. The vectors stay in scripts whose breaks UAX #29 fixes. |
| P2 Contracts | `src/contracts/{operations,envelope,errors,limits}.ts`, `schemas/`, `tests/vectors/` (WP2) | Adds the operations, the code, the reasons, the phase, the bounds, and the shell setting of contract Δ1 to Δ10. | Schema tests and golden vectors in Bun and Rust. | typify drops ranges. Keep explicit Rust checks (001 §1). |
| P3 Shell | `src-tauri/src/{process_requests,service,settings,dialogs,ipc,schema,lib}.rs`, new `links.rs`, `build.rs`, `capabilities/main.json` (WP3) | The WSL `globalConfig` target, `setSpelling`, `openLicenceLink`, the `importDictionary` picker step, and the forwarded dictionary commands. | Cargo tests for each target, refusal, setting round trip, and the WSL argv. | Local only. |
| P4 Service dictionaries | new `src/git-service/{dictionaries,dictionary-store}.ts`, `session.ts`, `main.ts` (WP5) | US3 service part: list, read, download, import, remove, and the release reconcile. | SC-002 (synthetic), SC-003, every FR-016 text cause, Cancel, the deadline, one run at a time. | A Windows rename of a folder that another process holds open fails. The result then names the folder. |
| P5 WSL parity | `src/git-service/git-settings.ts`, `tests/git/bun-runner.ts`, `tests/wsl/workbench-wsl.test.ts` (WP4) | US2 service part, and the US4 rows. | SC-005, SC-006, the control mutation of D14. | `wslParts` of the UNC root for `/` (research R10). |
| P6 Editor spell check | new `src/frontend/spelling/*`, `commit/CommitTray.tsx`, `vite.config.ts`, `bridge.ts`, `package.json`, `bun.lock` (WP6) | US1. | SC-001, SC-008, the menu, the case rule, the word list bounds, Ignore. | The mirror alignment and the mark update time at 64 KiB. |
| P7 Settings | new `settings/{SpellingPage,LicencePanel}.tsx`, `settings/SettingsView.tsx`, `settings/git/{GitSettingsPage.tsx,texts.ts}`, `app/Workbench.tsx` (WP7) | US3 UI and the US2 Global header. | Component tests per FR. | 87 rows by keyboard. The grid keys of D16 bound it. |
| P8 Qualification | `tests/windows/{spelling-packaged,spelling-perf}.test.ts`, one full WSL run (WP8) | None (tests). | SC-004, SC-007, SC-009, FR-017 packaged gate, FR-028, no network. | The IME needs an installed Japanese IME, else a capability skip. |

Each step writes its tests first. P0.1 and P0.2 are the riskiest proofs and run first in WP1.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. Summary:
- New service operations: `listDictionaries`, `readDictionary`, `downloadDictionary`, `removeDictionary`, and the native-first `importDictionary` (D3 to D7).
- New shell-only operations: `setSpelling` (D11) and `openLicenceLink` (D12). The 003 `readSyncSettings` result gains `spelling`.
- New code `DICTIONARY_UNAVAILABLE` with its reasons (contract Δ9). The 001 codes `DEADLINE`, `CANCELED`, `UNKNOWN_TARGET`, `INVALID_REQUEST`, and `BUSY` keep their meaning.
- New progress phase `dictionary` with the counters `received` and `total`.
- The 004 `globalConfig` context gains its WSL form (contract Δ6, Δ11). The `config-save` precheck drops its WSL refusal.
- No new private native process request. The service reads and writes only the app-owned folder and the folder that the shell picker returns.

### D2 Process model and outcomes

- A dictionary operation names no repository. It runs no Git process. It never waits for a Git operation, and a Git operation never waits for it (spec FR-011). It does not enter the 001 read scheduler, the mutation exclusion, or `MUTATIONS`.
- One dictionary run at a time: a `downloadDictionary` or `importDictionary` holds the service dictionary lock for its whole run. A second one gets `DICTIONARY_UNAVAILABLE` reason `busy` before any byte moves. `removeDictionary` of the language under a run gets `busy` too. `listDictionaries` and `readDictionary` never wait for the lock.
- Release reconcile (spec FR-017, data-model §3): the first dictionary operation of each service process takes the lock and reconciles the folder once (D5). Later operations skip it.
- Cancel: the 001 `cancel {operationId}` aborts the `fetch` and the file steps of that run. The response is `canceled`, and the staging folder goes. Cancel is never rollback (001 FR-023).
- Deadline: one timer of `DICTIONARY_DOWNLOAD_DEADLINE_MS` (120 s, equal to `REGISTERED_DEADLINE_CAP_MS`) per download. Its own flag records the cause before the abort, so `DEADLINE` and `CANCELED` never depend on an error object.
- `readDictionary`: at most `SPELLING_LANGUAGES` (3) run at the same time. A fourth gets `BUSY`. Each call reads the whole file, checks it, and returns one chunk (D7).
- Progress: phase `dictionary` with `received` and `total`, at most `DICTIONARY_PROGRESS_EVENTS_PER_SECOND` (4) events per second. Events carry no URL, path, or name.
- Close: a dictionary run is no mutation, so `requestClose` lists none. A service exit during a run leaves a staging folder, and the next reconcile removes it (D5).
- Logs: the operation kind, the language ID, the code, the reason, the HTTP status, and byte counts. No URL, path, or proxy value.

### D3 Catalog

- File `src/contracts/dictionaries.json` (data-model §1, §2). `scripts/dictionary-catalog.ts` makes it at dev time from the pinned commit. Only an application release changes it (spec FR-017).
- Source facts (research R3): the GitHub tree of `8cfea406b505e4d7df52d5a19bce525df98c54ab` lists each `dictionaries/<id>/` folder with its files and sizes. The script downloads each file once from `https://raw.githubusercontent.com/wooorm/dictionaries/<commit>/dictionaries/<id>/<name>` into the local cache and computes the SHA-256 there.
- Licence documents: every file named `license` or `licence` of that folder, in that order. A folder with neither uses `readme.md` (`eu`, `et`). So `oc` gets two licence documents (O-2). The row link names the first document.
- SPDX name: the `license` field of the folder's `package.json`, as given. `en` gives `(MIT AND BSD)`, `eu` gives `GPL-2.0`, `et` gives `LGPL-2.1`, and `oc` gives `GPL-2.0` (read on 2026-10-22).
- Name: `Intl.DisplayNames("en", {type: "language"})` of the ID, in Bun 1.4.3 at script time. A result that equals the ID itself fails the script, and the script then takes the name from its reviewed override table. The JSON stores the name, so the run-time ICU version changes nothing.
- Order: by name, with the 005 `compareNames` over the UTF-8 bytes. No locale compare.
- Gate (spec FR-017), each entry:
  1. The files together are at most 12,582,912 bytes. This drops el, el-polyton, ko, mn, and rw (research R3).
  2. nspell 2.1.5 loads `index.aff` and `index.dic`, and the language fixture passes (data-model §16).
  3. The packaged WebView2 worker loads the language within 10 s (P8, N7).
  4. The packaged process-tree memory increase stays within 256 MiB (P8, N7).
  Step 1 runs in the script. Step 2 runs in the script and in `tests/git/dictionary-gate.test.ts` in Bun as an early report, with a 60 s process bound. Bun is not the product runtime (spec SC-002), so a Bun time decides nothing. Steps 2 to 4 decide in `tests/windows/spelling-perf.test.ts`. That test copies each cached language with its `entry.json` into the dictionary folder of a scratch profile, selects only that language in `settings.json`, starts the package, and loads the language in the commit editor. It then types the positive fixture words and requires "No possible misspellings", and types the negative words and requires their count. A failure enters `scripts/dictionary-gate.json` with its measured values, and the script leaves that entry out on the next run. The shipped catalog holds only entries that passed all four steps.
- `en` stays out of `entries`: the bundled `dictionary-en` 4.0.0 files equal the pinned `dictionaries/en` files (3,086, 551,762, and 15,731 bytes). The catalog record `bundled` holds their names, sizes, SHA-256 values, URLs, and the licence data, and a contract test checks them against `node_modules/dictionary-en` (research R3).
- Load at start: the service, the renderer, and the shell parse the JSON with the `Catalog` schema of `src/contracts/dictionaries.ts`. A schema failure stops the service start, the renderer build, and the shell build. Every URL must equal `https://raw.githubusercontent.com/wooorm/dictionaries/<commit>/dictionaries/<id>/<name>` exactly.
- Local test cache: the script fills `<ARBARETO_DICTIONARY_CACHE>/<commit>/<id>/<name>`. The folder must lie outside the repository. Tests read it only, and skip with "dictionary cache absent: set ARBARETO_DICTIONARY_CACHE" without it (spec SC-002).

### D4 Download

- Request `downloadDictionary {language}` (contract Δ3). `language` must be a catalog ID. Spec FR-010: only a user selection of Download or Retry sends it.
- Steps, under the dictionary lock:
  1. The release reconcile (D2), once per service process.
  2. For each file of the entry, in catalog order: `new URL(url).protocol` must be `https:`, else reason `not-https` and no request.
  3. `fetch(url, {redirect: "manual", proxy, tls: {rejectUnauthorized: true, ca: tls.rootCertificates}, signal, keepalive: false})`. `proxy` is the `HTTPS_PROXY` value that `environmentValue` (`trust.ts:57`, with the platform name fold) reads from the service environment, or `false` without one. So Bun reads no other proxy variable (Bun docs "Proxying requests"; F2). The explicit `ca` keeps `NODE_EXTRA_CA_CERTS` out, and `rejectUnauthorized: true` keeps `NODE_TLS_REJECT_UNAUTHORIZED` out (F3, unverified until F3 runs).
  4. Status: 200 goes on. 300 to 399 gives reason `redirect`, also for the same host (spec FR-010, F1). 404 gives `http-not-found`. 429 gives `http-rate-limit`. Any other status gives `http-status` with `status`. A rejected `fetch` or a rejected body read that is not this run's abort gives `transport`. The run's own flags decide Cancel and the deadline (D2).
  5. Body: the service reads the decoded stream into the staging file and counts the bytes. At the catalog size plus one byte, it cancels the stream (F4). It hashes with `Bun.CryptoHasher("sha256")`. A byte count or SHA-256 other than the catalog gives reason `mismatch`. `Content-Length` and `Content-Encoding` decide nothing (research R4).
  6. After every file matches: the manifest `entry.json` (data-model §3), then the install swap of D5.
- Each failure and Cancel removes the staging folder, so no file stays (spec FR-011, SC-003). A failed removal stays for the next reconcile.
- A write error (`ENOSPC`, `EACCES`, `EPERM`, `EIO`, or any other `node:fs` rejection) gives reason `save` with `folder`, the Windows path of `<launch directory>\dictionaries\<id>`.
- Progress: `received` counts the decoded bytes of all files, `total` is the sum of the catalog sizes.
- Result `{language, state: "ready"}` (data-model §5).

### D5 Dictionary folder, install, and release reconcile

- Folder `<launch directory>/dictionaries`. The service takes the launch directory from its working folder at start, which the shell sets (`service.rs:240`). `createSession` takes `dictionaryFolder` as an option, so tests own their folder.
- Layout: `<id>/index.aff`, `<id>/index.dic`, each licence document, and `<id>/entry.json`. The manifest holds the catalog entry that the files came from (spec FR-017).
- Install swap: the run writes into `.staging-<id>-<32 hex>/`. After the checks, it renames an existing `<id>/` to `.old-<id>-<32 hex>/`, renames the staging folder to `<id>/`, and removes the old folder. A crash between two renames leaves dot folders, which the next reconcile removes. A language folder without a valid manifest counts as Changed.
- Release reconcile, once per service process, under the lock (data-model §3):
  - Each entry whose name starts with `.staging-` or `.old-` goes.
  - A folder whose name is a catalog ID: its manifest equals the current entry, so it stays. A manifest that differs: the folder goes, and the notice `catalog-changed` for that ID holds for this service process (spec FR-017 text).
  - A folder whose name is no catalog ID and whose manifest parses with that ID: the folder goes, and the notice `catalog-removed` with the manifest name holds for this service process.
  - Any other entry stays untouched. Arbareto never guesses whose it is.
- Removal uses `rm` with `recursive: true`, which removes a link and never follows it (Node API that Bun implements; F7).

### D6 Import

- `importDictionary {language}` is native-first (contract Δ3). The shell checks the ID against the embedded catalog and shows the 004 folder picker with the title of D17. Cancel gives `canceled`. A picker failure gives `rejected` `PICKER_FAILED`. The shell forwards `{language, folder}`. The renderer never sends a path.
- Service steps, under the dictionary lock: the reconcile; then for each catalog file name, `stat` of `<folder>/<name>` must give a regular file with the catalog size. The service reads at most the size plus one byte and hashes it. A missing file, another type, another size, or another SHA-256 gives reason `import-mismatch` (spec FR-012). A read error other than `ENOENT` gives reason `import-unreadable` with `folder`. Then the staging and install of D5. No network request runs.
- A picked folder in a WSL distro is read through its UNC path. The files hold at most 12 MiB.

### D7 Read and the load check

- `readDictionary {language, file, offset}` (contract Δ3). `file` is one file name of the catalog entry. `offset` is a multiple of `DICTIONARY_CHUNK_BYTES` (1 MiB) below the file size, or 0.
- Steps: the reconcile; an absent `<id>/` gives reason `absent`; an absent manifest, a manifest other than the entry, a missing file, or a size other than the catalog gives `changed`. The service reads the whole file and hashes it. A SHA-256 other than the catalog gives `changed` (spec FR-013). Then it returns the chunk at `offset` as base64, with the size and the chunk length.
- Each call checks the whole file, so every chunk comes from bytes that equal the catalog. The renderer joins the chunks of one file. The service keeps no load state.
- Cost: 1 MiB chunks keep each response near 1.4 MB of JSON, so the main thread parses each one in a few milliseconds (FR-028). An 8.5 MB `index.dic` takes 9 calls, and each hashes 8.5 MB again (research R5).
- `listDictionaries {}` gives the state of every catalog language with the same file checks, the running download or import, and the session notices (data-model §4).

### D8 Spell check in the commit message editor

- Scope (spec FR-002): only the `CommitTray.tsx` message `textarea`. It serves Commit, Amend last commit, and Commit and push. The merge message, file content, diffs, and names get no check.
- The textarea stays a plain `textarea` with `spellCheck={false}`, its drafts flow, its 72-column guide (`guideStyle`), and its key rules (spec FR-007).
- Box: a wrapper `div` takes the 1 px Control border, the 4 px radius, the Surface fill, and the focus ring through `:has(textarea:focus-visible)`. The textarea and the mirror take border 0, `padding: 4px 8px`, the code font at 12/18 px, and a transparent fill. The mirror sits behind the textarea at the same origin. Its width is the textarea `clientWidth`, read with a `ResizeObserver` and after each input, so a scrollbar changes both wraps alike. The mirror copies `white-space`, `overflow-wrap`, `direction`, `unicode-bidi`, `tab-size`, and the font settings from the computed style of the textarea. It sets `scrollTop` from each textarea `scroll` event. It has `aria-hidden="true"` and `pointer-events: none`.
- Mirror content: text nodes and one `span` per mark, built with `replaceChildren` from the shown marks. React owns the mirror element, not its children. The spans add no bidi isolation, so the bidi layout equals the textarea layout (SC-009).
- Mark style: `text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: var(--removed); text-decoration-thickness: 1px; text-underline-offset: 3px; text-decoration-skip-ink: none`. The mirror text stays transparent. The wave shape is the cue (spec FR-001).
- Mark updates (data-model §13): each input rebuilds the mirror text at once. Marks before the edit keep their offsets, marks after the edit move by the length change, and marks that overlap the changed range go until the next check result. The prefix and suffix compare of the old and new text decides the range exactly. Typing never waits for a worker (FR-008).
- IME (SC-009): `compositionstart` hides every mark. `compositionend` starts a new check round. The mirror never marks composed text.
- Count: the editor `aria-describedby` gains the count element after the 004 elements: "No possible misspellings", "1 possible misspelling", or "<n> possible misspellings" with the en-US thousands separator. The count element exists only while spell check is on, at least one language is loaded, and no composition runs.
- Chip (spec FR-001, Main board): after "Commit message" and before the Summary counter, with a 12 px gap. It is static text with a tooltip, not a control.
- Above `COMMIT_MESSAGE_BYTES` (65,536 UTF-8 bytes): no check round runs, and no mark shows. The chip tooltip states the D17 limit text.

### D9 Spell engine and workers

- One module worker per loaded language (`spell-worker.ts`, Vite `?worker` form as `PatchPool.tsx:4`). The engine creates a worker only when the commit editor first shows with spell check on (FR-008). Spell check Off, Remove, or a cleared selection terminates that worker.
- English: the worker of `en` imports `dictionary-en` `index.aff` and `index.dic` with `?raw` through a Vite `resolve.alias` to the package folder, in a dynamic `import()` (004 R20). No request runs at run time, because `?raw` inlines the text into the worker chunk.
- A downloaded language: the main thread reads the chunks with `readDictionary` and posts each base64 chunk string to the worker. The worker decodes them with `TextDecoder("utf-8", {fatal: true})` and builds `nspell(aff, dic)`. A decode failure or an nspell exception gives `load-failed`.
- Load order: the selection order. The engine reads one language at a time. Each worker answers checks as soon as it has loaded.
- Check round (data-model §14): the engine sends the current text to every loaded worker that is idle, with a round number. A busy worker gets only the newest text when it ends. Each worker segments the text with `spell-words.ts`, checks each word with its cache, and replies with the refused ranges as a `Uint32Array` (transferred). The engine merges a round when every loaded worker replied to it. A newer round drops an older one.
- Merge (spec FR-004): a word gets a mark only when all of these hold. Spell check is on. At least one language is loaded. Every loaded language refused the word. Neither the personal word list nor the Ignore list accepts it under the case rule (data-model §12). A worker that loads later joins at the next round. Until then, the chip names only the loaded languages, and its tooltip names each language that still loads.
- Word cache per worker: at most `SPELL_WORD_CACHE_ENTRIES` (100,000) words. At the bound, the cache empties.
- Suggestions (spec FR-005): the menu sends `suggest {word}` to each loaded worker in selection order. The engine joins the lists in that order, drops repeats by exact string equality after NFC, and keeps the first 5. Each list shows as soon as its worker answers.
- A worker `error` event or a `load-failed` reply marks that language failed for the window session. The chip and the row then show the FR-016 load text. Spell check uses the other languages.

### D10 Personal word list and Ignore list

- Database `arbareto-spelling`, version 1, store `words` with key path `word`. Each record is `{word, addedAt}` (data-model §9). The drafts database `arbareto-drafts` stays at version 1 (`draft-store.ts:34`).
- Add (spec FR-006): one `readwrite` transaction with `durability: "strict"`. It counts the store, refuses at 10,000, and then calls `add`. A `ConstraintError` means the word is already there. Add never calls `put` and never rewrites other records.
- Bounds: at most 10,000 words, each NFC, 1 to 100 code points. A longer word makes Add unavailable with its D17 reason.
- Read at the first editor show: `getAll(null, 10_001)`. More than 10,000 records, a record that fails the bounds, or a read error give the state `unreadable`. Arbareto then writes nothing to the store, the listed words get marks, and Add is unavailable with "Arbareto could not read the personal word list." A failed `open` gives the state `unavailable`.
- Remove on the Spelling page: `delete` of that key. The list then reads again.
- Ignore list: a renderer `Set` of NFC words for the window session, across repositories. A restart clears it. Ignore re-merges at once without a worker round.
- Case rule (spec FR-006, data-model §12): a listed word `w` also accepts `upper(first code point of w) + rest of w` and `upper(w)`, with `String.prototype.toUpperCase`, the Unicode default case mapping. The Ignore list uses the same rule.
- Order on the Spelling page: the 005 `compareNames` over the UTF-8 bytes of each word.

### D11 Language selection setting

- Shell setting `spelling: {enabled, languages}` in `settings.json` (data-model §8), beside `defaultPullAction` and `switchChoice`. The default is `{enabled: true, languages: ["en"]}` (spec Assumptions).
- `setSpelling {enabled, languages}` is shell-only, as `setSwitchChoice` (004 Δ3). It answers the `readSyncSettings` result with `spelling`. The shell refuses with `INVALID_REQUEST`: more than 3 languages, a repeat, or an ID that is not `en` and not a catalog ID of the embedded catalog.
- At load, the shell drops each stored ID that is not `en` and not a catalog ID. So a release that removes a language also removes it from the selection (spec FR-017). The renderer then saves nothing.
- The renderer sends `setSpelling` for each change on the Spelling page at once, with no Save footer (O-3). A failure shows the existing 004 text "The setting did not change: <code>".

### D12 Licence link and licence text

- The row licence name is a link. Its `href` is the catalog URL of the first licence document, so the tooltip and the accessible name name the URL (spec FR-015). Activation prevents the WebView2 navigation and sends `openLicenceLink {language}`.
- `openLicenceLink` is shell-only. The shell takes the URL from the embedded catalog (`include_str!` of `src/contracts/dictionaries.json`, as `git_env.rs:24` reads `git-environment.json`). It calls `ShellExecuteW(None, "open", url, None, None, SW_SHOWNORMAL)` in the new `links.rs`. A return value of 32 or less gives `failed` with reason `link` (Microsoft Learn `ShellExecuteW`: a value above 32 means success). The renderer never sends a URL.
- Show licence: English reads the bundled `dictionary-en/license` text through `?raw`. Another language reads each licence document with `readDictionary`. The panel decodes the bytes with `TextDecoder("utf-8")` and shows them as `textContent`, never as markup or Markdown (spec FR-015).

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
- `engine.ts`: the workers, the loads, the check rounds, the merge, and the suggestions (D9). `word-list.ts`: the IndexedDB store with an injected `IDBFactory`, as `draft-store.ts`.
- `SpellMirror.tsx`, `SpellChip.tsx`, and `SpellMenu.tsx`: used by `CommitTray.tsx`. `SpellMenu` renders the house `ActionMenu` with `anchor` at the mark span.
- Menu opening (spec FR-005): a `contextmenu` event whose point lies inside a client rect of a mark span opens the menu and calls `preventDefault`. Shift+F10 and the Menu key on `keydown` with `selectionStart === selectionEnd` and the caret at an offset o with `start ≤ o ≤ end` of a mark open it with `byKey`, as `ChangesPane.tsx:717`. Every other event keeps the default, so the built-in menu with Cut, Copy, Paste, and Select all opens (004 FR-085, `suppressPageMenu`).
- Suggestion: the engine checks that the textarea text in the mark range still equals the marked word. Then `setSelectionRange(start, end)` and `document.execCommand("insertText", false, suggestion)` replace only that word as one undo step (N2). A changed range or a `false` return changes nothing and shows the D17 replace text.
- Cut and Copy: `document.execCommand("cut")` and `("copy")` on the textarea selection. With an empty selection, they are unavailable with their D17 reason. Select all: `textarea.select()`.
- `settings/SpellingPage.tsx` and `LicencePanel.tsx`: D16. `SettingsView.tsx` adds "Spelling" to `APP_PAGES` after "Branch switch".
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
- Licence view (LicenceView board): while a licence shows, the Languages panel shows the compact form at 340 px wide (Language, State, Show licence) with 32 px rows, and the licence panel takes the rest of the width. The panel header holds the language name (12/600), the SPDX name and the file name (code font) in Muted text, the byte count, and the 28 px close button (`Cancel01Icon`). The `readme.md` note row has the Warning fill and `InformationCircleIcon`, padding 8 px 12 px. The text region uses the code font, `white-space: pre-wrap`, `overflow-wrap: anywhere`, padding 8 px 24 px 8 px 12 px, its own scrollbar, `tabindex="0"`, and `role="document"`. One licence shows at a time. `oc` shows its two documents one after the other, each with its file name and byte count.
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

Every visible text of this feature comes from this list. `<Language>` is the catalog name, `<word>` the marked word, `<folder>` a Windows path, and `<n>` a count with the en-US thousands separator.

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
  - Licence link: the SPDX name. Tooltip: "Full licence text" and, on a second line, the URL.
  - States: "Bundled", "Not downloaded", "Downloading <n>%" with n = floor(100 × received / total), "Importing…", "Ready", "Changed", "Failed".
  - Buttons and their accessible names: "Download" ("Download <Language>"), "Retry" ("Retry <Language>"), "Cancel" ("Cancel the <Language> download"), "Import…" ("Import… <Language>"), "Show licence" ("Show licence of <Language>"), "Remove" ("Remove <Language>"). Checkbox: "Select <Language>". Progress bar: "Download <Language>".
  - Message rows: `eu` and `et`: "This dictionary has no licence file. Its readme names the licence."; the FR-016 texts of spec FR-016 for their causes; a failed import read: "Arbareto could not read the <Language> files in <folder>."; a failed Remove: "Arbareto could not remove the <Language> dictionary from <folder>."; a failed link: "Windows could not open the link. The address is <url>."
  - Above the table: "This Arbareto release has no <Language> dictionary. Arbareto removed it."
  - Selection: the note "Select at most 3 languages. English counts as one."; the limit reason "You can select at most 3 languages. Clear one first."; the not-ready reason "Download or import the <Language> dictionary first."
  - Selected languages panel: heading "Selected languages" and the count; Move up: name "Move <Language> up", tooltip "Move up (Alt+Up)", reason "<Language> is already first."; Move down: name "Move <Language> down", tooltip "Move down (Alt+Down)", reason "<Language> is already last."; preview "Chip: Spelling: <languages>"; empty: "No language is selected. Spell check marks no word."
  - Personal word list panel: heading "Personal word list" and the count; "<n> of 10,000 words"; Remove: name "Remove <word>", tooltip "Remove"; empty: "No words yet. Add a word from the spelling menu of the commit message."; read failure: "Arbareto could not read the personal word list."; no storage: "Arbareto cannot save words, because the app storage is not available."; a failed Remove: "Arbareto could not remove <word> from the personal word list."
  - Import picker title: "Choose the folder with the <Language> dictionary files".
  - Licence panel: the language name; the SPDX name; the file name; "<n> bytes" ("1 byte"); close button name and tooltip "Close the licence text (Esc)"; text region name "Licence text of <Language>", or "Readme text of <Language>" for `readme.md`; the readme note "This dictionary has no licence file. Its readme names the licence."; read failure "Arbareto could not read the licence text: <code>."
- WSL Global header: "Git in <distro> writes its global file. It uses GIT_CONFIG_GLOBAL when set, else ~/.gitconfig, or the XDG file when only that exists."
- Copy rule: "Label (Key)" in tooltips. "…" only when a further step follows: "Import…" opens the picker. "Downloading", "Importing…", and "Finding suggestions…" are states.

### D18 Licences and notices

- `nspell`, `is-buffer`, and `dictionary-en` ship with the application, so the 004 notices inventory takes their licence files from `bun.lock` (`src/frontend/build/notices.ts`, 004 R20). WP6 checks that the full `dictionary-en` `license` text appears in the generated inventory.
- Downloaded and imported dictionaries do not ship with the release. Each keeps its licence documents next to its files (spec FR-015). The catalog filters no licence. The legal reading of a run-time download stays unverified (research R3).

### D19 Tests and fixtures

- Oracles: Git's own commands on a copy for the WSL rows (D14). The catalog bytes and SHA-256 values for every dictionary outcome. Exact word vectors for `spell-words.ts`. nspell itself for the language fixtures.
- Network: no test uses the network. Service tests inject `fetch`. P0.2 uses local `Bun.serve` servers on 127.0.0.1 only. The packaged no-network check uses a local counting proxy in `HTTPS_PROXY` (P8). Only `scripts/dictionary-catalog.ts` uses the network, at dev time, after the user approves.
- Synthetic dictionaries: committed tests build small `index.aff` and `index.dic` texts in the test, and a synthetic catalog that `createSession` takes as an option. The repository holds no third-party dictionary (spec Assumptions).
- Real dictionaries: `tests/git/dictionary-gate.test.ts` starts one Bun process per cached language with a 60 s timeout and kills it by PID at the end. It sits in `tests/groups.json` `serial` with the reason "loads every cached catalog language, one per process".
- No-network evidence for SC-001 (O-13): in `tests/contracts`, stubs of `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `navigator.sendBeacon` count zero calls during the spell check cases; in `tests/git`, the injected `fetch` counts zero calls outside download cases; in the package, the counting proxy counts zero connections during US1.
- Each new test file adds its line to `tests/groups.json`. Timing tests go into `serial`. `tests/windows` files stay out of `tests/groups.json`.
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
| One nspell instance cannot combine languages. | nspell readme (spec Research inputs) |
| nspell stores every affixed word form in memory. | nspell `lib/util/add.js`; the Bun measurement of 2026-10-22 (research R2) |
| `Intl.Segmenter` gives "don't" as one word and "follow-up" as two. | Bun 1.4.3 run, 2026-10-21 and 2026-10-22 (research R6) |
| Inside a repository, Git applies `core.sharedRepository` to a new lock file. Outside, only the global and system configuration count. | Git 2.56 tempfile.c:135-152, path.c:739-789, repo-settings.c:196-208 (research R9) |
| `wsl.rs` adds `-C <directory>` after `--no-lazy-fetch` and keeps `WSLENV` empty. | `wsl.rs:519`, `:123-133` |
| A WSL mutation-class run starts its anchor before its first Git process. | `process_requests.rs:1699-1709` |
| The renderer already runs a module worker under this CSP. | `PatchPool.tsx:4,10`, `tauri.conf.json:12-22` |
| `ShellExecuteW` returns a value above 32 on success. | Microsoft Learn `ShellExecuteW` |

## Open items and reviewer defaults

- **O-1 Memory and time gate against the Bun measurement.** Open (needs the user). The user confirmed 256 MiB and 10 s on 2026-10-22. Bun 1.4.3 measured uk at +488.8 MiB and 5.5 s, fr at +348.8 MiB, and he did not load within 180 s (research R2). If the packaged WebView2 measurement agrees, Ukrainian and French leave the catalog. Choices: (a) keep the bounds and ship without them; (b) raise the per-language bound before P8, for example to 512 MiB, with a stated total for 3 languages; (c) evaluate a Hunspell engine in WebAssembly that keeps stems with their flags, such as `hunspell-wasm` 0.3.0 (`(LGPL-2.0 OR GPL-2.0 OR MPL-1.1)`, research R2), which needs its own licence review. Recommendation: run the packaged gate for uk, fr, tr, ru, and he as the first P8 step, then decide.
- **O-2 Two licence documents of `oc`.** Reviewer default (2026-10-22): both `license` and `licence` are licence documents, and both download and show. The row link names `license`. The spec text "`oc` names its file `licence`" does not match the tree.
- **O-3 Apply at once.** Reviewer default: each Spelling page change applies at once, as the 004 Pull default and switch choice do. No Save footer (SpellingPage board open point).
- **O-4 Filter field.** Reviewer default: no filter field for the Languages table. The spec has none. The grid keys of D16 reach every row (SpellingPage board open point). The user may ask for a filter.
- **O-5 Move labels.** Reviewer default: "Move <Language> up" and "Move <Language> down" with the tooltips "Move up (Alt+Up)" and "Move down (Alt+Down)" (SpellingPage board open point).
- **O-6 WSL status bar.** Decided by fact: the status bar keeps "Git <version> (WSL: <distro>)" (`Workbench.tsx:584`). The board draft does not change it.
- **O-7 Board texts marked TBD.** Reviewer default: the D17 texts for the 10,000-word limit, the 100-character limit, the storage failure, the word count line, and the licence close tooltip.
- **O-8 Licence layout.** Reviewer default: one licence panel at a time, with the compact language list beside it (LicenceView board). The board shows two panels as two examples.
- **O-9 App setting note.** Reviewer default: the note "Arbareto setting for all repositories. Not stored in Git configuration." follows the Spelling heading row, as on the 004 app pages. The SpellingPage board shows it in the Settings header.
- **O-10 Selection storage.** Reviewer default: the shell settings file, as the Pull default (spec FR-009). A smaller option is the renderer `localStorage` beside `arbareto.preferences.v1`, which needs no Rust change.
- **O-11 Proxy variables.** Reviewer default: the service passes only the `HTTPS_PROXY` value (spec FR-010). Bun then ignores `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY`. Proxy authentication works only through the proxy URL user information (Bun docs), unverified.
- **O-12 Root certificates.** Reviewer default: `tls.ca` is `tls.rootCertificates`, so `NODE_EXTRA_CA_CERTS` adds nothing (spec FR-010). F3 verifies it. If F3 fails, the shell adds `NODE_EXTRA_CA_CERTS` to its removed variables, and research R13 records the change.
- **O-13 No-network evidence.** Decided by fact: the 003 no-network harness (003 T079, `tests/windows/no-network.test.ts`) is not on main. 006 uses the D19 stubs and the counting proxy.
- **O-14 Spell check above 64 KiB.** Reviewer default: no check runs above `COMMIT_MESSAGE_BYTES`. Such a message cannot commit anyway (001 contract §5).
- **O-15 Cut and Copy without a selection.** Reviewer default: unavailable with "Select text first.", as the Windows menus disable them.
- **O-16 English link.** Reviewer default: the English row links the pinned `dictionaries/en/license` URL, because the bundled files equal those files (D3).

## Phases

### Batches

| Batch | Steps | Tracks that run in parallel | Content |
|---|---|---|---|
| 0 | P0.1, P0.2, P1, P2 | WP1, then WP2. | This plan, the catalog, the download facts, the pure logic, and the contracts. |
| 1 | P3, P4, P6 | A: WP3 (local Rust). B: WP5. C: WP6 (frontend). | The shell, the service dictionaries, and the editor spell check. |
| 2 | P5, P7, P0.3 | A: WP4 (local WSL, after WP3). B: WP7 (after WP5 and WP6). Then the P0.3 packaged facts. | The WSL parity, the Settings page, and the packaged facts. |
| 3 | P8 | WP8 (WSL alone, then packaged). | Qualification. |

User stories by priority: P1 is US1 and US2 (WP2, WP3, WP4, WP6, WP7). P2 is US3 (WP1, WP3, WP5, WP7). P3 is US4 (WP4).

### Work packages, in run order

| WP | Agent | Files | Steps |
|---|---|---|---|
| WP0 | orchestrator | `specs/006-wsl-parity-spellcheck/{plan.md, research.md, data-model.md, contracts/operations.md, quickstart.md}`; after approval, the cross-feature notes in the 004 spec and contract lines that spec "Changes to earlier requirements" names | This plan. Then `/speckit-tasks` and `/speckit-analyze`. |
| WP1 | implementer | new `scripts/dictionary-catalog.ts`, new `scripts/dictionary-gate.json`, new `src/contracts/dictionaries.json`, new `src/contracts/dictionaries.ts` (the `Catalog` schema only), `package.json` and `bun.lock` (`nspell` `^2.1.5`, `dictionary-en` `^4.0.0`), new `tests/git/dictionary-gate.test.ts`, new `tests/git/dictionary-facts.test.ts`, new `tests/contracts/dictionary-catalog.test.ts`, `tests/groups.json`, `README.md` "Development" (the catalog command, only after it ran green) | P0.1, P0.2. The script runs only after the user approves the dev-time network use. |
| WP2 | implementer | `src/contracts/{operations,envelope,errors,limits}.ts`, `src/contracts/dictionaries.ts` (types and helpers), new `src/contracts/spell-words.ts`, `src/contracts/schemas/`, `tests/vectors/`, new `tests/contracts/{spelling-contract,spell-words}.test.ts`; the ripple in `src-tauri/src/schema.rs`, `src/frontend/bridge.ts`, and the existing contract tests | P1, P2. After WP1. |
| WP3 | implementer-xhigh | `src-tauri/src/{process_requests,service,settings,dialogs,ipc,schema,lib}.rs`, new `src-tauri/src/links.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/main.json` | P3. `Local: Rust`. After WP2. |
| WP4 | implementer-xhigh | `src/git-service/git-settings.ts`, `tests/git/bun-runner.ts`, `tests/wsl/workbench-wsl.test.ts`, `tests/wsl/fixtures.ts` | P5. `Local: WSL`. After WP3. Runs alone on Ubuntu-26.04. |
| WP5 | implementer | new `src/git-service/{dictionaries,dictionary-store}.ts`, `src/git-service/{session,main}.ts`, new `tests/git/dictionaries.test.ts`, `tests/git/service-harness.ts` (the `dictionaryFolder`, `catalog`, and `fetch` options), `tests/groups.json` | P4. After WP2. Parallel with WP3 and WP6. |
| WP6 | frontend-implementer (loads arbareto-ux, vercel-react-best-practices, web-design-guidelines) | new `src/frontend/spelling/{engine.ts,spell-worker.ts,english.ts,word-list.ts,store.ts,SpellMirror.tsx,SpellMenu.tsx,SpellChip.tsx,texts.ts}`, `src/frontend/commit/CommitTray.tsx`, `vite.config.ts` (the `dictionary-en` alias), `src/frontend/bridge.ts`, `src/frontend/app/Workbench.tsx` (the spelling store), new `tests/contracts/{spelling-editor.test.tsx,word-list.test.ts}`, `tests/groups.json` | P6. After WP2. Parallel with WP3 and WP5. |
| WP7 | frontend-implementer | new `src/frontend/settings/{SpellingPage,LicencePanel}.tsx`, `src/frontend/settings/{SettingsView,SettingsDialog}.tsx`, `src/frontend/settings/git/{GitSettingsPage.tsx,texts.ts}`, `src/frontend/app/Workbench.tsx` (the `wslDistro` prop), `src/frontend/bridge.ts`, new `tests/contracts/spelling-page.test.tsx`, `tests/contracts/workbench-settings.test.tsx`, `tests/groups.json` | P7. After WP5 and WP6. |
| WP8 | implementer writes, scout runs (WSL alone, then packaged) | new `tests/windows/{spelling-packaged,spelling-perf}.test.ts`, `scripts/dictionary-gate.json` (packaged gate results) | P0.3 after WP6, then P8. Last. |

Parallel tracks use disjoint files in separate worktrees. These files are not disjoint:
- `src/frontend/bridge.ts`: WP2 (ripple), then WP6, then WP7.
- `src/frontend/app/Workbench.tsx`: WP6, then WP7.
- `src/contracts/dictionaries.ts`: WP1 (schema), then WP2 (types and helpers).
- `src/contracts/envelope.ts`, `errors.ts`, `limits.ts`, `operations.ts`, and `schemas/`: WP2 owns them. A later package that needs a schema change reports it, and the orchestrator merges it.
- `src-tauri/`: only WP3 edits it, except the WP2 ripple in `schema.rs`.
- `tests/groups.json`: every WP appends its lines. The orchestrator resolves merge conflicts.
- `tests/git/bun-runner.ts`: only WP4. `tests/git/service-harness.ts`: only WP5.

Dependencies: feature 005 merges first (spec Dependencies). 006 uses the 005 `compareNames` of `src/contracts/tree-order.ts` and the 005 public request bound. The 004 WSL rows and the 004 folder picker are on main.

## Agent context

Spec Kit v1.0.12 in this repository has no `update-agent-context` script, and `setup-plan.ps1` changes no agent file. So this step changes no `CLAUDE.md`. The new packages `nspell` and `dictionary-en` need no CLAUDE.md rule. The catalog command enters README "Development" only after it runs green (CLAUDE.md "Tool boundaries"). A CLAUDE.md change goes through `claude-md-management:claude-md-improver`.

## Complexity Tracking

No Constitution Check violation. The table stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
