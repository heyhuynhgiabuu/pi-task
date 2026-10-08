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

test("durable conversations survive without a terminal on every explicit durable preference", () => {
	withPreferenceEnv({}, () => {
		for (const overrides of [
			{ settingsBackend: "durable" },
			{ settingsBackend: "Durable" },
		]) {
			assert.equal(
				gate({ conversationId: "conv-1", ...overrides }).kind,
				"allowed",
				`settings ${String(overrides.settingsBackend)} allows durable conversations`,
			);
		}
	});
	withPreferenceEnv({ PI_TASK_BACKEND: "durable" }, () => {
		assert.equal(gate({ conversationId: "conv-1" }).kind, "allowed");
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

test("prepareTaskExecution admits durable conversations without a terminal", async () => {
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
		assert.equal(prepared.kind, "continue", "a durable conversation must not be rejected for lacking tmux");
	} finally {
		rmSync(artifactsDir, { recursive: true, force: true });
	}
});
