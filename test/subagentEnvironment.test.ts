import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTmuxEnvironmentPrefix,
  launchTerminalTask,
} from "../src/subagent/terminal-launch.js";
import {
  resolveSubagentEnvironment,
  type SubagentEnvironmentResolution,
} from "../src/subagent/environment.js";
import type { TerminalBackend, TerminalLaunchInput } from "../src/subagent/terminalBackend.js";

function successful(
  result: SubagentEnvironmentResolution,
): Extract<SubagentEnvironmentResolution, { ok: true }> {
  assert.equal(result.ok, true);
  return result;
}

async function withEnvironment(
  values: Record<string, string | undefined>,
  callback: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function fakeHerdrBackend(
  onLaunch: (input: TerminalLaunchInput) => void,
): TerminalBackend {
  return {
    kind: "herdr",
    available: async () => true,
    launch: async (input) => {
      onLaunch(input);
      return {
        backend: "herdr",
        resourceId: "pane-1",
        socketPath: "/tmp/herdr.sock",
        terminalId: "terminal-1",
      };
    },
    isAlive: async () => true,
    send: async () => {},
    readTail: async () => "",
    close: async () => {},
  };
}

test("forwards only default-prefixed variables and strips one prefix", () => {
  const result = successful(resolveSubagentEnvironment({
    PI_SUBAGENT_FORWARD_REVIEW_MODE: "auto",
    PI_SUBAGENT_FORWARD_EMPTY: "",
    PLAIN_PARENT_VALUE: "must-not-forward",
  }));

  assert.deepEqual(result.environment, {
    EMPTY: "",
    REVIEW_MODE: "auto",
  });
  assert.deepEqual(result.diagnostics, []);
});

test("invalid targets are skipped with diagnostics that do not expose values", () => {
  const result = successful(resolveSubagentEnvironment({
    PI_SUBAGENT_FORWARD_: "hidden-empty-target-value",
    PI_SUBAGENT_FORWARD_lowercase: "hidden-lowercase-value",
    PI_SUBAGENT_FORWARD_GOOD_NAME: "kept-value",
  }));

  assert.deepEqual(result.environment, { GOOD_NAME: "kept-value" });
  assert.equal(result.diagnostics.length, 2);
  const diagnosticText = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
  assert.match(diagnosticText, /PI_SUBAGENT_FORWARD_/);
  assert.match(diagnosticText, /PI_SUBAGENT_FORWARD_lowercase/);
  assert.doesNotMatch(diagnosticText, /hidden-(?:empty-target|lowercase)-value/);
});

test("configured prefixes use longest-match precedence and report duplicate targets", () => {
  const result = successful(resolveSubagentEnvironment({
    PI_TASK_SUBAGENT_FORWARD_PREFIXES: "A_, A_B_, MY_AGENT_CHILD_",
    A_B_TRACE: "specific",
    A_FOO: "short-prefix",
    MY_AGENT_CHILD_FOO: "long-prefix",
  }));

  assert.deepEqual(result.environment, {
    FOO: "long-prefix",
    TRACE: "specific",
  });
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.kind === "ambiguous-prefix"));
  const duplicate = result.diagnostics.find((diagnostic) => diagnostic.kind === "duplicate-target");
  assert.ok(duplicate);
  assert.match(duplicate.message, /FOO/);
  assert.match(duplicate.message, /A_FOO/);
  assert.match(duplicate.message, /MY_AGENT_CHILD_FOO/);
  assert.doesNotMatch(duplicate.message, /short-prefix|long-prefix/);
});

test("invalid configured prefixes reject the launch configuration", () => {
  const result = resolveSubagentEnvironment({
    PI_TASK_SUBAGENT_FORWARD_PREFIXES: "GOOD_PREFIX_,bad-prefix",
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /bad-prefix/);
});

test("required launch environment wins over a forwarded collision", () => {
  const result = successful(
    resolveSubagentEnvironment(
      { PI_SUBAGENT_FORWARD_PI_TASK_TOOL_DISABLED: "0" },
      { PI_TASK_TOOL_DISABLED: "1" },
    ),
  );

  assert.deepEqual(result.environment, { PI_TASK_TOOL_DISABLED: "1" });
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.kind, "base-collision");
  assert.doesNotMatch(result.diagnostics[0]?.message ?? "", /[01]$/);
});

test("tmux quotes values but leaves validated assignment names unquoted", () => {
  const prefix = buildTmuxEnvironmentPrefix({
    PI_TASK_TOOL_DISABLED: "1",
    TRACE_CONTEXT: "$(touch /tmp/not-created); `echo unsafe` &&\nnext",
  });

  assert.equal(
    prefix,
    "PI_TASK_TOOL_DISABLED='1' TRACE_CONTEXT='$(touch /tmp/not-created); `echo unsafe` &&\nnext'",
  );
  assert.match(prefix, /TRACE_CONTEXT=/);
  assert.doesNotMatch(prefix, /'TRACE_CONTEXT'/);
});

test("shared terminal launch forwards the same resolved environment to HerdR", async () => {
  await withEnvironment({
    PI_SUBAGENT_FORWARD_REVIEW_MODE: "auto",
    PI_SUBAGENT_FORWARD_TRACE_CONTEXT: "a=b",
    PI_SUBAGENT_FORWARD_PI_TASK_TOOL_DISABLED: "0",
  }, async () => {
    let received: Record<string, string> | undefined;
    const result = await launchTerminalTask({
      backend: "herdr",
      terminalBackend: fakeHerdrBackend((input) => {
        received = input.env;
      }),
      agentArgs: ["--session", "task"],
      initialPrompt: "prompt",
      cwd: "/repo",
      sessionDir: "/repo/.pi/tasks/task",
      sessionName: "task",
      environment: { PI_TASK_TOOL_DISABLED: "1" },
      label: "task",
      remainOnExit: false,
      selfDestruct: true,
    });

    assert.equal(result.paneId, "pane-1");
    assert.deepEqual(received, {
      PI_TASK_TOOL_DISABLED: "1",
      REVIEW_MODE: "auto",
      TRACE_CONTEXT: "a=b",
    });
  });
});
