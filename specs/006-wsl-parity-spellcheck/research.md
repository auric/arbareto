# Research: WSL Parity and Commit Message Spell Check

## R1 Sources and fact marks

- Spec inputs: `spec.md` with its Clarifications of 2026-10-21 and 2026-10-22, the 006 recommendations and clarify scans (`scratchpad\f006\recommendations.md`, `scratchpad\f006\clarify.md`), and the user approval of the 006 mockup on 2026-10-22 (https://claude.ai/artifact/WX74LFkBZsAvyvFCPFiRJs, 8 boards, no comment threads; the local source in `scratchpad\f006\canvas\project\` has the same file sizes as the published files).
- The independent plan review of 2026-10-22 and the user decisions of 2026-10-22 (spec Clarifications).
- npm registry, read on 2026-10-22: `hunspell-wasm`, `dictionary-en`, `nspell`, `is-buffer`, `hunspell-asm`, `emscripten-wasm-loader`, `spellchecker-wasm`.
- The `hunspell-wasm` 0.3.0 and `hunspell-asm` 4.0.2 tarballs in `scratchpad\f006-wasm\dl-*` and their extracts in `scratchpad\f006-wasm\x-hw` and `x-ha`.
- Measurements of 2026-10-22 in headless Edge 155.0.4283.62 (V8 15.5.9.7), one dictionary per browser process, in a dedicated worker, with the Chrome DevTools Protocol and a process-tree sampler: `scratchpad\f006-wasm\runs\results.jsonl` (Hunspell, engines `hw` = `hunspell-wasm` and `ha` = `hunspell-asm`), `scratchpad\f006-wasm\runs\csp.jsonl` (the CSP probes), and the nspell baseline `scratchpad\f006-v8\runs\results.jsonl`. The sampler summed `PrivateMemorySize64` of the Edge process tree every 250 ms (`scratchpad\f006-wasm\scripts\driver.mjs:91`).
- Measurements of 2026-10-22 with Bun 1.4.3 in `scratchpad\f006-plan` (`scripts\measure.mjs`, `scripts\seg.mjs`, `scripts\words.mjs`): nspell 2.1.5 and seven dictionaries of the pinned commit, one language per process; the segmenter and the word rules.
- GitHub API and raw.githubusercontent.com, read on 2026-10-22: the head of wooorm/dictionaries, the recursive tree of `8cfea406b505e4d7df52d5a19bce525df98c54ab`, the `package.json` of `en`, `eu`, `et`, and `oc`, the `oc` licence files, the `eu` readme, and the response headers of `dictionaries/en/index.aff`.
- Bun documentation "Fetch" (https://bun.com/docs/runtime/networking/fetch), read on 2026-10-22. It describes the current Bun release, so F1 to F7 repeat each point on Bun 1.4.3.
- Tauri source `tauri-2.12.1/src/manager/mod.rs` in the Cargo registry. `src-tauri/Cargo.lock` resolves `tauri` 2.12.1.
- Git source: the Git 2.56 tree at `scratchpad\gitrepo` (commit a018953), read on 2026-10-22. Line numbers below are Git 2.56.
- Microsoft Learn: `ShellExecuteW` and its remarks on COM initialization.
- Repository code at main 2949620 (equal to this branch apart from the 006 documents), read through CodeGraph and by line: `src/contracts/{limits,operations,envelope}.ts`, `src/git-service/{git-settings,git-runner,session,operations,log,trust}.ts`, `src/frontend/{commit/CommitTray.tsx,components/action-menu.tsx,state/draft-store.ts,settings/SettingsView.tsx,settings/git/GitSettingsPage.tsx,settings/git/texts.ts,changes/PatchPool.tsx,app/Workbench.tsx,about/AboutDialog.tsx,build/notices.ts,index.css}`, `src-tauri/src/{service,profile,env_sanitize,process_requests,wsl,settings,ipc}.rs`, `src-tauri/{tauri.conf.json,Cargo.toml,Cargo.lock}`, `scripts/windows/measure-ram.ps1`, `tests/git/bun-runner.ts`, `tests/wsl/workbench-wsl.test.ts`, `tests/groups.json`, `tests/groups.ts`, `vite.config.ts`, `package.json`.
- 004 research R20 (spell check) and R21 (open facts, the WSL rows), and the 004 quickstart rows Q8 to Q23.
- Marks: "doc" is a documentation statement. "source" is a Git or library source statement. "code" is this repository. "registry" and "tree" are the 2026-10-22 reads. "measured" is a 2026-10-22 run. "experiment" needs a P0 test, listed in R12. "unverified" has no source and no test yet.

## R2 Spell engine

- Decision: Hunspell through `hunspell-wasm` 0.3.0, in module Web Workers: one check worker and one suggestion worker per loaded language (plan D9). The user chose it on 2026-10-22, after the measurements below. It replaces nspell.
- `hunspell-wasm` facts (registry): 0.3.0 is the last of 7 versions, all published on 2024-10-30 and 2024-10-31 by one author; no dependencies; `type: module`, `main: ./dist/Hunspell.js`, no `exports` map; `license` `(LGPL-2.0 OR GPL-2.0 OR MPL-1.1)`; repository github.com/rotemdan/hunspell-wasm; `gitHead` `8f755ef64e8b047b77b676f9698b3dfa5cb1887d`; integrity `sha512-D7/QLaeekJYYlE37D7KBq5v38vL4tQutTFIUBOUGBl0g9la8OUgfSd8+XbwNPV5uYMHS13umXR9MtdAxStpHJg==` (the downloaded tarball gives the same SHA-512); 34 files, 1,049,352 bytes unpacked. Upkeep: no release since 2024-10-31 (risk recorded; the code is a thin wrapper of Hunspell).
- Tarball facts: `COPYING` (GNU GPL version 2), `COPYING.LESSER` (GNU LGPL version 2.1), `COPYING.MPL` (Mozilla Public License 1.1); the TypeScript wrapper source in `src/` and its build in `dist/`; `docs/Building.md`; `wasm/hunspell.js` (67,406 bytes, the Emscripten loader) and `wasm/hunspell.wasm` (811,567 bytes, SHA-256 `72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0`). The tarball holds no Hunspell C++ source. `docs/Building.md` builds the module from a clone of the hunspell-wasm repository with Emscripten.
- Licence reading: the `package.json` value names LGPL-2.0, but the shipped `COPYING.LESSER` is LGPL 2.1, and upstream Hunspell names "MPL 1.1/GPL 2.0/LGPL 2.1". Arbareto uses Hunspell under LGPL-2.1, which code under AGPL-3.0-or-later may use (GNU licence list). The LGPL source obligation and the embedding of `hunspell.wasm` in the application bundle are legal readings that stay unverified (plan D18).
- API facts (`src/Hunspell.ts`): `createHunspellFromStrings(affixes, dictionary)` gets the module once per JavaScript realm (`getWasmModule`, a module-level singleton), writes both texts into the Emscripten in-memory file system under random names, calls `_Hunspell_create`, and unlinks the names. A zero handle throws "Failed to create hunspell instance". `testSpelling(word)` calls `_Hunspell_spell`. `getSpellingSuggestions(word)` calls `_Hunspell_suggest`. `dispose()` destroys the handle.
- Loader facts (`wasm/hunspell.js`): `new URL("hunspell.wasm", import.meta.url)` names the module, and `instantiateStreaming` loads it with `fetch`. The loader also reads `wasmBinary` and `instantiateWasm` from its options, but `getWasmModule` passes none. The memory maximum is 2,147,483,648 bytes. So each worker fetches the asset once, and each language worker holds its own WebAssembly memory.
- Measured in Edge 155 (V8 15.5.9.7), engine `hw`, two runs per language. Load is `createHunspellFromStrings`. The peak is the largest sample of the summed private bytes of the Edge process tree minus the baseline before the load. Checks are 1,000 words, about half of them correct. The suggestion is one list for one misspelled word:

| Language | Files (aff + dic) | Load | Peak increase | 1,000 checks | One suggestion list |
|---|---|---|---|---|---|
| en | 554,848 bytes | 63 to 85 ms | 27.5 to 32.4 MiB | 9.2 to 9.9 ms | 20 to 21 ms |
| fr | 1,429,003 bytes | 87 to 146 ms | 29.5 to 34.2 MiB | 16.8 to 18.6 ms | 80 to 85 ms |
| ru | 3,544,427 bytes | 125 to 138 ms | 30.9 MiB | 10.9 to 15.0 ms | 103 to 134 ms |
| he | 5,766,994 bytes | 236 to 245 ms | 49.2 to 64.0 MiB | 8.0 to 8.9 ms | 108 to 112 ms |
| tr | 9,358,006 bytes | 348 to 386 ms | 72.9 to 75.8 MiB | 8.3 to 8.6 ms | 258 to 299 ms |
| uk | 8,696,386 bytes | 348 to 376 ms | 81.3 to 82.5 MiB | 19.8 to 20.5 ms | 208 to 210 ms |

- The nspell baseline in the same browser (`scratchpad\f006-v8`): en 110 ms and 16.8 MiB; de 699 ms and 56.0 MiB; ru 1,989 to 2,111 ms and about 193 MiB; tr 1,224 to 1,273 ms and about 180 MiB; fr 2,849 to 3,147 ms and about 306 to 310 MiB; uk 6,176 to 6,211 ms and about 349 to 351 MiB; he failed with `RangeError: Too many properties to enumerate` after a peak of 685.6 MiB. The Bun 1.4.3 nspell runs of the first plan pass gave the same order (uk 5.5 s and +488.8 MiB RSS; he did not load within 180 s).
- Reading for the plan: every measured language passes 10 s and 256 MiB with Hunspell. A full round of 10,000 words for uk takes about 200 ms (20.5 ms per 1,000), so rounds check only the changed lines (plan D9). A suggestion list takes up to about 300 ms, so suggestions run in their own worker (plan D9). These are browser numbers, not packaged WebView2 numbers, so the packaged gate still decides (plan D3).
- Alternatives considered:
  - nspell 2.1.5 (registry: MIT, last release 2021-01-17, one dependency `is-buffer` 2.0.5, MIT; no push since 2021). It keeps every affixed form in memory (`lib/util/add.js`) and lacks the compound rules. It failed the gate values above for fr and uk and could not load he. Pure JavaScript, so it needs no CSP change. Rejected by the user on 2026-10-22.
  - `hunspell-asm` 4.0.2 (registry: published 2020-02-01; dependencies `emscripten-wasm-loader` `^3.0.3` (3.0.3, MIT, 2019-07-19) and `nanoid` `^2.1.5`; 4.9 MB unpacked). Its MIT `LICENSE` covers only the wrapper. Its readme names "Hunspell: original license", and the tarball holds no Hunspell licence text. The module sits inside the JavaScript, so it needs no asset fetch. Measured (engine `ha`): uk 467 to 508 ms and 83 MiB, tr up to 491 ms per suggestion list.
  - `spellchecker-wasm` 0.4.0 (registry: MIT; a Rust port of SymSpell 6.7.3; 0.4.0 published 2026-10-18 after 0.3.3 of 2020-05-13; 44 files, 19,059,941 bytes unpacked with its frequency dictionary). SymSpell uses word frequency lists, not Hunspell `.aff` and `.dic` files, so it cannot use the wooorm dictionaries.
  - The WebView2 built-in check: its suggestions show only in the native menu, and its result has no fixed oracle (004 R20). Rejected by the user (spec Clarifications).
  - Every WebAssembly option needs `'wasm-unsafe-eval'` in `script-src` (R6).

## R3 Dictionary source and catalog

- Decision: raw.githubusercontent.com at the pinned commit `8cfea406b505e4d7df52d5a19bce525df98c54ab` of wooorm/dictionaries (spec Clarifications). The catalog script records every entry (plan D3). It may read `api.github.com` and `raw.githubusercontent.com` (user decision, 2026-10-22).
- Tree facts (GitHub API, 2026-10-22): the commit is still the head of `main` (2024-09-09T11:38:24Z). The tree holds 92 `dictionaries/<id>/` folders. Each holds `index.aff`, `index.dic`, `index.js`, `package.json`, and `readme.md`. All but `eu` and `et` hold `license`. `oc` holds `license` (980 bytes) and `licence` (1,959 bytes).
- Size gate: el (19,444,263 bytes), el-polyton (16,691,753), ko (13,961,541), mn (17,909,512), and rw (38,239,631) exceed 12 MiB with their licence document. 87 dictionaries pass, 184.4 MiB together. Without `en`, the catalog holds at most 86 entries. The largest passing ones are fy (10,667,730), gl (9,831,463), tr (9,359,092), uk (8,731,528), he (5,767,455), pt (5,458,942), nb (5,367,389), and eu (5,035,696).
- IDs (tree): bg br ca ca-valencia cs cy da de de-AT de-CH el el-polyton en en-AU en-CA en-GB en-ZA eo es es-AR es-BO es-CL es-CO es-CR es-CU es-DO es-EC es-GT es-HN es-MX es-NI es-PA es-PE es-PH es-PR es-PY es-SV es-US es-UY es-VE et eu fa fo fr fur fy ga gd gl he hr hu hy hyw ia ie is it ka ko la lb lt ltg lv mk mn nb nds ne nl nn oc pl pt pt-PT ro ru rw sk sl sr sr-Latn sv sv-FI tk tlh tlh-Latn tr uk vi.
- `oc` licence files (raw, 2026-10-22): both hold the same GPL-2.0-or-later grant of the Occitan word list. `license` names the copyright years 2006-2017, and `licence` names 2006-2020. The user decided on 2026-10-22 that both are licence documents.
- Licence values (`package.json` `license`, 2026-10-22): `en` `(MIT AND BSD)`, `eu` `GPL-2.0`, `et` `LGPL-2.1`, `oc` `GPL-2.0`. `(MIT AND BSD)` is no valid SPDX expression, and `GPL-2.0` is a deprecated SPDX ID, so the rows show the values as given (spec FR-015). The `eu` readme states "Dictionary and affix file: GPL-2.0. Rest: MIT". The board sample "GPL-2.0 OR LGPL-2.1" for Basque is sample data.
- Licence examples (wooorm readme, spec Design notes): uk GPL-3.0, de GPL-2.0 OR GPL-3.0, fr MPL-2.0, es GPL-3.0 OR LGPL-3.0 OR MPL-1.1, pl GPL-3.0 OR LGPL-3.0 OR MPL-2.0, ru BSD-3-Clause, cs GPL-2.0 only, he AGPL-3.0.
- `en` equality: `dictionary-en` 4.0.0 holds `index.aff` 3,086 bytes, `index.dic` 551,762 bytes, and `license` 15,731 bytes, the sizes of the pinned `dictionaries/en` (tree, 004 R20). The contract test of plan D3 also compares the SHA-256 values.
- `dictionary-en` facts (registry): version 4.0.0, published 2023-11-03, the last release; `(MIT AND BSD)`; no dependencies; ESM only, `exports: "./index.js"`, and `index.js` reads its files with `node:fs/promises` (004 R20). So the renderer imports the two files with `?raw` through a Vite alias.
- Encoding: every dictionary declares `SET UTF-8` (spec, clarify scan). NFC: unverified. The early gate report records `aff === aff.normalize("NFC")` and the same for `dic` per language (F13). The catalog holds no NFC field. The language fixture applies NFC to each fixture word, as the product does. So a dictionary that is not in NFC fails its fixture when NFC changes one of its fixture words (data-model §16).
- Names: `Intl.DisplayNames("en", {type: "language"})` at script time, with a reviewed override table for IDs that it returns unchanged (plan D3). The JSON stores the names.
- Legal reading: a run-time download from upstream at the user's request means that the Arbareto release distributes no third-party dictionary except English. This reading is unverified (spec Assumptions).
- Alternatives considered: the LibreOffice dictionaries (several use non-UTF-8 `SET`); the npm tarballs (need tar and gzip parsing); jsDelivr (another host, the user chose GitHub raw).

## R4 Download in the service

- Decision: Bun `fetch` in the service with the options of plan D4, and no proxy (user decision, 2026-10-22). No new dependency. The shell gets no TLS code (constitution II).
- `Content-Encoding` fact (2026-10-22): `GET https://raw.githubusercontent.com/wooorm/dictionaries/8cfea406…/dictionaries/en/index.aff` with the default Bun request headers answered 200, `Content-Encoding: gzip`, `Content-Length: 1003`, and `Content-Type: text/plain; charset=utf-8`. The file holds 3,086 bytes. So the byte bound counts the decoded body, and `Content-Length` decides nothing.
- Bun docs facts (2026-10-22):
  - Without a `proxy` option, Bun reads `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` in upper or lower case for each request, and `NO_PROXY`. An explicit `proxy` value, `false` included, replaces the environment.
  - `redirect: "manual"` lets the caller see the redirect response.
  - A connection failure rejects with a `TypeError` whose `code` is the socket error (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`). A TLS validation failure with `rejectUnauthorized` true or unset fails the request.
  - `tls` takes `rejectUnauthorized` and `ca`. `decompress` defaults to true for gzip, deflate, brotli, and zstd. `AbortController` cancels a request.
- Environment facts (code): the shell removes `NODE_USE_SYSTEM_CA` from the service (`env_sanitize.rs:7-40`), so Bun uses its bundled roots. It keeps `NODE_EXTRA_CA_CERTS` and `NODE_TLS_REJECT_UNAUTHORIZED`. So plan D4 passes `proxy: false`, `tls.ca`, and `tls.rejectUnauthorized` explicitly (O-11, O-12).
- Status rules: only 200 succeeds (spec FR-016). 300 to 399 is a redirect, also to the same host. 404 and 429 have their own texts. Every other status names its number. The run's own flags decide Cancel and the deadline, not an error object or its message.
- Integrity: the catalog SHA-256 decides every kept byte, so a TLS failure can only refuse a download, never change a kept file.
- Alternatives considered: a WinHTTP download in the shell (it would use the Windows proxy and certificate store, which the user declined, and adds native code); `redirect: "error"` (Bun then rejects with an error, and only its text would tell a redirect from a transport failure); `HTTPS_PROXY` support (the first plan pass; the user dropped it on 2026-10-22).

## R5 Dictionary folder and install

- Decision: `<launch directory>/dictionaries/<id>/` with `entry.json`, a staging folder, one removal, and one rename (plan D5).
- The service starts in the launch directory (`service.rs:229-242` spawns it with `current_dir: &self.launch_directory`). The launch directory is `app_local_data_dir()` of the identifier `io.github.auric.arbareto`, or `<ARBARETO_PROFILE_ROOT>/data` (`service.rs:108-113`, `profile.rs:22-29`). So the folder follows `ARBARETO_PROFILE_ROOT` (spec Assumptions). The board sample path under `AppData/Roaming` is sample data.
- The service already opens, renames, and unlinks files (`index-lock.ts:8`) and makes temporary folders (`history-search.ts:320`). So a service write to the app-owned folder follows an existing pattern, and no private request is needed.
- Chunk cost: each `readDictionary` call hashes the requested file whole. An 8.5 MB `index.dic` needs 9 calls of 1 MiB. Bun hashes SHA-256 natively (`Bun.CryptoHasher`). The P4 test records the time of a full 12 MiB load (unverified until it runs).
- Frame facts (code): the pipe frame holds 16 MiB (`limits.ts:13`). 12 MiB of base64 takes 16 MiB, so one response cannot hold a whole file. The 1 MiB chunk takes 1,398,104 base64 bytes.
- Alternatives considered: a retained load with a `loadId` (keeps up to 36 MiB in the service and needs lifetime rules); the Tauri asset protocol (gives the renderer file access, which spec FR-027 forbids); rename of each file into place (a crash can leave a language with mixed files); a rename of the old folder before the swap (the plan review removed it as unneeded: the reconcile cleans a crash leftover either way).

## R6 Words, marks, and the worker CSP

- Decision: `Intl.Segmenter("und", {granularity: "word"})` with `isWordLike`, plus the FR-003 token rules of data-model §11; an `aria-hidden` mirror behind the textarea (plan D8); rounds over changed lines (plan D9).
- Measured on 2026-10-22, Bun 1.4.3: a 65,540-byte text of 9,364 word-like segments segmented in 2.6 ms, and in 2.5 ms with NFC. The segments of "don't follow-up v1.2.3 user@host snake_case ‘quoted’ привіт" are `don't`, `follow`, `up`, `v1.2.3`, `user`, `host`, `snake_case`, `quoted`, `привіт`. So the FR-003 whitespace token rule, not the segmenter, removes `v1.2.3`, `user@host`, and `snake_case`.
- The vector table of data-model §11 gave exactly the listed words with these rules in Bun 1.4.3 on 2026-10-22 (`scripts\words.mjs`). Extra checks of that run: "it's a ‘quoted’ word, (paren) end" gives `it's`, `a`, `quoted`, `word`, `paren`, `end`; the Main board message gives `Add`, `a`, `kubectl`, `check`, `to`, `the`, `deploy`, `script`, `See`, `in`, `and`, `the`, `notes`, `at`.
- Line locality: UAX #29 breaks before and after a line feed (WB3a, WB3b), and the token rules split at White_Space, which holds U+000A. So the words of one line never depend on another line, and a round of the changed lines gives the same words as a round of the whole text.
- Locale: the fixed locale `"und"` keeps the system locale of WebView2 out. ICU adds dictionary breaks for Thai, Lao, Khmer, Myanmar, and CJK text beyond UAX #29 (unverified per ICU version). The contract vectors stay in scripts whose breaks UAX #29 fixes (Latin, Cyrillic, Hebrew).
- NFC and upper case: `String.prototype.normalize("NFC")` and `String.prototype.toUpperCase()` are the Unicode algorithms of the engine. Bun and WebView2 can ship different Unicode versions, which changes results only for code points that one version lacks (unverified).
- Mirror: the existing textarea (`CommitTray.tsx:300-321`) has `spellCheck={false}`, the code font, `px-2 py-1`, a border, and the column guide as its background (`MessageGuide.tsx:27-34`). The mirror takes the same box without the border (plan D8). Its marks are spans without bidi isolation, so the bidi layout stays the textarea layout.
- Undo: `document.execCommand("insertText")` keeps the browser undo stack in Chromium editable fields (unverified in WebView2 until N2). `setRangeText` and a `value` write clear it.
- Menu points: the `contextmenu` point inside a mark span client rect is a layout fact. The caret offset of `selectionStart` decides the keyboard case. So no caret behavior of a right-click decides anything.
- CSP probes in Edge 155 (`csp.jsonl`), with the app CSP of `tauri.conf.json`:
  - The CSP on the page only: `WebAssembly.compile` in the page throws "violates the following Content Security policy directive because 'unsafe-eval' is not an allowed source of script … "script-src 'self'"". A worker without a CSP compiles the module and fetches its asset with status 200.
  - The CSP on the page and on the worker script: the worker compile throws the same error, and the asset fetch fails with "TypeError: Failed to fetch", because `connect-src` holds only `ipc: http://ipc.localhost`.
  - The CSP with `'wasm-unsafe-eval'` on both: the compile works in the page and in the worker. The asset fetch still fails under that `connect-src`. `hunspell-asm`, whose module sits inside its JavaScript, initializes; `hunspell-wasm` does not.
  - So `script-src` needs `'wasm-unsafe-eval'`, and `connect-src` needs the app origin `'self'` once a worker has the CSP.
- Tauri fact: Tauri 2.12.1 sets the CSP header only when the asset path ends with `.html` (`tauri-2.12.1/src/manager/mod.rs:422-439`). A dedicated worker takes the CSP of its own script response, so the app workers run without a CSP today. The plan does not rely on that and puts both sources into the CSP (plan D9, contract Δ7).
- The renderer already runs the Pierre diff pool as module workers from `?worker&url` (`PatchPool.tsx:4,10`). The spell workers use the same form. N1 confirms the workers, the CSP, and the asset fetch in the package.
- Asset build: the loader names its module with `new URL("hunspell.wasm", import.meta.url)` inside `node_modules`. Whether the Vite 8 build emits the file as an asset with a hashed name beside the worker chunk is unverified until F14.

## R7 Personal word list storage

- Decision: the IndexedDB database `arbareto-spelling` with one record `{word}` per word (plan D10). The user chose the profile storage (spec Clarifications).
- `arbareto-drafts` opens version 1 with one store (`draft-store.ts:24-38`). A new store there needs a version change and an upgrade path. A second database needs neither.
- With `ARBARETO_PROFILE_ROOT`, WebView2 keeps the data in `<root>/webview2` (`profile.rs:22-29`).
- The `add` call refuses an existing key with `ConstraintError` (IndexedDB), so Add never overwrites a record.

## R8 Language selection setting

- Decision: the shell setting `spelling` in `settings.json`, answered by `readSyncSettings` and `setSpelling` (plan D11), because spec FR-009 asks that Arbareto keep it "as it keeps the Pull default".
- The Pull default and the switch choice are shell settings (`settings.rs:45-59`, `:116-121`). `setSwitchChoice` is shell-only and answers the `readSyncSettings` result (004 contract Δ3, Δ14). `SettingsView.tsx:125-170` renders those app pages.
- The shell parses contract JSON at build time with `include_str!` (`git_env.rs:24`, `wsl.rs:85`), so it can check language IDs against the catalog.
- Alternative considered: the renderer `localStorage` beside `arbareto.preferences.v1` (`preferences.ts:23`). It needs no Rust change, but a cleared WebView2 profile resets it, and the spec names the Pull default form (plan O-10).

## R9 WSL Global save

- Decision: run the two fixed `config` arrays in the distro with `-C /` (plan D13).
- Git source facts (Git 2.56):
  - `repo_create_tempfile_mode` calls `adjust_shared_perm` on each new temporary file (tempfile.c:135-152). A configuration write holds `<file>.lock` through it (config.c:3067).
  - `adjust_shared_perm` returns at once when `repo_settings_get_shared_repository` is 0, which is `PERM_UMASK` (path.c:762-768).
  - `repo_settings_get_shared_repository` reads `core.sharedrepository` with `repo_config_get_value` (repo-settings.c:196-208). Outside a repository, that configuration holds only the global and system files.
  - `calc_shared_perm` with an octal value such as 0660 gives exactly that mode (path.c:739-759).
  - So a write in a repository with `core.sharedRepository=0660` creates the global file with mode 0660, and a write from `/` creates it with `0666 & ~umask`. A global `core.sharedRepository` still applies outside a repository, as in a terminal. The Git 2.55 source is not read. The SC-005 case checks it on Git 2.55 by experiment.
- Shell facts (code): `Kind::GlobalConfig` refuses every WSL Git today (`process_requests.rs:1902-1916`). `Kind::Clone` builds the WSL target with `wsl::wsl_program()`, no identity, and `/` (`process_requests.rs:1874-1884`). `wsl.rs:509-519` refuses a directory that does not start with `/` and adds `-C <directory>` after `--no-lazy-fetch`. `global_config_fits` admits only the listing and the two writes (`process_requests.rs:3720-3739`, `git-runner.ts:313-318`).
- Service facts (code): the precheck refuses a WSL Global save (`git-settings.ts:214-216`). `saveFiles` sets `files.global` null for WSL (`git-settings.ts:155-158`). The run writes Global keys in the `globalConfig` context (`git-settings.ts:243-245`).
- Renderer facts (code): `KeyRow` locks a scope whose file is null (`GitSettingsPage.tsx:358-366`). `scopeFile` shows `TEXTS.noGlobalFile` (`GitSettingsPage.tsx:215-220`, `texts.ts:64`).
- File naming: in the product, `git var GIT_CONFIG_GLOBAL` prints two lines, and the choice needs an `access(R_OK)` check inside the distro. The double forwards `GIT_CONFIG_GLOBAL`, so it prints one line. No naming rule can be tested through the double (user decision of 2026-10-21). So the view names no file on WSL.
- `HOME`: `wsl.exe` sets `HOME` from the distro user and ignores a `HOME` in `WSLENV` (`bun-runner.ts:116-118`, 004 R21). F10 checks it under the wrapper.
- `GIT_CONFIG_GLOBAL` on WSL: the shell keeps `WSLENV` empty (`wsl.rs:123-133`), so only the distro can set it. Whether a distro sets it for `wsl.exe` processes is unverified.
- XDG global file: through the double, `GIT_CONFIG_GLOBAL` wins over the XDG file (git-config(1) `--global`). So the 004 Q21 XDG case cannot run on WSL and stays unverified.

## R10 WSL parity rows

- The rows come from 004 R21 "Not covered yet on WSL": Q8, Q9, Q10, Q11, Q13, Q15, Q16, Q20, Q22, Q23, plus the Q21 Global saves and Add worktree through the service.
- Double facts (code): `resolveTarget` refuses a WSL `globalConfig` and a WSL `worktreeAdd` (`bun-runner.ts:601-616`). `destinationFacts` refuses a WSL `worktreeAdd` binding (`bun-runner.ts:1349-1358`). The shell has the WSL `worktreeAdd` target and the `wslFiles` mode `destination` (`process_requests.rs:1920-1935`, `wsl.rs:1480-1505`).
- `tests/wsl/workbench-wsl.test.ts` is in `tests/groups.json` `serial` already. Its last full run took 1,302 s (004 R21).
- Risk: `wslParts` of the UNC root for `/` (`bun-runner.ts:164-168`) maps `\\wsl.localhost\<distro>` to `/`. A UNC form with a trailing separator must give the same path (unverified until WP4 tests it).
- Q11 needs a bare remote in the owned distro folder. Q23 needs an SSH server that the distro reaches (003 T008 rule). Both are unverified until they run.

## R11 Licence link

- Decision: the shell-only operation `openLicenceLink {language}`, with the URL from the embedded catalog and `ShellExecuteW` on a dedicated COM thread (plan D12).
- The renderer has no link opener today. No `opener` plugin and no `href` exist in `src/frontend` (code). A plain link would navigate the WebView2 window away from the application.
- `ShellExecuteW` returns a value above 32 on success. Its remarks ask the caller to initialize COM before the call, because the call can delegate to Shell extensions that COM activates, and they name `COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE` (Microsoft Learn). The `windows` crate features `Win32_UI_Shell` and `Win32_System_Com` are already in `Cargo.toml`.
- Alternative considered: `tauri-plugin-opener`. It adds a crate, a JS API, and a capability scope by URL pattern. The scope cannot bind a URL to a catalog entry, and the renderer would send the URL.

## R12 Open facts (P0 list)

Each F fact runs on Windows with Bun 1.4.3, with local servers on 127.0.0.1 only, in `tests/git/dictionary-facts.test.ts`, except F9 to F11 (WSL tests), F12 and F13 (the early gate report), F14 (a throwaway Vite build in `tests/gate/wasm-asset.test.ts`, and again on the package `dist/`), and F16 (a source lookup). N1 and N2 run first on `bun run dev`, then in the package. Each records the observed versions.

- F1: `fetch(url, {redirect: "manual"})` against a local server that answers 301, 302, 303, 307, and 308 gives a response with that status and does not follow it.
- F2: with `proxy: false` and `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` set to a local counting proxy, the request goes to the local target directly, and the counter stays 0.
- F3: a local TLS server with a test CA that the test makes at run time with the openssl of the selected Git (no committed key; a capability skip without openssl). In a child process with `NODE_EXTRA_CA_CERTS` set to that CA, `tls: {ca: tls.rootCertificates}` makes the request fail, and a request without `tls` succeeds. With `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: true` still fails an unknown certificate.
- F4: a local server sends a gzip body. The stream yields decoded bytes, and a cancel after N + 1 bytes ends the read without reading the rest.
- F5: an abort during a body read rejects the pending read, and the run's own flag tells Cancel from the deadline.
- F6: a closed local port rejects with a `TypeError` that carries `code`. The service maps every such rejection to `transport` without reading its message.
- F7: `rm(path, {recursive: true})` on a folder that holds a junction and a symbolic link to an outside folder removes the links and keeps the outside files. `rename` of a folder to a new name in the same parent succeeds on NTFS.
- F8: `Intl.Segmenter("und", {granularity: "word"})` gives the data-model §11 vectors in Bun 1.4.3. N8 repeats them in WebView2.
- F9: on Ubuntu-26.04 Git 2.55, a Global save through the double with `-C /` in a repository with `core.sharedRepository=0660` creates the global file with `0666 & ~umask`, and the control mutation gives 0660 (SC-005).
- F10: `HOME` is set for a process that `wsl.exe` starts through the wrapper in mode `integrate`.
- F11: `git var GIT_CONFIG_GLOBAL` through the double prints the owned global file.
- F12: per cached catalog language, in one Bun process each: the Hunspell load time, the RSS increase, and the fixture result (the early report of gate step 2).
- F13: per cached catalog language: `index.aff` and `index.dic` equal their NFC form.
- F14: `bun run build` emits `hunspell.wasm` as an asset with the SHA-256 of R2, and the built spell worker names it through `new URL(…, import.meta.url)`.
- F15: `createHunspellFromStrings` runs under Bun 1.4.3 (the loader's Node path reads the module from the package folder). If it fails, the early report gives no fixture result, and the packaged gate alone decides step 2.
- F16: the tree of github.com/rotemdan/hunspell-wasm at `8f755ef64e8b047b77b676f9698b3dfa5cb1887d` (read through `api.github.com`): whether it holds the Hunspell C++ source or a submodule commit of github.com/hunspell/hunspell, the Hunspell version, and the build files that make `wasm/hunspell.wasm`. The result decides the D18 source link text.
- N1: in the package, the spell workers start under the CSP with `'wasm-unsafe-eval'` and `connect-src 'self'`, fetch `hunspell.wasm` from the app origin, and load English from the `?raw` chunk.
- N2: in the package, `execCommand("insertText")` in the React-controlled textarea replaces the word, fires one `input` event, and one Ctrl+Z through live input restores the word.
- N3: in the package, Shift+F10 and the Menu key with the caret in a marked word open the spelling menu. Elsewhere, the built-in menu with Cut, Copy, Paste, and Select all opens. A right-click on a mark opens the spelling menu (live input, the T082 harness).
- N4: in the package, at 100%, 150%, and 225% text scale, the UI Automation `TextPattern` bounding rectangle of each marked word equals the client rect of its mirror span within 1 device pixel, also for a Hebrew line.
- N5: in the package, a Japanese IME composition shows no mark, and after it ends, the marks equal the marks of the same text typed without the IME. Without an installed Japanese IME, a capability skip records it as unverified.
- N6: in a Windows Sandbox with `<Networking>Disable</Networking>`, US1 passes in the package, and Download shows the `transport` text and keeps no file. Without Windows Sandbox, a capability skip records it as unverified.
- N7: in the package, per cached catalog language, the packaged gate of plan D3: the load time, the WebView2 private bytes increase with both workers, and the fixture count, 3 runs each.
- N8: in the package, the data-model §11 vectors give the same segments in the WebView2 worker as in Bun.

Unverified points (they stay unverified until their test runs):
- The explicit `tls.ca` against `NODE_EXTRA_CA_CERTS` (F3).
- The `hunspell.wasm` asset in the Vite build (F14), and `hunspell-wasm` under Bun (F15).
- The packaged load time and memory of each language (N7), and so the final catalog size.
- One undo step through `insertText` in WebView2 (N2).
- The IME case without an installed Japanese IME (N5), and the offline run without Windows Sandbox (N6).
- The packaged WSL Global save. No test runs it, by design (spec FR-025).
- The XDG global file on WSL (R9), the Q11 force note, and the Q23 host line on WSL (R10).
- `GIT_CONFIG_GLOBAL` set by a distro for `wsl.exe` processes (R9).
- ICU dictionary word breaks for Thai, Lao, Khmer, Myanmar, and CJK text (R6).
- Whether the hunspell-wasm repository at `8f755ef` holds the Hunspell sources and the build files of `hunspell.wasm`, and which Hunspell version it builds (F16, plan D18).
- The legal readings of a run-time download (R3) and of the LGPL-2.1 use of `hunspell.wasm` inside the application bundle (R2).
- The NFC state of each catalog dictionary (F13).

## R13 Results

The results of F1 to F16 and N1 to N8 go here when WP1, WP4, WP5, and WP8 run them. The packaged gate records each run of each language here: the date, the build, the WebView2 runtime version, the baseline, the peak, the increase, the load time, and the fixture count.

Measurements before the tests (2026-10-22): the R2 tables (Edge 155, Hunspell and nspell; Bun 1.4.3, nspell), the R6 CSP probes, and the R6 segmentation time.

### WP1 (batch 0, 2026-10-24, Windows 11 10.0.26300, Bun 1.4.4, Vite 8.3.2)

The facts ran under Bun 1.4.4, not 1.4.3: main moved to Bun 1.4.4 (T390) before WP1.

Package review (T003, constitution VIII):
- `hunspell-wasm` 0.3.0: `package.json` licence `(LGPL-2.0 OR GPL-2.0 OR MPL-1.1)`. The installed package holds `COPYING`, `COPYING.LESSER`, and `COPYING.MPL`. No dependencies. The `bun.lock` integrity is `sha512-D7/QLaeekJYYlE37D7KBq5v38vL4tQutTFIUBOUGBl0g9la8OUgfSd8+XbwNPV5uYMHS13umXR9MtdAxStpHJg==`, the reviewed value. `wasm/hunspell.wasm` has the SHA-256 `72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0`. Upkeep: no release since 2024-10-31 (R2).
- `dictionary-en` 4.0.0: licence `(MIT AND BSD)`. No dependencies. The `bun.lock` integrity is `sha512-3NHnE1uq33ZE/CIwaZ6gqxa4BnglHnxeAcTM0GJ7cmtRGcvX9InMK/IqLtYcUMFCUpUNgybH+DzkqdgAo3F1zg==`. `index.aff`, `index.dic`, and `license` (3,086, 551,762, and 15,731 bytes) equal the pinned `dictionaries/en` files in size and SHA-256 (catalog script check). Upkeep: no release since 2023-11-03 (R3).
- `bun run build:notices` puts the three `hunspell-wasm` texts, the D18 note, and the full `dictionary-en` `license` text into the inventory.

Licence facts of the batch 0 review (2026-10-24). These are facts only. The legal reading stays open for the user.
- LGPL 2.1 §4 covers the object code of the Library itself. It asks that the source comes with the object code, or that the source is offered "from the same place".
- The `hunspell-wasm` note names the source used: `rotemdan/hunspell-wasm` commit `8f755ef` (`lib/hunspell/`, `Makefile`). The 30 files of `lib/hunspell/` equal `src/hunspell/` of `hunspell/hunspell` commit `edb619100791110d3e34f09ec35392ad327c1135` (F16).
- The emsdk version is not recorded (`docs/Building.md` names emsdk `latest`). So a byte-equal rebuild of `hunspell.wasm` stays unverified.
- Open: `hunspell.wasm` and `hunspell.js` hold Emscripten runtime parts, and the inventory has no notice for them yet. The Emscripten repository (main branch, read through DeepWiki on 2026-10-24, not pinned to a version) names these licences: Emscripten itself MIT or University of Illinois/NCSA (`LICENSE`); musl MIT (`system/lib/libc/musl/COPYRIGHT`); libc++, libc++abi, and compiler-rt the LLVM licence (`LICENSE.TXT` in each folder). The emsdk version is unknown, so the linked parts and their licence texts at that version are not verified.

Catalog (T007): `bun scripts/dictionary-catalog.ts` wrote 86 entries from the pinned commit, before the gate step 2 report. Gate step 1 left out el-polyton (16,691,753 bytes), el (19,444,263), ko (13,961,541), mn (17,909,512), and rw (38,239,631). `--offline` wrote the same bytes (SHA-256 `bcb12e49247f7f15e5e5230c7f3eed36f2a3bc5133251cae2b99ee83d7400cb6`). The script checks each download against the Git blob ID of the tree. `Intl.DisplayNames` in Bun 1.4.4 returns the ID itself only for `hyw`. The override table names it "Western Armenian", the ISO 639-3 reference name.

Facts (mark, then the observation line):
- F1 holds. `OBSERVATION T004: F1 statuses=301,302,303,307,308 targetHits=0 bun=1.4.4`
- F2 holds. The control request without `proxy` went through the proxy, so the child read the variables for 127.0.0.1. `OBSERVATION T004: F2 direct="target" control="proxy" proxyConnections=1 bun=1.4.4`
- F3 holds. So O-12 stays: `tls.ca` is `tls.rootCertificates`, and the shell does not remove `NODE_EXTRA_CA_CERTS`. `OBSERVATION T004: F3 extraCa.roots={"ok":false,"name":"TypeError","code":"UNABLE_TO_VERIFY_LEAF_SIGNATURE"} extraCa.plain={"ok":true,"status":200} rejectUnauthorized0.strict={"ok":false,"name":"TypeError","code":"UNABLE_TO_VERIFY_LEAF_SIGNATURE"} bun=1.4.4`
- F4 holds. `OBSERVATION T004: F4 received=262144 N=65536 prefixEqual=true gzipBytes=55770 sentAtCancel=16384 bun=1.4.4`
- F5 holds. Both aborts reject the pending read with `AbortError`, so only the run flag tells Cancel from the deadline. `OBSERVATION T004: F5 cancel={"outcome":"rejected AbortError","flag":"cancel"} deadline={"outcome":"rejected AbortError","flag":"deadline"} bun=1.4.4`
- F6 holds. `OBSERVATION T004: F6 typeError=true name=TypeError code=ECONNREFUSED bun=1.4.4`
- F7 holds. `OBSERVATION T004: F7 symlink=created folderGone=true outsideKept=true rename=true bun=1.4.4`
- F15 holds under Bun 1.4.4. `OBSERVATION T004: F15 receive=true recieve=false bun=1.4.4`
- F14 holds. The worker build emits one `.wasm` asset with the reviewed SHA-256. The name sits in the loader chunk that the worker chunk imports, as `new URL("/assets/hunspell-<hash>.wasm", "" + import.meta.url)`. Vite replaces the Node imports `fs/promises` and `module` of the package with its browser stub. The first run found that the app bundle check (`src/frontend/highlight/guard.ts`) refused every `.wasm` file. `OBSERVATION T005: F14 exit=0 wasm=["assets/hunspell-B7u9vk2r.wasm"] sha256=["72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0"] newUrl=["assets/hunspell-B2QpINDD.js"] appGuard=["WebAssembly file: assets/hunspell-B7u9vk2r.wasm"] vite=8.3.2 bun=1.4.4`
- F16 holds. The tree of github.com/rotemdan/hunspell-wasm at `8f755ef64e8b047b77b676f9698b3dfa5cb1887d` (api.github.com, not truncated, 57 items) holds the Hunspell C++ source as plain files in `lib/hunspell/` (30 files), not as a submodule. Each of the 30 Git blob IDs equals the blob of `src/hunspell/` at github.com/hunspell/hunspell commit `edb619100791110d3e34f09ec35392ad327c1135` (2023-11-03). That commit comes after v1.7.2: v1.7.2 differs in 13 of the 30 files. `lib/hunspell/Makefile.am` names `libhunspell-1.7`. The build files are `Makefile` (`emcc -O3` over the 10 `.cxx` files, `MODULARIZE`, `EXPORT_ES6`) and `docs/Building.md` (emsdk `latest`). The Emscripten version is not recorded, so a byte-equal rebuild stays unverified. The Git blob IDs of `wasm/hunspell.wasm` (`5bf6977e915bfa17073e53ed99aace4a5b9c01c5`) and `wasm/hunspell.js` (`cd0a65985aa2f952e5e460a8ea121dd6b9183981`) at that commit equal the installed files. So the D18 note text stays.

Early gate report (T008, F12 and F13), with the data-model §16 rule of 2026-10-24 (Hunspell `edb6191` line, flag, `AF`, and homonym rules; refusing flags; no phrase lines; negative words in the script of the language): `bun test tests/gate/dictionary-gate.test.ts` with the cache ran one Bun child per cached catalog language. A Bun time decides nothing (spec SC-002). Marks:
- F12 fails for `tlh` only: `OBSERVATION T008: tlh fixture refused: no-positive-words positives=0 bun=1.4.4`. Each of the 4,592 `tlh` stems holds only Private Use code points (General_Category `Co`, the pIqaD script), so no stem is one §11 word, and the fixture has no positive evidence. `scripts/dictionary-gate.json` holds this failure, and the catalog now has 85 entries (offline rebuild, SHA-256 `1c634c0bf7ce9d0974c4ce2a8210e95676e3a966075db301d83ebe8b9898f6b0`).
- F12 holds for the other 86 languages (85 entries and `en`): each loaded within 60 s (largest load 1,391 ms, `eu`; largest RSS increase 86.6 MiB, `fy`), and the fixture gave 0 failures. `hu`, `ia`, and `tk`, which failed under the first rule, pass now.
- Script values: Latin 75, Cyrillic 5, Armenian 2, Arabic 1, Devanagari 1, Georgian 1, and Hebrew 1. `fr`, `sv`, and `sv-FI` also list Greek letter names (`α/r`, `Δt/L'D'Q'`), so the rule takes the Script value with the most letters.
- `uk` behavior (a product question, not a gate failure): with the `uk` files, Hunspell accepts each of the 5 fixed Latin negative words (`latinAccepted=5/5`), and also `hello`, `x`, and `Qzx`. It refuses the Cyrillic negative words. So when en and uk are both selected, the merge rule of plan D9 accepts every English typo. Every other language gives `latinAccepted=0/5`.
- F13: `index.aff` and `index.dic` are in NFC for 81 of the 86 languages. Not in NFC: `fr` (both), `ia` (both), `gl` (`index.dic`), `oc` (`index.dic`), and `fa` (`index.aff`).
- Fixture size: 76 languages have 200 positive words, 9 have 199, and `hu` has 197 (data-model §16: a step without an eligible stem at or after its line gives no word).
- F3 after the change to run-time certificates (no committed key; openssl `C:\Program Files\Git\usr\bin\openssl.exe` from the selected Git) holds again with the same observation. F14 with the changed bundle check gives `appGuard=[]`: `OBSERVATION T005: F14 exit=0 wasm=["assets/hunspell-B7u9vk2r.wasm"] sha256=["72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0"] newUrl=["assets/hunspell-B2QpINDD.js"] appGuard=[] vite=8.3.2 bun=1.4.4`
- The bundle check (`src/frontend/highlight/guard.ts`) tests each emitted asset with bytes for the WebAssembly magic `00 61 73 6D` at offset 0. The file name does not count. An asset with the magic passes only when its bytes have the SHA-256 of the reviewed `hunspell.wasm`.

```
OBSERVATION T008: en load=133 rss=22.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: hy load=193 rss=30.7 nfc=true/true fixture=0/0 positives=200 script=Armenian latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: en-AU load=128 rss=22.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: de-AT load=237 rss=51.4 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: eu load=1391 rss=36.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: br load=226 rss=37.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: en-GB load=132 rss=22.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: bg load=237 rss=52.4 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: en-CA load=135 rss=24.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ca load=363 rss=63.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ca-valencia load=368 rss=66.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: hr load=289 rss=56.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: cs load=395 rss=70.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: da load=400 rss=67.2 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: nl load=196 rss=33.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: en-ZA load=281 rss=54.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: eo load=129 rss=21.1 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: et load=407 rss=79.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: pt-PT load=336 rss=61.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fo load=348 rss=69.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fr load=319 rss=56.5 nfc=false/false fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fur load=204 rss=48.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: gl load=540 rss=74.1 nfc=true/false fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ka load=351 rss=65.3 nfc=true/true fixture=0/0 positives=200 script=Georgian latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: de load=225 rss=55.6 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: he load=445 rss=71.9 nfc=true/true fixture=0/0 positives=200 script=Hebrew latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: hu load=425 rss=70.7 nfc=true/true fixture=0/0 positives=197 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: is load=408 rss=68.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ia load=224 rss=49.6 nfc=false/false fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ie load=93 rss=19.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ga load=173 rss=26.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: it load=312 rss=55.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: tlh-Latn load=80 rss=16.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ltg load=262 rss=54.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: la load=357 rss=63.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: lv load=329 rss=60.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: lt load=316 rss=55.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: nds load=84 rss=17.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: lb load=358 rss=60.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: mk load=327 rss=62.3 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-MX load=296 rss=58.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ne load=290 rss=54.1 nfc=true/true fixture=0/0 positives=199 script=Devanagari latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: nb load=361 rss=67.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: nn load=296 rss=62.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: oc load=254 rss=55.7 nfc=true/false fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fa load=165 rss=31.5 nfc=false/true fixture=0/0 positives=200 script=Arabic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: pl load=421 rss=72.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: pt load=529 rss=73.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ro load=348 rss=63.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ru load=353 rss=63.6 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: gd load=183 rss=31.7 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sr load=200 rss=36.4 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sr-Latn load=178 rss=33.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sk load=372 rss=70.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sl load=204 rss=37.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es load=299 rss=57.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-AR load=296 rss=56.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-BO load=300 rss=57.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-CL load=314 rss=54.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-CO load=308 rss=53.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-CR load=309 rss=57.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-CU load=304 rss=55.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-DO load=304 rss=53.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-EC load=298 rss=58.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-SV load=298 rss=57.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-GT load=301 rss=57.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-HN load=310 rss=57.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-NI load=301 rss=58.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PA load=311 rss=56.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PY load=309 rss=57.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PE load=301 rss=57.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PH load=310 rss=57.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PR load=300 rss=55.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-US load=303 rss=55.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-UY load=300 rss=53.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-VE load=292 rss=58.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sv load=269 rss=59.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sv-FI load=266 rss=59.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: de-CH load=222 rss=54.9 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: tr load=514 rss=73.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: tk load=304 rss=55.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: uk load=548 rss=84.7 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=5/5 bun=1.4.4
OBSERVATION T008: vi load=59 rss=16.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: cy load=136 rss=23.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: hyw load=298 rss=57.9 nfc=true/true fixture=0/0 positives=200 script=Armenian latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fy load=678 rss=86.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: tlh fixture refused: no-positive-words positives=0 bun=1.4.4
```

### Batch 0 verification (T014), 2026-10-24

Run in `C:\Projects\arbareto-l3` on `006-wsl-parity-spellcheck` at 1fdeff6, Windows 11 10.0.26300, Bun 1.4.4, Vite 8.3.5, Git 2.56.0.windows.2.
- `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, and `cargo check --locked --manifest-path src-tauri/Cargo.toml`: exit 0.
- `bun run test:contracts`: exit 0, 5,046 pass, 37 skip, 0 fail, 5,083 tests in 104 files.
- `bun test tests/gate` with the cache: exit 0, 90 pass, 0 fail, 90 tests in 2 files.
- `bun run test:all`: exit 0, 122 min. Parallel group: 6,849 pass, 44 skip, 0 fail, 6,893 tests in 198 files. Serial group: 621 pass, 10 skip, 0 fail, 631 tests in 31 files.
- Every `ORIGIN` line is under `C:\Projects\arbareto-l3`: 302 in the contract run, 4 in the gate run, 1,908 in the full run. The 8 `GLOBAL_ORIGIN` lines of the full run name the owned fixture global file. All 88 `GIT_CORE` lines name one Git.
- Skips: the skip list holds no new skip.
- Kernel pool from 04:44 to 07:25: paged 2,463 to 4,648 MiB, nonpaged 1,419 to 1,851 MiB. During `test:all`, the lowest free memory was 12,720 MB, and the Bun processes of the run peaked at 4,944 MB private.
- The cargo test `ipc::tests::each_contract_operation_has_its_handler_and_its_grant` did not run. T014 runs `cargo check` only, and the test stays red until T015.
- Control mutations, each red, then undone with the original SHA-256 and green: (1) `:` dropped from the skip set of `spell-words.ts`: the `std::vector` vector of `tests/contracts/spell-words.test.ts` failed (46 pass, 1 fail), then 47 of 47 passed. (2) The URL check of `dictionaries.ts` accepted any commit: the URL case of `tests/contracts/dictionary-catalog.test.ts` failed (14 pass, 1 fail), then 15 of 15 passed.

Facts of the run (mark, then the observation line). Every fact holds again. The facts need no change to contracts/operations.md or plan.md.
- F1 holds. `OBSERVATION T004: F1 statuses=301,302,303,307,308 targetHits=0 bun=1.4.4`
- F2 holds. `OBSERVATION T004: F2 direct="target" control="proxy" proxyConnections=1 bun=1.4.4`
- F3 holds. `OBSERVATION T004: F3 extraCa.roots={"ok":false,"name":"TypeError","code":"UNABLE_TO_VERIFY_LEAF_SIGNATURE"} extraCa.plain={"ok":true,"status":200} rejectUnauthorized0.strict={"ok":false,"name":"TypeError","code":"UNABLE_TO_VERIFY_LEAF_SIGNATURE"} bun=1.4.4`
- F4 holds. `OBSERVATION T004: F4 received=262144 N=65536 prefixEqual=true gzipBytes=55770 sentAtCancel=16384 bun=1.4.4`
- F5 holds. `OBSERVATION T004: F5 cancel={"outcome":"rejected AbortError","flag":"cancel"} deadline={"outcome":"rejected AbortError","flag":"deadline"} bun=1.4.4`
- F6 holds. `OBSERVATION T004: F6 typeError=true name=TypeError code=ECONNREFUSED bun=1.4.4`
- F7 holds. `OBSERVATION T004: F7 symlink=created folderGone=true outsideKept=true rename=true bun=1.4.4`
- F15 holds. `OBSERVATION T004: F15 receive=true recieve=false bun=1.4.4`
- F14 holds. Vite 8.3.5 gives the same `.wasm` asset name and SHA-256, and a new loader chunk name. `OBSERVATION T005: F14 exit=0 wasm=["assets/hunspell-B7u9vk2r.wasm"] sha256=["72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0"] newUrl=["assets/hunspell-BwNx6ahT.js"] appGuard=[] vite=8.3.5 bun=1.4.4`
- F12 holds for each of the 86 languages (85 entries and `en`): each loaded within 60 s (largest load 1,414 ms, `eu`; largest RSS increase 84.6 MiB, `uk`), and the fixture gave 0 failures. `tlh` is out of the catalog (`scripts/dictionary-gate.json`), so no line names it.
- F13 gives the WP1 result again: not in NFC are `fr` (both), `ia` (both), `gl` (`index.dic`), `oc` (`index.dic`), and `fa` (`index.aff`).
- Script values, fixture sizes, and the `uk` behavior equal the WP1 report: Latin 75, Cyrillic 5, Armenian 2, Arabic 1, Devanagari 1, Georgian 1, and Hebrew 1; 76 languages with 200 positive words, 9 with 199, and `hu` with 197; only `uk` gives `latinAccepted=5/5`.

```
OBSERVATION T008: en load=219 rss=19.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: hy load=200 rss=30.9 nfc=true/true fixture=0/0 positives=200 script=Armenian latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: en-AU load=134 rss=22.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: de-AT load=262 rss=55.0 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: eu load=1414 rss=36.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: br load=234 rss=37.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: en-GB load=134 rss=23.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: bg load=231 rss=52.7 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: en-CA load=131 rss=24.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ca load=365 rss=66.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ca-valencia load=412 rss=63.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: hr load=294 rss=58.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: cs load=412 rss=76.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: da load=385 rss=68.0 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: nl load=200 rss=33.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: en-ZA load=298 rss=53.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: eo load=124 rss=22.5 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: et load=418 rss=79.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: pt-PT load=315 rss=63.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fo load=346 rss=56.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fr load=322 rss=53.9 nfc=false/false fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fur load=204 rss=48.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: gl load=549 rss=75.5 nfc=true/false fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ka load=347 rss=64.4 nfc=true/true fixture=0/0 positives=200 script=Georgian latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: de load=236 rss=53.5 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: he load=444 rss=76.8 nfc=true/true fixture=0/0 positives=200 script=Hebrew latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: hu load=423 rss=65.5 nfc=true/true fixture=0/0 positives=197 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: is load=403 rss=62.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ia load=235 rss=49.5 nfc=false/false fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ie load=93 rss=18.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ga load=180 rss=27.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: it load=319 rss=58.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: tlh-Latn load=78 rss=16.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ltg load=259 rss=46.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: la load=384 rss=67.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: lv load=330 rss=60.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: lt load=307 rss=54.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: nds load=86 rss=17.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: lb load=354 rss=72.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: mk load=330 rss=61.6 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-MX load=306 rss=56.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ne load=306 rss=56.8 nfc=true/true fixture=0/0 positives=199 script=Devanagari latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: nb load=362 rss=73.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: nn load=300 rss=62.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: oc load=258 rss=55.7 nfc=true/false fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fa load=164 rss=30.2 nfc=false/true fixture=0/0 positives=200 script=Arabic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: pl load=431 rss=73.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: pt load=535 rss=79.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ro load=344 rss=62.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: ru load=348 rss=66.2 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: gd load=179 rss=30.1 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sr load=194 rss=36.3 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sr-Latn load=175 rss=30.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sk load=391 rss=68.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sl load=210 rss=36.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es load=309 rss=55.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-AR load=299 rss=56.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-BO load=301 rss=58.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-CL load=301 rss=56.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-CO load=305 rss=55.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-CR load=305 rss=53.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-CU load=302 rss=57.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-DO load=294 rss=56.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-EC load=301 rss=53.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-SV load=322 rss=51.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-GT load=316 rss=53.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-HN load=309 rss=56.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-NI load=308 rss=57.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PA load=307 rss=53.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PY load=308 rss=57.3 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PE load=301 rss=57.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PH load=306 rss=61.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-PR load=302 rss=57.7 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-US load=307 rss=54.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-UY load=307 rss=52.6 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: es-VE load=300 rss=58.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sv load=261 rss=59.9 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: sv-FI load=267 rss=60.8 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: de-CH load=237 rss=52.0 nfc=true/true fixture=0/0 positives=199 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: tr load=532 rss=80.1 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: tk load=333 rss=56.4 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: uk load=569 rss=84.6 nfc=true/true fixture=0/0 positives=200 script=Cyrillic latinAccepted=5/5 bun=1.4.4
OBSERVATION T008: vi load=60 rss=16.0 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: cy load=141 rss=25.5 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: hyw load=302 rss=58.6 nfc=true/true fixture=0/0 positives=200 script=Armenian latinAccepted=0/5 bun=1.4.4
OBSERVATION T008: fy load=667 rss=73.2 nfc=true/true fixture=0/0 positives=200 script=Latin latinAccepted=0/5 bun=1.4.4
```

### Batch 0 review, 2026-10-24

Independent batch 0 review, reviewer agent, read-only, on e85aa5b (`git diff e36f56a e85aa5b`). Skills: `ponytail-review`, and a manual correctness, security, licence, heuristics, and constitution review. `web-design-guidelines` did not run, because the diff has no markup. Verdict: no data-loss or security bug, and no heuristic. Resolution: a2b0838 fixes items 1, 2, and 4 to 8.
- Medium: the `.wasm` bundle check decided by file name (`endsWith(".wasm")`). Fix: each asset with bytes is tested for the WebAssembly magic `00 61 73 6D`, and an asset with the magic must have the SHA-256 of the reviewed `hunspell.wasm`.
- Medium: the `listDictionaries` `removed` list had no bound (constitution III). Fix: at most `DICTIONARY_CATALOG_ENTRIES` (92) notices and a required `more` count, with vectors at and above the bound.
- Medium: the cargo ipc grant test stays red until T015. Fix: T014 names the exception.
- Low-medium: `PENDING_COMMANDS` was a silent skip list. Fix: an assert turns it red when T015 adds the commands.
- Low: the Hunspell note named no exact source. Fix: the note names rotemdan `8f755ef` and hunspell `edb6191`, and R13 records the LGPL 2.1 §4 facts and the open Emscripten notices.
- Low: the catalog script used tree paths before it checked them. Fix: it checks `LanguageId` and the file names before any file access.
- Low: `SPELLING_SUGGESTIONS = 5` had two copies. Fix: a test compares the `spell-words.ts` value with `limits.ts`.
- Low: the gate comment did not state the exact Script rule. Fix: the comment names the rule and the tie refusal.
- Also fixed: the catalog script imported `DICTIONARY_LANGUAGE_BYTES` from its old module and stopped at start.
- The review found the Script-based negative rule of data-model §16 exact: Unicode Script counts, typed refusals, and Hunspell `testSpelling` as the authority.

### WP6 early facts (T028), 2026-10-24, `bun run dev`, WebView2 Edg/155.0.4283.62

- The run used a scratch `ARBARETO_PROFILE_ROOT`, UI Automation patterns for the boot and the folder picker, and CDP for the page. It sent no OS input. The app ended by WM_CLOSE to its main window, and the Job of `bun run dev` ended by PID.
- The T017 CSP had not landed. So the run used the 2026-10-24 CSP of `tauri.conf.json` (`script-src 'self'`, `connect-src ipc: http://ipc.localhost`). N1 under the T017 CSP stays open for WP8 (T041).
- N1 holds under that CSP. The worker script response and the `hunspell.wasm` response carried no `Content-Security-Policy` header (research R6, Tauri sets it only on `.html`). CDP showed no `ContentSecurityPolicyIssue` and no `security` log entry. `OBSERVATION T028: N1 pass worker=assets/spell-worker-1TeTnzR1.js wasm=assets/hunspell-B7u9vk2r.wasm status=200 marks=["recieve"] chip="Spelling: English" cspIssues=0 webview2=155.0.4283.62`
- N2 holds. The probe key ran `setSelectionRange` and `document.execCommand("insertText", false, "receive")`, which returned true with one `input` event. One Ctrl+Z (CDP `Input.dispatchKeyEvent` with the `undo` command) restored "recieve". `OBSERVATION T028: N2 pass insertText=true inputs=1 undo=restored webview2=155.0.4283.62`
- Deviation: T028 names `tests/windows/inject.ts` for the keys. The batch preamble forbids OS input in app runs, so CDP sent the keys. A CDP key runs no native key binding, so the Ctrl+Z named the `undo` command. The native Ctrl+Z path stays for WP8 (Q8).
