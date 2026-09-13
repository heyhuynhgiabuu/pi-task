import { strict as assert } from "node:assert";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderCall } from "../src/tool/renderCall.js";
import { renderTaskResultBody } from "../src/tool/renderTaskResultBody.js";

// renderTaskResultBody resolves the expand keybinding through keyText().
initTheme("dark");

const theme = { fg: (_color: string, text: string) => text } as never;

function rendered(component: { render: (width: number) => string[] }): string {
  return component.render(80).join("\n");
}

test("renderCall labels the task mode from the raw call argument", () => {
  const sync = rendered(
    renderCall(
      { agent_type: "explore", description: "Map auth", background: false },
      theme,
    ),
  );
  assert.match(sync, /sync/, "sync call is labeled");
  assert.ok(!/async/.test(sync), "sync call is not labeled async");

  const async = rendered(
    renderCall(
      { agent_type: "explore", description: "Map auth", background: true },
      theme,
    ),
  );
  assert.match(async, /async/, "explicit background:true is labeled async");

  const defaulted = rendered(
    renderCall({ agent_type: "explore", description: "Map auth" }, theme),
  );
  assert.match(defaulted, /async/, "omitted background defaults to async");
});

test("renderTaskResultBody labels the result mode from details.background", () => {
  const stats = { tool_uses: 2, duration_ms: 1200, summary: "done" };

  const sync = rendered(
    renderTaskResultBody({ ...stats, background: false }, "done", { expanded: false }, theme),
  );
  assert.match(sync, /sync/, "sync result is labeled");

  const async = rendered(
    renderTaskResultBody({ ...stats, background: true }, "done", { expanded: false }, theme),
  );
  assert.match(async, /async/, "async result is labeled");

  const unknown = rendered(
    renderTaskResultBody(stats, "done", { expanded: false }, theme),
  );
  assert.ok(
    !/sync|async/.test(unknown),
    "no mode label when the result does not declare one",
  );
});

test("renderTaskResultBody labels the mode without tool or duration stats", () => {
  const sync = rendered(
    renderTaskResultBody({ background: false, summary: "done" }, "done", { expanded: false }, theme),
  );
  assert.match(sync, /sync/, "mode still renders when stats are absent");
});
