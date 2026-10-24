# Quickstart: First Release Validation

Run the local checks first. The GitHub runs need the orchestrator, and the user's OK for each GitHub step.

## Q1. Local contract and Git tests

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun run export:schemas --check`
- `bun test tests/contracts/release-pins.test.ts tests/contracts/release-workflow.test.ts tests/contracts/release-files.test.ts`
- `bun test tests/git/release-check.test.ts`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`
- Expected: all pass. Each test prints its `ORIGIN` line.

## Q2. Local rehearsal of the build job (reference host)

- Use a clean checkout of the branch. `git --no-optional-locks status --porcelain --untracked-files=all` prints nothing.
- `bun scripts/release/check.ts --mode dry-run`
- `bun run build`, then `bun run package:preview:exes`, then `bun run package:preview:bundle`.
- `bun scripts/release/notices-text.ts --out <scratch>`; `bun scripts/release/hunspell-source.ts --out <scratch>` (Local: network); copy the installer into `<scratch>`; `bun scripts/release/sums.ts write <scratch>`; `bun scripts/release/sums.ts verify <scratch>`.
- `bun scripts/release/notes.ts --version 0.1.0 --signing off --out <scratch>`.
- Expected: four release files in `<scratch>`, `verify` exit 0, and `git status` still empty.

## Q3. Control mutations

- Change `package.json` `version` to `0.1.1` in a scratch copy: `check.ts` exits 1 with `RELEASE_CHECK version-mismatch`.
- Add one untracked file: `check.ts` exits 1 with `RELEASE_CHECK dirty`, and a `preview` build fails in `build.rs`.
- Change one byte of the installer copy: `sums.ts verify` exits 1 with `RELEASE_SUMS mismatch`.
- Replace one action SHA with `@v4` in a scratch copy of the workflow: the workflow test fails.

## Q4. Sandbox install

- Copy the installer into the `scripts/windows/clean-install.wsb` share. Install as the Sandbox user. Set `ARBARETO_PROFILE_ROOT` to a scratch folder for app runs on the host.
- Expected: no administrator prompt; Arbareto starts; About shows `0.1.0`, `Preview`, and the commit; "Installed apps" shows "Arbareto"; uninstall removes it.

## Q5. Dry run on GitHub (orchestrator, after the user's OK)

- Push the branch head to `release-dry-run`. The `build` job runs; `publish` is skipped.
- Download the `release-files` artifact. Run `sums.ts verify` on it. Record the run record (image, tool versions, MSVC toolset, SDK) in research.md R7.
- Install the dry-run installer as in Q4.

## Q6. Release (after the public switch, 005 and 006 on `main`)

- Settings (orchestrator): environment `release` with the user as required reviewer and the tag rule `v*`; immutable releases on.
- Tag `v0.1.0` on `main`, push it, approve the `publish` job.
- Expected: a pre-release "Arbareto Preview v0.1.0" with four files, not latest, immutable; `gh attestation verify Arbareto_0.1.0_x64-setup.exe -R auric/arbareto` passes; the About links open without sign-in.
