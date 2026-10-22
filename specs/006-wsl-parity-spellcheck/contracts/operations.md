# Operation Contract Deltas: WSL Parity and Commit Message Spell Check

This file lists only the changes to the feature 001 contract (`specs/001-desktop-qualification/contracts/operations.md`) and to the 002 to 005 deltas (`specs/00n-*/contracts/operations.md`). "001 §n", "003 Δn", "004 Δn", and "005 Δn" name those sections. Every rule that no delta replaces stays in force.

## Δ1 Transport (001 §1)

- New service operations: `listDictionaries`, `readDictionary`, `downloadDictionary`, `removeDictionary`. Each has one Tauri command and one zod schema.
- New native-first operation: `importDictionary`. The shell shows the folder picker and forwards the picked folder (Δ3).
- New shell-only operations: `setSpelling` and `openLicenceLink`. The shell answers them natively and never forwards them.
- The 003 `readSyncSettings` result gains `spelling` (Δ12).
- The catalog `src/contracts/dictionaries.json` is a contract file. The service, the renderer, and the shell parse it with the same rules (plan D3, data-model §1).
- Keep explicit range checks in Rust (001 §1).

## Δ2 Envelope (001 §2)

- The dictionary operations carry no `repositoryId` and no `repositoryGeneration`. No generation rule applies.
- Each dictionary operation gets an `operationId` from the operation registry, as every 001 operation does. The 001 `cancel {operationId}` cancels it, and `getOperation` reports it. `CANCELED` arises only from such a request.
- Every dictionary operation waits for the one release reconcile of the service process before its own work (plan D2).
- `MUTATIONS` stays unchanged. No dictionary operation carries an approval, takes the mutation exclusion, or writes a recovery marker.
- New phase `dictionary` with the counters `received` and `total`. Events carry no URL, path, or name.

## Δ3 Public operations (001 §3)

### `listDictionaries`

- Payload: `{}`.
- Steps: the release reconcile once per service process (plan D5, data-model §3), then the data-model §3 language check of each installed catalog entry.
- Result: `{languages, removed}`. `languages` holds one `{language, state, notice?}` per catalog entry in catalog order, with `state` one of `not-downloaded`, `ready`, `changed`, `downloading`, `importing`, and `notice` `catalog-changed` when it applies. `removed` holds the `{language, name}` of each `catalog-removed` notice of this service process.
- Deadline: `READ_DEADLINE_MS` (30 s). It never takes the run lock.
- Errors: `DEADLINE`; `CANCELED` after a `cancel {operationId}`.

### `readDictionary`

- Payload: `{language, file, offset}`. `language` is a catalog ID. `file` is a `files` name of that entry. `offset` is 0 or a multiple of `DICTIONARY_CHUNK_BYTES` below the file size. Another value gives `INVALID_REQUEST`.
- Steps: the reconcile; then the data-model §3 file check: the manifest, and the requested file whole with its size and SHA-256 (plan D7). The other files of the language are not read.
- Result: `{language, file, size, offset, bytes}`. `bytes` holds the base64 of at most `DICTIONARY_CHUNK_BYTES` bytes from `offset`.
- Bounds: at most `SPELLING_LANGUAGES` (3) calls at the same time. A fourth gets `BUSY`.
- Deadline: `READ_DEADLINE_MS`. It never takes the run lock.
- Errors: `DICTIONARY_UNAVAILABLE` with `absent` or `changed`; `BUSY`; `DEADLINE`; `CANCELED` after a `cancel {operationId}`, which the renderer sends when the language leaves the selection or its load deadline passes.

### `downloadDictionary`

- Payload: `{language}`, a catalog ID.
- Steps (plan D4, data-model §5): the reconcile; the run lock, else `busy`; per file in catalog order, the HTTPS check, one `fetch` with `redirect: "manual"`, `proxy: false`, `tls: {rejectUnauthorized: true, ca: tls.rootCertificates}`, and `keepalive: false`; the status rule; the bounded body read with SHA-256; then the manifest and the install (plan D5).
- Status rule: 200 goes on; 300 to 399 gives `redirect`; 404 gives `http-not-found`; 429 gives `http-rate-limit`; any other status gives `http-status` with `status`. A rejected request or body read that is not this run's abort gives `transport`. No message text decides a reason.
- Body rule: the decoded bytes count. The run reads at most the catalog size plus one byte and writes at most the catalog size. Byte `size + 1`, another count, or another SHA-256 gives `mismatch`. `Content-Length` and `Content-Encoding` decide nothing.
- Connection: direct. The service reads no proxy variable (user decision, 2026-10-22).
- Progress: phase `dictionary`, at most 4 events per second.
- Deadline: `DICTIONARY_DOWNLOAD_DEADLINE_MS` (120 s) for the whole run, equal to `REGISTERED_DEADLINE_CAP_MS`. Its end gives `DEADLINE`. Cancel gives `canceled`. Both remove the staging folder.
- Result: `{language, state: "ready"}`.
- Errors: `DICTIONARY_UNAVAILABLE` with `busy`, `not-https`, `redirect`, `http-not-found`, `http-rate-limit`, `http-status`, `transport`, `mismatch`, or `save`; `DEADLINE`; `CANCELED`.

### `importDictionary`

- Renderer payload: `{language}`. The renderer never sends a path.
- Native step: the shell checks `language` against the embedded catalog, else `INVALID_REQUEST`. It shows the 004 folder picker with the plan D17 title. Cancel gives `canceled`. A failed picker call gives `rejected` `PICKER_FAILED`. The shell forwards `{language, folder}`, with `folder` the picked channel path. A path with a lone surrogate gives `rejected` `INVALID_REQUEST`.
- Service steps (plan D6, data-model §6): the reconcile; the run lock, else `busy`; per catalog file name, `stat` and a bounded read of `<folder>/<name>` (at most size plus one byte read, at most size written) with its size and SHA-256; then the manifest and the install. No network request runs.
- Deadline: `DICTIONARY_DOWNLOAD_DEADLINE_MS`. Cancel gives `canceled`.
- Result: `{language, state: "ready"}`.
- Errors: `DICTIONARY_UNAVAILABLE` with `busy`, `import-mismatch`, `import-unreadable`, or `save`; `DEADLINE`; `CANCELED`.

### `removeDictionary`

- Payload: `{language}`, a catalog ID.
- Steps: the reconcile; a run of the run lock for this ID gives `busy`; then `rm` of `<id>/` with `recursive: true`. No confirmation step exists (user decision, 2026-10-22).
- Result: `{language, removed}`. `removed` is false when the folder did not exist.
- Deadline: `READ_DEADLINE_MS`.
- Errors: `DICTIONARY_UNAVAILABLE` with `busy` or `remove`; `DEADLINE`; `CANCELED`.
- The personal word list stays unchanged (spec FR-014). The renderer then removes the ID from the selection with `setSpelling`.

### `setSpelling` (shell-only)

- Payload: `{enabled, languages}`. `enabled` is a boolean. `languages` holds 0 to 3 unique IDs, each `en` or a catalog ID of the embedded catalog. Another value gives `rejected` `INVALID_REQUEST`.
- Effect: stores data-model §8 `spelling` in `settings.json` and answers the 003 `readSyncSettings` result, which carries `spelling` (Δ12). A failed file write answers as the other settings operations do.

### `openLicenceLink` (shell-only)

- Payload: `{language}`, `en` or a catalog ID. Another value gives `rejected` `INVALID_REQUEST`.
- Effect: the shell takes the URL of `licences[0]` of that entry, or of the `bundled` record for `en`, from the embedded catalog. On a dedicated thread, it calls `CoInitializeEx` with `COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE`, then `ShellExecuteW` with the verb `open`, then `CoUninitialize` (Microsoft Learn `ShellExecuteW` remarks). A return value above 32 gives `succeeded` with `{}`. Another value gives `failed` with `DICTIONARY_UNAVAILABLE` reason `link` and `url`.
- The renderer never sends a URL.

### `reviewWorkbench` `config-save` (004 Δ3)

- The precheck no longer refuses `scope: "global"` for a WSL workspace. Every other 004 rule stays: the key list, the repeat rule, the value rule, the read-only reasons, the bound entries, and the plan.

### `runWorkbench` `config-save` (004 Δ3)

- A WSL Global write runs in the `globalConfig` context with the WSL Git of the workspace (Δ6, Δ11). The listing before each write and the fresh listing after the run stay in the registered WSL context. The outcome rules stay (004 spec FR-065).

### `readGitSettings` (004 Δ3)

- `files.global` stays null for a WSL workspace. On WSL, null now means "Git's `--global` rule applies inside the distro", and the renderer keeps Global editable (spec FR-020).

## Δ4 File staging (001 §4)

- No change. No dictionary operation touches a repository.

## Δ5 Finite bounds (001 §5)

| Limit | Value |
|---|---|
| Files of one language (`DICTIONARY_LANGUAGE_BYTES`) | 12 MiB (12,582,912 bytes), the FR-017 gate |
| Catalog entries | 92 (the folders of the pinned commit) |
| Manifest read (`DICTIONARY_MANIFEST_BYTES`) | 64 KiB (65,536 bytes) |
| Read chunk (`DICTIONARY_CHUNK_BYTES`) | 1 MiB (1,048,576 bytes), 1,398,104 bytes as base64 |
| Concurrent `readDictionary` calls | 3 (`SPELLING_LANGUAGES`) |
| Download and import deadline (`DICTIONARY_DOWNLOAD_DEADLINE_MS`) | 120 s (`REGISTERED_DEADLINE_CAP_MS`) |
| Run-time load deadline (`DICTIONARY_LOAD_DEADLINE_MS`) | 30 s (`READ_DEADLINE_MS`), per worker load |
| Dictionary runs at the same time | 1 |
| Download progress (`DICTIONARY_PROGRESS_EVENTS_PER_SECOND`) | 4 events per second |
| Selected languages (`SPELLING_LANGUAGES`) | 3, English included when selected |
| Workers per loaded language | 2 (check and suggestion) |
| Suggestions per menu (`SPELLING_SUGGESTIONS`) | 5 |
| Personal words (`PERSONAL_WORDS`) | 10,000 |
| Personal word length (`PERSONAL_WORD_CODE_POINTS`) | 100 code points |
| Checked text | `COMMIT_MESSAGE_BYTES` (65,536 UTF-8 bytes) |
| Gate load time (`DICTIONARY_LOAD_GATE_MS`, test only) | 10 s in the packaged build (plan D3 method) |
| Gate memory (`DICTIONARY_LANGUAGE_MEMORY_BYTES`, test only) | 256 MiB WebView2 private bytes increase per language, both workers included |

## Δ6 Private native process requests (001 §6)

- No new request.
- `run` with `contextKind: "globalConfig"` and the `gitInstallationId` of a WSL Git: the shell targets `wsl::wsl_program()` with no Git identity and the Linux directory `/`. The three 004 arrays and their policies stay (004 Δ6): the listing under `read`, and `config set --global` and `config unset --global` under `integrate`. The shell adds `-C /` after `--no-lazy-fetch` (001 §11 "Process launch"). The WSL anchor starts before an `integrate` process (001 §11 "Process ownership"). A Windows Git keeps its launch folder target.
- The 004 refusal "A WSL Git gets `INVALID_REQUEST`" of this context goes.

## Δ7 Startup, trust, and environment (001 §7)

- Renderer CSP (`src-tauri/tauri.conf.json`): `script-src 'self' 'wasm-unsafe-eval'` and `connect-src ipc: http://ipc.localhost 'self'`. Every other directive stays. `'wasm-unsafe-eval'` admits WebAssembly compilation for Hunspell, and `'self'` admits the fetch of the bundled `hunspell.wasm`. Tauri 2.12.1 sends the CSP only with `.html` assets, so the workers have no CSP of their own today. The contract still names both sources, so a worker with the CSP keeps working (research R6).
- Service start: the service parses the catalog with the `Catalog` schema. A failure ends the start with the 001 startup failure.
- Dictionary folder: `<launch directory>/dictionaries`. The service takes the launch directory from its working folder at start, which the shell sets to the launch directory.
- Download environment: the service passes `proxy: false`, so Bun reads no proxy variable. The shell keeps removing `NODE_USE_SYSTEM_CA` (`env_sanitize.rs`). The explicit `tls` options keep `NODE_EXTRA_CA_CERTS` and `NODE_TLS_REJECT_UNAUTHORIZED` out of the request (plan O-12, F3).
- Trust: the dictionary operations use no trust class and run no repository program. A WSL Global save keeps the 004 marker of kind `workbench` with action `config-save`, runs no repository program, and needs no trust approval (spec FR-021).
- Environment to WSL: no change. `WSLENV` stays empty, so no Windows variable reaches the distro (001 §11).
- Logs: the 001 §7 allowlist of `log.ts` stays: `kind`, `operationId`, `durationMs`, `code`, `cause`, `count`, and `effects`. A dictionary operation records its kind, operation ID, duration, code, and byte count. No language, reason, status, URL, path, or word.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- After each `downloadDictionary`, `importDictionary`, or `removeDictionary` end, the renderer reads `listDictionaries`.
- Cancel is never rollback. A canceled run keeps no file. Its staging folder goes, or the next reconcile removes it.
- A WSL Global save keeps the 001 FR-023 rule: the fresh listing decides the result, also after a failure or Cancel.

## Δ9 Error codes (001 §9)

| Code | Reasons | Meaning |
|---|---|---|
| `DICTIONARY_UNAVAILABLE` | `busy`, `not-https`, `redirect`, `http-not-found`, `http-rate-limit`, `http-status`, `transport`, `mismatch`, `save`, `import-mismatch`, `import-unreadable`, `absent`, `changed`, `remove`, `link` | The dictionary operation ends without its effect. No file stays from a download or import. |

- `http-status` carries `status`, an integer from 100 to 599. `save`, `import-unreadable`, and `remove` carry `folder`, a Windows path in the app data folder or the picked folder. `link` carries `url`, a catalog URL.
- Reused: `INVALID_REQUEST`, `BUSY`, `PICKER_FAILED`, `DEADLINE`, `CANCELED`.

## Δ10 Required contract checks (001 §10)

- Schema tests and golden vectors for every new operation, the code, every reason, the phase, `spelling` in `readSyncSettings`, and the shell setting, in Bun and Rust.
- A catalog test: the schema, the exact URL form, no `en` entry, unique IDs, the `compareNames` order, the 12 MiB sum, the `licences` rule, and the `bundled` sizes and SHA-256 values against `node_modules/dictionary-en`.
- A dependency test: `bun.lock` names `hunspell-wasm` 0.3.0 with the integrity `sha512-D7/QLaeekJYYlE37D7KBq5v38vL4tQutTFIUBOUGBl0g9la8OUgfSd8+XbwNPV5uYMHS13umXR9MtdAxStpHJg==`, and `node_modules/hunspell-wasm/wasm/hunspell.wasm` has the SHA-256 `72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0`. Fact F14 checks that the build emits the same bytes.
- A CSP test (cargo): `tauri.conf.json` holds the two sources of Δ7, and every other directive keeps its earlier value.
- Vector tests for `spell-words.ts` (data-model §11), the case rule (§12), the line shift and the round merge (§13), the suggestion merge (§15), and the size text (plan D17).
- A source test (`tests/contracts/network-sites.test.ts`): `src/frontend` holds no `fetch(` call, and `src/git-service` holds exactly one, in `dictionaries.ts`.
- A Rust test admits the WSL `globalConfig` arrays and checks the WSL command: `-C /`, mode `integrate` for the writes, mode `read` for the listing, and an empty `WSLENV`.
- The Rust check of `src-tauri/src/schema.rs` reads each new vector of `native-first-envelope` and of the shell-only operations.

## Δ11 WSL repositories (001 §11)

- The `globalConfig` context has a WSL form (Δ6). The Git working folder is the distro root `/`, never the repository folder, because Git applies the repository's `core.sharedRepository` to a new lock file only inside a repository (research R9).
- The view names no exact global file on WSL. The Global header states the git-config(1) `--global` rule (plan D17).
- Test double (test only, `tests/git/bun-runner.ts`): WSL routes for `globalConfig`, for `worktreeAdd`, and for the `destinationFacts` of a WSL `worktreeAdd` binding through the `wslFiles` mode `destination`. Each route refuses before any process when `wslGlobalConfig` is not configured.

## Δ12 Changes to 003 deltas

- 003 Δ3 `readSyncSettings`: the result gains data-model §8 `spelling`, so the renderer reads it as it reads `defaultPullAction`. `setSpelling` answers the same result.
- 003 SC-013 harness (003 T079, `tests/windows/no-network.test.ts`) is not on main. 006 adds its own network evidence (plan D19) and uses no 003 harness.

## Δ13 Changes to 004 deltas

- 004 FR-006 second exception, Clarifications "a WSL `global` save gives `INVALID_REQUEST`", contract lines 101, 225, and 355: the WSL Global refusal goes (Δ3, Δ6).
- 004 contract line 55 and data-model §9: the rule "A WSL workspace gives `files.global` null" stays. Its meaning on WSL is Δ3 `readGitSettings`.
- 004 FR-083, FR-084, FR-085, Scope Boundaries, Edge Cases, Assumptions, User Story 10, SC-012, research R20, and tasks T077 to T080 and T103: feature 006 delivers them with the changes that spec "Changes to earlier requirements" lists. Hunspell replaces the R20 nspell proposal.
- 004 task T081: the R21 "Not covered yet on WSL" rows and Add worktree through the service move here (plan D14).
- The 004 action menu (`action-menu.tsx`) gains no item type. The spelling menu uses `ActionMenu` with its `anchor` at a mirror span.

## Δ14 Changes to 005 deltas

- No change. 006 uses the 005 `compareNames` of `src/contracts/tree-order.ts` for the catalog order and the personal word list order.

## Contract gaps

- Each `readDictionary` call hashes the requested file whole. A file can change between two calls. Each chunk still comes from a version that equals the catalog, so the joined bytes equal the catalog. An external change during a load can make one chunk call give `changed`.
- A Remove can fail when another process holds a dictionary file open without delete sharing. The result names the folder, and the files stay.
- The release reconcile runs once per service process. A folder that another program adds later stays until the next service start.
- A proxy, the Windows system proxy, and the Windows certificate store are not supported (spec Assumptions). Import is the fallback.
- A suggestion list runs in one synchronous Hunspell call in the suggestion worker (up to about 300 ms measured). A newer menu waits for the running call to end, and the engine drops its stale reply. Check rounds never wait for it.
- A round of a paste of many lines, or of one line of many words, rechecks those lines and can exceed the 100 ms of SC-004 (about 20 ms per 1,000 words for Ukrainian in Edge 155).
- The XDG global file on WSL cannot run through the test double, because `GIT_CONFIG_GLOBAL` wins (research R9). It stays unverified.
- The licence link opens the default browser through `ShellExecuteW`. No test can see the browser window. A cargo test checks the URL and the call arguments.
