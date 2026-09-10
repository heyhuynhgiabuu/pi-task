/**
 * The parent-side fast entry point.
 *
 * It exists so one `--fast` covers the parent's own model calls as well as
 * everything it delegates to. The bridge itself is exercised elsewhere; what
 * matters here is that nothing is installed unless the flag is set, because
 * installing it unconditionally would override a globally installed
 * pi-codex-fast for every session.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import fastExtension from "../src/fast.js";

interface Harness {
	flags: Map<string, unknown>;
	handlers: Map<string, () => void>;
	providers: string[];
}

function harness(flagValue: boolean | string | undefined): Harness {
	const flags = new Map<string, unknown>();
	const handlers = new Map<string, () => void>();
	const providers: string[] = [];
	const pi = {
		registerFlag(name: string, options: { default?: unknown }) {
			flags.set(name, options.default);
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
	fastExtension(pi as never);
	return { flags, handlers, providers };
}

test("the fast entry point registers the flag and defers to session start", () => {
	const { flags, handlers, providers } = harness(undefined);

	assert.equal(flags.get("fast"), false, "the flag defaults to false");
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
