import test from "node:test";
import assert from "node:assert/strict";

import { DeliveryGuard } from "../src/panel/delivery.js";

function makeSession(over: Partial<{
  id: string;
  leafId: string | null;
  branchIds: string[];
}> = {}) {
  const session = {
    id: over.id ?? "sess-1",
    leafId: over.leafId !== undefined ? over.leafId : "leaf-1",
    branchIds: over.branchIds ?? ["root", "leaf-1"],
  };
  return {
    getSessionId: () => session.id,
    getLeafId: () => session.leafId,
    getBranch: () => session.branchIds.map((id) => ({ id })),
  };
}

test("DeliveryGuard allows delivery for untracked tasks (legacy callers)", () => {
  const guard = new DeliveryGuard();
  const session = makeSession();
  assert.equal(guard.allows(session, "unknown-task"), true);
});

test("DeliveryGuard allows delivery in the same session with the spawn leaf on the branch", () => {
  const guard = new DeliveryGuard();
  const spawn = makeSession({ id: "sess-1", leafId: "leaf-1" });
  const current = makeSession({ id: "sess-1", leafId: "leaf-9", branchIds: ["root", "leaf-1", "leaf-9"] });
  guard.track("t1", spawn);
  assert.equal(guard.allows(current, "t1"), true);
});

test("DeliveryGuard refuses delivery when the session id changed", () => {
  const guard = new DeliveryGuard();
  const spawn = makeSession({ id: "sess-1", leafId: "leaf-1" });
  const other = makeSession({ id: "sess-2", leafId: "leaf-1", branchIds: ["root", "leaf-1"] });
  guard.track("t1", spawn);
  assert.equal(guard.allows(other, "t1"), false);
});

test("DeliveryGuard refuses delivery when /tree moved off the spawn branch", () => {
  const guard = new DeliveryGuard();
  const spawn = makeSession({ id: "sess-1", leafId: "leaf-1" });
  const otherBranch = makeSession({
    id: "sess-1",
    leafId: "leaf-9",
    branchIds: ["root", "leaf-9"],
  });
  guard.track("t1", spawn);
  assert.equal(guard.allows(otherBranch, "t1"), false);
});

test("DeliveryGuard forget removes the record and restores delivery", () => {
  const guard = new DeliveryGuard();
  const spawn = makeSession({ id: "sess-1", leafId: "leaf-1" });
  const other = makeSession({ id: "sess-2", leafId: "leaf-1" });
  guard.track("t1", spawn);
  assert.equal(guard.allows(other, "t1"), false);
  guard.forget("t1");
  assert.equal(guard.allows(other, "t1"), true);
});

test("DeliveryGuard allows delivery when the spawn leaf is null", () => {
  const guard = new DeliveryGuard();
  const spawn = makeSession({ id: "sess-1", leafId: null });
  const current = makeSession({ id: "sess-1", leafId: "leaf-9", branchIds: ["root", "leaf-9"] });
  guard.track("t1", spawn);
  assert.equal(guard.allows(current, "t1"), true);
});
import { sessionViewOf } from "../src/panel/delivery.js";

test("sessionViewOf degrades to a permissive no-op when sessionManager is missing", () => {
  const guard = new DeliveryGuard();
  const view = sessionViewOf({} as never);
  guard.track("t1", view);
  // Records an empty session id, which never blocks delivery.
  assert.equal(guard.allows(makeSession({ id: "anything" }), "t1"), true);
});
