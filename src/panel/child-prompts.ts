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

/**
 * Pi 1.0.2 exposes the resource loader and autocomplete provider at the package
 * root, but keeps prompt-template loading/expansion and built-in command names
 * internal. Resolve those two native modules relative to Pi's exported entry
 * point rather than copying Pi's argument grammar or its built-in list.
 */
function loadNativePromptApis(): Promise<[
  { expandPromptTemplate(text: string, templates: PromptTemplate[]): string },
  { BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string }> },
]> {
  const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  return Promise.all([
    import(new URL("./core/prompt-templates.js", piEntryUrl).href),
    import(new URL("./core/slash-commands.js", piEntryUrl).href),
  ]) as Promise<[
    { expandPromptTemplate(text: string, templates: PromptTemplate[]): string },
    { BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string }> },
  ]>;
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
  const builtinNames = new Set(commandApi.BUILTIN_SLASH_COMMANDS.map(({ name }) => name));
  const parentSessionCommandNames = new Set(
    options.parentCommands
      .filter((command) => command.source === "extension" || command.source === "skill")
      .map((command) => command.name),
  );
  const conflicts = new Set([...builtinNames, ...parentSessionCommandNames]);
  const autocompleteCommands: SlashCommand[] = templates
    .filter((template) => !conflicts.has(template.name))
    .map((template) => ({
      name: template.name,
      ...(template.description ? { description: template.description } : {}),
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
    }));
  const autocompleteProvider = new CombinedAutocompleteProvider(
    autocompleteCommands,
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
          error: `Prompt template '/${commandName}' conflicts with a Pi command registered in the parent session; it was not expanded or executed. Rename the template to use it here.`,
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
