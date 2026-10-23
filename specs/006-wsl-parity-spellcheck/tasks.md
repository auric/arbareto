---

description: "Task list for the WSL Parity and Commit Message Spell Check feature"
---

# Tasks: WSL Parity and Commit Message Spell Check

**Input**: Design documents from `specs/006-wsl-parity-spellcheck/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/operations.md, quickstart.md, and checklists/requirements.md.

**Tests**: The spec (SC-001 to SC-009) and plan.md "Steps" require tests. Each step writes its tests first (plan.md "Steps (riskiest proof first)"). The fact tasks of research.md R12 come first in their phases, and the facts F3, F14, F15, F16, N1, and N2 run before the work that depends on them. A failing-test task comes before each implementation task. No test passes by default.

**Organization**: Phases follow the work packages of plan.md "Work packages, in run order": WP1 and WP2 (batch 0), WP3, WP5, and WP6 (batch 1), WP4 and WP7 (batch 2), and WP8 (batch 3). WP0 is plan.md, this file, and `/speckit-analyze`. Story phases carry `[USn]` labels. Phases 1, 2, and 8 carry no label.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: The task touches different files from the other `[P]` tasks in its group and depends on no incomplete task of that group. A sub-heading starts a new group. "Depends on" names the exact order.
- **[Story]**: The user story from spec.md (US1 to US4). A task that serves several stories carries the first story and names the others.
- **WP and agent**: Each task names its plan.md work package. The orchestrator dispatches one WP per agent, with the agent that plan.md "Work packages" names. Each phase heading names that agent. A fact task names its own agent when it differs.
- **Local tags**: `Local: Rust` needs the local Rust toolchain. `Local: Windows` needs the Windows reference host. `Local: package` needs the packaged Windows build. `Local: WSL` needs the `Ubuntu-26.04` distro with Git 2.55. `Local: network` needs the dev-time reads of `api.github.com` and `raw.githubusercontent.com` that the user allowed on 2026-10-22. Cloud sessions do not run these tasks (CLAUDE.md "Tool boundaries"). A skip never counts as a pass.
- **Earlier specs**: The 001 to 005 texts stay unchanged in their own specs (spec.md "Changes to earlier requirements"). Tasks implement the changes and cite the changed requirement. No task edits `specs/001-desktop-qualification/` to `specs/005-inspection-file-actions/`.
- **Portability**: Shared TypeScript code and the generic test harness hold no Win32 FFI. Windows-only behavior stays in `src-tauri/src/` and `tests/windows/` (CLAUDE.md "Project constraints").

## Path Conventions

- Paths follow plan.md "Project Structure": `scripts/`, `src/contracts/`, `src/git-service/`, `src/frontend/`, `src-tauri/`, `tests/contracts/`, `tests/git/`, `tests/gate/`, `tests/vectors/`, `tests/windows/`, and `tests/wsl/`.
- Feature evidence goes only into `specs/006-wsl-parity-spellcheck/research.md` "R13 Results".
- The approved mockup boards live in the orchestrator scratchpad folder `f006/canvas/project/`: `Main`, `SpellingEdges`, `SpellingPage`, `DictionaryFailures`, `LicenceView`, `WslGlobal`, `ForcedColors`, and `Light` (`*.dc.html`). They are not repository files.
- The local dictionary cache is the folder in `ARBARETO_DICTIONARY_CACHE`, outside the repository (plan.md D3).

## Harness and tick rules

- The 001 "Test harness rules" stay in force (`specs/001-desktop-qualification/tasks.md`). They cover `printOrigin`, the control mutation, Git discovery through `tests/git/git-binary.ts`, capability skips, `tests/groups.json`, `OBSERVATION` lines, owned fixture roots, and the source headers.
- Every Git test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. Every WSL test uses the owned distro global file (`wslGlobalConfig`). No test touches the user's own configuration or the real `~/.gitconfig` of a distro user (spec FR-025).
- No test uses the network. Service tests inject `fetch`. Fact tests use local `Bun.serve` servers on 127.0.0.1 only. Only `scripts/dictionary-catalog.ts` reads the network, at dev time (plan.md D19).
- Oracles (plan.md D19): Git's own commands on a copy for the WSL rows; the catalog bytes and SHA-256 values for every dictionary outcome; the exact word vectors of data-model §11; Hunspell itself for the language fixtures.
- A fact task has no implementation of its own. A failed fact is a finding, not a red task. The test prints `OBSERVATION <task ID>: <fact>` with the observed Bun, Edge, WebView2, Git, or Windows version. The fact gate task copies it into research.md R13. A failed fact changes contracts/operations.md and plan.md before the dependent task starts, and the change runs `/speckit-analyze`.
- Each new test file in `tests/contracts`, `tests/git`, or `tests/wsl` adds its line to `tests/groups.json` in the same task: `parallel`, or `serial` with its reason. A timing test goes into `serial`. `tests/windows` and `tests/gate` files are not in `tests/groups.json`, and `bun run test:all` does not run them (plan.md D19).
- App runs set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- A WSL run runs alone on the host. While WP4 runs its WSL tests, no other track runs tests (plan.md "Batches").
- A task is ticked only after a green full run (`bun run test:all`) on Windows that verifies it, with `ORIGIN` lines in the checkout under test. A `tests/windows` task is ticked only after a green `bun run test:windows` on the reference host. A `tests/gate` task is ticked only after a green `bun test tests/gate` with the cache.
- Batch verification tasks use only the README "Development" commands, plus the new commands that their batch made green and added there.
- No heuristics: every outcome comes from an HTTP status code, a transport result, a file size, a SHA-256, a documented Git exit code, machine-readable Git output, a fresh read, an OS fact, or a contract value (spec SC-008). A test that asserts a refusal asserts its code and reason, never a message text.

## Batch-to-story mapping

| Batch | Phases | Plan steps | Tasks | Stories | Work packages (agent) |
| --- | --- | --- | --- | --- | --- |
| 0. Catalog, facts, and contracts | 1, 2 | P0.1, P0.2, P1, P2 | T001–T014 | Foundational | WP1 (implementer; T006 by scout), then WP2 (implementer). |
| 1. Shell, service dictionaries, editor | 3, 4, 5 | P3, P4, P6, P0.3 (N1, N2 early) | T015–T030 | US2 and US3 shell (WP3); US3 service (WP5); US1 (WP6) | A: WP3 (implementer-xhigh, local Rust). B: WP5 (implementer). C: WP6 (frontend-implementer; T028 by scout). |
| 2. WSL parity, Settings | 6, 7 | P5, P7 | T031–T039 | US2 and US4 (WP4); US3 and the US2 header (WP7) | A: WP4 (implementer-xhigh, local WSL, alone). B: WP7 (frontend-implementer; pauses its test runs during the WP4 WSL runs). |
| 3. Qualification | 8 | P8, P0.3 (package) | T040–T046 | Cross-cutting | WP8 (implementer writes, scout runs; WSL alone, then packaged). |

---

## Phase 1: Catalog, packages, and early facts (Batch 0, P0.1 and P0.2, WP1)

**Agent**: implementer. T006 by scout.

**Purpose**: The dictionary catalog, the two runtime packages with their notices, and the facts that the later design depends on.

**CRITICAL**: No story work starts before Phase 2 is complete.

### Tests (write first; they must fail)

- [ ] T001 [P] Write failing tests in the new `tests/contracts/dictionary-catalog.test.ts` (P0.1, WP1). The `Catalog` schema of data-model §1 and §2: `version` 1; `source.commit` is 40 lowercase hex digits; every URL equals `urlPrefix + id + "/" + name` exactly with `urlPrefix` `https://raw.githubusercontent.com/wooorm/dictionaries/<commit>/dictionaries/`; every entry `commit` equals `source.commit`; `id` matches `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$` and holds at most 32 bytes; `name` 1 to 64 code points; `license` 1 to 128 bytes; `files` 3 or 4 entries in the order `index.aff`, `index.dic`, then the licence documents, each `size` 1 to 12,582,912, each `sha256` 64 lowercase hex digits; the sizes add up to at most 12,582,912; `licences` is `["license"]`, `["licence"]`, `["license", "licence"]`, or `["readme.md"]`, and `oc` holds `["license", "licence"]`, `eu` and `et` hold `["readme.md"]`; no entry has the ID `en`; IDs are unique; the order is the 005 `compareNames` order of the UTF-8 bytes of `name`. The `bundled` record matches `node_modules/dictionary-en` `index.aff`, `index.dic`, and `license` in size and SHA-256 (3,086, 551,762, and 15,731 bytes). The dependency test of contract Δ10: `bun.lock` names `hunspell-wasm` 0.3.0 with the integrity `sha512-D7/QLaeekJYYlE37D7KBq5v38vL4tQutTFIUBOUGBl0g9la8OUgfSd8+XbwNPV5uYMHS13umXR9MtdAxStpHJg==`, and `node_modules/hunspell-wasm/wasm/hunspell.wasm` has the SHA-256 `72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0`. Invalid vectors for each rule fail the schema. Add the file to `tests/groups.json` `parallel`. Spec: FR-015, FR-017. No dependency.
- [ ] T002 [P] Add failing cases to `tests/contracts/notices.test.ts` (P0.1, WP1). The licence name set holds `copying.lesser` and `copying.mpl`, so the `hunspell-wasm` inventory entry holds `COPYING`, `COPYING.LESSER`, and `COPYING.MPL`. The inventory holds the fixed `hunspell-wasm` note of plan.md D18 verbatim: "Arbareto uses Hunspell under LGPL-2.1. Source: https://github.com/rotemdan/hunspell-wasm (commit 8f755ef64e8b047b77b676f9698b3dfa5cb1887d) and https://github.com/hunspell/hunspell." The full `dictionary-en` `license` text appears. Spec: Design notes "Engine". No dependency.

### Implementation

- [ ] T003 Add `hunspell-wasm` `^0.3.0` and `dictionary-en` `^4.0.0` to `package.json` and regenerate `bun.lock` with `bun install`, and change `src/frontend/build/notices.ts` (P0.1, WP1). WP1 is the only owner of `package.json` and `bun.lock` (plan.md "Work packages"). Add `copying.lesser` and `copying.mpl` to `LICENSE_NAMES` and the fixed `hunspell-wasm` note of T002. Run `bun run build:notices`. Make T002 and the dependency part of T001 pass. Record the review of both packages (licence, version, upkeep, integrity) in research.md R13 (constitution VIII). Spec: Design notes "Engine". Depends on T001, T002.

### Early facts (they change the plan before dependent work)

- [ ] T004 [P] Write the fact cases F1 to F7 and F15 in the new `tests/git/dictionary-facts.test.ts`, with a test CA, a server certificate, and its key that the test makes at run time in its owned temporary folder with the openssl of the selected Git (`<git --exec-path>/../../../usr/bin/openssl.exe`, else `openssl` on `PATH`); without openssl, F3 skips with the capability `openssl`; the repository holds no key (P0.2, WP1). Local servers on 127.0.0.1 only. F1: `redirect: "manual"` gives 301, 302, 303, 307, and 308 unfollowed. F2: with `proxy: false` and `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` set to a local counting proxy, the counter stays 0. F3: in a child Bun process with `NODE_EXTRA_CA_CERTS` set to the test CA, `tls: {ca: tls.rootCertificates}` fails against the local TLS server, and a request without `tls` succeeds; with `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: true` still fails. F4: a gzip body yields decoded bytes, and a cancel after N + 1 bytes ends the read. F5: an abort during a body read rejects the pending read, and the run's own flag tells Cancel from the deadline. F6: a closed port rejects with a `TypeError` that carries `code`. F7: `rm(path, {recursive: true})` on a folder with a junction and a symbolic link to an outside folder keeps the outside files; `rename` of a folder to a new name in the same parent succeeds. F15: `createHunspellFromStrings` of `hunspell-wasm` loads the `dictionary-en` files under Bun 1.4.3 and answers `testSpelling("receive")` true and `testSpelling("recieve")` false. Each case prints `OBSERVATION T004: <Fn> <fact>` with the Bun version. Kill every child process by PID at the end. Add the file to `tests/groups.json` `parallel`. Spec: FR-008, FR-010, FR-011. Depends on T003.
- [ ] T005 [P] Write the fact case F14 in the new `tests/gate/wasm-asset.test.ts` (P0.2, WP1). In an owned temporary folder outside the repository, write a probe module worker that imports `createHunspellFromStrings` from `hunspell-wasm`, and build it with the installed Vite (`bunx --bun vite build` with a probe config, the `worker.format: "es"` of `vite.config.ts`). The output must hold one emitted `.wasm` file with the SHA-256 `72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0`, and the built worker chunk must name it through `new URL(…, import.meta.url)`. Print `OBSERVATION T005: F14 <result>` with the Vite version. Remove the temporary folder. A failure changes plan.md D9 (the asset form, for example an explicit `?url` import and the loader option `locateFile`) before T027. Spec: FR-008. Depends on T003.
- [ ] T006 [P] Record the fact F16 (P0.2, WP1, agent scout). `Local: network`. Read the tree of github.com/rotemdan/hunspell-wasm at `8f755ef64e8b047b77b676f9698b3dfa5cb1887d` through `api.github.com`. Record in research.md R13: whether the commit holds the Hunspell C++ source or a submodule commit of github.com/hunspell/hunspell, the Hunspell version that it builds, and the build files that make `wasm/hunspell.wasm`. If the commit holds no buildable source, change the plan.md D18 note text to name the exact upstream source, and record the gap. The legal reading of LGPL-2.1 Hunspell embedded in the application bundle stays a user and lawyer item. Spec: Design notes "Engine". Depends on T003.
- [ ] T007 Write `scripts/dictionary-catalog.ts`, `src/contracts/dictionaries.json`, `src/contracts/dictionaries.ts` (the `Catalog` schema only), and `scripts/dictionary-gate.json` (an empty failure list) (P0.1, WP1). `Local: network`. The script reads the tree of the pinned commit from `api.github.com`, stores it as `tree.json` in `<ARBARETO_DICTIONARY_CACHE>/<commit>/`, downloads each `index.aff`, `index.dic`, licence document, and `package.json` once from `raw.githubusercontent.com` into `<cache>/<commit>/<id>/`, and computes each SHA-256 there. Licence documents: every file named `license` or `licence`, in that order, else `readme.md` (plan.md D3). Licence value: the `license` field of the `package.json`, as given. Name: `Intl.DisplayNames("en", {type: "language"})`, with a reviewed override table for IDs that it returns unchanged. Gate step 1: leave out each language above 12,582,912 bytes (el, el-polyton, ko, mn, and rw). Leave out `en`, and write the `bundled` record from `node_modules/dictionary-en`. Leave out each ID of `scripts/dictionary-gate.json`. Order by `compareNames`. `--offline` reads only the cache and makes the same bytes. Make T001 pass. Add the catalog command to README "Development" only after it runs green. Spec: FR-015, FR-017. Depends on T001, T003.
- [ ] T008 Write the early gate report in the new `tests/gate/dictionary-gate.test.ts`, and run it with the cache (P0.1, WP1). One Bun child process per cached catalog language, with a 60 s timeout, killed by PID at the end. Each child loads the language with `createHunspellFromStrings` and runs the fixture of data-model §16 exactly: the Hunspell line, flag form, `AF` alias, and homonym rules; the refusing flags of `FORBIDDENWORD`, `NEEDAFFIX` or `PSEUDOROOT`, `ONLYINCOMPOUND`, and `WARN` with `FORBIDWARN`; no phrase lines; the 200 positive steps; the negative words of the Script value that holds the most letters of the positive words; and the refusals `no-positive-words`, `script-unlisted`, `script-tie`, and `script-letters`. Print `OBSERVATION T008: <id> load=<ms> rss=<MiB> nfc=<aff>/<dic> fixture=<failed positives>/<failed negatives> positives=<count> script=<value> latinAccepted=<count>/5` (F12, F13), `OBSERVATION T008: <id> fixture refused: <reason>`, or "no load within 60 s". A Bun time decides nothing. A fixture failure or refusal enters `scripts/dictionary-gate.json` with its reason and values. Without the cache, the test skips with "dictionary cache absent: set ARBARETO_DICTIONARY_CACHE". If T004 shows that F15 fails, the test records "hunspell-wasm does not run under Bun" and the packaged gate alone decides step 2. Add `bun test tests/gate` to README "Development" only after it runs green. Spec: FR-017, SC-002. Depends on T004, T007.

### Fact gate

- [ ] T009 Copy every `OBSERVATION` line of T004 to T008 into research.md R13 with its mark (WP1). A failed F3 changes plan.md O-12 before T018 and T022, so that T018 adds `NODE_EXTRA_CA_CERTS` to the removed variables of `src-tauri/src/env_sanitize.rs`. A failed F14 changes plan.md D9 before T027. A failed F15 changes plan.md D3 and quickstart.md Q4. A failed F16 changes plan.md D18. Each change runs `/speckit-analyze`. Spec: FR-008, FR-010, FR-017. Depends on T004 to T008.

**Checkpoint**: The catalog, the packages, and the notices exist. Every early Bun and build fact has an observation.

---

## Phase 2: Contracts and the word rules (Batch 0, P1 and P2, WP2)

**Agent**: implementer.

**Purpose**: The shared word rules and every contract delta that later packages use.

### Tests (write first; they must fail)

- [ ] T010 [P] Write failing contract tests in the new `tests/contracts/spelling-contract.test.ts` and in `tests/contracts/{envelope,vectors,schemas,bridge}.test.ts`, with valid and invalid golden vectors in `tests/vectors/` (P2, WP2). Contract Δ1 to Δ3: `listDictionaries {}`; `readDictionary {language, file, offset}` with `offset` 0 or a multiple of 1,048,576 below the size; `downloadDictionary {language}`; `importDictionary {language}` (native-first, forwarded as `{language, folder}`); `removeDictionary {language}`; `setSpelling {enabled, languages}` with 0 to 3 unique IDs; `openLicenceLink {language}`; the `readSyncSettings` result field `spelling`. The data-model §4 and §7 results. The phase `dictionary` with the counters `received` and `total`. The code `DICTIONARY_UNAVAILABLE` with the reasons `busy`, `not-https`, `redirect`, `http-not-found`, `http-rate-limit`, `http-status`, `transport`, `mismatch`, `save`, `import-mismatch`, `import-unreadable`, `absent`, `changed`, `remove`, `link`, with `status` an integer from 100 to 599 on `http-status`, `folder` on `save`, `import-unreadable`, and `remove`, and `url` on `link`. The Δ5 limits with their exact values: `DICTIONARY_LANGUAGE_BYTES` 12,582,912, `DICTIONARY_MANIFEST_BYTES` 65,536, `DICTIONARY_CHUNK_BYTES` 1,048,576, `DICTIONARY_DOWNLOAD_DEADLINE_MS` 120,000 (equal to `REGISTERED_DEADLINE_CAP_MS`), `DICTIONARY_LOAD_DEADLINE_MS` 30,000 (equal to `READ_DEADLINE_MS`), `DICTIONARY_PROGRESS_EVENTS_PER_SECOND` 4, `SPELLING_LANGUAGES` 3, `SPELLING_SUGGESTIONS` 5, `PERSONAL_WORDS` 10,000, `PERSONAL_WORD_CODE_POINTS` 100. Unknown fields give `INVALID_REQUEST`. Add the new file to `tests/groups.json` `parallel`. Spec: FR-009, FR-016, FR-027. Contract: Δ1 to Δ3, Δ5, Δ9, Δ10. Depends on T009.
- [ ] T011 [P] Write failing tests in the new `tests/contracts/spell-words.test.ts` (P1, WP2). Data-model §11: every row of the vector table; lines split at U+000A; backtick pairs per line, and a last unpaired backtick skips nothing; tokens are runs without `White_Space`; a token with a code point of `\p{Nd}`, `_`, `/`, `\`, `@`, or `:`, or a `.` that is neither its first nor its last code point, is skipped; `Intl.Segmenter("und", {granularity: "word"})` with `isWordLike`; the lookup form is NFC and the range keeps the offsets. Data-model §12: L = {kubectl} accepts `kubectl`, `Kubectl`, `KUBECTL` and refuses `KubeCtl`; L = {iPhone} accepts `iPhone`, `IPhone`, `IPHONE`. Data-model §13: the changed lines of a typed character, a deleted line, a pasted block, and an insertion at a line end; marks before the changed lines stay, marks after them move by `|B| − |A|`, marks in them go; a round merges only when every worker of the round replied; a newer round drops an older one, and the next round carries the union of the dropped and the new changed lines. Data-model §15: the join in selection order, NFC repeats dropped, cut to 5. Plan.md D17: the size text "<x.xx> MB" with x.xx = floor((bytes + 5,000) / 10,000) / 100 (570,579 bytes give "0.57 MB"). The module has no runtime import (assert on the source text). Add the file to `tests/groups.json` `parallel`. Spec: FR-003 to FR-006, SC-004. Depends on T009.

### Implementation

- [ ] T012 [P] Create `src/contracts/spell-words.ts` with the data-model §11 word rules, the §12 case rule, the §13 changed-line shift and round merge, the §15 suggestion merge, and the D17 size text (P1, WP2). No runtime import, as `src/contracts/ignore-line.ts`. Make T011 pass. Spec: FR-003 to FR-006. Depends on T011.
- [ ] T013 Implement the contract changes in `src/contracts/{operations,envelope,errors,limits}.ts` and the types and helpers of `src/contracts/dictionaries.ts`, export the schemas into `src/contracts/schemas/`, and carry the ripple into `src-tauri/src/schema.rs`, `src/frontend/bridge.ts`, and the existing contract tests (P2, WP2). `Local: Rust`. Add every Δ5 bound as a named constant. Add the operations to `OPERATION_NAMES`, and `setSpelling` and `openLicenceLink` to `SHELL_ONLY`. The service answers the new service operations with `SERVICE_UNAVAILABLE` until T022. Make T010 pass. Spec: FR-009, FR-016, FR-027. Depends on T010, T012.

### Batch 0 verification

- [ ] T014 Run the batch 0 verification: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `bun run test:contracts`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, `bun test tests/gate` with the cache, and `bun run test:all` (WP2). `Local: Rust`. `Local: Windows`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. Control mutations, each undone and rerun green: (1) in `src/contracts/spell-words.ts`, drop `:` from the skip set; the `user@host`-style URL vector of `tests/contracts/spell-words.test.ts` must fail. (2) In `src/contracts/dictionaries.ts`, accept a URL with another commit; the URL case of `tests/contracts/dictionary-catalog.test.ts` must fail. The task passes only after one independent review of batch 0 is recorded in research.md R13, with `ponytail-review` and the heuristics review. Spec: all IDs of T001 to T013. Depends on T001 to T013.

**Checkpoint**: The catalog, the word rules, and the contract exist. The service answers the new operations with `SERVICE_UNAVAILABLE`.

---

## Phase 3: User Stories 2 and 3 - The shell (Batch 1 track A, P3, WP3) (Priority: P1 and P2)

**Agent**: implementer-xhigh. Local only.

**Goal**: The WSL `globalConfig` target, the spelling setting, the licence link, the import picker step, the forwarded dictionary commands, and the CSP.

**Independent Test**: Cargo tests for each target, refusal, setting round trip, and the CSP value (quickstart.md Q15, Q20, Q21).

### Shell tests (write first; they must fail)

- [ ] T015 [US2] Write failing cargo tests in `src-tauri/src/{process_requests,service,settings,dialogs,ipc,schema,lib}.rs` and the new `src-tauri/src/links.rs` (P3, WP3). Stories: US2, US3. `Local: Rust`. WSL `globalConfig` (contract Δ6, as `a_wsl_clone_binds_its_git_without_an_identity_and_checks_the_destination_with_the_destination_mode`): a WSL installation targets `wsl::wsl_program()` with no Git identity; the listing runs in wrapper mode `read`, and `config set --global` and `config unset --global` in mode `integrate`; the command holds `--no-lazy-fetch -C /` before the fixed array; `WSLENV` is empty; the anchor starts before an `integrate` process; a Windows Git keeps its launch folder target; every other array still gives `INVALID_REQUEST`. `setSpelling` (contract Δ3): more than 3 languages, a repeat, or an ID that is not `en` and not a catalog ID give `rejected` `INVALID_REQUEST`; the setting round-trips in `settings.json`; the default and a read failure give `{enabled: true, languages: ["en"]}`; at load, an ID that left the catalog drops. `readSyncSettings` carries `spelling`. `openLicenceLink`: the URL is `licences[0]` of the embedded catalog entry, or the `bundled` URL for `en`; the call runs on a dedicated thread with `CoInitializeEx(COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)` before `ShellExecuteW` and `CoUninitialize` after it (an injected launcher records the order); a return value of 32 or less gives `failed` with reason `link` and `url`; an unknown ID gives `rejected` `INVALID_REQUEST`. `importDictionary` native step: an unknown ID gives `INVALID_REQUEST` before the picker; the picker title is "Choose the folder with the <Language> dictionary files"; Cancel gives `canceled`; a picker failure gives `rejected` `PICKER_FAILED`; a path with a lone surrogate gives `rejected` `INVALID_REQUEST`; the forward holds `{language, folder}`. Each new service operation has its Tauri command, its `build.rs` entry, and its capability. The CSP of `tauri.conf.json` holds `script-src 'self' 'wasm-unsafe-eval'` and `connect-src ipc: http://ipc.localhost 'self'`, and every other directive keeps its earlier value. Spec: FR-009, FR-012, FR-015, FR-018, FR-021. Depends on T014.

### Shell implementation

- [ ] T016 [US2] Implement the WSL target of `Kind::GlobalConfig` in `src-tauri/src/process_requests.rs` (P3, WP3). `Local: Rust`. Copy the `Kind::Clone` WSL form (`process_requests.rs:1874-1884`): `program: wsl::wsl_program()`, `git_identity: None`, `wsl: Some((installation, "/"))`. `global_config_fits` stays. Make the `globalConfig` cases of T015 pass. Spec: FR-018, FR-021. Depends on T015.
- [ ] T017 [P] [US1] Change the CSP in `src-tauri/tauri.conf.json` to `script-src 'self' 'wasm-unsafe-eval'` and `connect-src ipc: http://ipc.localhost 'self'` (P3, WP3). `Local: Rust`. Make the CSP case of T015 pass. Spec: FR-008. Contract: Δ7. Depends on T015.
- [ ] T018 [US3] Implement the spelling setting, the shell-only operations, and the native step in `src-tauri/src/{settings,service,dialogs,ipc,lib}.rs`, the new `src-tauri/src/links.rs`, `src-tauri/build.rs`, and `src-tauri/capabilities/main.json` (P3, WP3). `Local: Rust`. `settings.rs`: the key `spelling` beside `switchChoice` (data-model §8). `service.rs`: the native answers of `setSpelling` and `openLicenceLink`, and the `importDictionary` prepare step with the embedded catalog (`include_str!` of `src/contracts/dictionaries.json`, as `git_env.rs:24`). `dialogs.rs`: the folder picker with the D17 title. `links.rs`: the COM thread and `ShellExecuteW`. `ipc.rs`, `lib.rs`, `build.rs`, `capabilities/main.json`: the five service commands. When T009 recorded F3 as failed, also add `NODE_EXTRA_CA_CERTS` to `STARTUP_CONTROLS` in `src-tauri/src/env_sanitize.rs` with its cargo case (plan.md O-12). Make the rest of T015 pass. Spec: FR-009, FR-012, FR-015. Depends on T016.

**Checkpoint**: The shell serves the spelling setting, the licence link, the import picker, the dictionary commands, the CSP, and the WSL Global target.

---

## Phase 4: User Story 3 - Service dictionaries (Batch 1 track B, P4, WP5) (Priority: P2)

**Agent**: implementer.

**Goal**: List, read, download, import, and remove dictionaries, with the release reconcile.

**Independent Test**: Quickstart.md Q14 to Q19 with the injected `fetch` seam and synthetic dictionaries.

### Tests (write first; they must fail)

- [ ] T019 [P] [US3] Write failing tests in the new `tests/git/dictionaries.test.ts` through `openService` of `tests/git/service-harness.ts` with a synthetic catalog, an owned `dictionaryFolder`, and an injected `fetch` (P4, WP5). Quickstart.md Q14 to Q19, service part. Download: success installs `<id>/` with `entry.json` `{version: 1, entry}`, and every request names `redirect: "manual"`, `proxy: false`, `tls: {rejectUnauthorized: true, ca: tls.rootCertificates}`, and `keepalive: false`; Cancel gives `canceled`; one changed byte, a short body, and a long body give `mismatch`, and a long body writes at most the catalog size; 301 to the same host and 302 to another host give `redirect`; 404 gives `http-not-found`; 429 gives `http-rate-limit`; 503 gives `http-status` with `status` 503; an `http:` entry gives `not-https` with no request; a rejected `fetch` gives `transport`; the 120 s deadline (fake clock) gives `DEADLINE`; a write error gives `save` with the Windows folder path; after every end except `ready`, no file stays and no staging folder stays. Progress events of phase `dictionary` carry `received` and `total`, at most 4 per second. Import: the catalog files install with 0 `fetch` calls; a changed, missing, or other-type file gives `import-mismatch`; a read error other than `ENOENT` gives `import-unreadable` with `folder`; the 120 s deadline (fake clock) gives `DEADLINE`. Read: chunks of 1,048,576 bytes join to the catalog bytes; a changed byte of the requested file, a missing requested file, and a 65,537-byte `entry.json` give `changed`; a missing folder gives `absent`; a fourth concurrent read gives `BUSY`; a `cancel {operationId}` gives `canceled`. List: `not-downloaded`, `ready`, `changed`, `downloading`, `importing`, with the full language check. Reconcile (data-model §3 table): a `.staging-` leftover goes; another entry in `entry.json` removes the folder with the notice `catalog-changed`; an ID that left the catalog with a valid manifest removes the folder with `catalog-removed` and its name; an unknown folder stays untouched; a read sent before the reconcile ends waits for it. One run at a time: a second download gives `busy` before any byte; Remove of the language under a run gives `busy`. Remove: the folder goes with no confirmation step; `removed` is false for an absent folder; a held file gives `remove` with `folder`. A Git read and a commit run during a download, and neither waits. The session log holds only `kind`, `operationId`, `durationMs`, `code`, and `count`. Add the file to `tests/groups.json` `parallel`. Spec: FR-010 to FR-014, FR-016, FR-017, FR-027, SC-002, SC-003. Depends on T014.
- [ ] T020 [P] [US1] Write the failing source test in the new `tests/contracts/network-sites.test.ts` (P4, WP5). `src/frontend` holds no `fetch(` call. `src/git-service` holds exactly one, in `dictionaries.ts`. Add the file to `tests/groups.json` `parallel`. Spec: FR-007, SC-001. Depends on T014.

### Implementation

- [ ] T021 [US3] Create `src/git-service/dictionary-store.ts` (P4, WP5). The folder `<launch directory>/dictionaries` from the `dictionaryFolder` option; the staging folder `.staging-<id>-<32 hex>/`; the install: remove an existing `<id>/`, then rename the staging folder (plan.md D5); the manifest read of at most 65,536 bytes; the language check and the file check of data-model §3; the release reconcile as one promise per service process that every operation awaits. Removal uses `rm` with `recursive: true`. Make the store cases of T019 pass. Spec: FR-011, FR-013, FR-014, FR-017. Depends on T019.
- [ ] T022 [US3] Create `src/git-service/dictionaries.ts`, and change `src/git-service/{session,main}.ts` and `tests/git/service-harness.ts` (the `dictionaryFolder`, `catalog`, and `fetch` options) (P4, WP5). The five operations of contract Δ3 through the operation registry, with Cancel; the run lock; the download of plan.md D4 with the status rule, the bounded decoded body (at most size plus one byte read, at most size written), `Bun.CryptoHasher("sha256")`, the deadline flag, and progress; the import of D6; the read of D7 with at most 3 concurrent calls; `main.ts` passes `join(process.cwd(), "dictionaries")`. Make T019 and T020 pass. Spec: FR-010 to FR-014, FR-016, FR-027. Depends on T021.
- [ ] T023 [US3] Extend `tests/gate/dictionary-gate.test.ts` with the service path of spec SC-002 (P4, WP5). For each cached catalog language, in its own Bun process with a 60 s timeout, killed by PID at the end: start the service with `createSession`, an owned `dictionaryFolder`, the real catalog, and an injected `fetch` that serves the cached bytes for the catalog URLs; run `downloadDictionary`, read `index.aff` and `index.dic` back with `readDictionary`, and run the data-model §16 fixture on those bytes; then run `removeDictionary`, run the `importDictionary` service step with `folder` the cache folder of that language, and run the fixture again. Print `OBSERVATION T023: <id> download=<result> import=<result> fixture=<failed positives>/<failed negatives>`. Without the cache, the test skips with the T008 reason. If T004 recorded F15 as failed, the fixture part records "hunspell-wasm does not run under Bun", and the install part still runs. Spec: SC-002, FR-011, FR-012. Depends on T008, T022.

**Checkpoint**: The service downloads, imports, reads, lists, and removes dictionaries with every FR-016 cause.

---

## Phase 5: User Story 1 - Spell check in the commit message editor (Batch 1 track C, P6 and P0.3 early, WP6) (Priority: P1)

**Agent**: frontend-implementer. It loads `arbareto-ux`, `vercel-react-best-practices`, and `web-design-guidelines`. T028 by scout.

**Goal**: Marks, the chip, the count, the spelling menu, Ignore, Add to dictionary, and the workers.

**Independent Test**: Quickstart.md Q6, Q7, and Q9 to Q11 in component tests, then N1 and N2 on `bun run dev`.

### Tests (write first; they must fail)

- [ ] T024 [P] [US1] Write failing tests in the new `tests/contracts/word-list.test.ts` with an injected fake `IDBFactory`, as `tests/contracts/draft-store.test.ts` (P6, WP6). Data-model §9: database `arbareto-spelling` version 1, store `words`, key path `word`, record `{word}`; `word` is NFC, 1 to 100 code points; Add is one `readwrite` transaction with `count()` then `add`, refused at 10,000 records; `ConstraintError` means "already listed"; Add never calls `put`; Remove deletes one key; more than 10,000 records, a record that fails the rules, or a read error give `unreadable`, and then no write reaches the store; a failed `open` gives `unavailable`. Add the file to `tests/groups.json` `parallel`. Spec: FR-006. Depends on T014.
- [ ] T025 [P] [US1] Write failing tests in the new `tests/contracts/spelling-editor.test.tsx` with a fake worker factory and the fake bridge (P6, WP6). Quickstart.md Q6, Q7, Q9 to Q11. The English fixture message marks every listed misspelling and no correct word or skipped token (SC-001). The count text "No possible misspellings", "1 possible misspelling", or "<n> possible misspellings" joins the editor `aria-describedby`, and exists only while spell check is on, a language is loaded, and no composition runs. The chip "Spelling: English", "Spelling: English, Ukrainian", "Spelling: Off", and "Spelling: No language loaded", with the D17 tooltip lines, which also join the editor description. Right-click inside a mark span rect, Shift+F10, and the Menu key with the caret at `start ≤ o ≤ end` open the menu "Spelling of <word>" with at most 5 suggestions, then "Ignore" and "Add to dictionary", then "Cut", "Copy", and "Select all"; elsewhere no `preventDefault`. A suggestion replaces the range only when its text equals the mark `raw` text. "Finding suggestions…" shows while a suggestion worker computes, and a round of typed text merges while it computes. Ignore holds for the window session. Add to dictionary and the case rule; the four unavailable reasons of D17; "Select text first." for Cut and Copy without a selection. A typed character sends a round of its changed line only. The 30 s load deadline (fake clock) terminates the worker and shows the load text. A message above 65,536 UTF-8 bytes runs no round and shows the limit text. `compositionstart` hides every mark. The menu holds no Paste item, and Ctrl+V still pastes (FR-005). Commit with marked words runs with the text unchanged; the draft text, the drafts flow, and the 72-column guide stay unchanged (FR-007, US1-6). The merge message field of `IntegratePanel.tsx`, the diff views, and the file lists get no mirror and no marks (FR-002). Stubs of `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `navigator.sendBeacon` count 0 calls. When T004 recorded F15 as passed, one case runs the real `hunspell-wasm` engine under Bun with the bundled English files and the English fixture message; otherwise that case records `OBSERVATION T025: real engine case skipped, F15 failed`. Add the file to `tests/groups.json` `parallel`. Spec: FR-001 to FR-008, SC-001. Depends on T014.

### Implementation

- [ ] T026 [US1] Create `src/frontend/spelling/{word-list,store}.ts` (P6, WP6). The IndexedDB store of D10 with an injected `IDBFactory`; the store of D15: the selection from `readSyncSettings` `spelling`, the language states, the word list state, the Ignore list, and the subscriptions, with the 001 latest-wins rule. Make T024 pass. Spec: FR-006, FR-009. Depends on T024.
- [ ] T027 [US1] Create `src/frontend/spelling/{spell-worker,english,engine}.ts` with the check worker only, and change `vite.config.ts` (the `dictionary-en` `resolve.alias` and the `hunspell.wasm` asset form that T005 confirmed) (P6, WP6). The module worker in the `?worker&url` form of `PatchPool.tsx:4,10`; `createHunspellFromStrings`; English through `?raw` in a dynamic `import()`; downloaded languages through `readDictionary` chunks posted as base64 and decoded with `TextDecoder("utf-8", {fatal: true})`; rounds over the changed lines with `spell-words.ts`; complete rounds only; the 30 s load deadline with `cancel` of a running read and `worker.terminate()`. Make the check cases of T025 pass. Spec: FR-003, FR-004, FR-007, FR-008. Depends on T009, T013, T025, T026.
- [ ] T028 [US1] Run the early facts N1 and N2 on `bun run dev` with `ARBARETO_PROFILE_ROOT` set to a scratch folder (P0.3, WP6, agent scout). `Local: Windows`. N1: the check worker starts under the T017 CSP, fetches `hunspell.wasm` from the app origin, and marks "recieve" in the English fixture; no CSP violation reaches the WebView2 console. N2: an uncommitted probe edit of `src/frontend/commit/CommitTray.tsx` maps Ctrl+Alt+F12 to `setSelectionRange` on the word "recieve" of the fixture text and `document.execCommand("insertText", false, "receive")`; `tests/windows/inject.ts` sends Ctrl+Alt+F12, then one Ctrl+Z. The word must change with one `input` event, and the Ctrl+Z must restore "recieve". The run has a 60 s timeout, and the app process ends by PID. After the run, undo the probe edit, and `git diff -- src/frontend/commit/CommitTray.tsx` must show no probe line. Record `OBSERVATION T028: N1 <result>` and `N2 <result>` with the WebView2 version in research.md R13. A failed N1 changes plan.md D9 and contract Δ7 before T029. A failed N2 changes plan.md D15 (the replace and its undo rule) before T029. Each change runs `/speckit-analyze`. Spec: FR-005, FR-008, SC-001. Depends on T017, T027.
- [ ] T029 [US1] Create the suggestion worker in `src/frontend/spelling/{engine,spell-worker}.ts` and `src/frontend/spelling/{SpellMirror,SpellMenu,SpellChip}.tsx`, `src/frontend/spelling/texts.ts`, and change `src/frontend/commit/CommitTray.tsx`, `src/frontend/bridge.ts`, and `src/frontend/app/Workbench.tsx` (the spelling store) (P6, WP6). The suggestion worker of D9, created at the first menu of a language, loaded with the same chunks, with the 30 s deadline; the mirror of D8 (the wrapper box, `clientWidth`, the copied styles, `scrollTop`, `replaceChildren`, the wavy mark style); the menu of D15 on the house `ActionMenu` with `anchor` at the mark span; the chip of D16; the D17 texts verbatim. Make T025 pass. Compare with the Main, SpellingEdges, ForcedColors, and Light boards. Spec: FR-001 to FR-008, FR-026. Depends on T028.

### Batch 1 verification

- [ ] T030 Run the batch 1 verification: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, `bun run test:all`, then `bun run build:service` and `bun run test:windows`. `Local: Rust`. `Local: Windows`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. Control mutations, each undone and rerun green: (1) in `src/git-service/dictionaries.ts`, accept status 301 as success; the redirect case of `tests/git/dictionaries.test.ts` must fail. (2) In `src/git-service/dictionaries.ts`, drop `proxy: false`; the request option case of T019 must fail. (3) In `src/frontend/spelling/engine.ts`, merge a round when the first worker replies; the partial-round case of `tests/contracts/spelling-editor.test.tsx` must fail. (4) In `src-tauri/src/process_requests.rs`, give the WSL `globalConfig` target the repository folder; the `-C /` cargo case must fail. Board comparison: start the app with `bun run dev` and a scratch `ARBARETO_PROFILE_ROOT`, and compare the marks, the chip, and the menu with the Main, SpellingEdges, ForcedColors, and Light boards. Record the screenshots and every difference in research.md R13. The task passes only after one independent review of batch 1 is recorded in research.md, with `ponytail-review`, the heuristics review, and `web-design-guidelines` for the UI diff. Spec: all IDs of T015 to T029. Depends on T015 to T029.

**Checkpoint**: US1 works in the app with English. The service and the shell serve every dictionary operation.

---

## Phase 6: User Stories 2 and 4 - WSL parity (Batch 2 track A, P5, WP4) (Priority: P1 and P3)

**Agent**: implementer-xhigh. `Local: WSL`. Each WSL run runs alone on the host.

**Goal**: The Global save in a WSL repository, the double routes, and the 004 rows without a WSL case.

**Independent Test**: Quickstart.md Q22 and Q23 in Ubuntu-26.04.

### Precondition

- [ ] T031 [US2] Check the open 005 point after 005 merged (P5, WP4). Report to the orchestrator whether `src-tauri/src/wsl.rs` and `src/contracts/wsl-process.json` still hold the `wslFiles` mode `append`, and whether `tests/wsl/workbench-wsl.test.ts` still holds the T081 `fileAppend` block (plan.md D14). A leftover is a 005 follow-up. This task changes no file. Spec: Dependencies. Depends on T030.

### Tests (write first; they must fail)

- [ ] T032 [US2] Write failing WSL Global cases in `tests/wsl/workbench-wsl.test.ts` (P5, WP4). `Local: WSL`. Quickstart.md Q22. Before the first write, `git var GIT_CONFIG_GLOBAL` through the double must print the owned path (spec FR-023). Save and remove each 004 FR-060 key in Global: the owned global file changes only in that key, and every other configuration byte stays. A multi-valued key and an included value stay read only. Cancel, with the fresh listing deciding the result. A change before the review gives the 004 `changedOutside` path, and a change after the review gives `stale` with "<key> changed before its write, so Arbareto did not write it.". A refused write names the key and the bounded output tail. The mode case: `core.sharedRepository=0660` in the repository, no owned global file, the umask read with the wrapper in mode `integrate` around `/bin/sh -c umask`, a refusal to run when `0666 & ~umask` equals 0660, and `stat -c %a` of the new global file equal to `0666 & ~umask` after the save (F9, SC-005). `HOME` is set under the wrapper (F10). The SHA-256 of the real `~/.gitconfig` and of the real XDG file, read inside the distro without the forwarding, stays the same before and after (spec FR-025). The XDG global file case records `OBSERVATION T032: unverified XDG global file through the double` (research.md R9). The spec edge case of a distro user without `HOME` cannot run through the double, because the double forwards `GIT_CONFIG_GLOBAL`, so it records `OBSERVATION T032: unverified save without HOME`. The double without `wslGlobalConfig` refuses the WSL `globalConfig` and `worktreeAdd` routes before any process. Spec: FR-018 to FR-025, SC-005. Depends on T031.

### Implementation

- [ ] T033 [US2] Change `src/git-service/git-settings.ts` and `tests/git/bun-runner.ts` (P5, WP4). `Local: WSL`. `git-settings.ts`: drop the WSL refusal of the `config-save` precheck (`git-settings.ts:214-216`); `files.global` stays null on WSL. `bun-runner.ts`: the WSL `globalConfig` route with `cwd` the UNC root of `/`; the WSL `worktreeAdd` route with the `wslParts` Linux path check; the `destinationFacts` WSL branch through the `wslFiles` mode `destination` in wrapper mode `probe`, as `wsl.rs:1480-1505`; each refuses without `wslGlobalConfig`. Make T032 pass. Spec: FR-018, FR-019, FR-023. Depends on T016, T032.
- [ ] T034 [US4] Write the WSL rows in `tests/wsl/workbench-wsl.test.ts` (P5, WP4). `Local: WSL`. Plan.md D14 table: Q8 (two mapping refspecs), Q9 (delete a branch of another worktree; a branch moved after the review), Q10 (every merge option and allowed combination), Q11 (the force note for the push tracking ref, with a bare remote in the owned distro folder), Q13 (AU, UA, UD, DD, and the symlink stage), Q15 (a folder, all changes, one refused file, `STALE_SELECTION`), Q16 (added and removed hunks, and the refusals), Q20 (Open worktree; remove a locked worktree and the main worktree; Add worktree through the service), Q22 (Not now, Stop trusting, the version 1 record), and Q23 (a refusal, the host line, Retry, Cancel). Each result equals Git's own commands on a copy in the distro: HEAD, refs, the index, working files, configuration files, and the operation state. Each cancel or close case ends with no Git process and no `arbareto-*` scope. A row without its resource prints `OBSERVATION T034: unverified <row> <cause>` (spec FR-024). Run the file alone. Spec: FR-024, SC-006. Depends on T033.

**Checkpoint**: The Global save works in a WSL repository through the double. Every R21 row has a WSL result or a recorded cause.

---

## Phase 7: User Story 3 and the US2 header - Settings (Batch 2 track B, P7, WP7) (Priority: P2 and P1)

**Agent**: frontend-implementer. It loads `arbareto-ux`, `vercel-react-best-practices`, and `web-design-guidelines`. It pauses its test runs while T032 to T034 run in the distro.

**Goal**: The Spelling page, the licence view, the WSL Global header, and the Hunspell note in About.

**Independent Test**: Quickstart.md Q19 to Q21 and Q26 in component tests.

### Tests (write first; they must fail)

- [ ] T035 [P] [US3] Write failing tests in the new `tests/contracts/spelling-page.test.tsx` with the fake bridge (P7, WP7). Quickstart.md Q19 to Q21 and Q26, page part. Each row state of data-model §4 (Bundled, Not downloaded, Downloading <n>%, Importing…, Ready, Changed, Failed) with its actions and its message row; the size text; the licence value as a link whose activation sends `openLicenceLink {language}` and prevents navigation; the `eu` and `et` readme note; the `oc` licence view with both documents; Show licence as plain `textContent`; every FR-016 text for its cause; the release removal notice above the table; the 3-language limit with the visible limit reason on unselected Ready rows and the not-ready reason in the checkbox description; Move up and Move down with their names, tooltips, and the first and last reasons; Alt+Up and Alt+Down; the chip preview; the personal word list with "<n> of 10,000 words", Remove with no confirmation, the empty text, and the two failure texts; each change sends `setSpelling` at once; Remove of a selected language sends `removeDictionary`, then `setSpelling` without it; the grid keys and one Tab stop per list; Escape closes the licence panel before Settings. Add the file to `tests/groups.json` `parallel`. Spec: FR-009, FR-012 to FR-016, FR-026, SC-007. Depends on T030.
- [ ] T036 [P] [US2] Add failing cases to `tests/contracts/workbench-settings.test.tsx` and `tests/contracts/platform-label.test.tsx` (P7, WP7). Stories: US2, US3. A WSL workspace with `files.global` null shows the FR-020 header "Git in <distro> writes its global file. It uses GIT_CONFIG_GLOBAL when set, else ~/.gitconfig, or the XDG file when only that exists." with the distro name, keeps the Global rows editable, shows "An empty field removes the key from this scope.", and enables Save; a Windows workspace with `files.global` null keeps `TEXTS.noGlobalFile`. About shows the `hunspell-wasm` note of plan.md D18 beside its licence texts. Spec: FR-020, Design notes "Engine". Depends on T030.

### Implementation

- [ ] T037 [US3] Create `src/frontend/settings/{SpellingPage,LicencePanel}.tsx`, and change `src/frontend/settings/{SettingsView,SettingsDialog}.tsx` and `src/frontend/bridge.ts` (P7, WP7). "Spelling" joins `APP_PAGES` after "Branch switch". The layout of plan.md D16 and the texts of D17 verbatim. Show licence of English reads the bundled `dictionary-en/license` through `?raw` (plan.md D12). Make T035 pass. Compare with the SpellingPage, DictionaryFailures, LicenceView, and Light boards. Spec: FR-009, FR-012 to FR-016, FR-026. Depends on T035.
- [ ] T038 [US2] Change `src/frontend/settings/git/{GitSettingsPage.tsx,texts.ts}`, `src/frontend/app/Workbench.tsx` (the `wslDistro` prop from `workspace.location.distro`), `src/frontend/settings/SettingsView.tsx` (`wsl` becomes `wslDistro`), and `src/frontend/about/AboutDialog.tsx` (P7, WP7). Make T036 pass. Compare with the WslGlobal board. Spec: FR-020. Depends on T036, T037.

### Batch 2 verification

- [ ] T039 Run the batch 2 verification: first `bun test tests/wsl/workbench-wsl.test.ts` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04` alone on the host, then `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, and `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. `Local: Rust`. `Local: Windows`. `Local: WSL`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. Copy every `OBSERVATION` line of T032 and T034 into research.md R13. Control mutations, each undone and rerun green: (1) the safe control of plan.md D14: the double runs the Global write in `registered(w)`; the mode case of T032 must fail with 0660. (2) In `src/frontend/settings/git/GitSettingsPage.tsx`, lock Global on WSL again; the T036 editable case must fail. Board comparison of the Spelling page and the WSL Global header against the SpellingPage, DictionaryFailures, LicenceView, WslGlobal, ForcedColors, and Light boards, recorded in research.md R13. The task passes only after one independent review of batch 2 is recorded in research.md, with `ponytail-review`, the heuristics review, and `web-design-guidelines` for the UI diff. Spec: all IDs of T031 to T038. Depends on T031 to T038.

**Checkpoint**: All four user stories work. The WSL rows have results.

---

## Phase 8: Qualification (Batch 3, P8, WP8, cross-cutting)

**Agent**: implementer writes the tests; scout runs them. WSL runs alone, then the packaged runs.

**Purpose**: Packaged Windows evidence, the packaged gate, the offline catalog rebuild, and the heuristics review.

- [ ] T040 Add `-Json` and `-IntervalMs` to `scripts/windows/measure-ram.ps1` (P8, WP8). `Local: Windows`. With `-Json`, the script prints one JSON line per sample with the root PID, the sum of `PrivateMemorySize64` of the `msedgewebview2.exe` processes in the `arbareto.exe` tree by its tree rule, and the total. With `-IntervalMs <n>`, it samples every n ms until the test ends it by PID. The text output without the switches stays unchanged. Check both forms by hand against a running app and record the output in research.md R13. Spec: SC-004, FR-017. Depends on T039.
- [ ] T041 [P] Write `tests/windows/spelling-packaged.test.ts` (P8, WP8). `Local: package`. F14 again: the installed `dist` assets hold `hunspell.wasm` with its SHA-256. N1: the workers fetch it under the CSP and mark English. N2: one Ctrl+Z after a suggestion restores the word (Q8). N3: right-click, Shift+F10, and the Menu key on a mark open the spelling menu, and elsewhere the built-in menu (live input, the T082 harness). N4: at 100%, 150%, and 225% text scale, the UI Automation `TextPattern` rect of each marked word equals its mirror span rect within 1 device pixel, also for a Hebrew line (Q13). N5: a Japanese IME composition shows no mark, and afterwards the marks equal the typed text; without the IME, a capability skip. N6: in a Windows Sandbox with `<Networking>Disable</Networking>`, as `scripts/windows/clean-install.wsb` runs the package, US1 passes, and Download shows the `transport` text and keeps no file (Q24); without Windows Sandbox, a capability skip. N8: the data-model §11 vectors give the same segments in the WebView2 worker. Keyboard-only runs of US1 to US3, accessible names, visible focus, and a contrast of at least 4.5:1 in Dark, Light, and forced colors (Q26). The manual checks of quickstart.md "Manual checks in the packaged build". Spec: FR-005, FR-007, FR-008, FR-026, SC-001, SC-007, SC-009. Depends on T040.
- [ ] T042 [P] Write `tests/windows/spelling-perf.test.ts` (P8, WP8). `Local: package`. Quickstart.md Q12, Q25, and Q27. SC-004: English marks within 1 s after the first open; a mark update within 100 ms after a typed character in a 64 KiB message with every word marked; no stall above 50 ms; the round time of a whole-text paste recorded as the limit case. The packaged gate of plan.md D3 per cached language: a fresh profile copy with the language and its `entry.json` in `<root>/data/dictionaries/<id>/` and `settings.json` `spelling` `{enabled: false, languages: [<id>]}`; the fixture text written with `ValuePattern`; the baseline as the median of 3 samples 1 s apart, 10 s after the editor shows; the load timer from the return of the Spell check switch `Toggle` to the first 50 ms poll that finds the chip name "Spelling: <Language>"; 250 ms samples of the T040 sampler until 5 s after the load and 5 s after the spelling menu of the first negative word shows its suggestions; the increase as the peak minus the baseline; the count text equal to the negative word count; 3 runs, each with a new app process; a pass only when all 3 runs load within 10 s, add at most 256 MiB, and give the exact count. FR-028: 95% of inputs within 100 ms and every input within 500 ms during a Ukrainian load, a 64 KiB round, a suggestion list, and a download. A missing 001 measurement tool gives a recorded capability skip, and the task stays open. Spec: FR-017, FR-028, SC-004. Depends on T040.
- [ ] T043 Run the packaged gate of T042 for every cached catalog language on the 004 reference PC, and record each run in research.md R13: the date, the build, the WebView2 runtime version, the baseline, the peak, the increase, the load time, and the fixture count (P8, WP8, agent scout). `Local: package`. Enter each failed language in `scripts/dictionary-gate.json` with its values. Then run `bun scripts/dictionary-catalog.ts --offline` and `bun test tests/contracts/dictionary-catalog.test.ts`. Spec: FR-017, SC-002, SC-004. Depends on T042.
- [ ] T044 Review the requirement-to-test map of the "Coverage" section (quickstart.md Q28). Record in `specs/006-wsl-parity-spellcheck/research.md` R13 that no outcome depends on Git message text, an error message, timing, a name pattern, or a language guess, or list each finding. Spec: SC-008. Depends on T041 to T043.
- [ ] T045 Run the batch 3 verification: first `bun test tests/wsl/workbench-wsl.test.ts` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04` alone, then `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, `bun test tests/gate` with the cache, `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`, then `bun run build:service`, `bun run package`, and `bun run test:windows`. `Local: Rust`. `Local: WSL`. `Local: package`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. Copy every record into research.md R13. Control mutations, each undone and rerun green: (1) in `tests/windows/spelling-perf.test.ts`, lower the 256 MiB bound to 1 MiB; the gate case must fail. (2) Lower the 100 ms mark update bound to 1 ms; the SC-004 case must fail. The task passes only after one independent review of batch 3 is recorded in research.md. Spec: SC-001 to SC-009. Depends on T041 to T044.
- [ ] T046 Run `/speckit-converge` and record the result. Spec: all. Depends on T045.

---

## Dependencies & Execution Order

### Phase dependencies

- Batch 0 (T001–T014): feature 005 merged first (spec Dependencies). WP1 (T001–T009) first, then WP2 (T010–T013), then T014.
- Batch 1 (T015–T030): after T014. WP3 (T015–T018), WP5 (T019–T023), and WP6 (T024–T029) run in parallel. T028 needs T017 of WP3. T030 after all three.
- Batch 2 (T031–T039): after T030. WP4 (T031–T034) and WP7 (T035–T038) run in parallel, but WP7 pauses its test runs while T032 to T034 run in the distro. T039 after both.
- Batch 3 (T040–T046): after T039. T040, then T041 beside T042, then T043, T044, T045, and T046.

### Early facts and the work they gate

| Fact | Task | Gates |
| --- | --- | --- |
| F3 (`tls.ca` against `NODE_EXTRA_CA_CERTS`) | T004 | T022 (the download options), through T009 |
| F14 (the `hunspell.wasm` asset of a Vite build) | T005 | T027 (the worker and `vite.config.ts`), through T009 |
| F15 (`hunspell-wasm` under Bun) | T004 | T008 (the early gate report) and the real-engine cases of T025 |
| F16 (the Hunspell source at the published commit) | T006 | the D18 note text of T003, through T009 |
| N1 (the workers and the wasm fetch under the CSP) | T028 | T029 |
| N2 (`insertText` with one undo step) | T028 | T029 |

### Changes to earlier requirements and their tasks

| Change (spec.md "Changes to earlier requirements") | Tasks |
| --- | --- |
| 004 FR-006 second exception, Clarifications, and contract lines 101, 225, 355: the WSL Global refusal goes | T015, T016, T032, T033 |
| 004 contract line 55 and data-model §9: `files.global` null on WSL means Git's `--global` rule | T036, T038 |
| 004 FR-083 and User Story 10, SC-012: marks for every selected language, Add to dictionary, the chip | T025, T027, T029 |
| 004 FR-084: only Download and Retry use the network | T019, T020, T025, T041 |
| 004 FR-085: a marked word gets its own action menu | T025, T029, T041 |
| 004 Scope Boundaries, Edge Cases, Assumptions: other dictionaries and their source | T001, T007, T019, T035 |
| 004 research R20: Hunspell replaces the nspell proposal | T003, T027 |
| 004 tasks T077 to T080 and T103 | T024 to T029, T032, T033 |
| 004 task T081: the R21 rows and Add worktree on WSL | T033, T034 |

### Parallel opportunities

- Batch 0: T001 beside T002, then T003; T004, T005, and T006 in parallel; T007, then T008, then T009; T010 beside T011; T012 beside T013 after their tests.
- Batch 1: Track A WP3: T015, then T016 beside T017, then T018. Track B WP5: T019 beside T020, then T021, then T022, then T023. Track C WP6: T024 beside T025, then T026, T027, T028, and T029 in order.
- Batch 2: Track A WP4: T031, T032, T033, T034 in order. Track B WP7: T035 beside T036, then T037, then T038.
- Batch 3: T040, then T041 beside T042.
- Shared files: `src/frontend/bridge.ts` in WP2 (T013), then WP6 (T029), then WP7 (T037). `src/frontend/app/Workbench.tsx` in WP6 (T029), then WP7 (T038). `src/frontend/settings/SettingsView.tsx` in WP7 only (T037, T038). `src/contracts/dictionaries.ts` in WP1 (T007), then WP2 (T013). `src/contracts/dictionaries.json` in WP1 (T007), then WP8 (T043). `package.json` and `bun.lock` in T003 only. `tests/gate/dictionary-gate.test.ts` in WP1 (T008), then WP5 (T023). `src-tauri/` in WP3 only, except the T013 ripple in `schema.rs`. `tests/groups.json` in every WP; the orchestrator resolves merge conflicts.

## Parallel Example: Batch 1

```text
Track A (WP3): T015 -> T016, T017 -> T018                 (Local: Rust)
Track B (WP5): T019, T020 -> T021 -> T022 -> T023
Track C (WP6): T024, T025 -> T026 -> T027 -> T028 -> T029   (T028 waits for T017; Local: Windows)
Then:          T030
```

## Coverage

| Requirement | Tasks |
| --- | --- |
| FR-001 (marks, count, chip) | T011, T025, T029, T041 |
| FR-002 (only the commit message editor) | T025, T029 |
| FR-003, FR-004 (words, any-accepts, NFC) | T011, T012, T025, T027, T041 |
| FR-005 (menu, suggestions, one undo step) | T011, T025, T028, T029, T041 |
| FR-006 (personal word list, case rule) | T011, T024, T026, T035 |
| FR-007 (offline, never blocks a commit) | T020, T025, T041 |
| FR-008 (bundled English, lazy load, workers, load deadline) | T004, T005, T017, T025, T027, T028, T041, T042 |
| FR-009 (Spelling page, selection setting) | T010, T015, T018, T026, T035, T037 |
| FR-010, FR-011 (download rules, bytes, deadline, one run) | T004, T019, T022, T023 |
| FR-012 (import) | T015, T018, T019, T022, T023, T035 |
| FR-013, FR-014 (check before load, remove) | T019, T021, T035 |
| FR-015 (licence value, link, documents) | T001, T007, T015, T018, T035, T037 |
| FR-016 (failure texts) | T010, T019, T035, T037 |
| FR-017 (catalog, gate, reconcile) | T001, T007, T008, T019, T021, T042, T043 |
| FR-018 to FR-022 (WSL Global save) | T015, T016, T032, T033, T036, T038 |
| FR-023 to FR-025 (double routes, WSL rows, no real global write) | T032, T033, T034 |
| FR-026 (controls) | T029, T035, T037, T041 |
| FR-027 (typed bounded operations) | T010, T013, T019, T022 |
| FR-028 (response targets) | T042 |
| SC-001 | T020, T025, T041 |
| SC-002 | T008, T019, T023, T043 |
| SC-003 | T019 |
| SC-004 | T011, T042, T043 |
| SC-005 | T032, T039 |
| SC-006 | T034 |
| SC-007 | T035, T041 |
| SC-008 | T014, T030, T039, T044 |
| SC-009 | T041 |

## Implementation Strategy

- MVP: batches 0 and 1 deliver US1 (spell check with bundled English) end to end, and the service and shell of US3. Stop there and validate with the user.
- Batch 2 delivers US2 (WSL Global save), US3 (the Spelling page), and US4 (the WSL rows).
- Batch 3 qualifies the package, runs the packaged gate, and rebuilds the catalog offline.
- Each batch ends with its verification task, the control mutations, the board comparison for UI work, and one independent review.

## Notes

- Run `/speckit-analyze` after every edit of this file.
- Run `/speckit-converge` at the end of each batch.
- The orchestrator commits after each task or logical group.
- The legal reading of LGPL-2.1 Hunspell embedded in the application bundle stays a user and lawyer item (plan.md D18).
