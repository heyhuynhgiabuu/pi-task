import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ignoreStaleExtensionCtx, isStaleExtensionCtxError } from "../src/stale-ctx.ts";

describe("stale extension ctx guard", () => {
  it("recognizes the Pi SDK stale ctx message", () => {
    assert.equal(
      isStaleExtensionCtxError(
        new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
        ),
      ),
      true,
    );
  });

  it("ignores stale ctx errors but rethrows unrelated errors", () => {
    assert.doesNotThrow(() =>
      ignoreStaleExtensionCtx(() => {
        throw new Error("captured pi or command ctx after ctx.switchSession()");
      }),
    );

    assert.throws(
      () =>
        ignoreStaleExtensionCtx(() => {
          throw new Error("real failure");
        }),
      /real failure/,
    );
  });
});
