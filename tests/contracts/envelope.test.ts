// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { decodeRequest } from "../../src/contracts/envelope";
import { isWindows } from "../../src/contracts/native-path";
import { OPERATIONS } from "../../src/contracts/operations";

printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/native-path.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);

type Side = "renderer" | "service";
type Json = Record<string, unknown>;

const MIB = 1024 * 1024;
const id = () => crypto.randomUUID();
const FINGERPRINT = "a".repeat(64);
const GIT_PATH = isWindows ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";

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
  readHistory: { renderer: () => ({}), service: () => ({}) },
  readComparison: {
    renderer: () => ({ snapshotId: id(), entryId: id() }),
    service: () => ({ snapshotId: id(), entryId: id() }),
  },
  readTrust: { renderer: () => ({}), service: () => ({}) },
  approveTrust: {
    renderer: () => ({ fingerprint: FINGERPRINT, approve: true }),
    service: () => ({ fingerprint: FINGERPRINT, approve: true }),
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
};

const NAMES = Object.keys(PAYLOADS);

const GENERATION_REQUIRED = [
  "readHistory",
  "readComparison",
  "applyHunk",
  "applyFile",
  "reviewCommit",
  "commit",
  "reviewSubmodules",
  "updateSubmodules",
  "approveTrust",
];
const GENERATION_ABSENT = NAMES.filter((n) => !GENERATION_REQUIRED.includes(n) && n !== "readWorkspace");

const REPOSITORY_BOUND = [
  "readWorkspace",
  "readHistory",
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
];

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
  test("holds exactly the 21 contract §3 operations", () => {
    expect([...OPERATIONS].sort()).toEqual([...NAMES].sort());
    expect(OPERATIONS.length).toBe(21);
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
    expectCode({ ...envelope("readHistory"), repositoryGeneration: value }, "INVALID_REQUEST"),
  );
  test("repositoryGeneration above the safe range gives INVALID_REQUEST", () => {
    const text = JSON.stringify(envelope("readHistory")).replace('"repositoryGeneration":3', '"repositoryGeneration":9007199254740992');
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

  for (const name of NAMES.filter((n) => !REPOSITORY_BOUND.includes(n))) {
    for (const side of sidesOf(name)) {
      test(`${name} with repositoryId gives INVALID_REQUEST on the ${side} side`, () =>
        expectCode({ ...envelope(name, side), repositoryId: id() }, "INVALID_REQUEST", side));
    }
  }

  test("a readTrust payload with repositoryId gives INVALID_REQUEST", () =>
    expectCode(envelope("readTrust", "renderer", { repositoryId: id() }), "INVALID_REQUEST"));
});

describe("approveTrust fingerprint", () => {
  test.each([
    ["a".repeat(63)],
    ["a".repeat(65)],
    ["A".repeat(64)],
    ["g" + "a".repeat(63)],
    [id()],
  ])("fingerprint %j gives INVALID_REQUEST", (fingerprint) =>
    expectCode(envelope("approveTrust", "renderer", { fingerprint, approve: true }), "INVALID_REQUEST"),
  );
});

describe("explicit approval fields", () => {
  const cases: Array<[string, string]> = [
    ["approveTrust", "approve"],
    ["commit", "confirmFullScope"],
    ["updateSubmodules", "start"],
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
  ])("payload field %s gives INVALID_REQUEST", (field, value) => {
    for (const name of ["readComparison", "applyHunk", "applyFile", "commit", "readHistory"]) {
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

describe("other exact payloads", () => {
  test.each([[{ limit: 100 }], [{ ref: "main" }], [{ cursor: id() }]])("readHistory payload %j gives INVALID_REQUEST", (payload) =>
    expectCode(envelope("readHistory", "renderer", payload), "INVALID_REQUEST"),
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
