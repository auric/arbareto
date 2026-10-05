// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The SessionStart hook runs this file with Bun, because a native Windows session has no guaranteed POSIX shell.
// Hook stdout enters the session context.
// Only cloud sessions set CLAUDE_CODE_REMOTE to "true". cloud-setup.sh runs the ponytail-review check there.
if (process.env.CLAUDE_CODE_REMOTE === "true") {
  const setup = Bun.spawn(["bash", `${import.meta.dir}/cloud-setup.sh`], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  process.exit(await setup.exited);
}

// A local session start must never fail or wait longer than the timeout.
try {
  const check = Bun.spawn([process.execPath, `${import.meta.dir}/skills/ponytail-review/update.ts`, "--check"], { stdio: ["ignore", "ignore", "ignore"], env: process.env, timeout: 8000 });
  if ((await check.exited) === 3) console.log("ponytail-review copy is behind upstream: run `bun .claude/skills/ponytail-review/update.ts`, review the SKILL.md diff, and commit.");
} catch {}
process.exit(0);
