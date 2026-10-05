// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The SessionStart hook runs this file with Bun, because a native Windows session has no guaranteed POSIX shell.
// Only cloud sessions set CLAUDE_CODE_REMOTE to "true".
if (process.env.CLAUDE_CODE_REMOTE !== "true") process.exit(0);

const setup = Bun.spawn(["bash", `${import.meta.dir}/cloud-setup.sh`], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
process.exit(await setup.exited);
