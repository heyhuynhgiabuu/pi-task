import assert from "node:assert/strict";
import test from "node:test";

import {
  createHerdrTerminalBackend,
  createSyncHerdrControl,
} from "../src/subagent/herdr.js";
import { buildPiArgs, type AgentConfig } from "../src/helpers.js";

function processInfoResult(
  paneId = "w1:p2",
  foregroundProcessGroupId = 123,
) {
  return {
    stdout: JSON.stringify({
      result: {
        process_info: {
          pane_id: paneId,
          foreground_process_group_id: foregroundProcessGroupId,
        },
      },
    }),
    stderr: "",
  };
}

test("HerdR Pi argv defers the raw task prompt instead of using a file attachment", () => {
  const agent: AgentConfig = {
    name: "reviewer",
    description: "Reviews code",
    body: "# Reviewer\n\nInspect the diff.",
    source: "user",
  };
  const args = buildPiArgs(
    agent,
    "task-reviewer",
    "/repo/.pi/tasks/reviewer",
    "# Task\n\nReview the current diff.",
    false,
    ["read", "bash"],
    "task",
    undefined,
    {
      systemPromptPath: "/repo/.pi/tasks/reviewer/agent-system-prompt.md",
      deferTaskPrompt: true,
    },
  );

  assert.ok(
    args.every((arg) => !/[\u0000-\u001f\u007f]/u.test(arg)),
    "HerdR rejects agent argv containing control characters",
  );
  assert.ok(args.includes("/repo/.pi/tasks/reviewer/agent-system-prompt.md"));
  assert.ok(!args.some((arg) => arg.startsWith("@")));
  assert.ok(!args.includes("# Task\n\nReview the current diff."));
  assert.ok(!args.includes(agent.body));
});

test("grouped HerdR launch starts Pi in the new workspace root pane", async () => {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const outputs = [
    JSON.stringify({
      workspace: { workspace_id: "w2" },
      root_pane: { pane_id: "w2:p1" },
    }),
    JSON.stringify({ pane: { pane_id: "w2:p1", terminal_id: "term-1" } }),
    JSON.stringify({ agent: { pane_id: "w2:p1", terminal_id: "term-1" } }),
  ];
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args, options) => {
      calls.push({ args: [...args], env: options?.env });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    },
  });

  const handle = await backend.launch({
    cwd: "/repo",
    agentArgs: ["--session", "task"],
    workspaceGroup: "parallel-retry",
  });

  assert.deepEqual(handle, {
    backend: "herdr",
    resourceId: "w2:p1",
    socketPath: "/tmp/herdr.sock",
    terminalId: "term-1",
    workspaceId: "w2",
    workspaceGroup: "parallel-retry",
  });
  assert.deepEqual(calls.map(({ args }) => args), [
    [
      "workspace",
      "create",
      "--cwd",
      "/repo",
      "--label",
      "parallel-retry",
      "--no-focus",
    ],
    ["pane", "get", "w2:p1"],
    [
      "agent",
      "start",
      "pi-task",
      "--kind",
      "pi",
      "--pane",
      "w2:p1",
      "--",
      "--session",
      "task",
    ],
  ]);
});

test("HerdR launch retries until a new workspace root is an available shell", async () => {
  let agentStarts = 0;
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      if (args[0] === "workspace") {
        return {
          stdout: JSON.stringify({
            workspace: { workspace_id: "w-ready" },
            root_pane: { pane_id: "w-ready:p1" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w-ready:p1", terminal_id: "term-ready" },
          }),
          stderr: "",
        };
      }
      agentStarts += 1;
      if (agentStarts === 1) {
        throw Object.assign(new Error("herdr exited unsuccessfully"), {
          stderr: '{"error":{"code":"agent_pane_busy"}}',
        });
      }
      return {
        stdout: JSON.stringify({
          agent: { pane_id: "w-ready:p1", terminal_id: "term-ready" },
        }),
        stderr: "",
      };
    },
  });

  const handle = await backend.launch({
    cwd: "/repo",
    agentArgs: ["--session", "task"],
    workspaceGroup: "shell-ready-retry",
  });

  assert.equal(agentStarts, 2);
  assert.equal(handle.resourceId, "w-ready:p1");
});

test("ungrouped HerdR launch splits the caller pane before starting Pi", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent") {
        return {
          stdout: JSON.stringify({
            agent: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  const handle = await backend.launch({
    cwd: "/repo",
    agentArgs: ["--session", "task"],
  });

  assert.deepEqual(handle, {
    backend: "herdr",
    resourceId: "w1:p2",
    socketPath: "/tmp/herdr.sock",
    terminalId: "term-2",
  });
  assert.deepEqual(calls, [
    [
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      "/repo",
      "--no-focus",
    ],
    [
      "agent",
      "start",
      "pi-task",
      "--kind",
      "pi",
      "--pane",
      "w1:p2",
      "--",
      "--session",
      "task",
    ],
  ]);
});

test("HerdR submits the initial task prompt with a bounded lifecycle wait", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: "term-2",
                name: "pi-task",
                agent: "pi",
                agent_status: "idle",
                state_change_seq: 10,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult();
      }
      return {
        stdout: JSON.stringify({
          agent: { pane_id: "w1:p2", terminal_id: "term-2" },
        }),
        stderr: "",
      };
    },
  });
  const initialPrompt = "# Task: review\n\nInspect the diff exactly as written.";

  await backend.launch({
    cwd: "/repo",
    agentArgs: ["--session", "task"],
    initialPrompt,
  });

  assert.deepEqual(calls.at(-1), [
    "agent",
    "prompt",
    "w1:p2",
    initialPrompt,
    "--wait",
    "--until",
    "working",
    "--until",
    "blocked",
    "--until",
    "done",
    "--timeout",
    "8000",
  ]);
  assert.ok(
    calls.some((args) => args[0] === "pane" && args[1] === "process-info"),
  );
  assert.ok(
    calls.some(
      (args) =>
        args.join(" ") === "pane process-info --pane w1:p2",
    ),
  );
});

test("HerdR retries only a stalled prompt and requires a newer sequence", async () => {
  const calls: string[][] = [];
  let agentGets = 0;
  let retrySent = false;
  const backend = createHerdrTerminalBackend({
    promptTimeoutMs: 5_001,
    retryTimeoutMs: 5,
    retryPollMs: 1,
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          stdout: JSON.stringify({
            agent: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        const error = new Error("prompt stalled") as Error & { stderr?: string };
        error.stderr = JSON.stringify({
          error: {
            code: "agent_prompt_stalled",
            message:
              "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 10",
          },
        });
        throw error;
      }
      if (args[0] === "agent" && args[1] === "get") {
        agentGets += 1;
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: "term-2",
                name: "pi-task",
                agent: "pi",
                agent_status: "idle",
                state_change_seq: retrySent ? 11 : 10,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult();
      }
      if (args[0] === "agent" && args[1] === "send-keys") {
        retrySent = true;
      }
      return {
        stdout: JSON.stringify({
          agent: { pane_id: "w1:p2", terminal_id: "term-2" },
        }),
        stderr: "",
      };
    },
  });

  await backend.launch({
    cwd: "/repo",
    agentArgs: ["--session", "task"],
    initialPrompt: "Review the diff.",
  });

  assert.ok(
    calls.some((args) => args[0] === "agent" && args[1] === "send-keys"),
  );
  assert.deepEqual(
    calls.find((args) => args[0] === "agent" && args[1] === "send-keys"),
    ["agent", "send-keys", "pi-task", "enter"],
  );
  assert.ok(
    calls.some((args) => args[0] === "agent" && args[1] === "get"),
  );
});

test("HerdR uses HerdR's stalled sequence baseline before retrying", async () => {
  const calls: string[][] = [];
  let agentGets = 0;
  let retrySent = false;
  const backend = createHerdrTerminalBackend({
    promptTimeoutMs: 5_001,
    retryTimeoutMs: 5,
    retryPollMs: 1,
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          stdout: JSON.stringify({
            agent: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        const error = new Error("prompt stalled") as Error & { stderr?: string };
        error.stderr = JSON.stringify({
          error: {
            code: "agent_prompt_stalled",
            message:
              "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 11",
          },
        });
        throw error;
      }
      if (args[0] === "agent" && args[1] === "get") {
        agentGets += 1;
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: "term-2",
                name: "pi-task",
                agent: "pi",
                agent_status: retrySent ? "working" : "idle",
                state_change_seq: retrySent ? 12 : agentGets === 1 ? 10 : 11,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult();
      }
      if (args[0] === "agent" && args[1] === "send-keys") {
        retrySent = true;
      }
      return { stdout: "", stderr: "" };
    },
  });

  await backend.launch({
    cwd: "/repo",
    agentArgs: ["--session", "task"],
    initialPrompt: "Review the diff.",
  });

  assert.deepEqual(
    calls.find((args) => args[0] === "agent" && args[1] === "send-keys"),
    ["agent", "send-keys", "pi-task", "enter"],
  );
});

test("HerdR does not retry an ordinary prompt timeout", async () => {
  const calls: string[][] = [];
  let agentGets = 0;
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          stdout: JSON.stringify({
            agent: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        const error = new Error("prompt timed out") as Error & { stderr?: string };
        error.stderr = JSON.stringify({
          error: { code: "timeout", message: "timed out waiting for agent status" },
        });
        throw error;
      }
      if (args[0] === "agent" && args[1] === "get") {
        agentGets += 1;
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: "term-2",
                name: "pi-task",
                agent: "pi",
                agent_status: "working",
                state_change_seq: agentGets > 1 ? 11 : 10,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult();
      }
      return {
        stdout: JSON.stringify({
          agent: { pane_id: "w1:p2", terminal_id: "term-2" },
        }),
        stderr: "",
      };
    },
  });

  await backend.launch({
    cwd: "/repo",
    agentArgs: ["--session", "task"],
    initialPrompt: "Review the diff.",
  });

  assert.equal(
    calls.some((args) => args[0] === "agent" && args[1] === "send-keys"),
    false,
  );
});

test("HerdR tolerates optional session metadata changing during a retry", async () => {
  let agentGets = 0;
  let retrySent = false;
  const backend = createHerdrTerminalBackend({
    promptTimeoutMs: 5_001,
    retryTimeoutMs: 5,
    retryPollMs: 1,
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          stdout: JSON.stringify({
            agent: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        const error = new Error("prompt stalled") as Error & { stderr?: string };
        error.stderr = JSON.stringify({
          error: {
            code: "agent_prompt_stalled",
            message:
              "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 10",
          },
        });
        throw error;
      }
      if (args[0] === "agent" && args[1] === "get") {
        agentGets += 1;
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: "term-2",
                name: "pi-task",
                agent: "pi",
                agent_status: retrySent ? "working" : "idle",
                state_change_seq: retrySent ? 11 : 10,
                ...(agentGets === 1
                  ? { agent_session: { value: "session-old" } }
                  : {}),
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult();
      }
      if (args[0] === "agent" && args[1] === "send-keys") {
        retrySent = true;
      }
      return { stdout: "", stderr: "" };
    },
  });

  await backend.launch({
    cwd: "/repo",
    agentArgs: ["--session", "task"],
    initialPrompt: "Review the diff.",
  });
});

test("HerdR rejects a dropped retry Enter instead of accepting stale state", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    promptTimeoutMs: 5_001,
    retryTimeoutMs: 5,
    retryPollMs: 1,
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        const error = new Error("prompt stalled") as Error & { stderr?: string };
        error.stderr = JSON.stringify({
          error: {
            code: "agent_prompt_stalled",
            message:
              "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 10",
          },
        });
        throw error;
      }
      if (args[0] === "agent" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: "term-2",
                name: "pi-task",
                agent: "pi",
                agent_status: "idle",
                state_change_seq: 10,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult();
      }
      if (args[0] === "pane" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2", agent: "pi" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          stdout: JSON.stringify({
            agent: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    backend.launch({
      cwd: "/repo",
      agentArgs: ["--session", "task"],
      initialPrompt: "Review the diff.",
    }),
    /no confirmed lifecycle transition/i,
  );
  assert.ok(
    calls.some((args) => args[0] === "agent" && args[1] === "send-keys"),
  );
  assert.equal(
    calls.some((args) => args[0] === "agent" && args[1] === "wait"),
    false,
  );
});

test("HerdR rejects a replacement agent and does not clean up its pane", async () => {
  const calls: string[][] = [];
  let agentGets = 0;
  let retrySent = false;
  const backend = createHerdrTerminalBackend({
    promptTimeoutMs: 5_001,
    retryTimeoutMs: 5,
    retryPollMs: 1,
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        const error = new Error("prompt stalled") as Error & { stderr?: string };
        error.stderr = JSON.stringify({
          error: {
            code: "agent_prompt_stalled",
            message:
              "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 10",
          },
        });
        throw error;
      }
      if (args[0] === "agent" && args[1] === "get") {
        agentGets += 1;
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: retrySent ? "term-replaced" : "term-2",
                name: "pi-task",
                agent: "pi",
                agent_status: "working",
                state_change_seq: retrySent ? 11 : 10,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult(
          "w1:p2",
          retrySent ? 124 : 123,
        );
      }
      if (args[0] === "agent" && args[1] === "send-keys") {
        retrySent = true;
      }
      if (args[0] === "pane" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            pane: {
              pane_id: "w1:p2",
              terminal_id: "term-replaced",
              agent: "shell",
            },
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          agent: { pane_id: "w1:p2", terminal_id: "term-2" },
        }),
        stderr: "",
      };
    },
  });

  await assert.rejects(
    backend.launch({
      cwd: "/repo",
      agentArgs: ["--session", "task"],
      initialPrompt: "Review the diff.",
    }),
    /identity|replacement|terminal/i,
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "close"),
    false,
  );
});

test("HerdR skips destructive cleanup when initial identity capture fails", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          stdout: JSON.stringify({
            agent: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "get") {
        throw new Error("agent lookup unavailable");
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult();
      }
      if (args[0] === "pane" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2", agent: "pi" },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    backend.launch({
      cwd: "/repo",
      agentArgs: ["--session", "task"],
      initialPrompt: "Review the diff.",
    }),
    /identity|lookup|unavailable/i,
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "close"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "workspace" && args[1] === "close"),
    false,
  );
});

test("HerdR skips destructive cleanup when agent startup fails before identity capture", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        throw new Error("agent start failed");
      }
      if (args[0] === "pane" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2", agent: "pi" },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    backend.launch({
      cwd: "/repo",
      agentArgs: ["--session", "task"],
    }),
    /agent start failed/i,
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "close"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "workspace" && args[1] === "close"),
    false,
  );
});

test("HerdR cleans up after a prompt failure once identity was captured", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        return {
          stdout: JSON.stringify({
            agent: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: "term-2",
                name: "pi-task",
                agent: "pi",
                agent_status: "idle",
                state_change_seq: 10,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return processInfoResult();
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        throw new Error("prompt failed before HerdR returned a structured error");
      }
      if (args[0] === "pane" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2", agent: "pi" },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    backend.launch({
      cwd: "/repo",
      agentArgs: ["--session", "task"],
      initialPrompt: "Review the diff.",
    }),
    /prompt failed/i,
  );
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "close"),
    true,
  );
});

test("parallel HerdR launches serialize workspace and pane creation", async () => {
  let activeRuns = 0;
  let maxActiveRuns = 0;
  let nextPane = 2;
  const run = async (_command: string, args: readonly string[]) => {
    if (args[0] === "workspace") {
      return {
        stdout: JSON.stringify({
          workspace: { workspace_id: "w1" },
          root_pane: { pane_id: "w1:p1" },
        }),
        stderr: "",
      };
    }
    if (args[0] === "pane" && args[1] === "get") {
      return {
        stdout: JSON.stringify({
          pane: { pane_id: "w1:p1", terminal_id: "term-1" },
        }),
        stderr: "",
      };
    }
    if (args[0] === "pane" && args[1] === "split") {
      const pane = nextPane++;
      return {
        stdout: JSON.stringify({
          pane: { pane_id: `w1:p${pane}`, terminal_id: `term-${pane}` },
        }),
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "start") {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeRuns -= 1;
      const paneId = args[args.indexOf("--pane") + 1]!;
      return {
        stdout: JSON.stringify({
          agent: {
            pane_id: paneId,
            terminal_id: `term-${paneId.split("p").at(-1)}`,
          },
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  const env = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  };
  const first = createHerdrTerminalBackend({ env, run });
  const second = createHerdrTerminalBackend({ env, run });

  const handles = await Promise.all([
    first.launch({
      agentArgs: ["first"],
      cwd: "/repo",
      workspaceGroup: "parallel-launch",
    }),
    second.launch({
      agentArgs: ["second"],
      cwd: "/repo",
      workspaceGroup: "parallel-launch",
    }),
  ]);

  assert.equal(maxActiveRuns, 1);
  assert.equal(new Set(handles.map((handle) => handle.terminalId)).size, 2);
});

test("HerdR ownership is checked before reads", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      return {
        stdout: JSON.stringify({
          pane: { pane_id: "w1:p2", terminal_id: "another-terminal" },
        }),
        stderr: "",
      };
    },
  });

  await assert.rejects(
    backend.readTail(
      {
        backend: "herdr",
        resourceId: "w1:p2",
        socketPath: "/tmp/herdr.sock",
        terminalId: "term-2",
      },
      20,
    ),
    /ownership/i,
  );
  assert.equal(calls.length, 1);
});

test("HerdR liveness requires the owned pane to still host Pi", async () => {
  const handle = {
    backend: "herdr" as const,
    resourceId: "w1:p2",
    socketPath: "/tmp/herdr.sock",
    terminalId: "term-2",
  };

  for (const [agent, expected] of [["pi", true], [null, false]] as const) {
    const backend = createHerdrTerminalBackend({
      env: {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      },
      run: async () => ({
        stdout: JSON.stringify({
          pane: {
            pane_id: "w1:p2",
            terminal_id: "term-2",
            agent,
          },
        }),
        stderr: "",
      }),
    });

    assert.equal(await backend.isAlive(handle), expected);
  }
});

test("HerdR cleanup closes the task workspace without requiring a live agent pane", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
    run: async (_command, args) => {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    },
  });

  await backend.close({
    backend: "herdr",
    resourceId: "w2:p2",
    socketPath: "/tmp/herdr.sock",
    terminalId: "term-2",
    workspaceId: "w2",
  });

  assert.deepEqual(calls, [["workspace", "close", "w2"]]);
});

test("HerdR cleanup after restart closes only an untracked grouped task pane", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
    run: async (_command, args) => {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    },
  });

  await backend.close({
    backend: "herdr",
    resourceId: "w2:p2",
    socketPath: "/tmp/herdr.sock",
    terminalId: "term-2",
    workspaceId: "w2",
    workspaceGroup: "post-restart",
  });

  assert.deepEqual(calls, [["pane", "close", "w2:p2"]]);
});

test("sync steering accepts HerdR mutation commands with empty stdout", () => {
  const calls: string[][] = [];
  const control = createSyncHerdrControl(
    { HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
    (args) => {
      calls.push([...args]);
      if (args[1] === "get") {
        return JSON.stringify({
          pane: { pane_id: "w1:p2", terminal_id: "term-2" },
        });
      }
      return "";
    },
  );
  const handle = {
    backend: "herdr" as const,
    resourceId: "w1:p2",
    socketPath: "/tmp/herdr.sock",
    terminalId: "term-2",
  };

  control.send(handle, "follow up");
  assert.deepEqual(calls, [
    ["pane", "get", "w1:p2"],
    ["pane", "send-text", "w1:p2", "follow up"],
    ["pane", "send-keys", "w1:p2", "enter"],
  ]);
});

test("sync cleanup closes a task-owned HerdR workspace without a live pane", () => {
  const calls: string[][] = [];
  const control = createSyncHerdrControl(
    { HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
    (args) => {
      calls.push([...args]);
      return "";
    },
  );

  control.close({
    backend: "herdr",
    resourceId: "w2:p2",
    socketPath: "/tmp/herdr.sock",
    terminalId: "term-2",
    workspaceId: "w2",
  });

  assert.deepEqual(calls, [["workspace", "close", "w2"]]);
});

test("sync cleanup after restart closes only an untracked grouped task pane", () => {
  const calls: string[][] = [];
  const control = createSyncHerdrControl(
    { HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
    (args) => {
      calls.push([...args]);
      return "";
    },
  );

  control.close({
    backend: "herdr",
    resourceId: "w2:p2",
    socketPath: "/tmp/herdr.sock",
    terminalId: "term-2",
    workspaceId: "w2",
    workspaceGroup: "post-restart-sync",
  });

  assert.deepEqual(calls, [["pane", "close", "w2:p2"]]);
});

test("sync cleanup ignores an already-closed HerdR workspace", () => {
  const control = createSyncHerdrControl(
    { HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
    () => {
      throw new Error("workspace_not_found");
    },
  );

  assert.doesNotThrow(() =>
    control.close({
      backend: "herdr",
      resourceId: "w2:p2",
      socketPath: "/tmp/herdr.sock",
      terminalId: "term-2",
      workspaceId: "w2",
    }),
  );
});

test("async steering sends text followed by exactly one delayed Enter", async () => {
  const calls: string[][] = [];
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[1] === "get") {
        return {
          stdout: JSON.stringify({
            pane: { pane_id: "w1:p2", terminal_id: "term-2" },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  await backend.send(
    {
      backend: "herdr",
      resourceId: "w1:p2",
      socketPath: "/tmp/herdr.sock",
      terminalId: "term-2",
    },
    "follow up",
  );

  assert.deepEqual(calls, [
    ["pane", "get", "w1:p2"],
    ["pane", "send-text", "w1:p2", "follow up"],
    ["pane", "send-keys", "w1:p2", "enter"],
  ]);
});

test("HerdR transport failures are not reported as dead panes", async () => {
  const backend = createHerdrTerminalBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    },
    run: async () => {
      throw new Error("connection refused");
    },
  });

  await assert.rejects(
    backend.isAlive({
      backend: "herdr",
      resourceId: "w1:p2",
      socketPath: "/tmp/herdr.sock",
      terminalId: "term-2",
    }),
    (error: unknown) =>
      error instanceof Error && error.name === "HerdrUnavailableError",
  );
});
