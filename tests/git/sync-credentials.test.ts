// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T037: no credential reaches a result, progress event, log entry, remedy, output tail, or shell frame (FR-006, FR-008, SC-005, contract Δ7).
// The T004 HTTP remote takes a password in the URL and, for another remote, a credential helper script from an owned global file.
// The T002 helper is a shell snippet that names the password. A snippet names no program file and needs trust approval, so this test uses a script file.

import { expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { startHttpRemote } from "../support/http-remote";
import { useFixtureRoot } from "./fixture-root";
import { describeGit, fixtureGitPath } from "./git-binary";
import { buildCredentialRemote, fc, gitRun, HTTP_PASSWORD, HTTP_USER, importStream, nativeEnv, urlWithCredential } from "./remote-fixtures";
import { caseTest } from "./service-harness";
import { gitExe, helperGlobal, hostFor, native, register, reviewed, run, sendSync, strings, TIMEOUT_MS, withSync, type SyncResult } from "./sync-harness";

useFixtureRoot();

const TASK = "T037";
const SHELL = ["shell-double"] as const;
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const SUCCEEDED = { state: "succeeded", code: undefined };
const REMEDY_TEXT = "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again.";

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > end) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await Bun.sleep(20);
  }
}

describeGit("credentials stay out of every output (T037)", () => {
  caseTest(TASK, "SC-005: fetch, push, a failed fetch, a canceled fetch, a stall, and a helper sign-in hold no secret bytes and no URL user name; the remedy of a URL with user information is text only; logs hold no URL, remote name, or ref name", SHELL, async () => {
    const h = hostFor("t037-credentials");
    const project = `${h.root}/http`;
    mkdirSync(native(project), { recursive: true });
    const bare = buildCredentialRemote(h, project);
    const clone = `${h.root}/clone`;
    gitRun(h, h.root, ["clone", "-q", "--", bare, clone]);
    const global = helperGlobal(h, HTTP_USER, HTTP_PASSWORD);
    const server = startHttpRemote({ git: fixtureGitPath(gitExe()), projectRoot: project, user: HTTP_USER, password: HTTP_PASSWORD, env: nativeEnv() });
    const operations: unknown[] = [];
    try {
      const url = `${server.url}/cred.git`;
      gitRun(h, clone, ["remote", "set-url", "origin", urlWithCredential(url)]);
      gitRun(h, clone, ["remote", "add", "wrong", urlWithCredential(url, HTTP_USER, "wrong-password")]);
      gitRun(h, clone, ["remote", "add", "helped", url]);
      // git-config(1) `remote.<name>.followRemoteHEAD`: a first fetch would create `refs/remotes/<name>/HEAD`, which no porcelain line names.
      for (const name of ["wrong", "helped"]) gitRun(h, clone, ["config", `remote.${name}.followRemoteHEAD`, "never"]);
      await withSync("t037-credentials", async (service) => {
        const r = await register(service, clone);
        importStream(h, bare, [fc({ mark: 1, ref: "refs/heads/later", message: "later\n", files: { "later.txt": "later\n" } })]);
        expect(outcome(await run(service, r, { action: "fetch" }))).toEqual(SUCCEEDED);
        expect(outcome(await run(service, r, { action: "fetch", remote: "helped" }))).toEqual(SUCCEEDED);

        gitRun(h, clone, ["checkout", "-q", "-b", "feature"]);
        gitRun(h, clone, ["commit", "-q", "--allow-empty", "-m", "feature"]);
        const review = await reviewed(service, r, { action: "push", destination: { remote: "origin", branch: "feature", setUpstream: false } });
        expect(review.plan.destination!.url).toBe(url.replace("http://", `http://<redacted>@`));
        const pushed = await service.response<SyncResult>(sendSync(service, r, review.syncReviewToken));
        expect(outcome(pushed)).toEqual(SUCCEEDED);

        const failed = await run(service, r, { action: "fetch", remote: "wrong" });
        expect(outcome(failed)).toEqual({ state: "failed", code: "GIT_FAILED" });
        expect(failed.result!.fetch!.remotes[0]!.outputTail).not.toBe("");
        expect(failed.result!.remedy).toEqual({ text: REMEDY_TEXT, command: null });

        // A cancel during a paused answer, then a stall of a paused answer.
        server.pause();
        let served = server.requests();
        let requestId = sendSync(service, r, (await reviewed(service, r, { action: "fetch" })).syncReviewToken);
        await until(() => server.requests() > served, "a paused request");
        await service.cancel(await service.operationId(requestId));
        expect(outcome(await service.response(requestId))).toEqual({ state: "canceled", code: "CANCELED" });

        service.runner.inject.limits = { stallMs: 300 };
        served = server.requests();
        requestId = sendSync(service, r, (await reviewed(service, r, { action: "fetch" })).syncReviewToken);
        const operationId = await service.operationId(requestId);
        await until(() => (service.progress as { requestId?: string; stalled?: boolean }[]).some((p) => p.requestId === requestId && p.stalled === true), "stalled event");
        const stalled = await service.getOperation(operationId);
        operations.push(stalled.result);
        expect((stalled.result as { stallRemedy?: unknown }).stallRemedy).toEqual({ text: REMEDY_TEXT });
        await service.cancel(operationId);
        await service.response(requestId);
        service.runner.inject.limits = {};
        server.resume();

        const everything = [service.responses, service.progress, service.log(), operations, service.runner.frames];
        const texts = strings(everything);
        for (const secret of [HTTP_PASSWORD, HTTP_USER, "wrong-password"]) expect({ secret, found: texts.filter((t) => t.includes(secret)) }).toEqual({ secret, found: [] });
        const logTexts = strings(service.log());
        for (const name of ["http", "127.0.0.1", "origin", "helped", "wrong", "refs/", "cred.git"]) expect({ name, found: logTexts.filter((t) => t.includes(name)) }).toEqual({ name, found: [] });
      }, { environment: nativeEnv({ GIT_CONFIG_GLOBAL: global }) });
    } finally {
      await server.stop();
    }
  }, TIMEOUT_MS);
});
