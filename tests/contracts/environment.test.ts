// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { RECOVERY_MARKERS_PER_HANDSHAKE } from "../../src/contracts/limits";
import { getEnvironment, QUALIFIED_VERSION_SETS } from "../../src/git-service/environment";
import type { GitProbeResult } from "../../src/git-service/git-installation";
import type { Handshake } from "../../src/git-service/session";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/environment.ts", import.meta.dir);
printOrigin("../../src/git-service/git-installation.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

const MINIMUM = "2.55.0.windows.3";
const IDENTITY = { volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" };
const GIT_PATH = "C:\\arbareto-test-fixture\\git\\cmd\\git.exe";

const marker = (n: number) => ({
  markerId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
  kind: "commit",
  startedAt: "2026-10-02T08:00:00Z",
  worktreeRoot: `C:\\repo${n}`,
  commonDirectory: `C:\\repo${n}\\.git`,
  commonIdentity: IDENTITY,
});

// Contract §6 "Startup handshake".
function handshake(extra: Partial<Handshake> = {}): Handshake {
  return {
    version: 1,
    restarted: false,
    platformScope: "qualification-target",
    osBuild: 26200,
    webView2Version: "154.0.4258.37",
    buildIdentity: { version: "0.1.0", commit: `${"a".repeat(40)}-dirty`, signing: "unsigned" },
    markers: [],
    unloadedMarkers: 0,
    damagedMarkers: [],
    trustRecords: [],
    ...extra,
  };
}

const admitted: GitProbeResult = {
  ok: true,
  installation: {
    gitInstallationId: "11111111-1111-4111-8111-111111111111",
    executablePath: GIT_PATH,
    executableIdentity: { file: IDENTITY, versionOutput: `git version ${MINIMUM}\ncpu: x86_64\n`, digest: "c".repeat(64) },
    version: MINIMUM,
    admission: "admitted",
  },
};

describe("getEnvironment (T054)", () => {
  const canaryName = `ARBARETO_CANARY_${crypto.randomUUID().replaceAll("-", "_")}`;
  const canaryValue = `canary-value-${crypto.randomUUID()}`;
  afterEach(() => {
    delete process.env[canaryName];
  });

  test("the build-time qualified version list ships empty", () => {
    expect(QUALIFIED_VERSION_SETS).toEqual([]);
  });

  test("an admitted Git gives the facts, the admission, and a separate unverified qualification", () => {
    const env = getEnvironment(handshake(), admitted);
    expect(env).toEqual({
      buildIdentity: { version: "0.1.0", commit: `${"a".repeat(40)}-dirty`, signing: "unsigned" },
      platformScope: "qualification-target",
      selectedGit: GIT_PATH,
      detectedVersion: MINIMUM,
      minimumVersion: MINIMUM,
      admission: "admitted",
      qualification: "unverified",
      markers: [],
      damagedMarkers: [],
    });
  });

  test("the platform scope comes from the handshake", () => {
    expect(getEnvironment(handshake({ platformScope: "other" }), admitted).platformScope).toBe("other");
  });

  test("an unsupported Git gives GIT_UNSUPPORTED with the detected and minimum versions", () => {
    const env = getEnvironment(handshake(), { ok: false, gitCode: "GIT_UNSUPPORTED", detectedVersion: "2.54.0.windows.1", minimumVersion: MINIMUM });
    expect(env).toMatchObject({ gitCode: "GIT_UNSUPPORTED", admission: "unsupported", detectedVersion: "2.54.0.windows.1", minimumVersion: MINIMUM, qualification: "unverified" });
    expect(env.selectedGit).toBeUndefined();
  });

  test("a changed Git gives GIT_CHANGED with the new version", () => {
    const env = getEnvironment(handshake(), { ok: false, gitCode: "GIT_CHANGED", detectedVersion: "2.56.0.windows.1", minimumVersion: MINIMUM });
    expect(env).toMatchObject({ gitCode: "GIT_CHANGED", detectedVersion: "2.56.0.windows.1", minimumVersion: MINIMUM, qualification: "unverified" });
    expect(env.selectedGit).toBeUndefined();
  });

  test("a handshake without a startup Git context leaves Git unselected with GIT_UNAVAILABLE", () => {
    const env = getEnvironment(handshake(), null);
    expect(env).toMatchObject({ gitCode: "GIT_UNAVAILABLE", minimumVersion: MINIMUM, qualification: "unverified" });
    expect(env.selectedGit).toBeUndefined();
    expect(env.detectedVersion).toBeUndefined();
    expect(env.admission).toBeUndefined();
  });

  test("the recovery markers come from the handshake, without a limit below 64 markers", () => {
    const markers = [marker(1), marker(2)];
    const env = getEnvironment(handshake({ markers }), admitted);
    expect(env.markers).toEqual(markers.map(({ markerId, kind, startedAt, worktreeRoot }) => ({ markerId, kind, startedAt, worktreeRoot })));
    expect(env.markerLimit).toBeUndefined();
    expect(env.unloadedMarkers).toBeUndefined();
  });

  test("above 64 markers it reports the limit and the count of unloaded files", () => {
    const markers = Array.from({ length: RECOVERY_MARKERS_PER_HANDSHAKE }, (_, i) => marker(i + 1));
    const env = getEnvironment(handshake({ markers, unloadedMarkers: 3 }), admitted);
    expect(env.markers).toHaveLength(64);
    expect(env.markerLimit).toBe(64);
    expect(env.unloadedMarkers).toBe(3);
  });

  test("each damaged marker comes from the handshake with exactly its ID and file name, and reports no limit", () => {
    const damagedMarkers = [
      { markerId: "00000000-0000-4000-8000-0000000000d1", fileName: "broken.json" },
      { markerId: "00000000-0000-4000-8000-0000000000d2", fileName: "large.json" },
    ];
    const env = getEnvironment(handshake({ markers: [marker(1)], damagedMarkers }), admitted);
    expect(env.damagedMarkers).toEqual(damagedMarkers);
    expect(env.markers).toHaveLength(1);
    expect(env.markerLimit).toBeUndefined();
    expect(env.unloadedMarkers).toBeUndefined();
    expect(getEnvironment(handshake(), admitted).damagedMarkers).toEqual([]);
  });

  test("no environment variable name or value appears in the result", () => {
    process.env[canaryName] = canaryValue;
    const env = getEnvironment(handshake({ markers: [marker(1)] }), admitted);
    const json = JSON.stringify(env);
    expect(json).not.toContain(canaryName);
    expect(json).not.toContain(canaryValue);
  });
});
