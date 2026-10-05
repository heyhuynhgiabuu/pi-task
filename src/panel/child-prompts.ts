import {
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
  type PromptTemplate,
  type SlashCommandInfo,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  type AutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type {
  ChildBuiltinCommand,
  ChildBuiltinCommandBackend,
} from "../types.js";

/**
 * Pi 1.0.2 exposes the resource loader and autocomplete provider at the package
 * root, but keeps prompt-template loading/expansion and built-in command names
 * internal. Resolve those two native modules relative to Pi's exported entry
 * point rather than copying Pi's argument grammar or its built-in list.
 */
type NativePromptApis = [
  { expandPromptTemplate(text: string, templates: PromptTemplate[]): string },
  {
    BUILTIN_SLASH_COMMANDS: ReadonlyArray<{
      name: string;
      description: string;
      argumentHint?: string;
    }>;
  },
];

let nativePromptApisPromise: Promise<NativePromptApis> | undefined;

function loadNativePromptApis(): Promise<NativePromptApis> {
  if (nativePromptApisPromise) return nativePromptApisPromise;
  const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  nativePromptApisPromise = Promise.all([
    import(new URL("./core/prompt-templates.js", piEntryUrl).href),
    import(new URL("./core/slash-commands.js", piEntryUrl).href),
  ]) as Promise<NativePromptApis>;
  return nativePromptApisPromise;
}

/**
 * Pi 1.0.2 dispatches three private debug commands absent from its exported
 * command list. `/llama` is documented in this release's docs but is absent
 * from both the list and the interactive dispatcher. Reserve all four names
 * rather than letting a prompt template make them look like supported Pi
 * controls in a child editor.
 */
const EXTRA_RESERVED_BUILTINS = [
  "debug",
  "arminsayshi",
  "dementedelves",
  "llama",
] as const;

const CHILD_BUILTIN_NAMES: Record<ChildBuiltinCommandBackend, readonly string[]> = {
  sdk: ["model", "thinking", "name", "session"],
  durable: ["model", "thinking", "session"],
  terminal: ["thinking", "name"],
  none: [],
};

function childBuiltinDescription(
  name: string,
  backend: ChildBuiltinCommandBackend,
): { description: string; argumentHint?: string } {
  if (name === "model") {
    return {
      description: "Set or inspect the child session model (does not change the parent)",
      argumentHint: "<provider/model>",
    };
  }
  if (name === "thinking") {
    return backend === "terminal"
      ? {
          description: "Set the child thinking level; a level is required because its selector is hidden",
          argumentHint: "<level>",
        }
      : {
          description: "Set or inspect the child session thinking level",
          argumentHint: "<level>",
        };
  }
  if (name === "name") {
    return backend === "terminal"
      ? {
          description: "Set the child session display name (requires a name)",
          argumentHint: "<name>",
        }
      : {
          description: "Set or inspect the child session display name",
          argumentHint: "[name]",
        };
  }
  if (name === "session") {
    return { description: "Show this child session's information and statistics" };
  }
  return { description: `Run /${name} in this child session` };
}

/** Native Pi controls the selected child-session view can actually perform. */
export async function availableChildBuiltinCommands(
  backend: ChildBuiltinCommandBackend,
): Promise<SlashCommand[]> {
  const [, commandApi] = await loadNativePromptApis();
  const supported = new Set(CHILD_BUILTIN_NAMES[backend]);
  return commandApi.BUILTIN_SLASH_COMMANDS
    .filter(({ name }) => supported.has(name))
    .map(({ name }) => ({
      name,
      ...childBuiltinDescription(name, backend),
    }));
}

function unsupportedBuiltinMessage(
  name: string,
  backend: ChildBuiltinCommandBackend,
): string {
  if (name === "login" || name === "logout") {
    return `/${name} is disabled in child views: Pi's credential store is shared with the parent, and child controls never read or mutate credentials.`;
  }
  if (name === "trust") {
    return "/trust is disabled in child views because it changes project trust for future Pi sessions; no child-scoped confirmation flow is available.";
  }
  if (["copy", "export", "share", "bug"].includes(name)) {
    return `/${name} is disabled in child views because it copies, exports, or shares private session data; an explicit export-confirmation flow is not available here.`;
  }
  if (name === "quit") {
    const stop = backend === "durable"
      ? "Use /task cancel <task-id> to cancel a durable child."
      : backend === "terminal"
        ? "Use the child task's stop control to stop its process."
        : backend === "sdk"
          ? "This SDK task has no panel cancellation API."
          : "This comparison transcript has no child-control handle.";
    return `/quit is never forwarded from a child editor. ${stop}`;
  }
  if (name === "compact") {
    return backend === "durable"
      ? "/compact is unavailable for durable child tasks because pi-durable has no atomic active-task-only compaction admission; a command could outlive the task view."
      : "/compact is unavailable for this child task: compaction can interrupt its one-shot runner, and the task API cannot safely guarantee continuation.";
  }
  if (name === "model" && backend === "terminal") {
    return "/model is unavailable for terminal children because the task view cannot safely inspect the child model catalog or operate Pi's hidden model selector.";
  }
  if (name === "name" && backend === "durable") {
    return "/name is unavailable for durable children because pi-durable exposes no session display-name API.";
  }
  if (name === "session" && backend === "terminal") {
    return "/session is unavailable for terminal children because Pi renders its statistics in the child TUI, which the transcript overlay hides, and no terminal session-stats API is exposed.";
  }
  if (backend === "none") {
    return "Built-in controls are unavailable for this comparison transcript; its SDK runner does not expose a mutable child session handle.";
  }
  if (["new", "resume", "fork", "clone", "tree", "import"].includes(name)) {
    return `/${name} is unavailable in child views because session switching or branch mutation is not connected to the task lifecycle.`;
  }
  if (["settings", "scoped-models", "reload", "hotkeys", "changelog"].includes(name)) {
    return `/${name} requires Pi's interactive host UI or shared settings and is not exposed by the child task editor.`;
  }
  if (["debug", "arminsayshi", "dementedelves"].includes(name)) {
    return `/${name} is an undocumented Pi 1.0.2 dispatcher command and is not exposed in child task views.`;
  }
  if (name === "llama") {
    return "/llama is mentioned in the Pi 1.0.2 slash-command docs but is absent from the installed command list and interactive dispatcher; it is not available in child views.";
  }
  return `/${name} is not supported by the ${backend} child-task controls. Available child controls: ${CHILD_BUILTIN_NAMES[backend].map((item) => `/${item}`).join(", ") || "none"}.`;
}

/**
 * Recognize installed Pi built-ins before prompt expansion or task steering.
 * Unsupported native commands are returned as denials so they can never fall
 * through to either the parent dispatcher or an interactive terminal child.
 */
export async function routeChildBuiltinCommand(
  text: string,
  backend: ChildBuiltinCommandBackend,
): Promise<
  | { kind: "supported"; command: ChildBuiltinCommand }
  | { kind: "unsupported"; command: ChildBuiltinCommand; message: string }
  | undefined
> {
  const input = text.trim();
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return undefined;
  const [, name, argument = ""] = match;

  const [, commandApi] = await loadNativePromptApis();
  const known = new Set([
    ...commandApi.BUILTIN_SLASH_COMMANDS.map(({ name: builtin }) => builtin),
    ...EXTRA_RESERVED_BUILTINS,
  ]);
  if (!known.has(name)) return undefined;

  const command: ChildBuiltinCommand = {
    name,
    argument: argument.trim(),
    rawText: input,
  };
  if (CHILD_BUILTIN_NAMES[backend].includes(name)) {
    return { kind: "supported", command };
  }
  return {
    kind: "unsupported",
    command,
    message: unsupportedBuiltinMessage(name, backend),
  };
}

export interface ChildPromptTemplateService {
  readonly templates: PromptTemplate[];
  readonly autocompleteProvider: AutocompleteProvider;
  /** Prepare a view-editor submission for the selected child backend. */
  prepareSteeringInput(
    text: string,
    backend: "durable" | "sdk" | "terminal",
  ): { text: string; error?: string };
}

export interface ParentCommandDescriptor {
  name: string;
  source: string;
  sourceInfo?: SourceInfo;
}

export interface ChildPromptTemplateOptions {
  cwd: string;
  parentCwd: string;
  parentProjectTrusted: boolean;
  parentCommands: readonly (SlashCommandInfo | ParentCommandDescriptor)[];
  /** Child-native built-ins to advertise; absent defaults to terminal capabilities. */
  backend?: ChildBuiltinCommandBackend;
  /** Test seam; production uses Pi's current agent directory. */
  agentDir?: string;
}

/**
 * Return only file-backed prompt resources already enabled in the parent.
 * `getCommands()` is public but intentionally carries no template bodies; the
 * native loader below re-reads those exact paths. Project auto-discovery from a
 * different parent cwd is not inherited: the child discovers its own project
 * prompts instead. User-wide auto prompts and explicit/package paths remain
 * enabled parent resources and are carried across.
 */
export function activeParentPromptPaths(
  commands: readonly (SlashCommandInfo | ParentCommandDescriptor)[],
  parentCwd: string,
  childCwd: string,
): string[] {
  const sameCwd = resolve(parentCwd) === resolve(childCwd);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (command.source !== "prompt") continue;
    const info = command.sourceInfo;
    if (!info?.path) continue;
    if (
      !sameCwd &&
      info.source === "auto" &&
      info.scope === "project"
    ) continue;
    const path = isAbsolute(info.path) ? resolve(info.path) : resolve(parentCwd, info.path);
    if (!existsSync(path) || seen.has(path)) continue;
    try {
      if (!statSync(path).isFile() || !path.endsWith(".md")) continue;
    } catch {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Resolve whether project resources in a child cwd may be read without asking
 * for trust from inside the parent's editor. A same-cwd child inherits the
 * live session decision (including session-only trust); other cwds use the
 * persisted nearest trust decision, and are implicitly safe only when there
 * are no trust-gated project resources to load.
 */
export function isChildProjectTrusted(options: {
  cwd: string;
  parentCwd: string;
  parentProjectTrusted: boolean;
  agentDir: string;
}): boolean {
  if (resolve(options.cwd) === resolve(options.parentCwd)) {
    return options.parentProjectTrusted;
  }
  const decision = new ProjectTrustStore(options.agentDir).get(options.cwd);
  if (decision !== null) return decision;
  return !hasTrustRequiringProjectResources(options.cwd);
}

/** Locate an already-installed fd binary; never downloads a tool for autocomplete. */
function findFdPath(): string | undefined {
  const executableNames = process.platform === "win32" ? ["fd.exe", "fd"] : ["fd", "fdfind"];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of executableNames) {
      const candidate = resolve(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function readonlySettingsManager(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): SettingsManager {
  const diskSettings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const withoutExecutableResources = (settings: ReturnType<SettingsManager["getSettings"]>) => ({
    ...settings,
    // Package resolution can install missing packages. Prompt discovery needs
    // only local settings paths and already-enabled parent prompt files.
    packages: [],
    extensions: [],
    skills: [],
    themes: [],
  });
  const snapshots = {
    global: withoutExecutableResources(diskSettings.getGlobalSettings()),
    project: withoutExecutableResources(diskSettings.getProjectSettings()),
  };
  // Infer the non-exported SettingsStorage type from the public factory.
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock(scope, read) {
      read(JSON.stringify(snapshots[scope]));
    },
  };
  return SettingsManager.fromStorage(storage, { projectTrusted });
}

/**
 * Discover child-cwd prompt resources without loading extensions, skills,
 * themes, context files, or packages. Parent prompt bodies are re-read only
 * from file-backed paths returned by the public getCommands() API.
 */
export async function loadChildPromptTemplates(
  options: ChildPromptTemplateOptions,
): Promise<ChildPromptTemplateService> {
  const [promptApi, commandApi] = await loadNativePromptApis();
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const projectTrusted = isChildProjectTrusted({
    cwd,
    parentCwd: options.parentCwd,
    parentProjectTrusted: options.parentProjectTrusted,
    agentDir,
  });
  const parentPromptPaths = activeParentPromptPaths(
    options.parentCommands,
    options.parentCwd,
    cwd,
  );
  const settingsManager = readonlySettingsManager(cwd, agentDir, projectTrusted);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalPromptTemplatePaths: parentPromptPaths,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
    appendSystemPrompt: [],
  });
  await loader.reload();
  const templates = loader.getPrompts().prompts;
  const builtinNames = new Set([
    ...commandApi.BUILTIN_SLASH_COMMANDS.map(({ name }) => name),
    ...EXTRA_RESERVED_BUILTINS,
  ]);
  const parentSessionCommandNames = new Set(
    options.parentCommands
      .filter((command) => command.source === "extension" || command.source === "skill")
      .map((command) => command.name),
  );
  const conflicts = new Set([...builtinNames, ...parentSessionCommandNames]);
  const backend = options.backend ?? "terminal";
  const supportedBuiltins = new Set(CHILD_BUILTIN_NAMES[backend]);
  const builtinAutocomplete: SlashCommand[] = commandApi.BUILTIN_SLASH_COMMANDS
    .filter(({ name }) => supportedBuiltins.has(name))
    .map(({ name }) => ({
      name,
      ...childBuiltinDescription(name, backend),
    }));
  const promptAutocomplete: SlashCommand[] = templates
    .filter((template) => !conflicts.has(template.name))
    .map((template) => ({
      name: template.name,
      ...(template.description ? { description: template.description } : {}),
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
    }));
  const autocompleteProvider = new CombinedAutocompleteProvider(
    [...builtinAutocomplete, ...promptAutocomplete],
    cwd,
    findFdPath(),
  );
  const expand = (text: string) => promptApi.expandPromptTemplate(text, templates);
  const matchedTemplate = (text: string) => {
    const sentinel = "__pi_task_template_match__";
    return templates.find((template) =>
      promptApi.expandPromptTemplate(text, [{ ...template, content: sentinel }]) === sentinel,
    );
  };

  return {
    templates,
    autocompleteProvider,
    prepareSteeringInput(text, backend) {
      const commandName = text.startsWith("/")
        ? text.slice(1).split(/\s/, 1)[0]
        : "";
      const matchingTemplate = matchedTemplate(text);
      if (matchingTemplate && conflicts.has(matchingTemplate.name)) {
        return {
          text,
          error: `Prompt template '/${commandName}' conflicts with a Pi built-in or parent-session command; it was not expanded or executed. Rename the template to use it here.`,
        };
      }

      // AgentSession.steer() expands natively. Forward SDK input unchanged so
      // Pi performs exactly one expansion in the child session.
      if (backend === "sdk") return { text };

      const expanded = expand(text);
      if (backend === "durable") return { text: expanded };

      // The terminal child is interactive, so a native built-in or a parent
      // extension command would be dispatched instead of steered. Prefix only
      // those commands (or slash-leading expansion results) with an invisible
      // word-joiner: JS trim preserves it and Pi treats the text as a prompt.
      if (
        text.startsWith("/") &&
        (builtinNames.has(commandName) || parentSessionCommandNames.has(commandName))
      ) {
        return { text: `\u2060${text}` };
      }
      if (matchingTemplate && expanded.startsWith("/")) {
        return { text: `\u2060${expanded}` };
      }
      return { text: expanded };
    },
  };
}
