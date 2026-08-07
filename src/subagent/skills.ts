import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export function resolveDeclaredSkillPaths(
  names: readonly string[],
  available: readonly Pick<Skill, "name" | "filePath">[],
): string[] {
  const byName = new Map(available.map((skill) => [skill.name, skill.filePath]));
  const paths: string[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];

  for (const name of names) {
    const path = byName.get(name);
    if (!path) {
      missing.push(name);
      continue;
    }
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Declared subagent skill(s) not found: ${missing.join(", ")}`);
  }
  return paths;
}

export async function resolveAgentSkillPaths(
  names: readonly string[] | undefined,
  cwd: string,
  projectTrusted = true,
): Promise<string[]> {
  const declared = names ?? [];
  if (declared.length === 0) return [];

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
  });
  await resourceLoader.reload();
  return resolveDeclaredSkillPaths(declared, resourceLoader.getSkills().skills);
}
