# Data Model: WSL Parity and Commit Message Spell Check

Each section names its source. Field names are contract names. "001 data-model §n" to "005 data-model §n" name the earlier models.

## 1. Catalog file (`src/contracts/dictionaries.json`)

- Source: plan D3, spec FR-017. `scripts/dictionary-catalog.ts` writes it, from the network or with `--offline` from the cache. Only an application release changes it.
- `version`: 1.
- `source`: `{repository: "wooorm/dictionaries", commit, urlPrefix}`. `commit` is 40 lowercase hex digits. `urlPrefix` is `https://raw.githubusercontent.com/wooorm/dictionaries/<commit>/dictionaries/`.
- `bundled`: the English record (§2 fields), with `id` `en`, the `dictionary-en` package name and version, and the files of that package.
- `entries`: 0 to 92 entries (§2), unique by `id`, in the 005 `compareNames` order of the UTF-8 bytes of `name`. No entry has the ID `en`.
- Validation (the `Catalog` schema of `src/contracts/dictionaries.ts`): every field below; every URL equals `urlPrefix + id + "/" + name` exactly; every `commit` equals `source.commit`. A failure stops the service start, the renderer build, and the shell build.

## 2. Catalog entry

- `id`: a language ID. Form `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`, at most 32 bytes. Examples: `uk`, `de-CH`, `sr-Latn`, `ca-valencia`, `tlh-Latn`, `hyw`.
- `name`: the English name, 1 to 64 code points (plan D3).
- `license`: the `license` field of the folder's `package.json`, 1 to 128 bytes, as given (spec FR-015).
- `commit`: the pinned commit.
- `files`: 3 or 4 entries `{name, url, size, sha256}`, in the order `index.aff`, `index.dic`, then the licence documents. `name` is one of `index.aff`, `index.dic`, `license`, `licence`, `readme.md`. `size` is 1 to 12,582,912. `sha256` is 64 lowercase hex digits.
- `licences`: the licence document names, 1 or 2: `["license"]`, `["licence"]`, `["license", "licence"]` (`oc`), or `["readme.md"]` (`eu`, `et`).
- Validation: the sizes of `files` add up to at most 12,582,912 (`DICTIONARY_LANGUAGE_BYTES`). Each name occurs once.
- The download order is the `files` order. The row link names the URL of `licences[0]`.

## 3. Installed dictionary (`<launch directory>/dictionaries/<id>/`)

- Source: plan D5, spec FR-013, FR-017.
- Files: each `files` name of the entry, and `entry.json`.
- `entry.json`: `{version: 1, entry}`. `entry` is the catalog entry (§2) that the files came from. The service reads at most `DICTIONARY_MANIFEST_BYTES` (65,536) of it. A larger file, invalid JSON, or another form counts as no valid manifest.
- Staging: `.staging-<id>-<32 hex>/` in `dictionaries/`. It exists only during a run or after a crash.
- Install: remove an existing `<id>/`, then rename the staging folder to `<id>/`.
- Language check (`listDictionaries`): the folder exists; `entry.json` is valid and its `entry` equals the current catalog entry (same keys and values); each file exists as a regular file with the catalog size and SHA-256.
- File check (`readDictionary`): the folder exists; `entry.json` is valid and equals the entry; the requested file exists as a regular file with the catalog size and SHA-256.
- Release reconcile (once per service process; every dictionary operation waits for it):

| Entry in `dictionaries/` | Action | Notice for this service process |
|---|---|---|
| A name that starts with `.staging-` | remove | none |
| A catalog ID whose `entry.json` holds the current entry | keep | none |
| A catalog ID whose `entry.json` holds another entry | remove | `catalog-changed` for that ID |
| A catalog ID without a valid `entry.json` | keep (the check gives `changed`) | none |
| No catalog ID, and `entry.json` is valid with that ID | remove | `catalog-removed` with `entry.name` |
| Any other entry | keep, untouched | none |

- A download or import of a language clears its `catalog-changed` notice.

## 4. Language state

- Service state per catalog entry (`listDictionaries`):

| `state` | Rule |
|---|---|
| `downloading` | A `downloadDictionary` run holds the run lock for this ID. |
| `importing` | An `importDictionary` run holds the run lock for this ID. |
| `not-downloaded` | The folder `<id>/` does not exist. |
| `changed` | The folder exists, and the §3 language check fails. |
| `ready` | The §3 language check passes. |

- `notice`: `catalog-changed` or absent. `removed`: the first `DICTIONARY_CATALOG_ENTRIES` (92) `catalog-removed` names of this service process. `more`: the count of the other `catalog-removed` notices.
- Row state in the renderer (plan D17 texts):

| Row | Source |
|---|---|
| Bundled | the `bundled` record, always |
| Not downloaded | `not-downloaded`, and no failure of this window session |
| Downloading <n>% | `downloading`, with the progress of the run |
| Importing… | `importing` |
| Ready | `ready`, and no load failure of this window session |
| Changed | `changed` |
| Failed | the last run of this window session for this ID failed, or its worker load failed or passed its deadline |

- A Failed row keeps its failure text until the next run of that row or a restart. A load failure of a `ready` row shows Failed with the FR-016 load text and offers only Remove.
- Row actions: Not downloaded: Download, Import…. Downloading: Cancel. Importing: none. Ready: Show licence, Remove. Changed: Download, Import…, Remove. Failed after a run: Retry, Import…, and Remove when files exist. Failed with reason `not-https`: Import… only. Bundled: Show licence.
- Selection checkbox: available for Bundled and Ready, and for every selected row (to clear it). Otherwise unavailable with the limit reason when 3 languages are selected, else with the not-ready reason.

## 5. Download run

- Source: plan D4, spec FR-010, FR-011, FR-016.
- Request: `{language}`. Result: `{language, state: "ready"}`.
- Steps: the reconcile → the run lock → `fetching` (file i of n) → `checking` (file i) → `installing` → `ready`. Every file passes `fetching` and `checking` before `installing`.
- Ends: `ready`; `failed` with `DICTIONARY_UNAVAILABLE` and a reason below; `failed` with `DEADLINE`; `canceled`. Every end except `ready` removes the staging folder.
- Reasons: `not-https` (before any request), `redirect` (300 to 399), `http-not-found` (404), `http-rate-limit` (429), `http-status` with `status` (any other status that is not 200), `transport` (a rejected request or body read that is not this run's abort), `mismatch` (a byte count or SHA-256 other than the catalog), `save` with `folder` (a file system error of the staging or the install), `busy` (another run holds the lock).
- Bytes: the run reads at most the catalog size plus one byte of each body, and writes at most the catalog size. Byte `size + 1` gives `mismatch`.
- Connection: direct, `proxy: false` (user decision, 2026-10-22).
- Progress: phase `dictionary`, counters `received` (decoded bytes so far, all files, each up to its size) and `total` (the sum of the catalog sizes).
- Bounds: `DICTIONARY_DOWNLOAD_DEADLINE_MS` (120,000) for the whole run.

## 6. Import run

- Source: plan D6, spec FR-012.
- Renderer request: `{language}`. Service payload after the shell picker: `{language, folder}`, with `folder` a channel path from the picker.
- Steps: the reconcile → the run lock → `checking` (file i) → `installing` → `ready`.
- Bytes: at most the catalog size plus one byte read, and at most the catalog size written, per file.
- Reasons: `import-mismatch` (a missing file, another type, another size, or another SHA-256), `import-unreadable` with `folder` (a read error other than `ENOENT`), `save` with `folder`, `busy`.
- No network request runs.

## 7. Read chunk

- Source: plan D7, spec FR-013.
- Request: `{language, file, offset}`. `file` is a `files` name of the entry. `offset` is a multiple of `DICTIONARY_CHUNK_BYTES` (1,048,576) below the size, or 0.
- Result: `{language, file, size, offset, bytes}`. `bytes` is the base64 of the bytes from `offset`, at most `DICTIONARY_CHUNK_BYTES`.
- Reasons: `absent` (no folder), `changed` (the §3 file check fails). An unknown `language` or `file`, or a bad `offset`, gives `INVALID_REQUEST`. A `cancel {operationId}` gives `canceled`.
- Each call checks the requested file whole, so every chunk comes from bytes that equal the catalog.

## 8. Language selection setting

- Source: plan D11, spec FR-009. The shell file `settings.json`, key `spelling`.
- `{enabled: boolean, languages: LanguageId[]}`. `languages` holds 0 to 3 unique IDs in the user's order. Each is `en` or a catalog ID.
- Default and read failure: `{enabled: true, languages: ["en"]}`.
- At load, the shell drops each ID that is not `en` and not a catalog ID.
- Transitions: a check box adds the ID at the end or removes it; Move up and Move down swap two neighbours; the switch sets `enabled`; Remove of a dictionary removes its ID. Each transition is one `setSpelling`.

## 9. Personal word list record

- Source: plan D10, spec FR-006. IndexedDB database `arbareto-spelling`, version 1, store `words`, key path `word`.
- Record: `{word}`. `word` is NFC, 1 to 100 code points (`PERSONAL_WORD_CODE_POINTS`).
- List bound: 10,000 records (`PERSONAL_WORDS`).
- List state: `loading`, `loaded` (the words), `unreadable` (more than 10,000 records, a record that fails the rules, or a read error), `unavailable` (the database does not open).
- Add: one `readwrite` transaction, `count()`, then `add(record)`. `ConstraintError` means "already listed". Remove: `delete(word)`, with no confirmation (user decision, 2026-10-22).
- In `unreadable` and `unavailable`, Arbareto writes nothing to the store.

## 10. Ignore list

- Source: plan D10, spec FR-004, FR-005. A `Set` of NFC words in renderer memory for the window session, across repositories. A restart clears it. It has no bound, because each entry comes from one user selection.

## 11. Words and skip rules (`src/contracts/spell-words.ts`)

- Source: spec FR-003, FR-004. Offsets are UTF-16 code unit offsets of the editor text T.
- Lines: T splits at U+000A. Every rule below stays inside one line, because UAX #29 breaks at a line feed (WB3a, WB3b) and the token rules use White_Space, which holds U+000A.
- Backtick ranges: in each line, the U+0060 code points pair in order: the first with the second, the third with the fourth. Each pair skips the range from the first backtick to the second backtick, both included. A last backtick without a pair skips nothing.
- Tokens: the maximal runs of code points without the Unicode property `White_Space` (`/\P{White_Space}+/gu`). A token is skipped when it holds a code point of `\p{Nd}`, or U+005F `_`, U+002F `/`, U+005C `\`, U+0040 `@`, or U+003A `:`, or a U+002E `.` that is neither its first nor its last code point.
- Words: the segments of `new Intl.Segmenter("und", {granularity: "word"})` over a line with `isWordLike` true, whose range meets no skipped range.
- Lookup form: `word.normalize("NFC")`. The range keeps the offsets in T.
- Vectors (the contract test holds these and more):

| Text | Words |
|---|---|
| `Fix the sync job so it does not recieve stale data` | Fix, the, sync, job, so, it, does, not, recieve, stale, data |
| `` Rename `fixtureName` in src/app.ts for v1.2.3. `` | Rename, in, for |
| `Ask user@host about snake_case and https://example.com/a.` | Ask, about, and |
| `don't follow-up` | don't, follow, up |
| `e.g. U.S. end.` | end |
| `` a `b` c `d `` | a, c, d |
| `x1 ٣abc word` | word |
| `привіт recieve` | привіт, recieve |
| `תיקון סדר התויות` | תיקון, סדר, התויות |

## 12. Case rule

- Source: spec FR-006, Edge Cases. For a list L of NFC words, the accepted set is the union over w in L of `w`, `cap(w)`, and `upper(w)`. `cap(w)` is `upper` of the first code point of w, then the rest of w unchanged. `upper` is `String.prototype.toUpperCase`.
- A word t (NFC) passes when the accepted set of the personal list or of the Ignore list holds t.
- Examples: L = {kubectl} accepts `kubectl`, `Kubectl`, and `KUBECTL`, and refuses `KubeCtl`. L = {iPhone} accepts `iPhone`, `IPhone`, and `IPHONE`.

## 13. Spelling marks and rounds

- Source: spec FR-001, FR-004, SC-004, SC-009; plan D9.
- Mark: `{start, end, raw, word}`. `start` and `end` are UTF-16 offsets in the text of its round. `raw` is the text of that range, as typed. `word` is its NFC form for the lookups.
- Refused set: per loaded language, the refused ranges of the current text, kept per line.
- Changed lines: A is the old text, and B is the new text. p is the length of their common prefix. s is the length of their common suffix, at most `min(|A|, |B|) − p`. The changed lines of A are the lines that meet the range from p to `|A| − s`, both ends included. The changed lines of B are the lines that meet the range from p to `|B| − s`.
- Shift: in each refused set and in the shown marks, the ranges in lines before the changed lines stay, the ranges in lines after them move by `|B| − |A|`, and the ranges in the changed lines go. This is exact, because §11 never crosses a line feed.
- Round: a number, the text version, the changed lines of B (all lines for the first round of a worker), and the set of check workers that were loaded when it started. Each of those workers replies with the refused ranges of those lines.
- Merge: when every worker of the round replied, the engine puts the replies into the refused sets. A range is a mark when every loaded language refused it, and neither list of §12 accepts its `word`. A round merges only when all its workers replied. A newer round drops an older one, and the engine then sends the union of the dropped and the new changed lines.
- Composition: from `compositionstart` to `compositionend`, no mark shows.
- Count: the number of shown marks.

## 14. Worker protocol

- Source: plan D9. Two workers per loaded language: the check worker and the suggestion worker. Main thread to worker, then the worker reply:

| Message | Worker | Fields | Reply |
|---|---|---|---|
| `init` | both | `language` | for `en`: `loaded` or `load-failed` after the `?raw` import |
| `chunk` | both | `file` (`aff` or `dic`), `data` (base64) | none |
| `build` | both | none | `loaded` or `load-failed` |
| `check` | check | `round`, `lines` (each `{start, text}`) | `checked {round, ranges}`, `ranges` a transferred `Uint32Array` of start and end pairs in offsets of T |
| `suggest` | suggestion | `id`, `word` | `suggested {id, list}`, at most 5 strings |

- A check worker gets the next `check` only after it replied to the last one. The engine keeps only the newest round for it.
- A suggestion worker gets the next `suggest` only after it replied to the last one. A newer request replaces a queued one, and the engine drops a reply whose `id` is not the newest.
- Load deadline: `DICTIONARY_LOAD_DEADLINE_MS` (30,000 ms) from the first `readDictionary` call, or from `init` for `en`, until `loaded`. At the deadline, the engine calls `worker.terminate()`.

## 15. Suggestions

- Source: spec FR-005. The lists of the suggestion workers of the loaded languages in selection order, joined, with repeats dropped by exact string equality after NFC, cut to 5 (`SPELLING_SUGGESTIONS`).
- A suggestion replaces the range of its mark only when the editor text in that range still equals the mark `raw` text. The NFC `word` is never the compare value.

## 16. Language fixture (SC-002)

- Source: spec SC-002, Assumptions. `scripts/dictionary-catalog.ts`, `tests/gate/dictionary-gate.test.ts`, and `tests/windows/spelling-perf.test.ts` build it from the cached `index.aff` and `index.dic` of one language. The packaged test writes the words into the commit editor and reads the count text (plan D3).
- Rule source: hunspell(5) and the Hunspell source that `hunspell.wasm` builds (github.com/hunspell/hunspell `edb6191`, research R13 F16): `hashmgr.cxx` `load_tables`, `decode_flags`, and `parse_aliasf`, and `hunspell.cxx` `checkword` and `spell`.
- Dictionary lines: the lines of `index.dic` after the first line, without a final empty line. Per line (`load_tables`):
  - A morphological field starts at the first `:` that has a space or TAB three positions before it. The word ends before the white space run in front of that field. A TAB before that point ends the word first.
  - The flags follow the first `/` that no `\` precedes. A `\/` stays in the word as `/`. A `/` at position 0 moves the split to position 1, as `load_tables` does.
- Flag form (hunspell(5) "AFFIX FILE GENERAL OPTIONS", `FLAG`): a `FLAG` line that holds `long`, `num`, or `UTF-8` sets the form, and the last match wins. Default: each byte is one flag. `long`: each byte pair is one flag. `num`: decimal numbers split by commas. `UTF-8`: each UTF-16 unit is one flag.
- Flag aliases (hunspell(5) `AF`): after the line `AF <count>`, the next `<count>` lines `AF <flag vector>` define the aliases 1 to `<count>`. With aliases, a dictionary flag field is the decimal number of one alias.
- Refusing flags: the `FORBIDDENWORD` flag (the last definition), the `NEEDAFFIX` flag (else the `PSEUDOROOT` flag), the `ONLYINCOMPOUND` flag, and the `WARN` flag when `FORBIDWARN` is present. `checkword` and `spell` refuse a bare stem that carries one of them (hunspell(5) "AFFIX FILE OTHER OPTIONS", "OPTIONS FOR COMPOUNDING", and "AFFIX FILE OPTIONS FOR SUGGESTION"). hunspell(5) has no `COMPOUNDONLY` directive.
- Eligible stem: no line of the same word carries a refusing flag, because Hunspell keeps each line as a homonym. The word holds no space or TAB (a phrase line). The word is one §11 word with no skipped token.
- Positive words: for i from 0 to 199, the first eligible stem at or after line ⌊i × (n − 1) / 199⌋ + 1 of the n dictionary lines. When no eligible stem lies at or after that line, step i gives no word. Each word must pass Hunspell `testSpelling` after NFC.
- Script: the Unicode `Script` value that holds the most `\p{L}` code points of the positive words after NFC, each occurrence counted. A tie refuses. fr and sv also list Greek letter names such as `α`, so their positive words hold two Script values. The fixture names these values: Latin, Cyrillic, Greek, Armenian, Hebrew, Arabic, Syriac, Thaana, Georgian, Ethiopic, Cherokee, Canadian_Aboriginal, Mongolian, Tifinagh, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Lao, Tibetan, Myanmar, Khmer, Hangul, Han, Hiragana, and Katakana.
- Negative words, Latin script: `qzxqzxqzx`, `xkcdqwvjz`, `zzqqxxjj`, `vvbbqqzz`, `jjqqxxzz`, and the first 5 positive words with `qzxqzx` appended.
- Negative words, another script: A is the distinct code points of that Script value among the `\p{L}` code points of the positive words, in code point order. T(k) is A[k] A[k+1] A[k+2]. The words are T(k) three times for k from 0 to 4, and the first 5 positive words with T(0) twice appended.
- Each negative word must fail `testSpelling`.
- Refusals, each a gate step 2 failure with its reason: `no-positive-words` (0 positive words), `script-unlisted U+XXXX` (a letter of a Script value that the list does not name), `script-tie <values>` (two or more Script values hold the most letters), and `script-letters <count>` (fewer than 7 letters in a script other than Latin).
- Result: `{language, positives, negatives, failedPositives, failedNegatives}`. A language passes with 0 failures and no refusal. In the package, the count text must equal the number of negative words.

## 17. WSL Global save request

- Source: plan D13, spec FR-018 to FR-022. The 004 data-model §2 `config-save` review stays: per changed key, the exact origin and key-value bytes of every entry of that key in the scope.
- Run target for each write: context `globalConfig` with the WSL installation of the workspace, `-C /`, policy `integrate`, the arrays `--no-lazy-fetch config set --global -- <key> <value>` and `--no-lazy-fetch config unset --global -- <key>`.
- `files.global` (004 data-model §9): null for a WSL workspace. On WSL, null means "Git's `--global` rule applies inside the distro", and Save stays enabled.

## 18. View state (renderer, not stored)

- Spelling store: the selection (§8), the language states (§4), the per-language load state of each worker (`idle`, `loading`, `loaded`, `failed`), the refused sets (§13), the word list state (§9), the Ignore list (§10), the shown marks (§13), and the open menu `{mark, suggestions, pending}`.
- Spelling page: the focused row of each list, the open licence `{language, documents}` or none, and the running run `{language, kind, operationId, received, total}` or none.
- Settings view: `wslDistro` (string or null) from `workspace.location`.
