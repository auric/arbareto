// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { decodeRequest } from "../../src/contracts/envelope";
import { HISTORY_ROWS_PER_REQUEST, HISTORY_VIEW_COMMITS, PIPE_FRAME_BYTES, STATUS_PAGE_BYTES } from "../../src/contracts/limits";
import { isWindows } from "../../src/contracts/native-path";
import { OPERATIONS } from "../../src/contracts/operations";

printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/native-path.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);

type Side = "renderer" | "service";
type Json = Record<string, unknown>;

const MIB = 1024 * 1024;
const id = () => crypto.randomUUID();
const FINGERPRINT = "a".repeat(64);
const GIT_PATH = isWindows ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const CLONE_DESTINATION = isWindows ? "D:\\src\\tool" : "/src/tool";

// Contract §3 names the payload values. Field names that the contract does not fix are test choices.
const PAYLOADS: Record<string, { renderer?: () => Json; service?: () => Json }> = {
  getEnvironment: { renderer: () => ({}), service: () => ({}) },
  chooseGit: { renderer: () => ({}), service: () => ({ bootstrapId: id(), executablePath: GIT_PATH }) },
  chooseRepository: { renderer: () => ({}), service: () => ({ bootstrapId: id() }) },
  restoreWorkspace: { renderer: () => ({}), service: () => ({ bootstrapId: id() }) },
  readWorkspace: {
    renderer: () => ({ refresh: false, check: "full" }),
    service: () => ({ refresh: false, check: "full" }),
  },
  readEntries: {
    renderer: () => ({ snapshotId: id(), cursor: id() }),
    service: () => ({ snapshotId: id(), cursor: id() }),
  },
  readRefs: { renderer: () => ({}), service: () => ({}) },
  // Feature 002 contract Δ3.
  openHistory: { renderer: () => ({ scope: "all" }), service: () => ({ scope: "all" }) },
  loadHistory: { renderer: () => ({ viewId: id(), need: { row: 40 } }), service: () => ({ viewId: id(), need: { row: 40 } }) },
  readHistoryRows: {
    renderer: () => ({ viewId: id(), mode: "full", at: { row: 0 }, count: 128, text: "rows" }),
    service: () => ({ viewId: id(), mode: "full", at: { row: 0 }, count: 128, text: "rows" }),
  },
  searchHistory: { renderer: () => ({ viewId: id(), text: "fix" }), service: () => ({ viewId: id(), text: "fix" }) },
  closeHistory: { renderer: () => ({ viewId: id() }), service: () => ({ viewId: id() }) },
  readComparison: {
    renderer: () => ({ snapshotId: id(), entryId: id() }),
    service: () => ({ snapshotId: id(), entryId: id() }),
  },
  readTrust: { renderer: () => ({}), service: () => ({}) },
  approveTrust: {
    renderer: () => ({ action: "commit" }),
    service: () => ({ action: "commit" }),
  },
  revokeTrust: { renderer: () => ({ trustId: id() }), service: () => ({ trustId: id() }) },
  applyHunk: {
    renderer: () => ({ comparisonId: id(), hunkId: id(), snapshotId: id(), direction: "stage" }),
    service: () => ({ comparisonId: id(), hunkId: id(), snapshotId: id(), direction: "stage" }),
  },
  applyFile: {
    renderer: () => ({ comparisonId: id(), snapshotId: id(), direction: "stage" }),
    service: () => ({ comparisonId: id(), snapshotId: id(), direction: "stage" }),
  },
  reviewCommit: { renderer: () => ({ snapshotId: id() }), service: () => ({ snapshotId: id() }) },
  commit: {
    renderer: () => ({ reviewToken: id(), message: "Fix parser", confirmFullScope: true }),
    service: () => ({ reviewToken: id(), message: "Fix parser", confirmFullScope: true }),
  },
  reviewSubmodules: { renderer: () => ({ snapshotId: id() }), service: () => ({ snapshotId: id() }) },
  updateSubmodules: {
    renderer: () => ({ submoduleReviewToken: id(), start: true }),
    service: () => ({ submoduleReviewToken: id(), start: true }),
  },
  cancel: { renderer: () => ({ operationId: id() }), service: () => ({ operationId: id() }) },
  getOperation: { renderer: () => ({ operationId: id() }), service: () => ({ operationId: id() }) },
  requestClose: { renderer: () => ({ choice: "stay" }) },
  currentSession: { renderer: () => ({}) },
  dismissRecoveryMarker: {
    renderer: () => ({ markerId: id() }),
    service: () => ({ markerId: id(), bootstrapId: id() }),
  },
  // Contract §3 "Recent repositories": the shell answers each one, or forwards an open as `restoreWorkspace`.
  listRecentRepositories: { renderer: () => ({}) },
  openRecentRepository: { renderer: () => ({ entryId: id() }) },
  removeRecentRepository: { renderer: () => ({ entryId: id() }) },
  // Feature 003 contract Δ1 and Δ3.
  readTracking: { renderer: () => ({}), service: () => ({}) },
  reviewSync: { renderer: () => ({ action: "fetch" }), service: () => ({ action: "fetch" }) },
  sync: { renderer: () => ({ syncReviewToken: id(), start: true }), service: () => ({ syncReviewToken: id(), start: true }) },
  clone: {
    renderer: () => ({ url: "https://example.test/team/tool.git", destination: CLONE_DESTINATION, keyFile: "none" }),
    service: () => ({ url: "https://example.test/team/tool.git", bootstrapId: id(), cloneId: id() }),
  },
  connectInTerminal: { renderer: () => ({ operationId: id() }), service: () => ({ operationId: id() }) },
  readSyncSettings: { renderer: () => ({}) },
  setSshClient: { renderer: () => ({ kind: "plink" }) },
  setDefaultPullAction: { renderer: () => ({ action: "pull-rebase" }) },
  chooseSyncPath: { renderer: () => ({ target: "plink" }) },
  clearSyncPath: { renderer: () => ({ target: "remoteKey", worktreeKey: FINGERPRINT, remote: "origin" }) },
  launchPuttygen: { renderer: () => ({}) },
  // Feature 004 contract Δ1 and Δ3.
  readBranches: { renderer: () => ({}), service: () => ({}) },
  readWorktrees: { renderer: () => ({}), service: () => ({}) },
  readGitSettings: { renderer: () => ({}), service: () => ({}) },
  reviewWorkbench: {
    renderer: () => ({ action: "worktree-add", branch: { existing: "refs/heads/topic" }, path: CLONE_DESTINATION }),
    service: () => ({ action: "worktree-add", branch: { existing: "refs/heads/topic" }, bootstrapId: id() }),
  },
  runWorkbench: { renderer: () => ({ workbenchToken: id(), start: true }), service: () => ({ workbenchToken: id(), start: true }) },
  applyFiles: {
    renderer: () => ({ snapshotId: id(), entryIds: [id()], direction: "stage", kind: "selected" }),
    service: () => ({ snapshotId: id(), entryIds: [id()], direction: "stage", kind: "selected" }),
  },
  openWorktree: { renderer: () => ({ repositoryId: id(), path: CLONE_DESTINATION }), service: () => ({ repositoryId: id(), bootstrapId: id() }) },
  revealPath: { renderer: () => ({ repositoryId: id(), entryId: id() }), service: () => ({ repositoryId: id(), entryId: id() }) },
  setSwitchChoice: { renderer: () => ({ choice: "stash" }) },
  chooseWorktreeFolder: { renderer: () => ({ repositoryId: id() }) },
  // Feature 006 contract Δ1 and Δ3.
  listDictionaries: { renderer: () => ({}), service: () => ({}) },
  readDictionary: { renderer: () => ({ language: "uk", file: "index.dic", offset: 0 }), service: () => ({ language: "uk", file: "index.dic", offset: 0 }) },
  downloadDictionary: { renderer: () => ({ language: "uk" }), service: () => ({ language: "uk" }) },
  importDictionary: { renderer: () => ({ language: "uk" }), service: () => ({ language: "uk", folder: CLONE_DESTINATION }) },
  removeDictionary: { renderer: () => ({ language: "uk" }), service: () => ({ language: "uk" }) },
  setSpelling: { renderer: () => ({ enabled: true, languages: ["en", "uk"] }) },
  openLicenceLink: { renderer: () => ({ language: "en" }) },
};

const NAMES = Object.keys(PAYLOADS);

const GENERATION_REQUIRED = [
  "readEntries",
  "openHistory",
  "readRefs",
  "readComparison",
  "applyHunk",
  "applyFile",
  "reviewCommit",
  "commit",
  "reviewSubmodules",
  "updateSubmodules",
  "readTracking",
  "reviewSync",
  "readBranches",
  "readWorktrees",
  "reviewWorkbench",
];
const GENERATION_ABSENT = NAMES.filter((n) => !GENERATION_REQUIRED.includes(n) && n !== "readWorkspace");

const REPOSITORY_BOUND = [
  "readWorkspace",
  "readEntries",
  "openHistory",
  "loadHistory",
  "readHistoryRows",
  "searchHistory",
  "closeHistory",
  "readRefs",
  "readComparison",
  "readTrust",
  "approveTrust",
  "revokeTrust",
  "applyHunk",
  "applyFile",
  "reviewCommit",
  "commit",
  "reviewSubmodules",
  "updateSubmodules",
  "readTracking",
  "reviewSync",
  "sync",
  "readBranches",
  "readWorktrees",
  "reviewWorkbench",
  "runWorkbench",
  "applyFiles",
];
// Feature 003 data-model §11: a sync target names its repository, and a clone target without a workspace names none.
// Feature 004 contract Δ3 `readGitSettings`: without `repositoryId`, the read runs in the `globalConfig` context.
const REPOSITORY_OPTIONAL = ["connectInTerminal", "readGitSettings"];

function envelope(operation: string, side: Side = "renderer", payload?: Json): Json {
  const make = PAYLOADS[operation]?.[side];
  const request: Json = {
    version: 1,
    requestId: id(),
    operation,
    payload: payload ?? (make ? make() : {}),
  };
  if (operation !== "currentSession") request.sessionId = id();
  if (REPOSITORY_BOUND.includes(operation)) request.repositoryId = id();
  if (GENERATION_REQUIRED.includes(operation)) request.repositoryGeneration = 3;
  if (operation === "readComparison") request.selectionId = id();
  return request;
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: unknown, side: Side = "renderer") => decodeRequest(encode(value), side);

function expectCode(value: unknown, code: string, side: Side = "renderer") {
  const result = decode(value, side);
  expect(result.ok).toBe(false);
  if (!result.ok) expect<string>(result.code).toBe(code);
}

function expectAccepted(value: unknown, side: Side = "renderer") {
  const result = decode(value, side);
  expect(result).toMatchObject({ ok: true });
}

const sidesOf = (name: string) =>
  (["renderer", "service"] as const).filter((side) => PAYLOADS[name][side] !== undefined);

describe("operation list", () => {
  // Feature 002 plan.md P7 retires the contract §3 `readHistory`.
  test("holds exactly the 25 remaining contract §3 operations, the 5 feature 002 contract Δ3 operations, the 11 feature 003 contract Δ1 operations, the 10 feature 004 contract Δ1 operations, and the 7 feature 006 contract Δ1 operations", () => {
    expect([...OPERATIONS].sort()).toEqual([...NAMES].sort());
    expect(OPERATIONS.length).toBe(58);
  });

  for (const name of NAMES) {
    for (const side of sidesOf(name)) {
      test(`valid ${name} decodes on the ${side} side`, () => {
        const result = decode(envelope(name, side), side);
        expect(result.ok).toBe(true);
        if (result.ok) expect<string>(result.request.operation).toBe(name);
      });
    }
  }
});

describe("version", () => {
  test.each([[2], [0], ["1"], [true], [null], [1.5], [-1]])("version %j gives PROTOCOL_VERSION", (version) =>
    expectCode({ ...envelope("getEnvironment"), version }, "PROTOCOL_VERSION"),
  );
  // Contract §2: `version` is the integer `1`, so its literal has no fraction and no exponent.
  const withVersion = (literal: string) => {
    const text = JSON.stringify(envelope("getEnvironment")).replace('"version":1,', `"version":${literal},`);
    expect(text).toContain(`"version":${literal},`);
    return decodeRequest(new TextEncoder().encode(text), "renderer");
  };
  test.each([["1.0"], ["1e0"], ["1.00"], ["10e-1"], ["1E0"]])("version %s gives PROTOCOL_VERSION", (literal) =>
    expect(withVersion(literal)).toEqual({ ok: false, code: "PROTOCOL_VERSION" }),
  );
  test("version 1 decodes", () => expect(withVersion("1")).toMatchObject({ ok: true }));
});

const BAD_IDS = [
  "not-a-uuid",
  id().replaceAll("-", ""),
  `{${id()}}`,
  `${id()}-0`,
  "0".repeat(65),
  id().replace(/[0-9]/, "\uFF11"),
  id().slice(0, 35) + "\u00e9",
  "",
  "C:\\Git\\cmd\\git.exe",
  "..\\..\\Windows",
  "../../etc/passwd",
  "HEAD~1",
  "refs/heads/main",
  "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n",
];

describe("identifiers", () => {
  test.each(BAD_IDS.map((v) => [v]))("requestId %j gives INVALID_REQUEST", (requestId) =>
    expectCode({ ...envelope("getEnvironment"), requestId }, "INVALID_REQUEST"),
  );
  test.each(BAD_IDS.map((v) => [v]))("sessionId %j gives INVALID_REQUEST", (sessionId) =>
    expectCode({ ...envelope("getEnvironment"), sessionId }, "INVALID_REQUEST"),
  );
  test.each(BAD_IDS.map((v) => [v]))("snapshotId %j gives INVALID_REQUEST", (snapshotId) =>
    expectCode(envelope("reviewCommit", "renderer", { snapshotId }), "INVALID_REQUEST"),
  );
  test.each(BAD_IDS.map((v) => [v]))("operationId %j gives INVALID_REQUEST", (operationId) =>
    expectCode(envelope("getOperation", "renderer", { operationId }), "INVALID_REQUEST"),
  );
  test.each([[1], [null], [[id()]], [{ id: id() }]])("non-string requestId %j gives INVALID_REQUEST", (requestId) =>
    expectCode({ ...envelope("getEnvironment"), requestId }, "INVALID_REQUEST"),
  );
});

describe("operation names", () => {
  test.each([
    ["deleteBranch"],
    ["read_workspace"],
    ["ReadWorkspace"],
    ["readworkspace"],
    [""],
    ["__proto__"],
    ["toString"],
    ["constructor"],
    [" readWorkspace"],
    // Feature 002 plan.md P7: the 001 operation is retired.
    ["readHistory"],
  ])("operation %j gives UNKNOWN_OPERATION", (operation) =>
    expectCode({ ...envelope("getEnvironment"), operation }, "UNKNOWN_OPERATION"),
  );

  test.each([["requestClose"], ["currentSession"]])("%s on the service side gives UNKNOWN_OPERATION", (name) =>
    expectCode(envelope(name, "renderer"), "UNKNOWN_OPERATION", "service"),
  );
});

describe("sessionId", () => {
  test("currentSession without sessionId decodes", () => expectAccepted(envelope("currentSession")));
  test("currentSession with sessionId gives INVALID_REQUEST", () =>
    expectCode({ ...envelope("currentSession"), sessionId: id() }, "INVALID_REQUEST"));

  for (const name of NAMES.filter((n) => n !== "currentSession")) {
    for (const side of sidesOf(name)) {
      test(`${name} without sessionId gives INVALID_REQUEST on the ${side} side`, () => {
        const { sessionId: _omit, ...rest } = envelope(name, side);
        expectCode(rest, "INVALID_REQUEST", side);
      });
    }
  }
});

describe("repositoryGeneration", () => {
  for (const name of GENERATION_REQUIRED) {
    test(`${name} without repositoryGeneration gives INVALID_REQUEST`, () => {
      const { repositoryGeneration: _omit, ...rest } = envelope(name);
      expectCode(rest, "INVALID_REQUEST");
    });
    test(`${name} with repositoryGeneration 0 decodes`, () =>
      expectAccepted({ ...envelope(name), repositoryGeneration: 0 }));
  }

  test("readWorkspace decodes with and without repositoryGeneration", () => {
    expectAccepted(envelope("readWorkspace"));
    expectAccepted({ ...envelope("readWorkspace"), repositoryGeneration: 7 });
  });

  for (const name of GENERATION_ABSENT) {
    test(`${name} with repositoryGeneration gives INVALID_REQUEST`, () =>
      expectCode({ ...envelope(name), repositoryGeneration: 1 }, "INVALID_REQUEST"));
  }

  test.each([[-1], [1.5], ["1"], [null], [true]])("repositoryGeneration %j gives INVALID_REQUEST", (value) =>
    expectCode({ ...envelope("openHistory"), repositoryGeneration: value }, "INVALID_REQUEST"),
  );
  test("repositoryGeneration above the safe range gives INVALID_REQUEST", () => {
    const text = JSON.stringify(envelope("openHistory")).replace('"repositoryGeneration":3', '"repositoryGeneration":9007199254740992');
    const result = decodeRequest(new TextEncoder().encode(text), "renderer");
    expect(result).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });
});

describe("selectionId", () => {
  test("readComparison without selectionId gives INVALID_REQUEST", () => {
    const { selectionId: _omit, ...rest } = envelope("readComparison");
    expectCode(rest, "INVALID_REQUEST");
  });

  for (const name of NAMES.filter((n) => n !== "readComparison")) {
    for (const side of sidesOf(name)) {
      test(`${name} with selectionId gives INVALID_REQUEST on the ${side} side`, () =>
        expectCode({ ...envelope(name, side), selectionId: id() }, "INVALID_REQUEST", side));
    }
  }

  test.each(BAD_IDS.map((v) => [v]))("selectionId %j gives INVALID_REQUEST", (selectionId) =>
    expectCode({ ...envelope("readComparison"), selectionId }, "INVALID_REQUEST"),
  );
});

describe("repositoryId", () => {
  for (const name of REPOSITORY_BOUND) {
    test(`${name} without repositoryId gives INVALID_REQUEST`, () => {
      const { repositoryId: _omit, ...rest } = envelope(name);
      expectCode(rest, "INVALID_REQUEST");
    });
  }

  for (const name of NAMES.filter((n) => !REPOSITORY_BOUND.includes(n) && !REPOSITORY_OPTIONAL.includes(n))) {
    for (const side of sidesOf(name)) {
      test(`${name} with repositoryId gives INVALID_REQUEST on the ${side} side`, () =>
        expectCode({ ...envelope(name, side), repositoryId: id() }, "INVALID_REQUEST", side));
    }
  }

  for (const name of REPOSITORY_OPTIONAL) {
    for (const side of sidesOf(name)) {
      test(`${name} decodes with and without repositoryId on the ${side} side`, () => {
        expectAccepted(envelope(name, side), side);
        expectAccepted({ ...envelope(name, side), repositoryId: id() }, side);
        expectCode({ ...envelope(name, side), repositoryId: "x" }, "INVALID_REQUEST", side);
      });
    }
  }

  test("a readTrust payload with repositoryId gives INVALID_REQUEST", () =>
    expectCode(envelope("readTrust", "renderer", { repositoryId: id() }), "INVALID_REQUEST"));
});

// Feature 004 contract Δ7: the payload names one contract Δ6 action and no fingerprint.
describe("approveTrust action", () => {
  test.each([["clone"], [""], ["Commit"], [1], [null]])("action %j gives INVALID_REQUEST", (action) =>
    expectCode(envelope("approveTrust", "renderer", { action }), "INVALID_REQUEST"),
  );
  test("the feature 001 payload with a fingerprint gives INVALID_REQUEST", () => {
    expectCode(envelope("approveTrust", "renderer", { fingerprint: FINGERPRINT, approve: true }), "INVALID_REQUEST");
    expectCode(envelope("approveTrust", "renderer", { action: "commit", fingerprint: FINGERPRINT }), "INVALID_REQUEST");
  });
});

describe("explicit approval fields", () => {
  const cases: Array<[string, string]> = [
    ["commit", "confirmFullScope"],
    ["updateSubmodules", "start"],
    ["sync", "start"],
    ["runWorkbench", "start"],
  ];
  for (const [name, field] of cases) {
    test.each([[false], ["true"], [1], [null]])(`${name} ${field} %j gives INVALID_REQUEST`, (value) => {
      const request = envelope(name);
      expectCode({ ...request, payload: { ...(request.payload as Json), [field]: value } }, "INVALID_REQUEST");
    });
    test(`${name} without ${field} gives INVALID_REQUEST`, () => {
      const request = envelope(name);
      const payload = { ...(request.payload as Json) };
      delete payload[field];
      expectCode({ ...request, payload }, "INVALID_REQUEST");
    });
  }
});

describe("unknown and forbidden fields", () => {
  for (const name of NAMES) {
    for (const side of sidesOf(name)) {
      test(`${name} with an unknown payload field gives INVALID_REQUEST on the ${side} side`, () => {
        const request = envelope(name, side);
        expectCode({ ...request, payload: { ...(request.payload as Json), extra: 1 } }, "INVALID_REQUEST", side);
      });
    }
  }

  test("an unknown envelope field gives INVALID_REQUEST", () =>
    expectCode({ ...envelope("getEnvironment"), extra: 1 }, "INVALID_REQUEST"));
  test("a renderer envelope with kind gives INVALID_REQUEST", () =>
    expectCode({ ...envelope("getEnvironment"), kind: "public" }, "INVALID_REQUEST"));
  test("a missing payload gives INVALID_REQUEST", () => {
    const { payload: _omit, ...rest } = envelope("getEnvironment");
    expectCode(rest, "INVALID_REQUEST");
  });
  test.each([[null], [[]], ["{}"], [1]])("payload %j gives INVALID_REQUEST", (payload) =>
    expectCode({ ...envelope("getEnvironment"), payload }, "INVALID_REQUEST"),
  );

  test.each([
    ["gitPath", "C:\\Program Files\\Git\\cmd\\git.exe"],
    ["executable", "C:\\Windows\\System32\\cmd.exe"],
    ["patch", "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"],
    ["ref", "HEAD~1"],
    ["revspec", "main..HEAD"],
    ["path", "..\\..\\Windows\\win.ini"],
    ["env", { GIT_DIR: "C:\\x" }],
    ["command", "git status"],
    ["pid", 4],
    ["pattern", "refs/heads/*"],
    ["format", "%(refname)"],
  ])("payload field %s gives INVALID_REQUEST", (field, value) => {
    for (const name of ["readComparison", "applyHunk", "applyFile", "commit", "openHistory", "readRefs"]) {
      const request = envelope(name);
      expectCode({ ...request, payload: { ...(request.payload as Json), [field]: value } }, "INVALID_REQUEST");
    }
  });

  test.each([
    ["C:\\Program Files\\Git\\cmd\\git.exe"],
    ["diff --git a/x b/x\n@@ -1 +1 @@\n"],
    ["HEAD"],
    ["refs/heads/main"],
    ["..\\..\\x"],
    ["../x"],
  ])("hunkId %j gives INVALID_REQUEST", (hunkId) => {
    const request = envelope("applyHunk");
    expectCode({ ...request, payload: { ...(request.payload as Json), hunkId } }, "INVALID_REQUEST");
  });
});

describe("frame limit", () => {
  const padded = (size: number) => {
    const body = JSON.stringify(envelope("getEnvironment"));
    return new TextEncoder().encode(" ".repeat(size - body.length) + body);
  };

  test("an encoded request of exactly 1 MiB decodes", () => {
    const bytes = padded(MIB);
    expect(bytes.length).toBe(MIB);
    expect(decodeRequest(bytes, "renderer")).toMatchObject({ ok: true });
  });

  test("an encoded request above 1 MiB gives FRAME_LIMIT", () => {
    const bytes = padded(MIB + 1);
    expect(bytes.length).toBe(MIB + 1);
    expect(decodeRequest(bytes, "renderer")).toEqual({ ok: false, code: "FRAME_LIMIT" });
  });

  test("a 1 MiB request of multi-byte text counts bytes, not characters", () => {
    const request = envelope("commit");
    const base = encode(request).length;
    const message = "\u00e9".repeat(Math.ceil((MIB - base) / 2) + 16);
    const bytes = encode({ ...request, payload: { ...(request.payload as Json), message } });
    expect(bytes.length).toBeGreaterThan(MIB);
    expect(JSON.stringify({ ...request, payload: { ...(request.payload as Json), message } }).length).toBeLessThan(MIB);
    expect(decodeRequest(bytes, "renderer")).toEqual({ ok: false, code: "FRAME_LIMIT" });
  });
});

describe("requestClose", () => {
  test.each([["stay"], ["closeIfIdle"], ["interruptAndClose"]])("choice %s decodes", (choice) =>
    expectAccepted(envelope("requestClose", "renderer", { choice })),
  );
  test.each([["close"], ["Stay"], ["interrupt"], [""], [true], [null]])("choice %j gives INVALID_REQUEST", (choice) =>
    expectCode(envelope("requestClose", "renderer", { choice }), "INVALID_REQUEST"),
  );
  test("an empty payload gives INVALID_REQUEST", () =>
    expectCode(envelope("requestClose", "renderer", {}), "INVALID_REQUEST"));
});

describe("native bootstrap operations", () => {
  for (const name of ["chooseGit", "chooseRepository", "restoreWorkspace"]) {
    test(`${name} renderer payload must be empty`, () => {
      expectAccepted(envelope(name, "renderer", {}));
      expectCode(envelope(name, "renderer", { bootstrapId: id() }), "INVALID_REQUEST");
      expectCode(envelope(name, "renderer", { path: "C:\\repo" }), "INVALID_REQUEST");
    });
  }

  test("chooseGit renderer payload rejects executablePath", () => {
    expectCode(envelope("chooseGit", "renderer", { executablePath: GIT_PATH }), "INVALID_REQUEST");
  });

  test("chooseGit service payload holds exactly bootstrapId and executablePath", () => {
    expectAccepted(envelope("chooseGit", "service", { bootstrapId: id(), executablePath: GIT_PATH }), "service");
    expectCode(envelope("chooseGit", "service", {}), "INVALID_REQUEST", "service");
    expectCode(envelope("chooseGit", "service", { bootstrapId: id() }), "INVALID_REQUEST", "service");
    expectCode(envelope("chooseGit", "service", { executablePath: GIT_PATH }), "INVALID_REQUEST", "service");
    expectCode(envelope("chooseGit", "service", { bootstrapId: "x", executablePath: GIT_PATH }), "INVALID_REQUEST", "service");
    expectCode(envelope("chooseGit", "service", { bootstrapId: id(), executablePath: GIT_PATH, path: "C:\\repo" }), "INVALID_REQUEST", "service");
  });

  test.skipIf(!isWindows)("windows-path-rules: chooseGit service executablePath accepts a UNC path", () => {
    expectAccepted(envelope("chooseGit", "service", { bootstrapId: id(), executablePath: "\\\\server\\share\\git.exe" }), "service");
  });

  test.skipIf(!isWindows)("windows-path-rules: chooseGit service executablePath: a device path with slashes gives INVALID_REQUEST", () => {
    expectCode(envelope("chooseGit", "service", { bootstrapId: id(), executablePath: "//./pipe/git" }), "INVALID_REQUEST", "service");
  });

  test.each([
    ["a relative path", "git.exe"],
    ["a drive-relative path", "C:git.exe"],
    ["a rooted path without a drive", "\\Git\\cmd\\git.exe"],
    ["a path with NUL", "C:\\Git\\cmd\\git\u0000.exe"],
    ["a lone surrogate", "C:\\Git\\cmd\\git\ud800.exe"],
    ["an empty path", ""],
    ["a path above 32,767 UTF-16 units", `C:\\${"a".repeat(32_765)}`],
    ["a non-string path", 1],
    ["a device path", "\\\\.\\pipe\\git"],
    ["a device path with mixed separators", "\\/.\\C:\\Git\\cmd\\git.exe"],
    ["a Win32 file namespace path", "\\\\?\\C:\\Git\\cmd\\git.exe"],
    ["a Win32 file namespace UNC path", "\\\\?\\UNC\\server\\share\\git.exe"],
  ])("chooseGit service executablePath: %s gives INVALID_REQUEST", (_, executablePath) => {
    expectCode(envelope("chooseGit", "service", { bootstrapId: id(), executablePath }), "INVALID_REQUEST", "service");
  });

  for (const name of ["chooseRepository", "restoreWorkspace"]) {
    test(`${name} service payload holds only bootstrapId`, () => {
      expectAccepted(envelope(name, "service", { bootstrapId: id() }), "service");
      expectCode(envelope(name, "service", {}), "INVALID_REQUEST", "service");
      expectCode(envelope(name, "service", { bootstrapId: "x" }), "INVALID_REQUEST", "service");
      expectCode(envelope(name, "service", { bootstrapId: id(), path: "C:\\repo" }), "INVALID_REQUEST", "service");
    });
  }

  test("dismissRecoveryMarker renderer payload holds only markerId", () => {
    expectAccepted(envelope("dismissRecoveryMarker", "renderer", { markerId: id() }));
    expectCode(envelope("dismissRecoveryMarker", "renderer", {}), "INVALID_REQUEST");
    expectCode(envelope("dismissRecoveryMarker", "renderer", { markerId: id(), bootstrapId: id() }), "INVALID_REQUEST");
    expectCode(envelope("dismissRecoveryMarker", "renderer", { markerId: "..\\x" }), "INVALID_REQUEST");
  });

  test("dismissRecoveryMarker service payload holds markerId and bootstrapId, or markerId alone", () => {
    expectAccepted(envelope("dismissRecoveryMarker", "service", { markerId: id(), bootstrapId: id() }), "service");
    // Contract §6 "Dismissal": the shell creates no context for a worktree path that does not exist.
    expectAccepted(envelope("dismissRecoveryMarker", "service", { markerId: id() }), "service");
    expectCode(envelope("dismissRecoveryMarker", "service", { markerId: "x" }), "INVALID_REQUEST", "service");
    expectCode(envelope("dismissRecoveryMarker", "service", { markerId: id(), bootstrapId: "x" }), "INVALID_REQUEST", "service");
    expectCode(envelope("dismissRecoveryMarker", "service", { markerId: id(), path: "C:\\x" }), "INVALID_REQUEST", "service");
    expectCode(envelope("dismissRecoveryMarker", "service", { bootstrapId: id() }), "INVALID_REQUEST", "service");
    expectCode(
      envelope("dismissRecoveryMarker", "service", { markerId: id(), bootstrapId: id(), path: "C:\\x" }),
      "INVALID_REQUEST",
      "service",
    );
  });
});

describe("stage directions", () => {
  for (const name of ["applyHunk", "applyFile"]) {
    test.each([["stage"], ["unstage"]])(`${name} direction %s decodes`, (direction) => {
      const request = envelope(name);
      expectAccepted({ ...request, payload: { ...(request.payload as Json), direction } });
    });
    test.each([["discard"], ["Stage"], ["both"], [""], [null], [1]])(`${name} direction %j gives INVALID_REQUEST`, (direction) => {
      const request = envelope(name);
      expectCode({ ...request, payload: { ...(request.payload as Json), direction } }, "INVALID_REQUEST");
    });
  }

  // Feature 003 contract Δ3 `applyFile`: Mark resolved.
  test("applyFile direction resolve decodes, and applyHunk direction resolve gives INVALID_REQUEST", () => {
    for (const side of ["renderer", "service"] as const) {
      const file = envelope("applyFile", side);
      expectAccepted({ ...file, payload: { ...(file.payload as Json), direction: "resolve" } }, side);
      const hunk = envelope("applyHunk", side);
      expectCode({ ...hunk, payload: { ...(hunk.payload as Json), direction: "resolve" } }, "INVALID_REQUEST", side);
    }
  });

  test("applyFile with a path field gives INVALID_REQUEST", () => {
    const request = envelope("applyFile");
    expectCode({ ...request, payload: { ...(request.payload as Json), path: "src/a.ts" } }, "INVALID_REQUEST");
  });
  test("applyFile with a hunkId gives INVALID_REQUEST", () => {
    const request = envelope("applyFile");
    expectCode({ ...request, payload: { ...(request.payload as Json), hunkId: id() } }, "INVALID_REQUEST");
  });
  test.each([["comparisonId"], ["snapshotId"], ["direction"]])("applyFile without %s gives INVALID_REQUEST", (field) => {
    const request = envelope("applyFile");
    const payload = { ...(request.payload as Json) };
    delete payload[field];
    expectCode({ ...request, payload }, "INVALID_REQUEST");
  });
});

describe("readWorkspace", () => {
  test.each([
    [false, "full"],
    [false, "changes"],
    [true, "full"],
  ])("refresh %j with check %j decodes", (refresh, check) =>
    expectAccepted(envelope("readWorkspace", "renderer", { refresh, check })),
  );
  test("refresh true with check changes gives INVALID_REQUEST", () =>
    expectCode(envelope("readWorkspace", "renderer", { refresh: true, check: "changes" }), "INVALID_REQUEST"));
  test.each([
    [{ refresh: "true", check: "full" }],
    [{ refresh: 1, check: "full" }],
    [{ refresh: false, check: "partial" }],
    [{ refresh: false, check: "FULL" }],
    [{ refresh: false }],
    [{ check: "full" }],
    [{}],
  ])("payload %j gives INVALID_REQUEST", (payload) =>
    expectCode(envelope("readWorkspace", "renderer", payload), "INVALID_REQUEST"),
  );
});

describe("readEntries", () => {
  // Contract §3: `readWorkspace` returns the first page, so each `readEntries` names a later page by its service-issued cursor.
  test.each([["snapshotId"], ["cursor"]])("a payload without %s gives INVALID_REQUEST", (field) => {
    const request = envelope("readEntries");
    const payload = { ...(request.payload as Json) };
    delete payload[field];
    expectCode({ ...request, payload }, "INVALID_REQUEST");
  });
  test.each([...BAD_IDS, 0, 1, null, id().toUpperCase()].map((v) => [v]))("cursor %j gives INVALID_REQUEST", (cursor) => {
    const request = envelope("readEntries");
    expectCode({ ...request, payload: { ...(request.payload as Json), cursor } }, "INVALID_REQUEST");
  });
  test("contract §5: the Status page bound is 8 MiB, below the 16 MiB private/reply frame", () => {
    expect(STATUS_PAGE_BYTES).toBe(8 * MIB);
    expect(STATUS_PAGE_BYTES).toBeLessThan(PIPE_FRAME_BYTES);
  });
});

describe("other exact payloads", () => {
  test.each([[{ limit: 100 }], [{ ref: "main" }], [{ cursor: id() }]])("openHistory payload with %j gives INVALID_REQUEST", (payload) =>
    expectCode(envelope("openHistory", "renderer", { scope: "all", ...payload }), "INVALID_REQUEST"),
  );

  test("reviewSubmodules accepts only a snapshot ID", () => {
    expectAccepted(envelope("reviewSubmodules", "renderer", { snapshotId: id() }));
    expectCode(envelope("reviewSubmodules", "renderer", {}), "INVALID_REQUEST");
    expectCode(envelope("reviewSubmodules", "renderer", { snapshotId: id(), path: "lib" }), "INVALID_REQUEST");
  });

  test("updateSubmodules accepts only a review token and an explicit start", () => {
    expectAccepted(envelope("updateSubmodules", "renderer", { submoduleReviewToken: id(), start: true }));
    expectCode(envelope("updateSubmodules", "renderer", { submoduleReviewToken: id() }), "INVALID_REQUEST");
    expectCode(envelope("updateSubmodules", "renderer", { start: true }), "INVALID_REQUEST");
    expectCode(
      envelope("updateSubmodules", "renderer", { submoduleReviewToken: id(), start: true, path: "lib" }),
      "INVALID_REQUEST",
    );
  });
});

// Feature 002 contract Δ2 and Δ3.
describe("history view payloads", () => {
  const rows = (payload: Json) => envelope("readHistoryRows", "renderer", { viewId: id(), mode: "full", at: { row: 0 }, count: 1, text: "none", ...payload });
  const load = (need: unknown) => envelope("loadHistory", "renderer", { viewId: id(), need });

  test("openHistory takes scope all or current", () => {
    expectAccepted(envelope("openHistory", "renderer", { scope: "current" }));
    expectCode(envelope("openHistory", "renderer", { scope: "branch" }), "INVALID_REQUEST");
    expectCode(envelope("openHistory", "renderer", {}), "INVALID_REQUEST");
  });

  test("loadHistory need is a row from 0 to 4,000,000, an oid, or end true", () => {
    for (const need of [{ row: 0 }, { row: HISTORY_VIEW_COMMITS }, { oid: "a".repeat(40) }, { oid: "b".repeat(64) }, { end: true }]) expectAccepted(load(need));
    for (const need of [{ row: -1 }, { row: HISTORY_VIEW_COMMITS + 1 }, { row: 1.5 }, { oid: "A".repeat(40) }, { oid: "a".repeat(41) }, { end: false }, { row: 1, end: true }, {}])
      expectCode(load(need), "INVALID_REQUEST");
  });

  test("a view operation without viewId gives INVALID_REQUEST", () => {
    expectCode(envelope("loadHistory", "renderer", { need: { end: true } }), "INVALID_REQUEST");
    expectCode(envelope("searchHistory", "renderer", { text: "fix" }), "INVALID_REQUEST");
    expectCode(envelope("closeHistory", "renderer", {}), "INVALID_REQUEST");
    expectCode(envelope("closeHistory", "renderer", { viewId: "view" }), "INVALID_REQUEST");
  });

  test("readHistoryRows count is 1 to 512", () => {
    expectAccepted(rows({ count: HISTORY_ROWS_PER_REQUEST }));
    expectCode(rows({ count: 0 }), "INVALID_REQUEST");
    expectCode(rows({ count: HISTORY_ROWS_PER_REQUEST + 1 }), "INVALID_REQUEST");
  });

  test("readHistoryRows mode filter requires searchId, and mode full takes it for highlight", () => {
    expectCode(rows({ mode: "filter" }), "INVALID_REQUEST");
    expectAccepted(rows({ mode: "filter", searchId: id() }));
    expectAccepted(rows({ mode: "full", searchId: id() }));
    expectCode(rows({ mode: "graph" }), "INVALID_REQUEST");
  });

  test("readHistoryRows text details requires count 1", () => {
    expectAccepted(rows({ text: "details", count: 1 }));
    expectCode(rows({ text: "details", count: 2 }), "INVALID_REQUEST");
    expectAccepted(rows({ text: "rows", count: 2 }));
    expectCode(rows({ text: "body" }), "INVALID_REQUEST");
  });

  test("readHistoryRows at is a row, an oid, a match step, or end true", () => {
    for (const at of [{ row: 7 }, { oid: "c".repeat(40) }, { match: "next", from: 3 }, { match: "previous", from: 0 }, { end: true }]) expectAccepted(rows({ at }));
    for (const at of [{ row: -1 }, { match: "last", from: 0 }, { match: "next" }, { end: false }, { row: 1, oid: "c".repeat(40) }, {}]) expectCode(rows({ at }), "INVALID_REQUEST");
  });

  test("searchHistory takes any nonempty text, so the service can refuse it with UNSUPPORTED_FILTER_TEXT", () => {
    for (const text of ["fix\nbug", "a\\Eb", "nul\u0000", "x".repeat(2048)]) expectAccepted(envelope("searchHistory", "renderer", { viewId: id(), text }));
    expectCode(envelope("searchHistory", "renderer", { viewId: id(), text: "" }), "INVALID_REQUEST");
    expectCode(envelope("searchHistory", "renderer", { viewId: id(), text: 7 }), "INVALID_REQUEST");
  });

  test("an unknown field in a nested payload object gives INVALID_REQUEST", () => {
    expectCode(load({ row: 1, skip: 10 }), "INVALID_REQUEST");
    expectCode(rows({ at: { row: 1, extra: true } }), "INVALID_REQUEST");
  });
});
