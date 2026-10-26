import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/helpers.js";
import {
	evaluateDurableConversationGate,
	prepareTaskExecution,
} from "../src/lifecycle/task-preparation.js";

const agent: AgentConfig = {
	name: "test",
	description: "test agent",
	body: "",
	source: "bundled",
	path: "/agents/test.md",
};

const PREFERENCE_ENV_VARS = [
	"PI_TASK_BACKEND",
	"PI_TASK_USE_SDK_BACKEND",
	"PI_TASK_USE_TMUX_BACKEND",
] as const;

function withPreferenceEnv<T>(values: Partial<Record<(typeof PREFERENCE_ENV_VARS)[number], string>>, run: () => T): T {
	const saved = new Map(PREFERENCE_ENV_VARS.map((name) => [name, process.env[name]]));
	try {
		for (const name of PREFERENCE_ENV_VARS) delete process.env[name];
		for (const [name, value] of Object.entries(values)) process.env[name] = value;
		return run();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function gate(overrides: {
	conversationId?: string;
	settingsBackend?: string;
	tmuxAvailable?: boolean;
	herdrContextAvailable?: boolean;
}) {
	return evaluateDurableConversationGate({
		tmuxAvailable: false,
		herdrContextAvailable: false,
		...overrides,
	});
}

test("an explicit durable preference rejects conversations even with a terminal", () => {
	for (const overrides of [{ settingsBackend: "durable" }, { settingsBackend: "Durable" }]) {
		withPreferenceEnv({}, () => {
			const decision = gate({
				conversationId: "conv-1",
				tmuxAvailable: true,
				herdrContextAvailable: true,
				...overrides,
			});
			assert.equal(decision.kind, "rejected", `settings ${overrides.settingsBackend}`);
			assert(decision.kind === "rejected");
			assert.equal(decision.result.details.error, "tmux required for durable conversation");
			assert.match(String(decision.result.content[0]?.text), /task_id/);
		});
	}
	withPreferenceEnv({ PI_TASK_BACKEND: "durable" }, () => {
		assert.equal(gate({ conversationId: "conv-1", tmuxAvailable: true }).kind, "rejected");
	});
	withPreferenceEnv({ PI_TASK_USE_TMUX_BACKEND: "1" }, () => {
		assert.equal(gate({ conversationId: "conv-1" }).kind, "rejected");
	});
});

test("sdk and terminal-less auto preferences still reject conversations", () => {
	withPreferenceEnv({}, () => {
		assert.equal(gate({ conversationId: "conv-1", settingsBackend: "sdk" }).kind, "rejected");
	});
	withPreferenceEnv({ PI_TASK_BACKEND: "sdk" }, () => {
		assert.equal(gate({ conversationId: "conv-1" }).kind, "rejected");
	});
	withPreferenceEnv({ PI_TASK_USE_SDK_BACKEND: "1" }, () => {
		assert.equal(gate({ conversationId: "conv-1" }).kind, "rejected");
	});
	withPreferenceEnv({}, () => {
		const decision = gate({ conversationId: "conv-1" });
		assert.equal(decision.kind, "rejected");
		assert(decision.kind === "rejected");
		assert.equal(decision.result.isError, true);
		assert.equal(decision.result.details.error, "tmux required for durable conversation");
	});
});

test("terminal availability keeps conversations working on auto and terminal preferences", () => {
	withPreferenceEnv({}, () => {
		assert.equal(gate({ conversationId: "conv-1", tmuxAvailable: true }).kind, "allowed");
		assert.equal(gate({ conversationId: "conv-1", herdrContextAvailable: true }).kind, "allowed");
		assert.equal(gate({ conversationId: "conv-1", settingsBackend: "tmux", tmuxAvailable: true }).kind, "allowed");
	});
	withPreferenceEnv({ PI_TASK_BACKEND: "tmux" }, () => {
		assert.equal(gate({ conversationId: "conv-1", tmuxAvailable: true }).kind, "allowed");
		assert.equal(gate({ conversationId: "conv-1" }).kind, "rejected");
	});
});

test("missing conversation_id never trips the gate", () => {
	withPreferenceEnv({ PI_TASK_BACKEND: "sdk" }, () => {
		assert.equal(gate({}).kind, "allowed");
	});
});

test("an invalid backend preference defers to the backend resolver instead of the gate", () => {
	withPreferenceEnv({ PI_TASK_BACKEND: "warp" }, () => {
		assert.equal(gate({ conversationId: "conv-1" }).kind, "allowed");
	});
});

test("prepareTaskExecution rejects a conversation under the durable preference", async () => {
	const artifactsDir = mkdtempSync(join(tmpdir(), "pi-task-conversation-gate-"));
	try {
		const prepared = await withPreferenceEnv({ PI_TASK_BACKEND: "durable" }, () =>
			prepareTaskExecution({
				taskParams: {
					agent_type: "general",
					prompt: "do the work",
					description: "gate",
				},
				agent,
				ctx: { cwd: artifactsDir, isProjectTrusted: () => true } as unknown as ExtensionContext,
				artifactsDir,
				id: "t-gate-1",
				conversationId: "conv-gate",
			}));
		assert(prepared.kind === "handled", "the durable backend cannot reopen a named conversation");
		assert.equal(prepared.result.details.error, "tmux required for durable conversation");
	} finally {
		rmSync(artifactsDir, { recursive: true, force: true });
	}
});
