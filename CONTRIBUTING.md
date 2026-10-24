# Contributing to Arbareto

## Build and test

- Use the commands in the README section [Development](README.md#development). Use no other build or test command.
- Add a command to that section only after it runs green.
- Tests use temporary repositories. Never point a test at a real repository, a shared service, or a live account.

## Feature process

- [GitHub Spec Kit](https://github.com/github/spec-kit) v1.0.12 is the only feature-planning process.
- Each feature has a folder in `specs/`, for example `specs/004-workbench-ux/`. The folder holds `spec.md`, `plan.md`, and `tasks.md`.
- One feature is active at a time. `.specify/feature.json` selects it. Git ignores that file.
- The constitution is in `.specify/memory/constitution.md`.
- [CLAUDE.md](CLAUDE.md) holds the project rules. Follow its rules on Git safety and on decisions from authoritative facts only.

## Commits

- Write commit messages in ASD-STE100 Simple Technical English: short sentences and active voice.
- Start the subject with a type, for example `fix:`, `build:`, or `merge:`. Name the task ID when one exists, for example `(T394)`.
- Do not add AI attribution lines, such as `Co-Authored-By` lines for an AI tool.

## Private string check before a push

- `.githooks/pre-push` refuses a push when a new commit holds a private string. It checks the added lines, the commit message, and the author and committer.
- The built-in rules find user profile paths, home folders, Claude scratch folders, and Arbareto fixture folders. `scripts/private-paths.ts` holds them.
- To enable the hook in your clone, run `git config core.hooksPath .githooks`. The hook needs Bun on `PATH`.
- To add your own rules, write `.git/info/private-patterns`. Put one JavaScript regular expression on each line. The hook skips empty lines and lines that start with `#`.
- In a linked worktree, use the file in the common Git folder that `git rev-parse --git-common-dir` prints.
- For a hit, the hook prints the commit, the path and line, and `<private pattern N>`, where N is the line number in the file. It never prints your pattern text.
- An invalid regular expression refuses the push.

## License of contributions

Arbareto uses the `AGPL-3.0-or-later` license. You license your contribution under the same terms (inbound = outbound). See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

## Claude Code tooling

The project vendors the Claude Code helper skills below. Each skill keeps its upstream license.

### Claude Code helper skills

Installed with the existing `npx skills` v1.5.18 cache, using `add <local-source> --skill <name> --agent claude-code --copy --yes`. Git snapshots came from temporary sparse clones outside this repository. Each project skill contains the complete upstream directory, including supporting files.

| Installed name | Project path | Upstream directory | Source commit | Local adaptations |
| --- | --- | --- | --- | --- |
| `frontend-design` | `.claude/skills/frontend-design/` | [anthropics/skills: skills/frontend-design](https://github.com/anthropics/skills/tree/33375500bcea98d610eb30ce10ac4e59b89c390d/skills/frontend-design) | `33375500bcea98d610eb30ce10ac4e59b89c390d` | None. Reused a byte-identical installed copy. |
| `shadcn` | `.claude/skills/shadcn/` | [shadcn-ui/ui: skills/shadcn](https://github.com/shadcn-ui/ui/tree/db2db460a26fa84fb65c8d903b213925fbdee9ed/skills/shadcn) | `db2db460a26fa84fb65c8d903b213925fbdee9ed` | Changed the embedded runner from `npx` to upstream-supported `bunx --bun`. Included the upstream root `LICENSE.md`. |
| `vercel-react-best-practices` | `.claude/skills/vercel-react-best-practices/` | [vercel-labs/agent-skills: skills/react-best-practices](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/react-best-practices) | `063bee94c3f4df8453406c830b0a7df0f2860278` | Scoped the description and instructions to client-side React. Retained all upstream rules. Added `NOTICE.md`. |
| `web-design-guidelines` | `.claude/skills/web-design-guidelines/` | [vercel-labs/agent-skills: skills/web-design-guidelines](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines) | `063bee94c3f4df8453406c830b0a7df0f2860278` | No guidance changes. Added `NOTICE.md`. |
| `animate` | `.claude/skills/animate/` | [emilkowalski/skills: skills/animate](https://github.com/emilkowalski/skills/tree/main/skills/animate) | Not recorded. `skills-lock.json` holds the content hash `fb0a18403891238d4ce4fc80f891689678766c29092de1e3aadc0c917133ee5d`. | None recorded. The Arbareto motion overrides are in `.claude/skills/arbareto-ux/`. |
| `animation-vocabulary` | `.claude/skills/animation-vocabulary/` | [emilkowalski/skills: skills/animation-vocabulary](https://github.com/emilkowalski/skills/tree/main/skills/animation-vocabulary) | Not recorded. `skills-lock.json` holds the content hash `9aaad861dd54dab7c9bb3fb5bd4c539078d8d06c14530d92d49cdb1509bfa937`. | None recorded. The Arbareto motion overrides are in `.claude/skills/arbareto-ux/`. |
| `find-animation-opportunities` | `.claude/skills/find-animation-opportunities/` | [emilkowalski/skills: skills/find-animation-opportunities](https://github.com/emilkowalski/skills/tree/main/skills/find-animation-opportunities) | Not recorded. `skills-lock.json` holds the content hash `c6673fadf179233cc0a52c978ea9acc9b82a210665c749307a571a86ed4c092e`. | None recorded. The Arbareto motion overrides are in `.claude/skills/arbareto-ux/`. |
| `review-animations` | `.claude/skills/review-animations/` | [emilkowalski/skills: skills/review-animations](https://github.com/emilkowalski/skills/tree/main/skills/review-animations) | Not recorded. `skills-lock.json` holds the content hash `8c2befeb28bb484bf2de7b2fc228774857e266d32a65d76895e78651a536d8cf`. | None recorded. The Arbareto motion overrides are in `.claude/skills/arbareto-ux/`. |

- The reused frontend copy came from the existing `claude-plugins-official/frontend-design/1dd995193ba2` cache. Both files matched the recorded `anthropics/skills` snapshot byte-for-byte.
- Preserved Anthropic's Apache-2.0 license and shadcn's MIT license. Vercel's root README declares MIT but supplies no separate license text. Each Vercel skill includes that declaration in `NOTICE.md`.
- The four `emilkowalski/skills` folders hold no license file. Their MIT license and notice are in `third-party-licenses/agent-skills/emilkowalski-skills/`. Their upstream links point to `main`, because no source commit was recorded.
- Spec Kit v1.0.12 generated the `.specify/` scripts, templates, and workflows and the `.claude/skills/speckit-*` skills. [GitHub licenses Spec Kit under MIT](https://github.com/github/spec-kit/blob/main/LICENSE). [NOTICE.md](NOTICE.md) reproduces the Spec Kit MIT license text. The project-owned `.specify/memory/constitution.md` is not third-party material.
- Restored React's unchanged `metadata.json`, which the installer excludes. Removed the generated lock file because it referenced temporary and machine-specific paths. The table records the upstream revisions.
- Audited pre-execution snippets before installation. The only snippet is `bunx --bun shadcn@latest info --json`. It runs on skill activation and can download the current CLI. No snippet ran during installation.
- Web design reviews fetch upstream guidelines from a moving `main` URL. That external content is not pinned by this snapshot.
- Apply React guidance only to the client. Exclude Next.js, server rendering, hydration, React Server Components, server actions, API routes, and deployment guidance. Keep all upstream references for completeness.

The skill installation added no shadcn initialization, application scaffolding, deployment skills, or additional specification process.

