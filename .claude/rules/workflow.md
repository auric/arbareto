This file is the cloud copy of the user's global rules. Locally, the user's global `CLAUDE.md` stays the master.

# Workflow rules

## Docs and comments: ASD-STE100, compact, no hard wraps

- Write all documentation, PR notes, help texts, commit messages, and code comments in ASD-STE100 Simple Technical English: short sentences (max 20 words), active voice, one instruction per sentence, no narration.
- Code comments state only constraints the code cannot show (ABI facts, safety rules, caps). Never narrate what the next line does or why a change is correct.
- Paste documents (PR notes, review replies, issue comments): no hard line wrapping. One bullet or paragraph is one physical line. Keep paste docs much shorter than internal docs.
- Review replies, PR notes, and final messages: give the direct answer first, in plain words. Then give at most three supporting facts. Cite a file:line or a number only when the reader must go there.
- Changelogs list only changes a user of the tool sees. One PR is one version section. Never record internal version history, review rounds, or test runs.
- Repo-committed files that already wrap (upstream READMEs, existing contracts) keep their surrounding file convention.

## Repos and tests

- Tests never touch a live or shared database, cache, or service. Use a dedicated test instance, and check the target before the first run.
- Never commit an executable binary (exe, dll, sys, so). Inert data fixtures are fine. A test that needs a real binary finds it at test time and skips when it is absent.
- After a dependency change, regenerate every lock file that CI checks, and commit them together.
- A green run from a worktree or a mutation copy proves nothing until it prints where the code under test was imported from. One control mutation must also turn it red.
- If a checkout holds uncommitted work you did not make, do not switch, edit, or build there.

## Subagent policy: the main session orchestrates, subagents execute

- The main session is orchestrator and validator only. Every implementation, investigation, check, lookup, and operational step goes to a subagent.
- The main session does only this inline: write dispatch prompts, read subagent reports, review diffs (`git diff`, `git status`, `git log`), decide, commit, and write the final message.
- Pick the effort by picking the agent. An `Agent` call cannot set effort. The project agents in `.claude/agents/` pin model and effort:
  - Implementation: `implementer` (Opus, medium) by default. Use `implementer-xhigh` for known-hard packages or to retry a failed medium run. Use `implementer-max` only to retry a failed xhigh run. Run one implementer at a time.
  - Frontend React and Vite work: `frontend-implementer` (Opus, medium). It preloads `vercel-react-best-practices` and `web-design-guidelines`.
  - Batch and diff review: `reviewer` (Opus, medium, read-only). It runs `code-review` and `security-review` in report-only mode.
  - Implementation plans and design: `Plan` (Opus, xhigh, read-only).
  - Root-cause analysis (crash analysis, bug diagnosis, repro design, fix proposal, review verification): `investigator` (Opus, medium, no edits to tracked files).
  - Code exploration, doc research, triage, data gathering, and operational runs that need judgment: `scout` (Opus, low). A shallow `scout` report goes to `investigator` when it needs analysis.
  - Broad read-only code search: `Explore` (Opus, low, read-only).
  - Mechanical steps and simple lookups (run a given command, fetch, grep, watch a log): `runner` (Haiku).
- Do not launch the built-in `general-purpose`, `claude`, or `fork` agents. They inherit the main model and the session effort.
- Never send a "why does this fail" question to `scout`, `Explore`, or `runner`.
- Never pass `model` to a pinned agent. A per-call `model` replaces the pinned model and breaks the pinned effort.
- Never export `CLAUDE_CODE_EFFORT_LEVEL`. It overrides the agent `effort:` field.
- The pinned agents carry the standing rules: no git mutation, no live or shared database, no service restarts unless the task is exactly that, and the report format. Each dispatch prompt adds only the task-specific rules.

## Local only

- The RTK command rewrite hook, the CodeGraph index, the model choice for the main session, user memory, and plugin skills exist only on the user's machine. Cloud sessions skip these rules.
