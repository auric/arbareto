# Feature Specification: WSL Parity and Commit Message Spell Check

**Feature Branch**: `006-wsl-parity-spellcheck`

**Feature Directory**: `specs/006-wsl-parity-spellcheck`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Feature 006: WSL parity and the commit message spell check, with nspell, bundled English, and downloadable dictionaries (005 Clarifications, 2026-10-21). Save Global Git settings in a WSL repository. Prove the 004 workbench rows on WSL that have no WSL test yet." Inputs: the 006 recommendations and the six user decisions of 2026-10-21, the 005 recommendations Q2 to Q5 (superseded where the 006 file differs), and 004 User Story 10, FR-006, FR-083, FR-084, research.md R20 and R21, and tasks T077 to T081 and T103.

## Clarifications

### Session 2026-10-21

The user gave these decisions on 2026-10-21. Earlier recommendations stay valid where these decisions do not change them.

- Q: Which spell check engine runs? → A: nspell, in the renderer. The WebView2 built-in check stays off, because its suggestions show only in the native menu and its result has no fixed oracle (004 research.md R20).
- Q: Which language ships with the application? → A: English. The English dictionary is bundled and works offline (FR-008).
- Q: How does the user get more dictionaries? → A: An in-app HTTPS download, only when the user asks, plus an offline import from a folder. Every file is checked against a SHA-256 catalog that ships with the application (FR-010 to FR-014).
- Q: Which languages does the catalog offer? → A: Every dictionary of wooorm/dictionaries that nspell loads within the size bound, not a short list. English stays bundled (FR-017, SC-002).
- Q: Which host serves the downloads? → A: raw.githubusercontent.com, at one pinned commit of wooorm/dictionaries (FR-010).
- Q: How does a word count as correct with several languages? → A: A word is correct when any selected dictionary accepts it, or the personal word list or the Ignore list holds it. The application never guesses the language of a word or a message (FR-004).
- Q: Which text does spell check cover? → A: Only the text of the commit message editor. This covers Commit, Amend last commit, and Commit and push. Spell check never covers file content, diffs, branch names, or the merge message (FR-002).
- Q: Which licence step comes before a download? → A: Option (a). Each language row shows its SPDX licence name and a link to the full licence text before Download. Selecting Download counts as acceptance, and no extra dialog opens. The licence file stays with the dictionary, and Settings shows it. The catalog keeps every dictionary that loads, with no licence filter (FR-015).
- Q: Where does Add to dictionary store the words? → A: In the app profile storage, the IndexedDB store of the WebView2 profile, as the commit drafts are (FR-006).
- Q: What does the Global page show for a WSL repository? → A: Git's own rule, "Git in <distro> writes its global file: ~/.gitconfig, or the XDG file when only that file exists.", and Save is enabled. The page names no exact file, because the service cannot check a Linux path (FR-020).
- Q: Is there a packaged check of the WSL Global save? → A: No. The tests through the isolated test double and the shell argument test are the evidence. A packaged or real-distro save would write the distro user's real `~/.gitconfig` (FR-025).

## User Scenarios & Testing *(mandatory)*

Feature 004 built the commit message editor and the Git settings view, and moved two items to a later feature: the commit message spell check (004 User Story 10) and the Global Git settings save on a WSL repository (004 FR-006). Feature 005 moved both into this feature, together with the WSL proof of the 004 rows that have no WSL test yet. Feature 005 delivers the WSL ignore read. Git Extensions is the reference: it checks the commit message with per-language dictionaries.

### User Story 1 - See spelling mistakes in the commit message (Priority: P1)

A developer writes a commit message. Misspelled words get a wavy underline. The context menu of a marked word offers suggestions, Ignore, and Add to dictionary. English works at once and offline.

**Why this priority**: Commit messages are permanent history. Git Extensions marks misspellings, and the user asked for it in 004. It needs no download, so it delivers value alone.

**Independent Test**: Type the English fixture message with known misspellings and known correct words. Check each mark, each suggestion, Ignore, and Add to dictionary. Check that the no-network harness of feature 003 records no request.

**Acceptance Scenarios**:

1. **Given** the word "recieve" in the message. **When** I type it. **Then** it gets a wavy underline whose shape is the cue, and the editor's accessible description states "1 possible misspelling".
2. **Given** a marked word. **When** I right-click it, or press Shift+F10 or the Menu key with the caret in it. **Then** the menu offers at most 5 suggestions, then Ignore and Add to dictionary.
3. **Given** the menu of "recieve". **When** I select "receive". **Then** only that word changes, and one Ctrl+Z restores "recieve".
4. **Given** a marked word "kubectl". **When** I select Add to dictionary. **Then** the mark goes, the word stays correct after a restart, and Settings lists it.
5. **Given** a marked word. **When** I select Ignore. **Then** the mark goes for that word until the window closes.
6. **Given** a message with marked words. **When** I select Commit. **Then** the commit runs with the text unchanged. Spell check never blocks a commit.
7. **Given** the text `` `fixtureName` ``, `src/app.ts`, `v1.2.3`, `user@host`, or `snake_case`. **When** I type it. **Then** it gets no mark.
8. **Given** the editor. **When** I look at it. **Then** the chip "Spelling: English" shows.

---

### User Story 2 - Save Global Git settings in a WSL repository (Priority: P1)

A developer opens Git settings in a WSL repository, selects the Global scope, changes a value, and saves. Git in the distro writes the value into its global file.

**Why this priority**: Feature 004 refuses this save today, so WSL users need a terminal for their identity and tool settings. Windows repositories already have it.

**Independent Test**: Through the test double, with an owned distro global file, save and remove each listed key. Check that only that key changes in the owned file, that every other configuration byte stays, and that the SHA-256 of the real `~/.gitconfig` and the real XDG file inside the distro stay the same.

**Acceptance Scenarios**:

1. **Given** a WSL repository in the distro Ubuntu-26.04. **When** I open the Global scope. **Then** the header states "Git in Ubuntu-26.04 writes its global file: ~/.gitconfig, or the XDG file when only that file exists.", and the controls are editable.
2. **Given** a change of `user.name`. **When** I select Save. **Then** Git in the distro writes only that key into its global file, and the view reads the values again.
3. **Given** a Global value that another program changed after the view loaded. **When** I select Save. **Then** the save refuses that key as stale, and the file keeps the other program's value.
4. **Given** the repository sets `core.sharedRepository=group` and no global file exists. **When** I save a Global value. **Then** the new global file gets the mode that the distro's umask gives, not a group-writable mode.
5. **Given** a save that Git refuses. **When** it ends. **Then** the view names the key and shows the bounded end of Git's output, as on Windows.

---

### User Story 3 - Add, select, and remove dictionary languages (Priority: P2)

A developer opens Settings, page Spelling. The page lists every catalog language with its size and licence. The developer downloads Ukrainian, or imports its files from a folder, selects it beside English, and sets the order. Later the developer removes it.

**Why this priority**: Many commit messages are not English. It needs the network or a manual file copy, so it comes after the offline English check.

**Independent Test**: With an injected test source and no real network, download, cancel, retry, import, select, order, and remove languages. Check each file against the catalog. Feed changed, short, long, redirected, and `http:` sources, and check that no file stays.

**Acceptance Scenarios**:

1. **Given** the Spelling page. **When** it opens. **Then** it shows Spell check on or off, English as bundled, and each catalog language with its size, its licence, and its state: Not downloaded, Downloading <n>%, Ready, Changed, or Failed.
2. **Given** Ukrainian is not downloaded. **When** I select Download. **Then** the row shows the progress, then Ready. The files are checked against the catalog before Arbareto keeps them.
3. **Given** a running download. **When** I select Cancel. **Then** the row states "Download canceled. Arbareto kept no file."
4. **Given** a downloaded file that differs from the catalog by one byte. **When** the download ends. **Then** the row states "The downloaded Ukrainian file does not match the catalog. Arbareto deleted it."
5. **Given** a folder with the Ukrainian `index.aff`, `index.dic`, and `license` files of the catalog. **When** I select Import and pick the folder. **Then** the row shows Ready, and no network request runs.
6. **Given** English and Ukrainian selected, in this order. **When** I type "привіт recieve". **Then** "привіт" gets no mark, "recieve" gets a mark, and the chip states "Spelling: English, Ukrainian".
7. **Given** a ready language. **When** I select Show licence. **Then** the page shows the text of its `license` file as plain text.
8. **Given** a ready language. **When** I select Remove. **Then** its files go, it leaves the selection, and the personal word list stays.
9. **Given** the personal word list. **When** I open it in Settings. **Then** it lists each added word, and Remove takes a word out.

---

### User Story 4 - Prove the workbench actions on WSL (Priority: P3)

The team runs the 004 workbench rows that have no WSL test yet, and Add worktree through the service, against a real WSL distro. This is a test-only story. It changes no visible behavior.

**Why this priority**: Feature 004 FR-006 claims WSL parity, but research.md R21 lists parts that no WSL case runs. A claim without evidence must stay unverified (constitution VI). It adds no user function, so it comes last.

**Independent Test**: In the owned distro folder of Ubuntu-26.04, run each row of the "Not covered yet on WSL" list of 004 research.md R21, plus Add worktree through the service. Compare each result with Git's own commands on a copy, run in the same distro.

**Acceptance Scenarios**:

1. **Given** a WSL repository. **When** the test adds a worktree through the service. **Then** `git worktree list --porcelain -z` and the references equal Git's own `git worktree add` on a copy.
2. **Given** each R21 row (Q8, Q9, Q10, Q11, Q13, Q15, Q16, Q20, Q22, Q23) and the Global saves of Q21. **When** the test runs it on WSL. **Then** HEAD, the references, the index, the working files, the configuration files, and the operation state equal Git's own commands on a copy.
3. **Given** a row that the test cancels or a window that the test closes. **When** the run ends. **Then** no Git process and no `arbareto-*` scope remains in the distro.

---

### Edge Cases

- The message holds text inside a backtick pair on one line, a path, a version, an e-mail address, or an identifier with `_`. Spell check skips these tokens (FR-003).
- A word holds an apostrophe or a hyphen, such as "don't" or "follow-up". The word segments of Unicode UAX #29 decide the word, not a pattern of Arbareto.
- The user types during an IME composition. The marks wait until the composition ends, so the mirror never marks half-composed text.
- The message has 64 KiB of text. Marks update within the SC-004 budget, and typing never waits for the check.
- No selected dictionary can load, for example because all downloaded files changed. The editor shows no marks, and the chip states that spell check has no loaded language. No mark is no proof of correct spelling.
- Spell check is off. The editor shows no marks and no count, and the chip states "Spelling: Off".
- The personal word list holds 10,000 words. Add to dictionary is unavailable with the limit stated.
- A word for the personal list is longer than 100 code points. Add to dictionary is unavailable with the limit stated.
- The profile storage is not available. Add to dictionary states that Arbareto cannot save the word. The commit and the draft are not affected.
- A downloaded file changes on disk later. The next load finds a size or SHA-256 difference. The row shows Changed with "The Ukrainian dictionary files changed. Download the dictionary again." The other languages keep working.
- The download host redirects to another host, the URL is not HTTPS, or the server sends more bytes than the catalog states. The download stops, and Arbareto keeps no file.
- The connection ends during a download. The row shows Failed with "Arbareto could not download the Ukrainian dictionary. Check the connection, then select Retry."
- The application ends during a download. No partial file becomes a dictionary, because only a checked file is renamed into place. The next start removes the temporary file.
- The dictionary folder is not writable. The row states "Arbareto could not save the Ukrainian dictionary in <folder>."
- An import folder holds files that are not the catalog files of that language. The import states "These files are not the Ukrainian files of the catalog. Arbareto did not import them."
- A WSL repository has no `HOME` for the distro user. Git cannot write the global file, and the save reports a typed failure with the output tail.
- A Global save on WSL is cancelled, and Git leaves `config.lock`. The fresh listing decides the result, and the next save reports Git's refusal with its output tail.
- A Global value on WSL comes from an included file, or a key has several values. The key is read-only, as on Windows (004 FR-063).
- A distro repository sits at `/`. Git in `/` reads a repository there only when the distro user owns `/.git`. This is a known gap, the same as the 003 clone gap.

## Requirements *(mandatory)*

### Scope Boundaries

Include spell check of the commit message editor text, with bundled English, suggestions, Ignore, and Add to dictionary. Include a Spelling page in Settings with on or off, the catalog languages, Download, Retry, Cancel, Import, Remove, the language order, the licence text, and the personal word list. Include the Global Git settings save on a WSL repository. Include the WSL test-double routes and the WSL tests of the 004 R21 rows and of Add worktree through the service.

Exclude the WSL ignore read and ignore save (feature 005 delivers them). Exclude Narrator support and its tests (001 spec.md:33). Exclude interactive rebase (004 spec.md:528). Exclude the live-input checks N1 and N2 (004 research.md:295, T082). Exclude spell check of the merge message, file content, diffs, and names. Exclude a WSL clone through the test double (003 T075 covers the clone in the distro). Exclude a packaged or real-distro WSL Global save check. Exclude Bitbucket and Jira integration. Exclude a background dictionary update check, an account, AI, and every spell check that uses the network.

The no-heuristics rule applies to every requirement. Every decision comes from exact parses of machine-readable Git output, from Git exit codes that the Git documentation defines for that command, from OS facts, from contract-defined values, or from a defined Unicode algorithm. Git message text, a language guess, and a "looks like" check never decide an outcome.

### Dependencies

- Feature 005 merges first. It delivers the WSL ignore read (005 spec.md:277, FR-043; 005 tasks T015, T040, and T059). It removes `fileAppend` (005 spec.md:276, T057), so this feature adds no WSL `append` route to the test double.
- Feature 004 provides the commit message editor, the house action menu, the Git settings view with its review and save, the native folder picker of Browse… (004 FR-052), and `tests/wsl/workbench-wsl.test.ts`.
- Feature 003 provides the no-network harness and the Commit and push flow.
- Feature 001 provides the WSL rules, the operation registry with Cancel, the frame bound, and the drafts store.

### Changes to earlier requirements

This feature changes these requirements for builds that include it. The earlier texts stay unchanged in their own files until the plan updates them.

- **004 FR-006** (`specs/004-workbench-ux/spec.md:338`): "Two exceptions move to a later feature (Clarifications, 2026-10-19): the ignore actions and the Global Git settings save on a WSL repository. Feature 004 refuses them with their contract reasons." Feature 005 closes the first exception (005 spec.md:277). This feature closes the second (FR-018 to FR-022). No exception remains.
- **004 Clarifications** (`specs/004-workbench-ux/spec.md:45`): "a WSL `global` save gives `INVALID_REQUEST` (contracts/operations.md gaps)". The refusal goes.
- **004 contract** (`specs/004-workbench-ux/contracts/operations.md:101`): "and a `global` save of a WSL workspace give `INVALID_REQUEST`". The WSL clause goes.
- **004 contract** (`specs/004-workbench-ux/contracts/operations.md:225`): "A WSL Git gets `INVALID_REQUEST` (contract gap)." The `globalConfig` context gets a WSL form (FR-018).
- **004 contract** (`specs/004-workbench-ux/contracts/operations.md:355`): "The `globalConfig` context has no WSL form. A WSL Git gets `INVALID_REQUEST`. The Global save on a WSL repository moves to a later feature (spec Clarifications, 2026-10-19). The refusal stays." The gap closes.
- **004 contract** (`specs/004-workbench-ux/contracts/operations.md:55`) and **004 data-model §9** (`specs/004-workbench-ux/data-model.md:103`): "A WSL workspace gives `files.global` null, because the service cannot check a Linux path." The rule stays. On WSL, null now means "Git's `--global` rule applies inside the distro". Save stays enabled (FR-020).
- **004 FR-083** (`specs/004-workbench-ux/spec.md:461`): "The message editor MUST mark misspelled English words with a wavy underline and a non-color cue. The context menu of a marked word MUST offer suggestions and Ignore. The editor MUST show the chip "Spelling: English"." The marks cover every selected language. The menu also offers Add to dictionary. The chip names the selected languages in order (FR-001, FR-005).
- **004 FR-084** (`specs/004-workbench-ux/spec.md:462`): "Spell check MUST run on the computer without a network connection and without AI." Spell check stays offline and without AI. Only Download and Retry on the Spelling page use the network, and only when the user selects them (FR-007, FR-010).
- **004 Scope Boundaries** (`specs/004-workbench-ux/spec.md:298`): "The later feature excludes dictionaries other than English, and every spell check that uses the network or AI." Other dictionaries are now allowed (FR-009). Spell check itself still uses no network and no AI.
- **004 Edge Cases** (`specs/004-workbench-ux/spec.md:288`): "Only English words get marks." Words get checked against every selected dictionary (FR-004).
- **004 Assumptions** (`specs/004-workbench-ux/spec.md:527`): "The dictionary source and its license are a plan decision." The source is decided (Clarifications). The licence rule is FR-015 (Clarifications).
- **004 User Story 10 and SC-012** (`specs/004-workbench-ux/spec.md:224-238`, `:504`): This feature delivers them as User Story 1 and SC-001.
- **004 tasks T077 to T080** (`specs/004-workbench-ux/tasks.md:282-285`) and **T103** (`specs/004-workbench-ux/tasks.md:436`): They move into this feature. The ignore half of T103 belongs to feature 005.
- **004 task T081** (`specs/004-workbench-ux/tasks.md:295`): "The Q26 parts that research.md R21 lists under "Not covered yet on WSL", and Add worktree through the service on WSL (the T206 double has no WSL `worktreeAdd` route), move to feature 005." Feature 005 moved them on (005 spec.md:21). This feature delivers them (User Story 4).
- **004 research.md R20** (`specs/004-workbench-ux/research.md:168`): "Decision (proposed): `nspell` with `dictionary-en`, in the renderer." The decision is confirmed (Clarifications).

### Functional Requirements

#### Spell check in the commit message editor

- **FR-001**: The commit message editor MUST mark each misspelled word with a wavy underline. The wave shape MUST be the cue, so the mark does not depend on color. The editor's accessible description MUST state the count, such as "3 possible misspellings". The editor MUST show the chip "Spelling: <languages>", with the selected languages in the user's order, such as "Spelling: English, Ukrainian". With spell check off, the chip MUST state "Spelling: Off".
- **FR-002**: Spell check MUST cover only the text of the commit message editor. This editor serves Commit, Amend last commit, and Commit and push. Spell check MUST NOT cover file content, diffs, branch names, paths in lists, or the merge message.
- **FR-003**: The words MUST be the word-like segments of Unicode UAX #29 word segmentation. Spell check MUST skip each whitespace-separated token that holds a digit, `_`, `/`, `\`, `@`, `:`, or a `.` between two other characters. It MUST skip text between a pair of backticks on one line. These rules are part of the contract.
- **FR-004**: A word MUST count as correct when the personal word list holds it, the Ignore list holds it, or any selected dictionary accepts it. The application MUST NOT guess the language of a word or a message. Each selected language MUST use its own dictionary instance, because one instance cannot combine languages.
- **FR-005**: Right-click, Shift+F10, or the Menu key on a marked word MUST open the house action menu. The menu MUST offer at most 5 suggestions, then Ignore and Add to dictionary. Suggestions MUST come from each selected dictionary in the user's order, without duplicates. A suggestion MUST replace only that word, as one undo step. Ignore MUST hold until the window closes.
- **FR-006**: Add to dictionary MUST add the word to the personal word list in the app profile storage, where the commit drafts are. The list MUST hold at most 10,000 words, and each word MUST have at most 100 code points. Above a bound, Add to dictionary MUST be unavailable with the limit stated. The Spelling page MUST list the words and offer Remove for each.
- **FR-007**: Spell check MUST run on the computer, with no network connection and no AI. It MUST NOT block a commit. It MUST NOT change the text without a user selection. It MUST NOT change the drafts flow or the 72-column guide of 004 FR-047.
- **FR-008**: The English dictionary MUST ship with the application. It MUST load only when the commit message editor first shows, not at application start. Spell check MUST run apart from the interface thread, so typing never waits for it.
- **FR-009**: The Spelling page in Settings MUST offer Spell check on or off, English as bundled, and each catalog language. Each row MUST show the size, the licence name, and the state: Not downloaded, Downloading <n>%, Ready, Changed, or Failed. The row MUST offer Download, Cancel, Retry, Remove, and Show licence where they apply. The page MUST offer Import… and the order of the selected languages, by keyboard and pointer.

#### Dictionaries

- **FR-010**: Download MUST run only when the user selects Download or Retry. It MUST use HTTPS to the catalog URL only. It MUST refuse a redirect to another host and every non-HTTPS URL. Download MUST NOT need an account. The application MUST NOT check for dictionary updates in the background. The catalog URLs MUST name raw.githubusercontent.com at one pinned commit of wooorm/dictionaries.
- **FR-011**: The application MUST keep a downloaded file only when its byte count and its SHA-256 equal the catalog entry. It MUST read at most the catalog byte count. It MUST write a temporary file and rename it into the dictionary folder only after the check. Cancel and every failure MUST keep no file. The download MUST stop at the plan deadline.
- **FR-012**: Import… MUST open the native folder picker. It MUST accept a folder only when its `index.aff`, `index.dic`, and `license` files equal one catalog entry in byte count and SHA-256. Import MUST use no network.
- **FR-013**: Before each load, the application MUST check the byte count and the SHA-256 of each file again. A difference MUST set the row to Changed. The other languages MUST keep working.
- **FR-014**: Remove MUST delete the files of that language and take it out of the selection. Remove MUST NOT change the personal word list.
- **FR-015**: Each catalog row MUST show the SPDX licence name and a link to the full licence text before the download. The link MUST name the catalog URL of the `license` file of that language. Selecting Download MUST count as acceptance of that licence. The application MUST NOT open an extra dialog for it. The catalog MUST NOT filter dictionaries by licence. Every downloaded or imported dictionary MUST keep its `license` file next to its other files. Show licence in Settings MUST show that text as untrusted plain text.
- **FR-016**: Each failure MUST show its own text:
  - "Arbareto could not download the <Language> dictionary. Check the connection, then select Retry."
  - "The downloaded <Language> file does not match the catalog. Arbareto deleted it."
  - "Download canceled. Arbareto kept no file."
  - "Arbareto could not save the <Language> dictionary in <folder>."
  - "The <Language> dictionary files changed. Download the dictionary again."
  - "These files are not the <Language> files of the catalog. Arbareto did not import them."
  - "Arbareto cannot load the <Language> dictionary. Spell check uses the other languages."
- **FR-017**: The catalog MUST ship with the application. Each entry MUST hold the language id, the name, the SPDX licence, the commit, and for each file the HTTPS URL, the byte count, and the SHA-256. The catalog MUST list every dictionary of wooorm/dictionaries at the pinned commit that passes two checks. The files of the language together MUST be at most 12 MiB (12,582,912 bytes). nspell MUST load them and pass the language fixture (SC-002). A catalog change MUST come only with an application release.

#### WSL Global Git settings save

- **FR-018**: A Global save on a WSL repository MUST run the distro's Git with the distro root `/` as its working folder, not the repository folder. Inside a repository, Git applies that repository's `core.sharedRepository` to a new lock file. The write and the remove MUST use the same Git configuration commands as on Windows.
- **FR-019**: The save MUST keep the 004 review rules unchanged. It MUST bind the exact origin and the exact key and value bytes of each changed key. It MUST check them again before each write. A fresh configuration listing MUST decide the result, also after a failure or Cancel (001 FR-023).
- **FR-020**: For a WSL repository, the Global header MUST state "Git in <distro> writes its global file: ~/.gitconfig, or the XDG file when only that file exists." This is the git-config(1) `--global` rule. The Global controls MUST be editable, and Save MUST be enabled. The view MUST NOT name an exact global file on WSL.
- **FR-021**: The save MUST run no repository program, and MUST need no trust approval. Arbareto MUST forward no Windows environment variable to the distro for it.
- **FR-022**: A failed save MUST name the key and show the bounded end of Git's output (004 FR-065). A Git exit that the Git documentation does not define as success MUST give a typed failure.

#### WSL tests

- **FR-023**: The test double MUST offer a WSL route for the `globalConfig` context with `/` as the working folder. It MUST also offer a WSL route for Add worktree through the service, with the destination check. Each route MUST fail closed when the owned distro global file is not configured. Before the first write, a test MUST check that Git in the distro names the owned global file.
- **FR-024**: The WSL tests MUST run every row of the 004 research.md R21 "Not covered yet on WSL" list, the Global saves of Q21, and Add worktree through the service. Each row MUST compare with Git's own commands on a copy in the same distro. A row that needs a resource the harness lacks MUST stay recorded as unverified with its cause.
- **FR-025**: Tests MUST NOT write the real global file of a distro user. Tests MAY read only the SHA-256 of the real `~/.gitconfig` and the real XDG file, inside the distro, before and after. The plan MUST NOT add a packaged or real-distro WSL Global save check. The plan MUST record the packaged WSL Global save as unverified.

#### Common rules

- **FR-026**: Every new control MUST follow 004 FR-085 and 004 FR-087. It MUST have an icon or a label, a tooltip, an accessible name, visible focus, and a stated reason when unavailable. Remove MUST stay apart from routine actions.
- **FR-027**: The dictionary operations MUST be bounded, typed service operations with Cancel. The renderer MUST NOT get network access or file access for them.
- **FR-028**: The window MUST keep the feature 001 SC-005 response targets while spell check loads, checks, and while a download runs.

### Key Entities *(include if feature involves data)*

- **Catalog entry**: A language id, its name, its SPDX licence, the source commit, and for each of `index.aff`, `index.dic`, and `license` the URL, the byte count, and the SHA-256.
- **Installed dictionary**: A catalog entry whose files sit in the dictionary folder, with its state: Ready, Changed, or Failed.
- **Language selection**: The ordered list of selected languages, with English bundled, and the on or off state.
- **Personal word list**: At most 10,000 words, each at most 100 code points, in the app profile storage.
- **Ignore list**: The words that the user ignored in this window session. It is not stored.
- **Spelling mark**: A word range in the message text and the languages that refused it.
- **WSL Global save request**: The changed keys with their values, the reviewed origin and value bytes per key, and the distro.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the English fixture message, every listed misspelling gets a mark, and no listed correct word or skipped token gets one. A suggestion replaces exactly that word, and one undo restores it. The feature 003 no-network harness records no request during the whole test.
- **SC-002**: Each catalog language passes its fixture after a download from the injected test source and after an import. The files of each language together are at most 12 MiB (12,582,912 bytes). No catalog entry exceeds that bound.
- **SC-003**: One changed byte, a short file, a long file, a redirect to another host, and an `http:` URL each keep no file and show their FR-016 text. Cancel keeps no file. A changed file on disk shows Changed at the next load.
- **SC-004**: On the packaged build, with budgets fixed before the measurement: English marks show within 1 s after the first open of the commit editor. A mark update shows within 100 ms after a keystroke for a 64 KiB message. No interface stall exceeds 50 ms. The process-tree memory increase per loaded language stays within the bound that the plan's P0 measurement fixes before qualification.
- **SC-005**: A WSL Global save changes only the saved keys in the owned distro global file. Every other configuration byte stays identical. The SHA-256 of the real `~/.gitconfig` and of the real XDG file stay the same. With `core.sharedRepository=group` in the repository, a new global file gets the mode `0666 & ~umask`.
- **SC-006**: Each R21 row, the Q21 Global saves, and the WSL Add worktree equal Git's own commands on a copy. No process remains after Cancel or close.
- **SC-007**: Keyboard-only users complete User Stories 1 to 3. Each new control has an accessible name, visible focus, and a contrast of at least 4.5:1.
- **SC-008**: A review of the requirement-to-test map finds no outcome that Git message text, timing, a name pattern, or a language guess decides.

## Assumptions

- Spell check is on by default, with English selected. This is a reviewer default.
- Ignore holds for the window session across repositories, and a restart clears it. This is a reviewer default.
- A language whose load takes long shows its marks when the load ends. Typing never waits for it (FR-008). The plan records the load time per language.
- nspell supports only part of the Hunspell format, for example no compound rules. Some languages, such as German, then mark correct words. The catalog gate accepts a language when nspell loads it and passes its fixture. Spell check quality outside English is not a claim of this feature.
- The language fixture of a downloaded language comes from that dictionary's own word list plus fixed non-words. The plan defines it.
- The dictionary folder sits in the application data folder, and it follows `ARBARETO_PROFILE_ROOT` when that variable is set.
- The proxy and certificate behavior of the service download follows the platform defaults. The plan verifies it.
- `HOME` is set for every process that `wsl.exe` starts. The 004 R21 note supports this. The plan verifies it.
- The Q11 force note can run with a local bare remote in the distro, and the Q23 host line may need an SSH server that the distro reaches (003 T008 rule). Both are unverified. FR-024 records a row that cannot run as unverified.
- The mockup of the Spelling page and of the editor marks comes first, through the arbareto-ux skill, before the frontend work.

## Design notes for planning

These notes come from the 006 recommendations of 2026-10-21 and the 005 recommendations Q2 to Q5. The plan decides the final form.

- Engine: `nspell` `^2.1.5` (MIT, last release 2021-01-17, one dependency `is-buffer` 2.0.5, MIT). `dictionary-en` `^4.0.0` (`(MIT AND BSD)`), `index.aff` 3,086 bytes and `index.dic` 551,762 bytes, about 192 KB gzip. Load English through a Vite `resolve.alias` with `?raw` in a dynamic `import()` (004 R20). Do not use `?url`. Add both to the notices inventory.
- Worker: nspell runs in a Web Worker. The CSP `worker-src` falls back to `script-src 'self'` (`tauri.conf.json`). Unverified in the packaged build. The renderer `connect-src` stays `ipc: http://ipc.localhost`.
- Marks: the editor stays a plain `<textarea>` with `spellCheck={false}` (`CommitTray.tsx`). An `aria-hidden` mirror layer behind it uses the same font, padding, wrap, and scroll position, and draws wavy-underline spans. Risks: alignment at 225% text scale, IME, and undo.
- Words: `Intl.Segmenter` with `granularity: "word"` and `isWordLike`. Unverified in Bun 1.4.3 for tests.
- Personal list: IndexedDB beside `draft-store.ts`. With `ARBARETO_PROFILE_ROOT`, the data sits in the profile `webview2` folder (`profile.rs`).
- Catalog: `src/contracts/dictionaries.json`, made by a dev-time script such as `scripts/dictionary-catalog.ts` (network at dev time, needs approval). Source: wooorm/dictionaries commit `8cfea406b505e4d7df52d5a19bce525df98c54ab` (2024-09-09), 92 dictionaries, UTF-8. The LibreOffice dictionaries and the npm tarballs are rejected.
- Licences (wooorm readme, examples): uk GPL-3.0, de GPL-2.0 OR GPL-3.0, fr MPL-2.0, es GPL-3.0 OR LGPL-3.0 OR MPL-1.1, pl GPL-3.0 OR LGPL-3.0 OR MPL-2.0, ru BSD-3-Clause, cs GPL-2.0 only, he AGPL-3.0. The project is AGPL-3.0-or-later.
- Sizes: uk 8.69 MB unpacked, tr 9.36 MB, en 0.58 MB. The frame bound is 16 MiB (`limits.ts:13`). Risk: the encoding of 12 MiB of text inside one frame.
- Operations: `listDictionaries`, `downloadDictionary`, `readDictionary`, `importDictionary` (native-first, through the 004 Browse picker), and `removeDictionary`, with schemas, vectors, and contract tests. The service downloads with Bun `fetch` and `CryptoHasher`, through the operation registry, with an injected `fetch` seam for tests. Tests never use the network. Files go to `<app data>/dictionaries/<id>/`.
- Settings: a new app page in `APP_PAGES` (`SettingsView.tsx`).
- WSL Global, shell: `Kind::GlobalConfig` refuses WSL today (`process_requests.rs`). Copy the 003 clone target: `wsl::wsl_program()`, `git_identity: None`, `wsl: Some((installation, "/"))`. `wsl.rs` adds `-C <dir>` after `--no-lazy-fetch`, so `globalConfigFits` (`git-runner.ts`) stays.
- WSL Global, argv: write `--no-lazy-fetch -C / config set --global -- <key> <value>`; remove `--no-lazy-fetch -C / config unset --global -- <key>`; both under policy `integrate`, so the wrapper exports `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR=:`. Reads stay in the registered WSL context: `--no-lazy-fetch --no-optional-locks --literal-pathspecs config list --show-scope --show-origin -z`, the `--global` file listing, and `git var`.
- WSL Global, service: delete the refusal in `git-settings.ts`. Keep `files.global` null on WSL. Trust marker `workbench` with action `config-save`.
- WSL Global, renderer: `GitSettingsPage.tsx` locks the Global rows when `files.global` is null, and `texts.ts` shows "Arbareto cannot name the global Git configuration file, so Global is read only." Unlock Global when `wsl` is true, and show the FR-020 text.
- File naming on WSL: `git var GIT_CONFIG_GLOBAL` gives two lines in the product, and the choice needs an `access(R_OK)` check inside the distro. The double forwards `GIT_CONFIG_GLOBAL`, so it gives one line. So no naming rule can be tested through the double (user decision 4).
- Test double: forwards `GIT_CONFIG_GLOBAL=<owned>/.gitconfig`, `GIT_CONFIG_NOSYSTEM=1`, and `XDG_CONFIG_HOME=<owned>/.config` (`bun-runner.ts`). `wsl.exe` ignores `HOME` in `WSLENV`. New routes: `globalConfig` WSL with the distro root as cwd; `worktreeAdd` WSL in `resolveTarget` with a Linux path check; the `destinationFacts` worktree-add WSL branch that runs the `wslFiles` `destination` mode. The safe control mutation runs the write in `registered(w)`, which the `core.sharedRepository=group` mode test must catch. No control mutation may drop the forwarding. Risk: `wslParts` on the root UNC path for `/` (unverified).
- WSL tests: `tests/wsl/workbench-wsl.test.ts`, already in `tests/groups.json` `serial`. Run alone on Ubuntu-26.04. The current run takes 1,302 s.
- Cancel gap: Cancel can leave `config.lock`. Git then refuses the next write until the lock goes. The fresh listing decides.
- Work packages, in run order, after 005 merges: WP1 facts and catalog; WP2 contracts; WP3 shell (`Local: Rust`); WP4 WSL parity (`Local: WSL`); WP5 service dictionaries; WP6 editor spell check (frontend); WP7 Settings (frontend); WP8 qualification (packaged budgets, the worker under the CSP, no network, one full WSL run alone).
- Open 005 point: 005 T057 does not remove the WSL `append` Perl mode (`wsl.rs`, `wsl-process.json` `append`) or the T081 `fileAppend` block (`tests/wsl/workbench-wsl.test.ts`). The plan checks it after 005 merges.

## Research inputs

These facts come from the nspell and wooorm/dictionaries repositories and the npm registry, read on 2026-10-17 and 2026-10-21. They describe those projects, not Arbareto.

- nspell has no push since 2021-01-17. The author wrote "I don't have time/priority to work on nspell" (issue #47).
- nspell lacks COMPOUNDFLAG, COMPOUNDBEGIN, COMPOUNDLAST, and CHECKCOMPOUND*. German has open faults: #47 (lowercase infinitives get marks) and #25 (`add` fails). Very large dictionaries stall it (#49).
- The nspell readme states that dictionaries of different languages cannot be combined in one instance.
- Git Extensions checks the commit message with NetSpell dictionaries, en-US by default, per repository (004 Research inputs).
