import type { RegistryEntry, TerminalHandle } from "../types.js";
import { probePane, probePaneAsync } from "../subagent/tmux.js";
import type { HerdrTerminalHandle } from "../subagent/terminalBackend.js";

export type RegistryEntryStatus = "alive" | "missing" | "unavailable";

type SyncHerdrControl = {
  exists(handle: HerdrTerminalHandle): boolean;
};

type AsyncHerdrControl = {
  isAlive(handle: TerminalHandle): Promise<boolean>;
};

function unavailableFrom(error: unknown): boolean {
  return error instanceof Error && error.name === "HerdrUnavailableError";
}

export function createRegistryEntryStatus(
  syncHerdr: SyncHerdrControl,
  asyncHerdr: AsyncHerdrControl,
): {
  registryEntryStatus: (entry: RegistryEntry) => RegistryEntryStatus;
  registryEntryStatusAsync: (entry: RegistryEntry) => Promise<RegistryEntryStatus>;
  registryEntryAliveAsync: (entry: RegistryEntry) => Promise<boolean>;
  registryEntryCancellationStatus: (entry: RegistryEntry) => RegistryEntryStatus;
} {
  const registryEntryStatus = (entry: RegistryEntry): RegistryEntryStatus => {
    if (entry.handle?.backend === "herdr") {
      try {
        return syncHerdr.exists(entry.handle) ? "alive" : "missing";
      } catch (error) {
        if (unavailableFrom(error)) return "unavailable";
        throw error;
      }
    }
    const paneId = entry.handle?.backend === "tmux"
      ? entry.handle.resourceId
      : entry.paneId;
    if (!paneId) return "missing";
    return probePane(paneId).state;
  };

  const registryEntryStatusAsync = async (
    entry: RegistryEntry,
  ): Promise<RegistryEntryStatus> => {
    if (entry.handle?.backend === "herdr") {
      try {
        return (await asyncHerdr.isAlive(entry.handle)) ? "alive" : "missing";
      } catch (error) {
        if (unavailableFrom(error)) return "unavailable";
        throw error;
      }
    }
    const paneId = entry.handle?.backend === "tmux"
      ? entry.handle.resourceId
      : entry.paneId;
    if (!paneId) return "missing";
    return (await probePaneAsync(paneId)).state;
  };

  const registryEntryAliveAsync = async (entry: RegistryEntry): Promise<boolean> => {
    const status = await registryEntryStatusAsync(entry);
    if (status === "unavailable") {
      throw new Error("terminal backend temporarily unavailable");
    }
    return status === "alive";
  };

  const registryEntryCancellationStatus = (
    entry: RegistryEntry,
  ): RegistryEntryStatus => {
    if (
      entry.handle?.backend === "herdr" &&
      entry.handle.foregroundProcessGroupId === undefined
    ) {
      return "unavailable";
    }
    return registryEntryStatus(entry);
  };

  return {
    registryEntryStatus,
    registryEntryStatusAsync,
    registryEntryAliveAsync,
    registryEntryCancellationStatus,
  };
}
