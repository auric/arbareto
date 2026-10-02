# Arbareto

Cross-platform, local-first Git client. Deliver and qualify Windows first; target macOS and Linux later. See [the project brief](docs/project-brief.md) for scope and architecture.

Name: see [docs/name.md](docs/name.md).

## Tooling

Spec Kit v1.0.12 remains the only feature-planning process. No application dependencies or shadcn project configuration exist yet.

### Claude Code helper skills

Installed with the existing `npx skills` v1.5.18 cache, using `add <local-source> --skill <name> --agent claude-code --copy --yes`. Git snapshots came from temporary sparse clones outside this repository. Each project skill contains the complete upstream directory, including supporting files.

| Installed name | Project path | Upstream directory | Source commit | Local adaptations |
| --- | --- | --- | --- | --- |
| `frontend-design` | `.claude/skills/frontend-design/` | [anthropics/skills: skills/frontend-design](https://github.com/anthropics/skills/tree/33375500bcea98d610eb30ce10ac4e59b89c390d/skills/frontend-design) | `33375500bcea98d610eb30ce10ac4e59b89c390d` | None. Reused a byte-identical installed copy. |
| `shadcn` | `.claude/skills/shadcn/` | [shadcn-ui/ui: skills/shadcn](https://github.com/shadcn-ui/ui/tree/db2db460a26fa84fb65c8d903b213925fbdee9ed/skills/shadcn) | `db2db460a26fa84fb65c8d903b213925fbdee9ed` | Changed the embedded runner from `npx` to upstream-supported `bunx --bun`. Included the upstream root `LICENSE.md`. |
| `vercel-react-best-practices` | `.claude/skills/vercel-react-best-practices/` | [vercel-labs/agent-skills: skills/react-best-practices](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/react-best-practices) | `063bee94c3f4df8453406c830b0a7df0f2860278` | Scoped the description and instructions to client-side React. Retained all upstream rules. Added `NOTICE.md`. |
| `web-design-guidelines` | `.claude/skills/web-design-guidelines/` | [vercel-labs/agent-skills: skills/web-design-guidelines](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines) | `063bee94c3f4df8453406c830b0a7df0f2860278` | No guidance changes. Added `NOTICE.md`. |

- The reused frontend copy came from the existing `claude-plugins-official/frontend-design/1dd995193ba2` cache. Both files matched the recorded `anthropics/skills` snapshot byte-for-byte.
- Preserved Anthropic's Apache-2.0 license and shadcn's MIT license. Vercel's root README declares MIT but supplies no separate license text. Each Vercel skill includes that declaration in `NOTICE.md`.
- Spec Kit v1.0.12 generated the `.specify/` scripts, templates, and workflows and the `.claude/skills/speckit-*` skills. [GitHub licenses Spec Kit under MIT](https://github.com/github/spec-kit/blob/main/LICENSE). [NOTICE.md](NOTICE.md) reproduces the Spec Kit MIT license text. The project-owned `.specify/memory/constitution.md` is not third-party material.
- Restored React's unchanged `metadata.json`, which the installer excludes. Removed the generated lock file because it referenced temporary and machine-specific paths. The table records the upstream revisions.
- Audited pre-execution snippets before installation. The only snippet is `bunx --bun shadcn@latest info --json`. It runs on skill activation and can download the current CLI. No snippet ran during installation.
- Web design reviews fetch upstream guidelines from a moving `main` URL. That external content is not pinned by this snapshot.
- Apply React guidance only to the client. Exclude Next.js, server rendering, hydration, React Server Components, server actions, API routes, and deployment guidance. Keep all upstream references for completeness.

No shadcn initialization, application scaffolding, deployment skills, or additional specification process was added.

## Development

Run these commands from the repository root. Run `bun run build` before `cargo check`, because the Tauri build needs the frontend and the service binary.

- `bun install --frozen-lockfile`
- `bun run build`
- `bun run typecheck`
- `bun run test:contracts`
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`

## License

Arbareto is free software under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). See [LICENSE](LICENSE). [NOTICE.md](NOTICE.md) states the copyright and the section 7 additional terms. These terms require attribution and marked, renamed modified versions. They grant no trademark rights to the name "Arbareto". Third-party material listed above keeps its own license.
