# Quickstart: Validate WSL Parity and Commit Message Spell Check

**Feature**: `specs/006-wsl-parity-spellcheck` | **Plan**: [plan.md](plan.md) | **Contract**: [contracts/operations.md](contracts/operations.md) | **Data model**: [data-model.md](data-model.md)

This guide lists the validation scenarios. It holds no implementation code. The work packages in plan.md create the named test files.

## Prerequisites

- Windows 11 x64 with the 001 qualification prerequisites and WebView2.
- Main with features 001 to 005 merged. 006 starts after 005 merges.
- Git for Windows 2.56 for the Windows cases. The 001 minimum Git 2.55.0 stays in force.
- WSL `Ubuntu-26.04` with Git 2.55 for the WSL scenarios. Set `ARBARETO_WSL_DISTRO`. Run the WSL tests alone, with no other test run on the host.
- For the real-language cases (Q4, Q25): set `ARBARETO_DICTIONARY_CACHE` to a folder outside the repository that the catalog script filled. Without it, those cases skip with "dictionary cache absent: set ARBARETO_DICTIONARY_CACHE", and the qualification run counts the skip as unverified (spec SC-002).
- For the packaged gate (Q25): the 004 reference PC (AMD Ryzen 7 4800H, 16 logical processors, Windows 11 10.0.26300).
- For the IME case (Q13): an installed Japanese IME. For the offline case (Q24): Windows Sandbox. Without either, the case skips with a recorded capability and stays unverified.
- For app runs: set `ARBARETO_PROFILE_ROOT` to a scratch folder. The dictionaries then go to `<root>/data/dictionaries`.
- No test uses the network. Every WSL case uses the owned distro global file (`wslGlobalConfig`), and every Windows case an owned `GIT_CONFIG_GLOBAL` with `GIT_CONFIG_NOSYSTEM=1`.

## Commands

Use only the README "Development" commands:

- `bun install --frozen-lockfile`
- `bun run build`
- `bun run typecheck`
- `bun run export:schemas --check`
- `bun run test:contracts`
- `bun run test:git`
- `bun run test:windows` (after `bun run build:service`)
- `bun run test:all` (alone, never in parallel with another full run)
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`
- `bun run dev`
- `bun run package`

New commands, which enter README "Development" only after they run green (CLAUDE.md "Tool boundaries"):
- `bun scripts/dictionary-catalog.ts` with `ARBARETO_DICTIONARY_CACHE` set. It reads `api.github.com` and `raw.githubusercontent.com` (user decision, 2026-10-22).
- `bun scripts/dictionary-catalog.ts --offline`. It reads only the cache.
- `bun test tests/gate`. The early gate report. `bun run test:all` does not run it, because `tests/gate` is outside the `tests/groups.json` roots.

## Scenarios

| # | Scenario | Test home | Expected outcome | Spec |
|---|---|---|---|---|
| Q1 | Build the catalog and the local cache from the pinned commit; then rebuild it with `--offline`. | `scripts/dictionary-catalog.ts` | `src/contracts/dictionaries.json` holds at most 86 entries without `en`, in `compareNames` order, with the size, SHA-256, URL, licence value, and licence documents of each. el, el-polyton, ko, mn, and rw are left out by size. The offline run gives the same bytes, minus each entry of `scripts/dictionary-gate.json`. | FR-017 |
| Q2 | Check the catalog file and the dependency. | `tests/contracts/dictionary-catalog.test.ts` | The schema passes. Every URL has the exact pinned form. No entry is `en`. `oc` lists `license` and `licence`, and `eu` and `et` list `readme.md`. The `bundled` record matches `node_modules/dictionary-en` in size and SHA-256. `bun.lock` holds the `hunspell-wasm` integrity value, and `hunspell.wasm` has its SHA-256. Each `script` value matches `Intl.Locale(id).maximize().script`, and the file has the `JSON.stringify(value, null, 2)` form. | FR-004, FR-015, FR-017 |
| Q3 | Record the facts F1 to F7 and F15 with local servers and the installed packages. | `tests/git/dictionary-facts.test.ts` | Each fact passes, or research.md R13 records the failure and the contract changes before P4 or P6. | FR-010, FR-011 |
| Q4 | Load each cached language in its own Bun process (early report). | `tests/gate/dictionary-gate.test.ts` | Each process prints the load time, the RSS increase, the NFC state, and the fixture result (data-model §16), or "no load within 60 s". A Bun time decides nothing. A fixture failure enters `scripts/dictionary-gate.json`. | FR-017, SC-002 |
| Q5 | Segment the vector texts. | `tests/contracts/spell-words.test.ts` | The words equal data-model §11. Backtick text, paths, versions, e-mail addresses, and `_` identifiers give no word. | FR-003, FR-004 |
| Q6 | Type the English fixture message with known misspellings and correct words. | `tests/contracts/spelling-editor.test.tsx`, `tests/contracts/network-sites.test.ts` | Every listed misspelling gets a mark, and no correct word or skipped token gets one. The count text and the chip "Spelling: English" show. The `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `sendBeacon` stubs count 0 calls. The source scan finds no `fetch(` in `src/frontend` and one in `src/git-service/dictionaries.ts`. | US1-1, US1-7, US1-8, SC-001 |
| Q7 | Open the menu of "recieve" by right-click, Shift+F10, and the Menu key; select "receive"; open the menu of an unmarked word; type while a suggestion list still computes. | `tests/contracts/spelling-editor.test.tsx` | At most 5 suggestions, then Ignore and Add to dictionary, then Cut, Copy, and Select all. "receive" replaces only that word, after the raw text of its range compared equal. An unmarked word keeps the built-in menu (no `preventDefault`). The check round of the typed text merges while the suggestion worker still runs. | US1-2, US1-3, US1-9, FR-005 |
| Q8 | Replace a word, then press Ctrl+Z once (packaged). | `tests/windows/spelling-packaged.test.ts` | The word changes, and one Ctrl+Z restores "recieve" (N2). | US1-3, FR-005 |
| Q9 | Ignore and Add to dictionary for "kubectl"; restart; type "Kubectl" and "KUBECTL"; fill 10,000 words; add a 101-code-point word; an unreadable and an unavailable store; Remove a word. | `tests/contracts/{spelling-editor.test.tsx,word-list.test.ts}` | Ignore holds for the window session. The added word stays after a restart, in all three case forms. Add is unavailable with its D17 reason at 10,000 words, above 100 code points, with an unreadable list, and without storage. Arbareto never writes to an unreadable store. Remove deletes the word with no confirmation. | US1-4, US1-5, US3-9, FR-006 |
| Q10 | Select English and a synthetic Ukrainian dictionary, in this order; type "привіт recieve", then a wrong-layout word "cир" (Latin "c") and a Greek word. | `tests/contracts/spelling-editor.test.tsx` | "привіт" has no mark, "recieve" has one, and the chip states "Spelling: English, Ukrainian". Each language checks only the words of its Script. "cир" has a mark, because English and Ukrainian both refuse it. The Greek word has no mark, because no selected language has its Script. The menu of "recieve" asks only the English suggestion worker. | US3-6, FR-004 |
| Q11 | Spell check Off; every selected language fails; one selected language fails; one language still loads; one load passes its 30 s deadline (fake clock). | `tests/contracts/spelling-editor.test.tsx` | "Spelling: Off" with no marks and no count. "Spelling: No language loaded" with no marks. The chip names only the loaded languages, and the tooltip holds the load text or the loading text. The deadline terminates the worker and shows the load text. | FR-001, FR-008, Edge Cases |
| Q12 | Open the commit editor, then type one character in a 64 KiB message with every word marked (packaged). | `tests/windows/spelling-perf.test.ts` | English marks within 1 s after the first open. Each mark update within 100 ms after a typed character. No stall above 50 ms. A paste of the whole text records its round time as the SC-004 limit case. | SC-004, FR-008 |
| Q13 | Compose with a Japanese IME; type a Hebrew line with English and Hebrew selected; check the mark positions at 100%, 150%, and 225% text scale (packaged). | `tests/windows/spelling-packaged.test.ts` | No mark during the composition, and the same marks as without the IME after it. Each mark rect equals the UI Automation text range rect of its word (N4, N5). | SC-009 |
| Q14 | Download from the injected source: success, Cancel, one changed byte, a short file, a long file, 301 to the same host, 302 to another host, 404, 429, 503, an `http:` entry, a connection failure, the deadline, and a write failure. | `tests/git/dictionaries.test.ts` | Success installs the language with its manifest, and each request names `proxy: false`. Each other case ends with its reason and its FR-016 text, and no file stays in the dictionary folder. A long file writes at most its catalog size. | US3-2 to US3-4, FR-010, FR-011, FR-016, SC-003 |
| Q15 | Import from a folder with the catalog files, with a changed file, a missing file, and an unreadable file; Cancel the picker. | `tests/git/dictionaries.test.ts`, cargo tests | The catalog files install, and the injected `fetch` counts 0 calls. The other cases give `import-mismatch` or `import-unreadable`. A canceled picker gives `canceled` and changes nothing. | US3-5, FR-012 |
| Q16 | Change one byte of an installed file, delete one file, delete the whole folder, and write a 65,537-byte `entry.json`; then load and list. | `tests/git/dictionaries.test.ts` | A changed or missing file, and the oversized manifest, give `changed`. A missing folder gives `not-downloaded`. A selected language without its folder stays selected and shows the load text. The other languages keep working. | FR-013, Edge Cases |
| Q17 | Start with a manifest of another catalog entry, a manifest whose ID left the catalog, a staging leftover, and an unknown folder; send a read before the reconcile ends. | `tests/git/dictionaries.test.ts` | The first folder goes with the notice `catalog-changed`. The second goes with `catalog-removed` and its name. The leftover goes. The unknown folder stays untouched. The read waits for the reconcile. The shell drops the removed ID from the selection. | FR-017, Edge Cases |
| Q18 | Start a second download during a download; Remove the language under download; run a Git read and a commit during a download; cancel a `readDictionary`. | `tests/git/dictionaries.test.ts` | The second run and that Remove give `busy` with the FR-016 text. The Git operations neither wait nor block. The canceled read ends `canceled`. | FR-011, Edge Cases |
| Q19 | Remove a selected language. | `tests/git/dictionaries.test.ts`, `tests/contracts/spelling-page.test.tsx` | Its folder goes with no confirmation, it leaves the selection, and the personal word list stays. | US3-8, FR-014 |
| Q20 | Open the Spelling page with Bundled, Not downloaded, Downloading, Importing, Ready, Changed, and Failed rows; `eu`; `oc`; three selected languages; the licence view; the link. | `tests/contracts/spelling-page.test.tsx`, cargo tests | Each row shows its size, licence value, licence link, state, and actions (data-model §4). The `eu` row shows the readme note. The fourth language shows "You can select at most 3 languages. Clear one first." Show licence shows the text as plain text, both `oc` documents included. The link sends `openLicenceLink` with the ID only, and the cargo test checks the catalog URL and the COM thread. | US3-1, US3-7, US3-10, FR-009, FR-015 |
| Q21 | Select English and Ukrainian, restart, and open another repository. | cargo tests (`settings.rs`), `tests/contracts/spelling-page.test.tsx` | The setting round-trips in `settings.json`. The same selection and order apply. An ID outside the catalog drops at load. | US3-11, FR-009 |
| Q22 | WSL Global save: the header; save and remove each FR-060 key; a change before the review; a change after the review; a refused write; a multi-valued key; an included value; Cancel; the `core.sharedRepository=0660` mode case. | `tests/wsl/workbench-wsl.test.ts` | The header states the FR-020 text with the distro name. Only the saved key changes in the owned global file, and every other configuration byte stays. The stale paths give their 004 texts. The new global file has mode `0666 & ~umask`. The real `~/.gitconfig` and XDG file keep their SHA-256. The control mutation (write in the repository context) makes the mode case fail. | US2, FR-018 to FR-025, SC-005 |
| Q23 | WSL rows Q8, Q9, Q10, Q11, Q13, Q15, Q16, Q20, Q22, and Q23 of 004, and Add worktree through the service. | `tests/wsl/workbench-wsl.test.ts` | Each result equals Git's own commands on a copy in the distro. No Git process and no `arbareto-*` scope remain after Cancel or close. A row without its resource records `unverified` with the cause. | US4, FR-024, SC-006 |
| Q24 | Packaged: the workers under the CSP; then US1 and one Download in a Windows Sandbox without networking. | `tests/windows/spelling-packaged.test.ts` | `dist/` holds `hunspell.wasm` with its SHA-256 (F14). The workers fetch it from the app origin and mark English (N1). In the Sandbox, US1 passes, and Download shows the `transport` text and keeps no file (N6). | SC-001, FR-007, FR-010 |
| Q25 | Packaged gate per cached language, by the plan D3 method: 3 runs, baseline median, 250 ms samples of the WebView2 private bytes, the load timer from the switch Toggle to the chip name, and the menu of one negative word. | `tests/windows/spelling-perf.test.ts`, `scripts/windows/measure-ram.ps1` | Each language passes when all 3 runs load within 10 s, add at most 256 MiB with both workers, and give the exact fixture count. A failure enters `scripts/dictionary-gate.json`. Then the offline rebuild (Q1) and Q2 pass (N7). | FR-017, SC-004 |
| Q26 | Keyboard-only runs of US1 to US3; each key of plan D16; contrast in Dark, Light, and forced colors. | `tests/contracts/spelling-page.test.tsx`, `tests/windows/spelling-packaged.test.ts` | Each story completes by keyboard. Each list is one Tab stop. Each new control has an accessible name and visible focus. Contrast at least 4.5:1. The wave stays visible in forced colors. | SC-007, FR-026 |
| Q27 | Input latency during a Ukrainian load, a round of 64 KiB, a suggestion list, and a download (packaged). | `tests/windows/spelling-perf.test.ts` | 95% of inputs within 100 ms, every input within 500 ms. | FR-028 |
| Q28 | Review of the requirement-to-test map. | review checklist | No outcome depends on Git message text, an error message, timing, a name pattern, or a language guess. | SC-008 |

## Manual checks in the packaged build

- The marks, the chip, and the spelling menu against the Main and SpellingEdges boards.
- The Spelling page, the failure texts, and the licence view against the SpellingPage, DictionaryFailures, and LicenceView boards.
- The licence link opens the catalog URL in the default browser.
- The About licence list shows the `hunspell-wasm` note with its two source links.
- The WSL Global header and Save against the WslGlobal board, with the owned distro global file of a test double run only.
- Forced colors (Aquatic) and Light for the menu and the Spelling page against the ForcedColors and Light boards.
