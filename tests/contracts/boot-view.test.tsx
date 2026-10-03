// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { printOrigin } from "../origin";
import { BootView, type Environment } from "../../src/frontend/boot/BootView";

printOrigin("../../src/frontend/boot/BootView.tsx", import.meta.dir);

const environment = (fields: Partial<Environment> = {}): Environment => ({
  buildIdentity: { version: "0.1.0", commit: "c".repeat(40) + "-dirty", signing: "unsigned" },
  platformScope: "other",
  detectedVersion: "2.43.0.windows.1",
  minimumVersion: "2.55.0.windows.3",
  qualification: "unverified",
  markers: [],
  ...fields,
});

const render = (env: Environment) => renderToStaticMarkup(<BootView state="facts" environment={env} onSelectGit={() => {}} onDismissMarker={() => {}} />);

describe("boot view", () => {
  test("the unavailable state names the code", () => {
    expect(renderToStaticMarkup(<BootView state="unavailable" code="SERVICE_UNAVAILABLE" />)).toContain("Git service not connected: SERVICE_UNAVAILABLE");
  });

  test("the facts state shows the build identity and the T064 labels", () => {
    const html = render(environment());
    expect(html).toContain("c".repeat(40) + "-dirty");
    expect(html).toContain("Unsigned local test package");
    expect(html).toContain("Unqualified platform");
    expect(html).not.toContain("Select Git");
  });

  test("each Git code shows a blocked state with both versions and Select Git", () => {
    for (const gitCode of ["GIT_UNAVAILABLE", "GIT_UNSUPPORTED", "GIT_CHANGED"]) {
      const html = render(environment({ gitCode }));
      expect(html).toContain(gitCode);
      expect(html).toContain("2.43.0.windows.1");
      expect(html).toContain("2.55.0.windows.3");
      expect(html).toContain("Select Git");
    }
  });

  test("any other Git code shows as plain text with Select Git", () => {
    for (const gitCode of ["DEADLINE", "OUTPUT_LIMIT", "UNKNOWN_TARGET", "PROCESS_OWNERSHIP_FAILED", "UNSUPPORTED_REPOSITORY", "GIT_FAILED"]) {
      const html = render(environment({ gitCode }));
      expect(html).toContain(gitCode);
      expect(html).toContain("Select Git");
    }
  });

  test("each recovery marker shows its facts and a Dismiss action", () => {
    const marker = { markerId: crypto.randomUUID(), kind: "commit", startedAt: "2026-10-02T10:00:00Z", worktreeRoot: "C:\\repo" };
    const html = render(environment({ platformScope: "qualification-target", markers: [marker], markerLimit: 64, unloadedMarkers: 3 }));
    expect(html).not.toContain("Unqualified platform");
    for (const text of ["commit", "C:\\repo", "2026-10-02T10:00:00Z", "Dismiss", "Marker limit: 64", "Unloaded marker files: 3"]) expect(html).toContain(text);
  });
});
