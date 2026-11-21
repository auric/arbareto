// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T104 stage 1: the heap of `readCommitChanges` on the 100,001-file commit, in the in-process service (spec SC-002, FR-012).
// The heap facts come from `bun:jsc`. The case uses the cached fixture only and skips when the cache lacks it.

import { expect, test } from "bun:test";
import { heapStats, memoryUsage } from "bun:jsc";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commitChangesArgs } from "../../src/git-service/commands";
import { rawListingOffsets } from "../../src/git-service/commit-changes";
import { PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, serviceEnv, useFixtureRoot } from "./fixture-root";
import { copyRepo, runGit, wideLarge } from "./history-diff-fixtures";
import { gitPath, load } from "./history-view-harness";
import { openService } from "./service-harness";

printOrigin("../../src/git-service/commit-changes.ts", import.meta.dir);

useFixtureRoot();

const TIMEOUT_MS = 600_000;
const MIB = 1024 * 1024;
const mib = (bytes: number) => (bytes / MIB).toFixed(1);
// Two full collections, as one can leave objects that a finalizer frees.
const collect = () => {
  Bun.gc(true);
  Bun.gc(true);
};
// `cached` in history-diff-fixtures.ts keeps each build in this folder. Without it, `wideLarge` would build the commit.
const MANIFEST = join(PERF_CACHE_ROOT, "f005-wide-100001", "manifest.json");
const CACHED = existsSync(MANIFEST);
if (!CACHED) console.log(`SKIP T104: the cached 100,001-file fixture is absent: ${MANIFEST}`);
// The scan keeps 100,002 offsets of 4 bytes (0.4 MiB). The v0.1.2 parse kept 47.0 MiB of entry objects (research.md "T104 P0 and stage 1").
const LIVE_PARSE_BYTES = 4 * MIB;

test.skipIf(!CACHED)(
  "OBSERVATION: the heap capacity right after readCommitChanges of the 100,001-file commit, and the heap after a forced collection",
  async () => {
    const cached = wideLarge(gitPath());
    const repo = copyRepo(cached.repo, "t104-memory-repo");
    const service = await openService({ git: gitPath(), name: "t104-memory", watchHints: false, environment: serviceEnv({ GIT_CONFIG_NOSYSTEM: "1" }) });
    try {
      const { repositoryId, generation } = await service.register(repo);
      const context = { repositoryId, repositoryGeneration: generation };
      const viewId = (await service.request<{ viewId: string }>("openHistory", { scope: "all" }, context)).result!.viewId;
      expect((await load(service, repositoryId, viewId, { end: true })).state).toBe("succeeded");
      const clear = () => {
        service.responses.length = 0;
        service.progress.length = 0;
        service.progressAt.length = 0;
      };
      clear();
      collect();
      const before = heapStats();
      const peakBefore = memoryUsage().peakCommit;
      // The harness keeps each response object, so the case drops the result from it.
      const readOnce = async () => {
        const response = await service.request<{ files: unknown[] }>("readCommitChanges", { viewId, oid: cached.oids.wide!, parent: 0 }, context);
        const read = { after: heapStats(), peakAfter: memoryUsage().peakCommit, state: response.state, shown: response.result?.files.length };
        delete response.result;
        return read;
      };
      const { after, peakAfter, state, shown } = await readOnce();
      expect({ state, bounded: shown !== undefined && shown > 0 && shown < 100_001 }).toEqual({ state: "limited", bounded: true });
      clear();
      await Bun.sleep(0);
      collect();
      const settled = heapStats();
      console.log(`OBSERVATION T104 stage 1: readCommitChanges of the 100,001-file commit, ${shown} files shown`);
      console.log(`OBSERVATION T104 stage 1: heapCapacity ${mib(before.heapCapacity)} MiB before, ${mib(after.heapCapacity)} MiB right after the read without a collection`);
      console.log(`OBSERVATION T104 stage 1: heapSize ${mib(before.heapSize)} MiB before, ${mib(after.heapSize)} MiB right after the read, ${mib(settled.heapSize)} MiB after a forced collection`);
      console.log(`OBSERVATION T104 stage 1: objects ${before.objectCount} before, ${after.objectCount} right after the read, ${settled.objectCount} after a forced collection`);
      console.log(`OBSERVATION T104 stage 1: mimalloc peak commit ${mib(peakBefore)} MiB before, ${mib(peakAfter)} MiB after the read, growth ${mib(peakAfter - peakBefore)} MiB`);
    } finally {
      await service.dispose();
    }
  },
  TIMEOUT_MS,
);

test.skipIf(!CACHED)(
  "the parse of the 100,001-record listing keeps far less than the 47.0 MiB object graph of v0.1.2",
  () => {
    const cached = wideLarge(gitPath());
    const repo = copyRepo(cached.repo, "t104-live-repo");
    const raw = new Uint8Array(runGit(gitPath(), FIXTURE_ROOT, repo, commitChangesArgs(cached.oids.base!, cached.oids.wide!, "sha1")));
    collect();
    const before = heapStats();
    const offsets = rawListingOffsets(raw, "sha1", false);
    collect();
    const after = heapStats();
    const heap = after.heapSize - before.heapSize;
    const live = heap + after.extraMemorySize - before.extraMemorySize;
    console.log(`OBSERVATION T104 stage 1: live parse of ${raw.length} listing bytes: heapSize +${mib(heap)} MiB, heapSize and extra memory +${mib(live)} MiB, bound ${mib(LIVE_PARSE_BYTES)} MiB`);
    expect(live).toBeLessThan(LIVE_PARSE_BYTES);
    expect(offsets?.length).toBe(100_002);
  },
  TIMEOUT_MS,
);
