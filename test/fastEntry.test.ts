/**
 * The parent-side fast mode setup.
 *
 * It exists so one `--fast` covers the parent's own model calls as well as
 * everything it delegates to. The bridge itself is exercised elsewhere; what
 * matters here is that nothing is installed unless the shared flag is set,
 * because installing it unconditionally would change every session.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { registerParentFastMode } from "../src/fast.js";

interface Harness {
	handlers: Map<string, () => void>;
	providers: string[];
}

function harness(flagValue: boolean | string | undefined): Harness {
	const handlers = new Map<string, () => void>();
	const providers: string[] = [];
	const pi = {
		registerFlag() {
			throw new Error("the shared fast flag must be registered by index.ts");
		},
		getFlag(name: string) {
			return name === "fast" ? flagValue : undefined;
		},
		on(event: string, handler: () => void) {
			handlers.set(event, handler);
		},
		registerProvider(name: string) {
			providers.push(name);
		},
	};
	registerParentFastMode(pi as never);
	return { handlers, providers };
}

test("parent fast mode reuses the shared flag and defers to session start", () => {
	const { handlers, providers } = harness(undefined);

	assert.ok(handlers.has("session_start"), "the bridge is decided at session start");
	assert.deepEqual(providers, [], "nothing is registered at load time");
});

test("the bridge is installed only when the session flag is set", () => {
	const off = harness(false);
	off.handlers.get("session_start")?.();
	assert.deepEqual(off.providers, [], "a false flag installs nothing");

	const unset = harness(undefined);
	unset.handlers.get("session_start")?.();
	assert.deepEqual(unset.providers, [], "an unset flag installs nothing");

	const on = harness(true);
	on.handlers.get("session_start")?.();
	assert.deepEqual(on.providers, ["openai", "openai-codex"], "a true flag installs both providers");
});
