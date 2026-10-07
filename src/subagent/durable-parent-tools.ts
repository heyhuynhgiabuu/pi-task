/**
 * Bridge read-only, context-free parent tools into the durable harness.
 *
 * The durable backend hosts child conversations without Pi's extension runtime:
 * `ToolExecutionApi` (pi-durable) offers no `ExtensionToolContext` surface
 * (`executeTool`, session, UI), so arbitrary parent extension tools cannot be
 * bridged faithfully. What CAN be bridged are the context-free factories from
 * pi-coding-agent's core (`createGrepTool`/`createFindTool`/`createLsTool`):
 * pure local-filesystem `AgentTool`s whose `execute` needs only a signal and a
 * cwd. They adapt 1:1 to pi-durable `ToolRegistration`s.
 *
 * Deliberate exclusions:
 * - `read`/`write`/`edit`/`bash` stay owned by the harness-installed
 *   `CodingTools` so conversation policy keeps one authoritative source; the
 *   factory list below only ever names the read-only trio, and `task` (nested
 *   delegation guard, `PI_TASK_TOOL_DISABLED`) is never listed.
 * - Extension-runtime tools (codemode, MCP, peer, …) still need their live
 *   `ExtensionToolContext`; only requested names with a known package entry
 *   path are re-hosted through `loadParentExtensionTools`.
 *
 * Stored durable conversations persist tool NAMES only; the registry is rebuilt
 * here on every `openDurableHarness`, so resume re-resolves stored names.
 */

import { pathToFileURL } from "node:url";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

export const BRIDGE_EXTENSION_NAME = "pi-task-parent-tools";

/**
 * Adapt a context-free parent `AgentTool` to a durable `ToolRegistration`.
 *
 * - `signal` comes from the chord context (`context.abortSignal`), matching how
 *   pi-durable's own bash tool observes cancellation.
 * - cwd resolves per call from the invocation's execution environment, falling
 *   back to the conversation agent's cwd.
 * - `onUpdate` partial text streams through `api.output()`.
 * - `structuredContent` has no `ToolExecutionResult` representation and is
 *   folded into `details`; `terminate` maps to `control.terminate`.
 */
export function adaptAgentTool(
	tool: AgentTool<any, any>,
	options: { replaySafe?: boolean } = {},
): ToolRegistration {
	const replaySafe = options.replaySafe ?? true;
	const execute = async (
		args: unknown,
		api: Parameters<ToolRegistration["execute"]>[1],
		context: Context,
	): Promise<ToolExecutionResult> => {
		try {
			const result = await tool.execute(
				api.callId,
				args as never,
				context.abortSignal,
				(partial) => {
					const texts = (partial.content ?? []).filter(
						(block): block is { type: "text"; text: string } =>
							(block as { type?: string }).type === "text",
					);
					const text = texts.map((block) => block.text).join("");
					if (text) api.output(text);
				},
			);
			return {
				...(result.content !== undefined ? { content: result.content } : {}),
				...(result.details !== undefined
					? { details: result.details as never }
					: {}),
				...(result.usage !== undefined ? { usage: result.usage } : {}),
				...(result.isError === true ? { isError: true } : {}),
				...(result.terminate === true
					? { control: { terminate: true } as never }
					: {}),
			};
		} catch (error) {
			// Durable tools surface failures as error results, not thrown errors.
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Error: ${message}` }],
				details: { error: message },
				isError: true,
			};
		}
	};
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(replaySafe ? { replay: "safe" as const } : {}),
		execute,
	} as ToolRegistration;
}

/**
 * Captured tools from one installed extension package, per module entry path.
 * Re-invoking an entry is only safe against a shim, never the live parent API,
 * so results are cached for the process lifetime.
 */
const extensionToolCache = new Map<
	string,
	Promise<Map<string, AgentTool<any, any>>>
>();

/**
 * Minimal ExtensionAPI surface: registration calls are captured, everything
 * else becomes a no-op so packages whose setup touches other APIs still load.
 */
function extensionCaptureShim(captured: Map<string, AgentTool<any, any>>): unknown {
	const target: Record<string, unknown> = {
		registerTool: (tool: AgentTool<any, any>) => {
			if (
				tool &&
				typeof tool.name === "string" &&
				typeof tool.execute === "function"
			) {
				captured.set(tool.name, tool);
			}
		},
	};
	return new Proxy(target, {
		get: (t, property, receiver) =>
			property in t
				? Reflect.get(t, property, receiver)
				: () => undefined,
	});
}

/**
 * Load the tools one installed extension package registers, by invoking its
 * default export against a capturing shim instead of the parent's live
 * ExtensionAPI. Only context-free tools actually work when re-hosted in the
 * durable harness; a tool whose execute needs the extension runtime surfaces a
 * tool error inside the child if ever called. Shim no-ops (appendEntry) can
 * degrade side features (e.g. pi-search's stored fetch content for
 * get_fetch_content) without breaking the tool's primary output.
 */
export function loadParentExtensionTools(
	entryPath: string,
): Promise<Map<string, AgentTool<any, any>>> {
	const cached = extensionToolCache.get(entryPath);
	if (cached) return cached;
	const loading = (async () => {
		try {
			const mod: unknown = await import(pathToFileURL(entryPath).href);
			const create = (mod as { default?: unknown }).default ?? mod;
			if (typeof create !== "function") {
				return new Map<string, AgentTool<any, any>>();
			}
			const captured = new Map<string, AgentTool<any, any>>();
			await (create as (api: unknown) => unknown)(
				extensionCaptureShim(captured),
			);
			return captured;
		} catch (error) {
			// A failed load must not poison the cache: the next run may succeed
			// (transient config) or surface the error again.
			extensionToolCache.delete(entryPath);
			throw error;
		}
	})();
	loading.catch(() => undefined);
	extensionToolCache.set(entryPath, loading);
	return loading;
}

/**
 * Load the read-only parent-tool bridge, or `undefined` when the peer's
 * context-free factories are unavailable (keeps the durable backend optional).
 */
export async function loadDurableParentToolBridge(): Promise<
	{ name: string; tools: ToolRegistration[] } | undefined
> {
	try {
		const sdk = await import("@earendil-works/pi-coding-agent");
		const candidates: AgentTool<any, any>[] = [];
		for (const create of [
			sdk.createGrepTool,
			sdk.createFindTool,
			sdk.createLsTool,
		] as const) {
			try {
				candidates.push(create(process.cwd()));
			} catch {
				// A factory failing to construct drops that single tool, never the backend.
			}
		}
		return {
			name: BRIDGE_EXTENSION_NAME,
			tools: candidates.map((tool) =>
				adaptAgentTool(tool, { replaySafe: true }),
			),
		};
	} catch {
		return undefined;
	}
}
