// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T036: the trust class `sync` (plan.md D11, N-1, contract Δ7, FR-009, SC-010).
// A canary program writes a file when it runs. No refused case may write it.

import { expect } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildFetchFlags, gitRun, refMap, type GitHost } from "./remote-fixtures";
import { caseTest, type Service, type TrustResult } from "./service-harness";
import { hostFor, native, register, remoteCalls, reviewed, reviewSync, run, sync, TIMEOUT_MS, withSync } from "./sync-harness";

useFixtureRoot();

const TASK = "T036";
const SHELL = ["shell-double"] as const;
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const SYNC_EVENTS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction", "pre-auto-gc", "pre-push", "pre-merge-commit", "post-merge", "post-checkout", "pre-rebase", "post-rewrite"];

interface Fixture {
  h: GitHost;
  origin: string;
  repo: string;
  canary: string;
  log: string;
}

function fixture(tag: string): Fixture {
  const h = hostFor(tag);
  const f = buildFetchFlags(h);
  const repo = `${h.root}/repo`;
  h.copy(f.clone, repo);
  gitRun(h, repo, ["tag", "-d", "t1"]);
  const log = `${h.root}/canary.log`;
  const canary = `${h.root}/canary.sh`;
  h.write(canary, `#!/bin/sh\necho ran >> '${log}'\nexit 1\n`);
  return { h, origin: f.origin, repo, canary, log };
}

async function approve(service: Service, repositoryId: string, generation: number): Promise<void> {
  const trust = await service.readTrust(repositoryId);
  expect(trust.state).toBe("succeeded");
  expect((await service.approveTrust(repositoryId, trust.result!.fingerprint, generation)).state).toBe("succeeded");
}

describeGit("trust class sync (T036)", () => {
  caseTest(TASK, "each repository-controlled SYNC_EVENTS hook, filter, command fsmonitor, signing program, transport program, merge driver, and protocol entry sets approvalRequired.sync in readTrust, so the review refuses and no canary runs", SHELL, async () => {
    const f = fixture("t036-gate");
    const configPath = `${f.repo}/.git/config`;
    const base = f.h.read(configPath)!;
    const programs: [string, string][] = [
      ["core.sshCommand", f.canary],
      ["core.gitProxy", f.canary],
      ["core.askPass", f.canary],
      ["credential.helper", `!'${f.canary}'`],
      ["credential.http://127.0.0.1.helper", f.canary],
      ["remote.origin.uploadpack", f.canary],
      ["remote.origin.receivepack", f.canary],
      ["protocol.allow", "always"],
      ["protocol.file.allow", "always"],
      ["filter.canary.clean", f.canary],
      ["filter.canary.smudge", f.canary],
      ["filter.canary.process", f.canary],
      ["core.fsmonitor", f.canary],
      ["gpg.program", f.canary],
      ["gpg.ssh.defaultKeyCommand", f.canary],
      // ll-merge.c `ll_ext_merge`: a pull merge runs it (plan.md D11).
      ["merge.x.driver", f.canary],
      // fetch-pack.c `for_each_alternate_ref` runs it in a repository with an alternate (plan.md D11).
      ["core.alternateRefsCommand", f.canary],
      // transport.c `transport_get` runs `git remote-<name>` for these (plan.md D11).
      ["remote.origin.vcs", "canary"],
      ["remote.origin.url", "canary::address"],
      ["remote.origin.url", "foo://x/y"],
      ["remote.origin.pushurl", "canary::address"],
      // Plan.md D11: every `insteadOf` and `pushInsteadOf` entry counts, also with a plain https base and value, and with an empty value.
      ["url.https://mirror.invalid/.insteadOf", "https://example.invalid/"],
      ["url.https://mirror.invalid/.pushInsteadOf", "https://example.invalid/"],
      ["url.canary::address.insteadOf", ""],
    ];
    const syncRequired = async (service: Service, repositoryId: string) => (await service.readTrust(repositoryId)).result!.approvalRequired.sync;
    await withSync("t036-gate", async (service) => {
      const r = await register(service, f.repo);
      expect(outcome(await reviewSync(service, r, { action: "fetch" }))).toEqual({ state: "succeeded", code: undefined });
      expect((await service.readTrust(r.repositoryId)).result!.approvalRequired).toEqual({ reads: false, commit: false, sync: false, workbench: false });
      for (const [key, value] of programs) {
        f.h.write(configPath, base);
        gitRun(f.h, f.repo, ["config", key, value]);
        expect({ key, sync: await syncRequired(service, r.repositoryId) }).toEqual({ key, sync: true });
        const from = service.runner.calls.length;
        for (const action of ["fetch", "fetch-all", "push"]) {
          const response = await reviewSync(service, r, { action });
          expect({ key, action, ...outcome(response) }).toEqual({ key, action, state: "failed", code: "TRUST_REQUIRED" });
        }
        expect({ key, calls: remoteCalls(service, from) }).toEqual({ key, calls: [] });
      }
      // transport.c `transport_get`: Git's own transports and its curl helpers select no remote helper.
      for (const url of ["https://example.invalid/x", "ssh://example.invalid/x", "git://example.invalid/x", "file:///C:/x", "example.invalid:path/x"]) {
        f.h.write(configPath, base);
        gitRun(f.h, f.repo, ["config", "remote.origin.url", url]);
        expect({ url, sync: await syncRequired(service, r.repositoryId) }).toEqual({ url, sync: false });
      }
      f.h.write(configPath, base);
      for (const event of SYNC_EVENTS) {
        const hook = `${f.repo}/.git/hooks/${event}`;
        f.h.write(hook, `#!/bin/sh\nexec '${f.canary}'\n`);
        const response = await reviewSync(service, r, { action: "fetch" });
        expect({ event, ...outcome(response) }).toEqual({ event, state: "failed", code: "TRUST_REQUIRED" });
        rmSync(native(hook));
      }
    });
    expect(existsSync(native(f.log))).toBe(false);
  }, TIMEOUT_MS);

  caseTest(TASK, "core.alternateRefsCommand with an alternate sets approvalRequired.sync; the review refuses and the canary does not run before approval; the approved fetch runs it", SHELL, async () => {
    const f = fixture("t036-alternate");
    const alternate = `${f.h.root}/alternate.git`;
    gitRun(f.h, f.h.root, ["init", "-q", "--bare", "--", alternate]);
    f.h.write(`${f.repo}/.git/objects/info/alternates`, `${native(alternate).replaceAll("\\", "/")}/objects\n`);
    gitRun(f.h, f.repo, ["config", "core.alternateRefsCommand", f.canary]);
    await withSync("t036-alternate", async (service) => {
      const r = await register(service, f.repo);
      expect((await service.readTrust(r.repositoryId)).result!.approvalRequired).toEqual({ reads: false, commit: false, sync: true, workbench: false });
      const from = service.runner.calls.length;
      for (const action of ["fetch", "fetch-all"]) expect({ action, ...outcome(await reviewSync(service, r, { action })) }).toEqual({ action, state: "failed", code: "TRUST_REQUIRED" });
      expect(remoteCalls(service, from)).toEqual([]);
      expect(existsSync(native(f.log))).toBe(false);
      // The positive control: the fixture reaches the command.
      await approve(service, r.repositoryId, r.generation);
      await run(service, r, { action: "fetch" });
      expect(existsSync(native(f.log))).toBe(true);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "sync refuses with TRUST_REQUIRED for a program added after the review, and with TRUST_CHANGED for an approved hook that changed, before any process", SHELL, async () => {
    const f = fixture("t036-sync");
    await withSync("t036-sync", async (service) => {
      const r = await register(service, f.repo);
      let review = await reviewed(service, r, { action: "fetch" });
      gitRun(f.h, f.repo, ["config", "remote.origin.uploadpack", f.canary]);
      let from = service.runner.calls.length;
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(remoteCalls(service, from)).toEqual([]);
      gitRun(f.h, f.repo, ["config", "--unset", "remote.origin.uploadpack"]);

      const hook = `${f.repo}/.git/hooks/pre-push`;
      f.h.write(hook, "#!/bin/sh\nexit 0\n");
      await approve(service, r.repositoryId, r.generation);
      gitRun(f.h, f.repo, ["checkout", "-q", "-b", "feature"]);
      review = await reviewed(service, r, { action: "push", destination: { remote: "origin", branch: "feature", setUpstream: false } });
      f.h.write(hook, `#!/bin/sh\nexec '${f.canary}'\n`);
      from = service.runner.calls.length;
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual({ state: "failed", code: "TRUST_CHANGED" });
      expect(remoteCalls(service, from)).toEqual([]);
    });
    expect(existsSync(native(f.log))).toBe(false);
  }, TIMEOUT_MS);

  caseTest(TASK, "US3 scenario 3: after approval the pre-push hook runs; a hook refusal shows its output and changes no remote ref", SHELL, async () => {
    const f = fixture("t036-hook");
    const ran = `${f.h.root}/pre-push.ran`;
    const hook = `${f.repo}/.git/hooks/pre-push`;
    f.h.write(hook, "#!/bin/sh\necho hook says no >&2\nexit 1\n");
    gitRun(f.h, f.repo, ["checkout", "-q", "-b", "feature"]);
    const origin = refMap(f.h, f.origin);
    await withSync("t036-hook", async (service) => {
      const r = await register(service, f.repo);
      const destination = { remote: "origin", branch: "feature", setUpstream: false };
      expect(outcome(await reviewSync(service, r, { action: "push", destination }))).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      await approve(service, r.repositoryId, r.generation);
      const refused = await run(service, r, { action: "push", destination });
      expect(outcome(refused)).toEqual({ state: "failed", code: "GIT_FAILED" });
      expect(refused.result!.push!.status).toBe("none");
      expect(refused.result!.push!.outputTail).toContain("hook says no");
      expect(refMap(f.h, f.origin)).toEqual(origin);

      f.h.write(hook, `#!/bin/sh\n: > '${ran}'\nexit 0\n`);
      await approve(service, r.repositoryId, r.generation);
      expect(outcome(await run(service, r, { action: "push", destination }))).toEqual({ state: "succeeded", code: undefined });
      expect(existsSync(native(ran))).toBe(true);
      expect(refMap(f.h, f.origin, ["refs/heads/feature"])).toEqual({ "refs/heads/feature": refMap(f.h, f.repo, ["refs/heads/feature"])["refs/heads/feature"] });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "Δ7: readTrust shows only the program of each transport value, a credential shell snippet as <shell command>, and remote.<name>.puttykeyfile, redacted; no secret reaches a response, progress event, or session log, and the fingerprint stays stable", SHELL, async () => {
    const f = fixture("t036-display");
    const values: [string, string][] = [
      ["core.sshCommand", "ssh -o ProxyCommand=http://user:secret@proxy.invalid/x"],
      ["core.gitProxy", "proxy-command for secret.invalid"],
      ["core.askPass", "askpass-program"],
      ["credential.helper", "!f() { echo username=u; echo password=secret; }; f"],
      ["credential.https://user:secret@host.invalid.helper", "cache --timeout=secret"],
      ["credential.https://store.invalid.helper", "store --file=secret.txt"],
      ["remote.origin.uploadpack", "git-upload-pack --secret"],
      ["remote.origin.receivepack", "git-receive-pack"],
      ["remote.origin.puttykeyfile", "C:\\keys\\user.ppk"],
      ["remote.helper.vcs", "cvs"],
      ["remote.helper.url", "hg::https://user:secret@host.invalid/repo"],
      ["remote.scheme.url", "foo://user:secret@host.invalid/repo"],
      ["remote.web.url", "https://user:secret@host.invalid/repo"],
      ["url.https://mirror.invalid/.insteadOf", "https://user:secret@host.invalid/"],
    ];
    for (const [k, v] of values) gitRun(f.h, f.repo, ["config", k, v]);
    await withSync("t036-display", async (service) => {
      const r = await register(service, f.repo);
      const first = await service.readTrust(r.repositoryId);
      expect(first.state).toBe("succeeded");
      const shown = (first.result as TrustResult).entries.filter((e) => e.scope === "local" && e.value !== undefined).map((e) => [e.key, e.value]).sort();
      expect(shown).toEqual(
        [
          ["core.sshcommand", "ssh"],
          ["core.gitproxy", "proxy-command"],
          ["core.askpass", "askpass-program"],
          ["credential.helper", "<shell command>"],
          ["credential.https://<redacted>@host.invalid.helper", "cache"],
          ["credential.https://store.invalid.helper", "store"],
          ["remote.origin.uploadpack", "git-upload-pack"],
          ["remote.origin.receivepack", "git-receive-pack"],
          ["remote.origin.puttykeyfile", "C:\\keys\\user.ppk"],
          ["remote.helper.vcs", "cvs"],
          ["remote.helper.url", "hg"],
          ["remote.scheme.url", "foo"],
        ].sort(),
      );
      // Contract Δ7: an `insteadOf` entry shows its key only.
      const rewrite = (first.result as TrustResult).entries.find((e) => e.key === "url.https://mirror.invalid/.insteadof");
      expect(rewrite).toEqual({ key: "url.https://mirror.invalid/.insteadof", scope: "local", origin: expect.any(String) });
      expect(JSON.stringify(first.result).includes("secret")).toBe(false);
      expect(JSON.stringify([service.responses, service.progress, service.log()]).includes("secret")).toBe(false);
      const second = await service.readTrust(r.repositoryId);
      expect(second.result!.fingerprint).toBe(first.result!.fingerprint);
    });
  }, TIMEOUT_MS);
});
