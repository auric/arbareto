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
- F3: a local TLS server with a test CA (committed PEM fixtures, inert data). In a child process with `NODE_EXTRA_CA_CERTS` set to that CA, `tls: {ca: tls.rootCertificates}` makes the request fail, and a request without `tls` succeeds. With `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: true` still fails an unknown certificate.
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
