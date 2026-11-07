// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 plan.md D9 "Trust" (T008): `approvalRequired.workbench` implies `approvalRequired.sync`, so the one `sync` gate covers the combined delete.
// trust.ts builds both flags from the same input, folder, and hooks-path terms, then from the hook events and the program classes below.

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import * as trust from "../../src/git-service/trust";

printOrigin("../../src/git-service/trust.ts", import.meta.dir);

// Every section, subsection form, and variable that `programKey` names. A new program key there needs its words here.
const SECTIONS = ["core", "remote", "credential", "url", "merge", "mergetool", "filter", "hook", "diff", "gpg"];
const SUBSECTIONS = [null, "x", "ssh", "https://example.invalid/"];
const VARIABLES = ["sshcommand", "askpass", "gitproxy", "uploadpack", "receivepack", "helper", "vcs", "url", "pushurl", "insteadof", "pushinsteadof", "alternaterefscommand", "driver", "tool", "cmd", "path", "clean", "process", "smudge", "fsmonitor", "command", "external", "textconv", "program", "defaultkeycommand"];

const keys = SECTIONS.flatMap((section) => SUBSECTIONS.flatMap((sub) => VARIABLES.map((variable) => (sub === null ? `${section}.${variable}` : `${section}.${sub}.${variable}`))));

describe("the workbench class implies the sync class", () => {
  test("every program key with workbench: true has sync: true", () => {
    const classified = keys.flatMap((key) => {
      const k = trust.programKey(trust.keyParts(key)!);
      return k === null ? [] : [{ key, workbench: k.workbench, sync: k.sync }];
    });
    // The list reaches the workbench rows of `programKey`, so the check below is not empty.
    expect(classified.filter((k) => k.workbench).map((k) => k.key)).toContain("core.fsmonitor");
    expect(classified.filter((k) => k.workbench && !k.sync)).toEqual([]);
  });

  test("every workbench hook event is a sync hook event", () => {
    expect(trust.WORKBENCH_EVENTS.size).toBeGreaterThan(0);
    expect([...trust.WORKBENCH_EVENTS].filter((event) => !trust.SYNC_EVENTS.has(event))).toEqual([]);
  });
});
