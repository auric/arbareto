// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { TERMINAL_STATES } from "../../src/contracts/errors";
import type { DraftRecord, DraftStore, StoreResult } from "../../src/frontend/state/draft-store";

printOrigin("../../src/frontend/state/drafts.ts", import.meta.dir);
const { createDrafts, SAVE_FAILURE } = await import("../../src/frontend/state/drafts");

// plan.md "Stored drafts" and the commit submission rules beside "Review states"; data-model §2 "Stored draft" and the token rules.
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The T250 store double keeps the store rules that drafts depend on: a delete with a revision deletes only that revision.
function storeDouble(seed: DraftRecord[] = []) {
  const records = new Map(seed.map((record) => [record.worktreeKey, record]));
  const calls: unknown[][] = [];
  const state = { fail: false };
  const result = (): StoreResult => (state.fail ? "failed" : "saved");
  const store: DraftStore = {
    async write(key, message, revision) {
      calls.push(["write", key, message, revision]);
      if (!state.fail) records.set(key, { worktreeKey: key, message, draftRevision: revision, writtenAt: 1 });
      return result();
    },
    async remove(key, revision) {
      calls.push(["remove", key, revision]);
      if (!state.fail && (revision === undefined || records.get(key)?.draftRevision === revision)) records.delete(key);
      return result();
    },
    async read(key) {
      calls.push(["read", key]);
      return state.fail ? "failed" : (records.get(key) ?? null);
    },
  };
  return { store, records, calls, state };
}

async function withDraft(text = "Fix the parser") {
  const double = storeDouble();
  const drafts = createDrafts(double.store);
  await drafts.change(KEY_A, text);
  return { ...double, drafts };
}

describe("draft submission", () => {
  test("a submission binds the worktree, the draft revision, and the submitted text", async () => {
    const { drafts } = await withDraft("Fix the parser");
    const submission = drafts.submit(KEY_A)!;
    expect(submission).toEqual({ worktreeKey: KEY_A, draftRevision: drafts.draft(KEY_A)!.revision, text: "Fix the parser" });
    await drafts.change(KEY_A, "Fix the parser and the lexer");
    expect(submission).toEqual({ worktreeKey: KEY_A, draftRevision: submission.draftRevision, text: "Fix the parser" });
    expect(drafts.draft(KEY_A)!.revision).not.toBe(submission.draftRevision);
  });

  test("a worktree without a draft gives no submission", () => {
    expect(createDrafts(storeDouble().store).submit(KEY_A)).toBeNull();
  });

  test("a reconciled succeeded outcome clears that unchanged draft", async () => {
    const { drafts, records } = await withDraft();
    await drafts.complete(drafts.submit(KEY_A)!, "succeeded");
    expect(drafts.draft(KEY_A)).toBeNull();
    expect(records.has(KEY_A)).toBe(false);
  });

  test("edits made during execution survive a succeeded outcome", async () => {
    const { drafts, records } = await withDraft("Fix the parser");
    const submission = drafts.submit(KEY_A)!;
    await drafts.change(KEY_A, "Fix the parser\n\nMore");
    await drafts.complete(submission, "succeeded");
    expect(drafts.draft(KEY_A)?.text).toBe("Fix the parser\n\nMore");
    expect(records.get(KEY_A)?.message).toBe("Fix the parser\n\nMore");
  });

  test("an edit back to the submitted text is a later edit, so it survives", async () => {
    const { drafts } = await withDraft("Fix");
    const submission = drafts.submit(KEY_A)!;
    await drafts.change(KEY_A, "Fixx");
    await drafts.change(KEY_A, "Fix");
    await drafts.complete(submission, "succeeded");
    expect(drafts.draft(KEY_A)?.text).toBe("Fix");
  });

  // History hides the commit tray (T146), so no composer subscribes. The module takes no mode.
  test("completion while History shows keeps later edits without a subscribed composer", async () => {
    const { drafts } = await withDraft("one");
    const submission = drafts.submit(KEY_A)!;
    await drafts.change(KEY_A, "two");
    await drafts.complete(submission, "succeeded");
    expect(drafts.draft(KEY_A)?.text).toBe("two");
  });

  test("a subscribed composer hears the clear of a succeeded outcome, and an unsubscribed one does not", async () => {
    const { drafts } = await withDraft("one");
    let heard = 0;
    const stop = drafts.subscribe(() => heard++);
    await drafts.complete(drafts.submit(KEY_A)!, "succeeded");
    expect(heard).toBe(1);
    stop();
    await drafts.change(KEY_A, "two");
    expect(heard).toBe(1);
  });

  test("the drafts of other worktrees survive a succeeded outcome", async () => {
    const { drafts, records } = await withDraft("A text");
    await drafts.change(KEY_B, "B text");
    await drafts.complete(drafts.submit(KEY_A)!, "succeeded");
    expect(drafts.draft(KEY_B)?.text).toBe("B text");
    expect(records.get(KEY_B)?.message).toBe("B text");
  });

  test("failed, completed-with-effects, failed-with-effects, unknown, and every other terminal state keep the draft", async () => {
    const keep = TERMINAL_STATES.filter((state) => state !== "succeeded");
    expect(keep).toEqual(expect.arrayContaining(["failed", "completed-with-effects", "failed-with-effects", "unknown"]));
    for (const state of keep) {
      const { drafts, records, calls } = await withDraft("kept");
      await drafts.complete(drafts.submit(KEY_A)!, state);
      expect(drafts.draft(KEY_A)?.text).toBe("kept");
      expect(records.get(KEY_A)?.message).toBe("kept");
      expect(calls.filter((call) => call[0] === "remove")).toEqual([]);
    }
  });

  test("a service restart keeps every draft: the pending submission reads unknown, and a restore keeps the memory drafts", async () => {
    const { drafts, store } = await withDraft("A text");
    await drafts.change(KEY_B, "B text");
    const submission = drafts.submit(KEY_A)!;
    // contract §2: `service-stopped` marks each request without a terminal response as State unknown.
    await drafts.complete(submission, "unknown");
    // contract §2: after `service-session`, the page runs `restoreWorkspace`, and each registration restores its draft.
    await store.write(KEY_A, "stale stored text", 1);
    await drafts.restore(KEY_A);
    await drafts.restore(KEY_B);
    expect(drafts.draft(KEY_A)?.text).toBe("A text");
    expect(drafts.draft(KEY_B)?.text).toBe("B text");
  });

  test.todo("after a `service-session` event, the Workbench keeps the composer text and the page does not reload (needs T148)", () => {});
});

describe("Clear message", () => {
  test("clears the draft only on explicit activation, also after completed-with-effects", async () => {
    const { drafts, records, calls } = await withDraft("kept");
    await drafts.complete(drafts.submit(KEY_A)!, "completed-with-effects");
    expect(drafts.draft(KEY_A)?.text).toBe("kept");
    await drafts.clear(KEY_A);
    expect(drafts.draft(KEY_A)).toBeNull();
    expect(records.has(KEY_A)).toBe(false);
    expect(calls.at(-1)).toEqual(["remove", KEY_A, undefined]);
  });

  test("Clear message keeps the drafts of other worktrees", async () => {
    const { drafts, records } = await withDraft("A text");
    await drafts.change(KEY_B, "B text");
    await drafts.clear(KEY_A);
    expect(drafts.draft(KEY_B)?.text).toBe("B text");
    expect(records.get(KEY_B)?.message).toBe("B text");
  });

  test.todo("the Clear message button of the status area clears the composer draft (needs T148)", () => {});
});

// T146 builds the commit tray. A template path keeps `tsc` from resolving the module before it exists.
describe("commit tray", () => {
  async function commitTray() {
    const module = "CommitTray";
    printOrigin(`../../src/frontend/commit/${module}.tsx`, import.meta.dir);
    return await import(`../../src/frontend/commit/${module}.tsx`);
  }

  test.todo("IME composition blocks submission (needs T146)", async () => {
    const { CommitTray } = await commitTray();
    expect(CommitTray).toBeDefined();
  });
});

describe("stored drafts", () => {
  test("each change writes the latest text for its worktreeKey", async () => {
    const { drafts, calls, records } = await withDraft("one");
    await drafts.change(KEY_A, "two");
    await drafts.change(KEY_B, "other");
    const writes = calls.filter((call) => call[0] === "write");
    expect(writes.map((call) => call.slice(1, 3))).toEqual([
      [KEY_A, "one"],
      [KEY_A, "two"],
      [KEY_B, "other"],
    ]);
    expect(writes[1]![3]).toBe(drafts.draft(KEY_A)!.revision);
    expect(records.get(KEY_A)?.message).toBe("two");
  });

  test("a page-load restore fills a missing memory draft", async () => {
    const double = storeDouble([{ worktreeKey: KEY_A, message: "stored", draftRevision: 7, writtenAt: 1 }]);
    const drafts = createDrafts(double.store);
    let notified = 0;
    drafts.subscribe(() => notified++);
    await drafts.restore(KEY_A);
    expect(drafts.draft(KEY_A)).toEqual({ text: "stored", revision: 7 });
    expect(notified).toBe(1);
    await drafts.restore(KEY_B);
    expect(drafts.draft(KEY_B)).toBeNull();
  });

  test("a restore never replaces an existing memory draft, also when the edit lands while the read runs", async () => {
    const double = storeDouble([{ worktreeKey: KEY_A, message: "stored", draftRevision: 7, writtenAt: 1 }]);
    const drafts = createDrafts(double.store);
    const restore = drafts.restore(KEY_A);
    const change = drafts.change(KEY_A, "typed");
    await Promise.all([restore, change]);
    expect(drafts.draft(KEY_A)?.text).toBe("typed");
  });

  test("a later edit of a restored draft takes a revision above the stored one", async () => {
    const double = storeDouble([{ worktreeKey: KEY_A, message: "stored", draftRevision: 7, writtenAt: 1 }]);
    const drafts = createDrafts(double.store);
    await drafts.restore(KEY_A);
    await drafts.change(KEY_A, "stored!");
    expect(drafts.draft(KEY_A)!.revision).toBeGreaterThan(7);
  });

  test("a reconciled succeeded deletes the stored record only while it holds the submitted revision", async () => {
    const { drafts, calls } = await withDraft("one");
    const submission = drafts.submit(KEY_A)!;
    await drafts.complete(submission, "succeeded");
    expect(calls.at(-1)).toEqual(["remove", KEY_A, submission.draftRevision]);
  });

  test("a succeeded outcome keeps a stored record of another revision, written by another instance", async () => {
    const { drafts, records, store } = await withDraft("one");
    const submission = drafts.submit(KEY_A)!;
    await store.write(KEY_A, "from another instance", submission.draftRevision + 100);
    await drafts.complete(submission, "succeeded");
    expect(records.get(KEY_A)?.message).toBe("from another instance");
  });

  test("Clear message deletes the stored record", async () => {
    const { drafts, records } = await withDraft("one");
    await drafts.clear(KEY_A);
    expect(records.has(KEY_A)).toBe(false);
  });

  test("a store failure keeps the memory draft and reports the plan.md save-failure text", async () => {
    expect(SAVE_FAILURE).toBe("The draft could not be saved. It stays until Arbareto closes.");
    const { drafts, state } = await withDraft("one");
    expect(drafts.failure(KEY_A)).toBeNull();
    state.fail = true;
    await drafts.change(KEY_A, "two");
    expect(drafts.draft(KEY_A)?.text).toBe("two");
    expect(drafts.failure(KEY_A)).toBe(SAVE_FAILURE);
    expect(drafts.failure(KEY_B)).toBeNull();
    state.fail = false;
    await drafts.change(KEY_A, "three");
    expect(drafts.failure(KEY_A)).toBeNull();
  });

  test("a failed restore read reports the save-failure text", async () => {
    const double = storeDouble();
    double.state.fail = true;
    const drafts = createDrafts(double.store);
    await drafts.restore(KEY_A);
    expect(drafts.draft(KEY_A)).toBeNull();
    expect(drafts.failure(KEY_A)).toBe(SAVE_FAILURE);
  });

  test("a refused write keeps the memory draft and reports the save-failure text", async () => {
    const drafts = createDrafts({ ...storeDouble().store, write: async () => "refused" });
    await drafts.change(KEY_A, "a\u0000b");
    expect(drafts.draft(KEY_A)?.text).toBe("a\u0000b");
    expect(drafts.failure(KEY_A)).toBe(SAVE_FAILURE);
  });

  test("a restore does not hide the failure of a write that started before it", async () => {
    const results: ((result: StoreResult) => void)[] = [];
    const record = { worktreeKey: KEY_A, message: "stored", draftRevision: 7, writtenAt: 1 };
    const drafts = createDrafts({ ...storeDouble().store, write: () => new Promise((resolve) => results.push(resolve)), read: async () => record });
    const change = drafts.change(KEY_A, "typed");
    const restore = drafts.restore(KEY_A);
    results[0]!("failed");
    await Promise.all([change, restore]);
    expect(drafts.draft(KEY_A)?.text).toBe("typed");
    expect(drafts.failure(KEY_A)).toBe(SAVE_FAILURE);
  });

  test("only the result of the latest write decides the failure text", async () => {
    const results: ((result: StoreResult) => void)[] = [];
    const drafts = createDrafts({ ...storeDouble().store, write: () => new Promise((resolve) => results.push(resolve)) });
    const first = drafts.change(KEY_A, "one");
    const second = drafts.change(KEY_A, "two");
    results[1]!("failed");
    results[0]!("saved");
    await Promise.all([first, second]);
    await tick();
    expect(drafts.failure(KEY_A)).toBe(SAVE_FAILURE);
  });
});
