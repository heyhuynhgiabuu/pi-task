import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { readTaskSessionHistory, upsertTaskSessionHistory } from "../src/conversation.js";
import { readPersistedAgentHistoryTranscript } from "../src/lifecycle/agent-history.js";
import { openDurableHarness, runDurableTask } from "../src/subagent/durable.js";
import { createTaskWidgetController } from "../src/lifecycle/widget.js";
import {
  createTaskTranscriptSessionView,
  findTaskTranscriptViewLink,
} from "../src/panel/task-session-view.js";
import type { BackgroundTask, TaskSessionHistoryEntry } from "../src/types.js";

function createTestController(t: TestContext, ...args: Parameters<typeof createTaskWidgetController>) {
  const controller = createTaskWidgetController(...args);
  t.after(() => controller.dispose());
  return controller;
}

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    agentType: "general",
    sessionName: "live-task",
    originalPane: null,
    description: "live task",
    startedAt: 1000,
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    dir: "/tmp/artifacts",
    status: "running",
    ...over,
  };
}

function historyEntry(
  id: string,
  ownerSessionId: string,
  over: Partial<TaskSessionHistoryEntry> = {},
): TaskSessionHistoryEntry {
  return {
    id,
    agentType: "general",
    description: `${id} persisted description`,
    sessionName: `${id}-session`,
    startedAt: 1000,
    piDir: "/tmp/pi",
    dir: "/tmp/pi/artifacts/tasks",
    background: true,
    status: "failed",
    backend: "sdk",
    ownerSessionId,
    ownerLeafId: `leaf-${id}`,
    completedAt: 2000,
    ...over,
  };
}

function editorContext(sessionManager: SessionManager, root: string) {
  let editorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => { handleInput(data: string): void }) | undefined;
  let widgetFactory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  const customCalls: Array<{
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => any;
    options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> };
    resolve?: () => void;
  }> = [];
  const notices: Array<{ message: string; level: string }> = [];
  const context: any = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    sessionManager,
    model: { api: "openai-completions", provider: "openai", id: "test-model" },
    ui: {
      setWidget: (_key: string, value: unknown) => {
        if (typeof value === "function") widgetFactory = value as typeof widgetFactory;
      },
      getEditorComponent: () => undefined,
      setEditorComponent: (factory: typeof editorFactory) => { editorFactory = factory; },
      notify: (message: string, level: string) => notices.push({ message, level }),
      custom: (factory: (typeof customCalls)[number]["factory"], options?: (typeof customCalls)[number]["options"]) =>
        new Promise<unknown>((resolve) => {
          customCalls.push({
            factory: (tui, theme, keybindings) => factory(tui, theme, keybindings, resolve),
            options,
            resolve: () => resolve(undefined),
          });
        }),
    },
  };
  const tui = { terminal: { rows: 40 }, requestRender: () => {} };
  const createEditor = () => editorFactory?.(tui, { borderColor: (text: string) => text }, { matches: () => false });
  const createWidget = () => widgetFactory?.(tui, { fg: (_token: string, text: string) => text });
  const mountLatestOverlay = () => {
    const call = customCalls.at(-1);
    assert.ok(call, "expected the historical transcript overlay");
    return call.factory(tui, {
      fg: (_token: string, text: string) => text,
      bg: (_token: string, text: string) => text,
    }, { matches: () => false }, () => {});
  };
  return { context, createEditor, createWidget, customCalls, notices, mountLatestOverlay };
}

function plain(lines: string[]): string {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const STOP = "x";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type HistoryTranscript = Awaited<ReturnType<NonNullable<Parameters<typeof createTaskWidgetController>[2]["readAgentHistoryTranscript"]>>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function focusChildEditor(overlay: unknown): void {
  (overlay as { focused: boolean }).focused = true;
}

test("/agents merges owner-session history, deduplicates runtime state, and navigates historical rows read-only", async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-history-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent conversation", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    const parentPath = parent.getSessionFile();
    assert.ok(ownerSessionId && parentPath);

    const records = [
      historyEntry("old-child", ownerSessionId, {
        description: "old failed child",
        ownerLeafId: "earlier-turn-leaf",
        sessionRef: "/recorded/old-child.jsonl",
      }),
      historyEntry("runtime-duplicate", ownerSessionId, {
        description: "stale persisted state",
        status: "failed",
        completedAt: 1500,
      }),
      historyEntry("foreign-child", "another-parent-session", {
        description: "must not leak",
      }),
      historyEntry("unknown-owner-child", "", {
        ownerSessionId: undefined,
        description: "legacy owner is unavailable",
      }),
    ];
    const foreground = new Map([
      ["runtime-duplicate", task({
        ownerSessionId,
        description: "newest runtime state",
        startedAt: 3000,
        status: "running",
      })],
    ]);
    const background = new Map([
      ["runtime-duplicate", task({
        ownerSessionId,
        description: "stale background runtime state",
        startedAt: 2000,
        status: "failed",
      })],
    ]);
    let selectedTranscriptId = "";
    const stopped: string[] = [];
    let steered = 0;
    const switchedPaths: string[] = [];
    const { context, createEditor, createWidget, customCalls, mountLatestOverlay } = editorContext(parent, root);
    Object.assign(context, {
      switchSession: async (path: string) => {
        switchedPaths.push(path);
        return { cancelled: false };
      },
    });
    const controller = createTestController(t, foreground, background, {
      readAgentHistory: () => records,
      readAgentHistoryTranscript: async (entry) => {
        selectedTranscriptId = entry.id;
        return {
          items: [
            { type: "user", text: "persisted transcript prompt", timestamp: "" },
            { type: "assistant", text: "persisted transcript answer", timestamp: "" },
          ],
          cwd: root,
        };
      },
      stopTask: (id) => { stopped.push(id); return null; },
      steerTask: () => { steered++; return null; },
    });
    controller.ensureTaskWidget(context);
    controller.noteTaskFinished("runtime-duplicate", task({
      ownerSessionId,
      status: "failed",
      description: "stale finished runtime state",
    }), Date.now());
    controller.noteTaskFinished("old-child", task({
      ownerSessionId,
      status: "done",
      description: "prunable in-memory duplicate",
    }), 1);

    assert.equal(await controller.openAgentSwitcher(context), true);
    const pickerWidget = createWidget();
    assert.ok(pickerWidget);
    const pickerRows = plain(pickerWidget.render(140));
    assert.match(pickerRows, /old-child/);
    assert.doesNotMatch(pickerRows, /foreign-child|unknown-owner-child/);
    assert.equal((pickerRows.match(/runtime-duplicate/g) ?? []).length, 1, "the persisted/runtime duplicate has one row");
    assert.match(pickerRows, /newest runtime state/, "live task state wins over stale persisted history");
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput(DOWN); // main -> the live duplicate
    editor.handleInput(DOWN); // live duplicate -> persisted-only child
    editor.handleInput(STOP);
    assert.deepEqual(stopped, [], "a persisted row cannot stop or dismiss lifecycle state");
    editor.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(selectedTranscriptId, "old-child", "the row resolves through its persisted backing record");
    assert.deepEqual(switchedPaths, [], "pending tasks use the read-only overlay fallback, not a session replacement");
    assert.equal(customCalls.length, 1, "only the selected historical transcript opens an overlay");
    const transcript = mountLatestOverlay();
    const rendered = plain(transcript.render(100));
    assert.match(rendered, /persisted transcript answer/);
    assert.match(rendered, /read-only/);
    transcript.handleInput("do not steer");
    transcript.handleInput(ENTER);
    assert.equal(steered, 0, "historical transcripts cannot steer a task");
    transcript.dispose();
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/agents fails closed for process-local and persisted tasks when the parent owner is unknown", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-unknown-owner-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    const { context, createWidget } = editorContext(parent, root);
    context.sessionManager = { getHeader: () => undefined, getBranch: () => [] };
    let historyReads = 0;
    const controller = createTestController(t,
      new Map([["unowned-runtime", task()]]),
      new Map(),
      {
        readAgentHistory: () => {
          historyReads++;
          return [historyEntry("unowned-persisted", "")];
        },
      },
    );
    controller.ensureTaskWidget(context);
    assert.equal(await controller.openAgentSwitcher(context), true);
    const rows = plain(createWidget()!.render(120));
    assert.doesNotMatch(rows, /unowned-runtime|unowned-persisted/);
    assert.equal(historyReads, 0, "history is not queried without a stable parent session id");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/agents modal fallback resolves historical navigation as a read-only overlay", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-history-modal-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    const parentPath = parent.getSessionFile();
    assert.ok(ownerSessionId && parentPath);
    const records = [
      historyEntry("modal-history", ownerSessionId, { ownerLeafId: "old-leaf" }),
      historyEntry("modal-foreign", "foreign-session"),
    ];
    const { context, customCalls, mountLatestOverlay } = editorContext(parent, root);
    context.ui.getEditorComponent = () => ({ handleInput() {} });
    const switchedPaths: string[] = [];
    let selectedTranscriptId = "";
    context.switchSession = async (path: string) => {
      switchedPaths.push(path);
      return { cancelled: false };
    };
    const controller = createTestController(t, new Map(), new Map(), {
      readAgentHistory: () => records,
      readAgentHistoryTranscript: async (entry) => {
        selectedTranscriptId = entry.id;
        return { items: [{ type: "user", text: "modal child transcript", timestamp: "" }], cwd: root };
      },
    });
    controller.ensureTaskWidget(context);
    const pending = controller.openAgentSwitcher(context);
    const call = customCalls.at(-1);
    assert.ok(call);
    const modal = call.factory(
      { terminal: { rows: 40 }, requestRender: () => {} },
      null,
      {},
      () => {},
    );
    const rendered = plain(modal.render(100));
    assert.match(rendered, /#modal-history/);
    assert.doesNotMatch(rendered, /modal-foreign/);
    const sessionFilesBefore = readdirSync(join(root, "parent-sessions")).filter((name) => name.endsWith(".jsonl"));
    modal.handleInput(DOWN);
    modal.handleInput(ENTER);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(selectedTranscriptId, "modal-history", "modal row selection resolves the persisted task");
    assert.deepEqual(switchedPaths, [], "selection never replaces the parent Pi session");
    assert.equal(
      readdirSync(join(root, "parent-sessions")).filter((name) => name.endsWith(".jsonl")).length,
      sessionFilesBefore.length,
      "no snapshot session file is written for a historical selection",
    );
    assert.equal(customCalls.length, 2, "the selection opens the persisted transcript as a second overlay");
    const transcript = mountLatestOverlay();
    const transcriptView = plain(transcript.render(100));
    assert.match(transcriptView, /modal child transcript/);
    assert.match(transcriptView, /read-only/);
    transcript.dispose();
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/agents modal's genuine Esc resolves its pending command", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-history-modal-esc-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    const { context, customCalls } = editorContext(parent, root);
    context.ui.getEditorComponent = () => ({ handleInput() {} });
    const controller = createTestController(t, new Map(), new Map());
    controller.ensureTaskWidget(context);
    const pending = controller.openAgentSwitcher(context);
    const call = customCalls.at(-1);
    assert.ok(call, "the switcher opened a pending custom modal");
    let resolvedByEsc = false;
    void pending.then(() => { resolvedByEsc = true; });
    const modal = call.factory(
      { terminal: { rows: 40 }, requestRender: () => {} },
      null,
      {},
      () => {},
    );
    modal.handleInput("\x1b");
    await pending;
    assert.equal(resolvedByEsc, true, "the modal's real Esc handler resolves ctx.ui.custom");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child arrows use focused /agents ordering across owner-scoped historical leaves without session replacement", async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-arrow-order-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const source = task({ ownerSessionId, description: "live source", startedAt: 100, status: "running" });
    const records = [
      historyEntry("source", ownerSessionId, { description: "stale duplicate", completedAt: 900 }),
      historyEntry("newer-history", ownerSessionId, { ownerLeafId: "earlier-leaf", completedAt: 300 }),
      historyEntry("older-history", ownerSessionId, { ownerLeafId: "older-leaf", completedAt: 100 }),
      historyEntry("foreign-history", "foreign-owner", { completedAt: 500 }),
    ];
    const reads: string[] = [];
    const switched: string[] = [];
    const steered: string[] = [];
    const { context, customCalls, mountLatestOverlay } = editorContext(parent, root);
    context.switchSession = async (path: string) => { switched.push(path); return { cancelled: false }; };
    const controller = createTestController(t,
      new Map([["source", source]]),
      new Map(),
      {
        readAgentHistory: () => records,
        readAgentHistoryTranscript: async (entry) => {
          reads.push(entry.id);
          return { items: [{ type: "user", text: `${entry.id} transcript`, timestamp: "" }] };
        },
        steerTask: (_task, id) => { steered.push(id); return null; },
        stopTask: () => null,
      },
    );
    controller.ensureTaskWidget(context);
    controller.openTaskView("source");
    const sourceOverlay = mountLatestOverlay();
    focusChildEditor(sourceOverlay);

    sourceOverlay.handleInput(LEFT);
    await turn();
    assert.equal(customCalls.length, 1, "the first sibling boundary clamps instead of selecting main");
    sourceOverlay.handleInput(RIGHT);
    await turn();
    assert.deepEqual(reads, ["newer-history"], "runtime state wins a duplicate and historical rows sort newest-first");
    const newerOverlay = mountLatestOverlay();
    assert.match(plain(newerOverlay.render(100)), /newer-history transcript/);
    newerOverlay.handleInput(RIGHT);
    await turn();
    assert.deepEqual(reads, ["newer-history", "older-history"], "old owner-session rows from earlier leaves remain navigable");
    const olderOverlay = mountLatestOverlay();
    assert.match(plain(olderOverlay.render(100)), /older-history transcript/);
    olderOverlay.handleInput(RIGHT);
    await turn();
    assert.equal(customCalls.length, 3, "the last sibling clamps without wrapping");
    olderOverlay.handleInput(LEFT);
    await turn();
    assert.equal(customCalls.length, 4, "left returns to the previous child");
    const backAtNewer = mountLatestOverlay();
    backAtNewer.handleInput(LEFT);
    await turn();
    assert.equal(customCalls.length, 5, "left reaches the live source, never main");
    assert.deepEqual(switched, [], "arrow navigation never replaces the parent Pi session");
    assert.deepEqual(steered, [], "historical navigation never steers a child");
    assert.equal(source.ownerSessionId, ownerSessionId, "navigation does not adopt or mutate task ownership");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical sibling loading keeps the source view and draft until a valid result; typing cancels stale results", { timeout: 5_000 }, async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-arrow-cancel-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const firstRead = deferred<HistoryTranscript>();
    const secondRead = deferred<HistoryTranscript>();
    let reads = 0;
    const { context, customCalls, mountLatestOverlay } = editorContext(parent, root);
    const controller = createTestController(t, new Map([["source", task({ ownerSessionId })]]), new Map(), {
      readAgentHistory: () => [historyEntry("delayed-target", ownerSessionId)],
      readAgentHistoryTranscript: () => reads++ === 0 ? firstRead.promise : secondRead.promise,
    });
    controller.ensureTaskWidget(context);
    controller.openTaskView("source");
    const sourceOverlay = mountLatestOverlay();
    focusChildEditor(sourceOverlay);
    sourceOverlay.handleInput(RIGHT);
    await turn();
    sourceOverlay.handleInput(RIGHT);
    assert.equal(reads, 1, "rapid repeats stay single-flight");
    assert.match(plain(sourceOverlay.render(100)), /Loading read-only child transcript/);
    assert.equal(customCalls.length, 1, "source stays visible while historical JSONL is loading");
    sourceOverlay.handleInput("x");
    const sourceEditor = (sourceOverlay as { editor: { getText(): string } }).editor;
    assert.equal(sourceEditor.getText(), "x", "typing preserves the source draft and cancels navigation");
    sourceOverlay.handleInput(BACKSPACE);
    assert.equal(sourceEditor.getText(), "", "the user can clear the draft after cancelling");
    sourceOverlay.handleInput(RIGHT);
    await turn();
    assert.equal(reads, 2, "a fresh navigation starts while the cancelled read is still unresolved");
    secondRead.resolve({ items: [{ type: "user", text: "fresh historical result", timestamp: "" }] });
    await turn();
    assert.equal(customCalls.length, 2, "the fresh valid result opens its sibling");
    const freshOverlay = mountLatestOverlay();
    assert.match(plain(freshOverlay.render(100)), /fresh historical result/);
    firstRead.resolve({ items: [{ type: "user", text: "stale historical result", timestamp: "" }] });
    await turn();
    assert.equal(customCalls.length, 2, "the earlier cancelled result cannot replace the fresh view");
    assert.match(plain(freshOverlay.render(100)), /fresh historical result/);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable sibling reports a warning without replacing the current transcript", { timeout: 5_000 }, async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-arrow-missing-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const { context, customCalls, mountLatestOverlay } = editorContext(parent, root);
    const controller = createTestController(t, new Map([["source", task({ ownerSessionId })]]), new Map(), {
      readAgentHistory: () => [historyEntry("missing-target", ownerSessionId)],
      readAgentHistoryTranscript: async () => undefined,
    });
    controller.ensureTaskWidget(context);
    controller.openTaskView("source");
    const sourceOverlay = mountLatestOverlay();
    focusChildEditor(sourceOverlay);
    sourceOverlay.handleInput(RIGHT);
    await turn();
    assert.equal(customCalls.length, 1, "a missing transcript leaves the current child open");
    assert.match(plain(sourceOverlay.render(100)), /could not be read|unavailable/i);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-child and missing-current-id orderings clamp without opening main or another owner", { timeout: 5_000 }, async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-arrow-bounds-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const { context, customCalls, mountLatestOverlay } = editorContext(parent, root);
    const controller = createTestController(t, new Map([
      ["only-child", task({ ownerSessionId })],
      ["foreign-source", task({ ownerSessionId: "another-parent" })],
    ]), new Map(), {
      readAgentHistory: () => [historyEntry("only-child", ownerSessionId)],
    });
    controller.ensureTaskWidget(context);
    controller.openTaskView("only-child");
    const only = mountLatestOverlay();
    focusChildEditor(only);
    only.handleInput(LEFT);
    await turn();
    only.handleInput(RIGHT);
    await turn();
    assert.equal(customCalls.length, 1, "a single row clamps both directions");

    controller.openTaskView("foreign-source");
    const missing = mountLatestOverlay();
    focusChildEditor(missing);
    missing.handleInput(LEFT);
    await turn();
    missing.handleInput(RIGHT);
    await turn();
    assert.equal(customCalls.length, 2, "a source id absent from its current-owner list is a no-op, not main or foreign history");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Esc cancels a delayed sibling read so its late result cannot reopen a closed view", { timeout: 5_000 }, async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-arrow-escape-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const read = deferred<HistoryTranscript>();
    const { context, customCalls, mountLatestOverlay } = editorContext(parent, root);
    const controller = createTestController(t, new Map([["source", task({ ownerSessionId })]]), new Map(), {
      readAgentHistory: () => [historyEntry("delayed-target", ownerSessionId)],
      readAgentHistoryTranscript: () => read.promise,
    });
    controller.ensureTaskWidget(context);
    controller.openTaskView("source");
    const source = mountLatestOverlay();
    focusChildEditor(source);
    source.handleInput(RIGHT);
    await turn();
    source.handleInput("\x1b");
    read.resolve({ items: [{ type: "user", text: "late result", timestamp: "" }] });
    await turn();
    assert.equal(customCalls.length, 1, "a late result cannot reopen a view after Esc closed it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changing the viewed task invalidates an outstanding historical sibling load", { timeout: 5_000 }, async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-arrow-view-change-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const read = deferred<HistoryTranscript>();
    const { context, customCalls, mountLatestOverlay } = editorContext(parent, root);
    const controller = createTestController(t, new Map([
      ["source", task({ ownerSessionId })],
      ["other", task({ ownerSessionId, startedAt: 2000 })],
    ]), new Map(), {
      readAgentHistory: () => [historyEntry("delayed-target", ownerSessionId)],
      readAgentHistoryTranscript: () => read.promise,
    });
    controller.ensureTaskWidget(context);
    controller.openTaskView("source");
    const source = mountLatestOverlay();
    focusChildEditor(source);
    source.handleInput(RIGHT);
    await turn();
    controller.openTaskView("other");
    assert.equal(customCalls.length, 2, "an explicit view change opens its selected child immediately");
    read.resolve({ items: [{ type: "user", text: "late result", timestamp: "" }] });
    await turn();
    assert.equal(customCalls.length, 2, "the stale sibling cannot replace the newly selected child");
    assert.match(plain(mountLatestOverlay().render(100)), /#other/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("switching between live siblings preserves each child's independent editor draft", { timeout: 5_000 }, async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-drafts-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const { context, customCalls, mountLatestOverlay } = editorContext(parent, root);
    const controller = createTestController(t, new Map([
      ["draft-source", task({ ownerSessionId, startedAt: 100 })],
      ["draft-target", task({ ownerSessionId, startedAt: 200 })],
    ]), new Map(), {
      readAgentHistory: () => [],
    });
    controller.ensureTaskWidget(context);
    controller.openTaskView("draft-source");
    const source = mountLatestOverlay();
    focusChildEditor(source);
    for (const character of "source draft") source.handleInput(character);
    for (const _ of "source draft") source.handleInput(BACKSPACE);
    assert.equal((source as { editor: { getText(): string } }).editor.getText(), "");
    source.handleInput(RIGHT);
    await turn();
    assert.equal(customCalls.length, 2, "an empty source can open its next live sibling");

    const target = mountLatestOverlay();
    focusChildEditor(target);
    for (const character of "target draft") target.handleInput(character);
    controller.openTaskView("draft-source");
    const restoredSource = mountLatestOverlay();
    assert.equal((restoredSource as { editor: { getText(): string } }).editor.getText(), "", "the source's cleared draft stays empty");
    focusChildEditor(restoredSource);
    restoredSource.handleInput(RIGHT);
    await turn();
    const restoredTarget = mountLatestOverlay();
    assert.equal((restoredTarget as { editor: { getText(): string } }).editor.getText(), "target draft", "activating a sibling does not clear that child's saved draft");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a late /agents historical read cannot override a later selected child", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-late-history-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const first = deferred<HistoryTranscript>();
    const second = deferred<HistoryTranscript>();
    const { context, createEditor, customCalls } = editorContext(parent, root);
    const switched: string[] = [];
    context.switchSession = async (path: string) => { switched.push(path); return { cancelled: false }; };
    const controller = createTestController(t, new Map(), new Map(), {
      readAgentHistory: () => [
        historyEntry("first-selection", ownerSessionId, { completedAt: 200 }),
        historyEntry("second-selection", ownerSessionId, { completedAt: 100 }),
      ],
      readAgentHistoryTranscript: (entry) => entry.id === "first-selection" ? first.promise : second.promise,
    });
    controller.ensureTaskWidget(context);
    await controller.openAgentSwitcher(context);
    const selectFirst = createEditor();
    assert.ok(selectFirst);
    selectFirst.handleInput(DOWN);
    selectFirst.handleInput(ENTER);
    await controller.openAgentSwitcher(context);
    const selectSecond = createEditor();
    assert.ok(selectSecond);
    selectSecond.handleInput(DOWN);
    selectSecond.handleInput(DOWN);
    selectSecond.handleInput(ENTER);
    second.resolve({ items: [{ type: "user", text: "second", timestamp: "" }] });
    await turn();
    assert.equal(customCalls.length, 1, "the later selection activates when its read completes");
    assert.deepEqual(switched, [], "activation opens the read-only overlay, never a session switch");
    const overlaysAfterSecond = customCalls.length;
    first.resolve({ items: [{ type: "user", text: "first", timestamp: "" }] });
    await turn();
    assert.equal(customCalls.length, overlaysAfterSecond, "the earlier selection cannot replace the later view");
    assert.deepEqual(switched, [], "the stale selection never switches sessions");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/agents opens historical transcripts read-only even when native session switching is available", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-no-session-switch-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const { context, createEditor, customCalls, mountLatestOverlay, notices } = editorContext(parent, root);
    const switchedPaths: string[] = [];
    context.switchSession = async (path: string) => { switchedPaths.push(path); return { cancelled: false }; };
    const controller = createTestController(t, new Map(), new Map(), {
      readAgentHistory: () => [historyEntry("no-switch-history", ownerSessionId)],
      readAgentHistoryTranscript: async () => ({
        items: [{ type: "user", text: "readable persisted transcript", timestamp: "" }],
      }),
    });
    controller.ensureTaskWidget(context);
    await controller.openAgentSwitcher(context);
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput(DOWN);
    editor.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(customCalls.length, 1, "the persisted transcript opens read-only without creating or switching a session");
    const transcript = mountLatestOverlay();
    assert.match(plain(transcript.render(100)), /readable persisted transcript|read-only/);
    transcript.dispose();
    assert.deepEqual(switchedPaths, [], "the parent session is never replaced");
    assert.deepEqual(notices, [], "no fallback warning is needed because the overlay always opens");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live resumed task takes precedence over cached history for a reused task id", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-resumed-history-id-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const foreground = new Map<string, BackgroundTask>();
    const { context, createEditor, customCalls } = editorContext(parent, root);
    context.switchSession = async () => ({ cancelled: false });
    let steered = 0;
    const controller = createTestController(t, foreground, new Map(), {
      readAgentHistory: () => [historyEntry("reused-id", ownerSessionId)],
      readAgentHistoryTranscript: async () => ({
        items: [{ type: "user", text: "old persisted run", timestamp: "" }],
      }),
      steerTask: () => { steered++; return null; },
    });
    controller.ensureTaskWidget(context);
    await controller.openAgentSwitcher(context);
    const picker = createEditor();
    assert.ok(picker);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    foreground.set("reused-id", task({
      ownerSessionId,
      backend: "sdk",
      description: "new resumed run",
      status: "running",
      startedAt: 3000,
    }));
    controller.openTaskView("reused-id");
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput("new live input");
    editor.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(steered, 1, "a reused live ID routes to lifecycle state, not its old history snapshot");
    assert.equal(customCalls.length, 1, "the reused live task opens one steerable transcript view");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/agents uses snapshot viewLink ownership across child snapshots and changes with the parent session", async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-owner-switch-"));
  try {
    const parentA = SessionManager.create(root, join(root, "parent-a"));
    parentA.appendMessage({ role: "user", content: "parent A", timestamp: 1 });
    const parentAId = parentA.getHeader()?.id;
    const parentAPath = parentA.getSessionFile();
    const parentB = SessionManager.create(root, join(root, "parent-b"));
    parentB.appendMessage({ role: "user", content: "parent B", timestamp: 2 });
    const parentBId = parentB.getHeader()?.id;
    const parentBPath = parentB.getSessionFile();
    assert.ok(parentAId && parentAPath && parentBId && parentBPath);

    const records = [
      historyEntry("a-old-leaf-child", parentAId, { ownerLeafId: "leaf-from-an-earlier-turn" }),
      historyEntry("b-child", parentBId, { ownerLeafId: "b-leaf" }),
    ];
    const switchedPaths: string[] = [];
    const { context, createEditor, createWidget } = editorContext(parentA, root);
    Object.assign(context, {
      switchSession: async (path: string) => {
        switchedPaths.push(path);
        return { cancelled: false };
      },
    });
    const controller = createTestController(t, new Map(), new Map(), {
      readAgentHistory: () => records,
      readAgentHistoryTranscript: async (entry) => ({
        items: [
          { type: "user", text: `${entry.id} transcript prompt`, timestamp: "" },
          { type: "assistant", text: `${entry.id} transcript answer`, timestamp: "" },
        ],
        cwd: root,
      }),
    });
    controller.ensureTaskWidget(context);

    await controller.openAgentSwitcher(context);
    let rows = plain(createWidget()!.render(140));
    assert.match(rows, /a-old-leaf-child/);
    assert.doesNotMatch(rows, /b-child/);
    const editorA = createEditor();
    assert.ok(editorA);
    editorA.handleInput(DOWN);
    editorA.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(switchedPaths, [], "historical selection opens the read-only overlay without a session switch");

    // Legacy snapshots created before overlay-only browsing remain navigable.
    const legacyA = createTaskTranscriptSessionView({
      taskId: "a-old-leaf-child",
      cwd: root,
      sessionDir: join(root, "legacy-a"),
      parentSessionPath: parentAPath,
      parentSessionId: parentAId,
      model: { api: "openai-completions", provider: "openai", model: "gpt-5.6" },
      items: [{ type: "user", text: "a-old-leaf-child transcript prompt", timestamp: "" }],
    });
    assert.ok(legacyA.ok);
    const snapshotA = SessionManager.open(legacyA.sessionPath);
    assert.deepEqual(findTaskTranscriptViewLink(snapshotA.getBranch(), snapshotA.getHeader()), {
      taskId: "a-old-leaf-child",
      parentSessionPath: parentAPath,
      parentSessionId: parentAId,
    });
    await controller.openAgentSwitcher({ ...context, sessionManager: snapshotA });
    rows = plain(createWidget()!.render(140));
    assert.match(rows, /a-old-leaf-child/, "snapshot id is not mistaken for the owner id");
    assert.doesNotMatch(rows, /b-child/);
    const snapshotEditor = createEditor();
    assert.ok(snapshotEditor);
    snapshotEditor.handleInput(UP);
    snapshotEditor.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(switchedPaths[0], parentAPath, "main returns to the original owner parent");

    await controller.openAgentSwitcher({ ...context, sessionManager: parentB });
    rows = plain(createWidget()!.render(140));
    assert.match(rows, /b-child/);
    assert.doesNotMatch(rows, /a-old-leaf-child/);
    const editorB = createEditor();
    assert.ok(editorB);
    editorB.handleInput(DOWN);
    editorB.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(switchedPaths, [parentAPath], "the second historical selection stays on the overlay path");
    const legacyB = createTaskTranscriptSessionView({
      taskId: "b-child",
      cwd: root,
      sessionDir: join(root, "legacy-b"),
      parentSessionPath: parentBPath,
      parentSessionId: parentBId,
      model: { api: "openai-completions", provider: "openai", model: "gpt-5.6" },
      items: [{ type: "user", text: "b-child transcript prompt", timestamp: "" }],
    });
    assert.ok(legacyB.ok);
    const snapshotB = SessionManager.open(legacyB.sessionPath);
    assert.deepEqual(findTaskTranscriptViewLink(snapshotB.getBranch(), snapshotB.getHeader()), {
      taskId: "b-child",
      parentSessionPath: parentBPath,
      parentSessionId: parentBId,
    });

    await controller.openAgentSwitcher({ ...context, sessionManager: parentA });
    rows = plain(createWidget()!.render(140));
    assert.match(rows, /a-old-leaf-child/);
    assert.doesNotMatch(rows, /b-child/, "switching back restores the original parent's list");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted JSONL history reads only the exact recorded ref and fails closed for unknown owners", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-recorded-child-ref-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    const parentPath = parent.getSessionFile();
    assert.ok(ownerSessionId && parentPath);

    const child = SessionManager.create(root, join(root, "child-sessions"), { parentSession: parentPath });
    child.appendSessionInfo("recorded-child-session");
    child.appendMessage({ role: "user", content: "exact child JSONL", timestamp: 2 });
    const childRef = child.getSessionFile();
    assert.ok(childRef);
    const record = historyEntry("recorded-child", ownerSessionId, {
      piDir: root,
      backend: "sdk",
      sessionName: "recorded-child-session",
      sessionRef: childRef,
    });
    upsertTaskSessionHistory(root, record);

    const transcript = await readPersistedAgentHistoryTranscript(root, ownerSessionId, record);
    assert.ok(transcript?.items.some((item) => item.type === "user" && item.text === "exact child JSONL"));
    assert.deepEqual(transcript?.metadata?.usageTotals, {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    }, "historical Pi JSONL carries its own empty totals without inventing usage");
    assert.deepEqual(transcript?.metadata?.contextUsage, { tokens: null });
    assert.equal(await readPersistedAgentHistoryTranscript(root, "foreign-parent", record), undefined);

    const wrongChild = SessionManager.create(root, join(root, "other-child-sessions"), { parentSession: parentPath });
    wrongChild.appendSessionInfo("different-child-session");
    wrongChild.appendMessage({ role: "user", content: "must not be attributed", timestamp: 3 });
    const wrongRecord = historyEntry("wrong-ref-child", ownerSessionId, {
      piDir: root,
      backend: "terminal",
      sessionName: "expected-child-session",
      sessionRef: wrongChild.getSessionFile(),
    });
    upsertTaskSessionHistory(root, wrongRecord);
    assert.equal(
      await readPersistedAgentHistoryTranscript(root, ownerSessionId, wrongRecord),
      undefined,
      "a different child's exact JSONL fails the recorded session-name check",
    );

    const missingRef = historyEntry("missing-ref-child", ownerSessionId, {
      piDir: root,
      backend: "sdk",
      sessionRef: undefined,
    });
    upsertTaskSessionHistory(root, missingRef);
    assert.equal(
      await readPersistedAgentHistoryTranscript(root, ownerSessionId, missingRef),
      undefined,
      "history with no recorded ref is unavailable instead of scanning by project/session name",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/agents opens a settled durable child read-only when legacy history omits conversationId", async (t) => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-durable-legacy-id-"));
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let controller: ReturnType<typeof createTaskWidgetController> | undefined;
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);

    const models = createModels();
    const faux = fauxProvider({ models: [{ id: "faux-history" }] });
    faux.setResponses([fauxAssistantMessage("settled durable child transcript body")]);
    models.setProvider(faux.provider);
    const modelFactory = () => models;
    const result = await runDurableTask({
      piDir: root,
      taskId: "legacy-durable-child",
      task: "Create a settled durable child transcript.",
      models: modelFactory,
    });
    handle = await openDurableHarness(root, { models: modelFactory });

    const legacyEntry = historyEntry("legacy-durable-child", ownerSessionId, {
      piDir: root,
      backend: "durable",
      runtime: "pi",
      conversationId: undefined,
      sessionRef: undefined,
      status: "done",
      completedAt: Date.now(),
      tokensPerSecond: 12.34,
    });
    upsertTaskSessionHistory(root, legacyEntry);
    const persistedEntry = readTaskSessionHistory(root).find(
      (entry) => entry.id === legacyEntry.id,
    );
    assert.ok(persistedEntry);
    assert.equal(persistedEntry.conversationId, undefined, "reproduces the legacy omitted attribution field");
    assert.ok(result.conversationId, "the durable byOwner mapping identifies the completed child");

    const { context, createEditor, customCalls, mountLatestOverlay, notices } = editorContext(parent, root);
    controller = createTestController(t, new Map(), new Map(), {
      readAgentHistory: () => readTaskSessionHistory(root),
      readAgentHistoryTranscript: (entry, owner) =>
        readPersistedAgentHistoryTranscript(root, owner, entry),
    });
    controller.ensureTaskWidget(context);
    assert.equal(await controller.openAgentSwitcher(context), true);
    const picker = createEditor();
    assert.ok(picker);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(customCalls.length, 1, "the real durable transcript reader opens the read-only overlay");
    const overlay = mountLatestOverlay();
    const rendered = plain(overlay.render(100));
    assert.match(rendered, /settled durable child transcript body/);
    assert.match(rendered, /read-only/);
    assert.match(rendered, /TPS 12\.3/, "the persisted run TPS recorded at settlement is shown read-only");
    assert.ok(
      !notices.some((notice) => /Could not read persisted transcript/.test(notice.message)),
      "a trusted byOwner binding avoids the false unavailable warning",
    );
    overlay.dispose();

    const spoofed = { ...legacyEntry, conversationId: "not-the-mapped-child" };
    upsertTaskSessionHistory(root, spoofed);
    await assert.rejects(
      readPersistedAgentHistoryTranscript(root, ownerSessionId, spoofed),
      /Durable ownership metadata does not match task/,
      "an explicit conversationId mismatch is not repaired from the mapping",
    );
    assert.equal(
      await readPersistedAgentHistoryTranscript(root, "foreign-owner", legacyEntry),
      undefined,
      "the owner-session check remains authoritative",
    );
  } finally {
    controller?.dispose();
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing historical transcript stays listed and reports honest unavailability", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-missing-history-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const records = [historyEntry("unavailable-child", ownerSessionId, { sessionRef: undefined })];
    const { context, createEditor, createWidget, notices } = editorContext(parent, root);
    const switchedPaths: string[] = [];
    context.switchSession = async (path: string) => {
      switchedPaths.push(path);
      return { cancelled: false };
    };
    const controller = createTestController(t, new Map(), new Map(), {
      readAgentHistory: () => records,
      readAgentHistoryTranscript: async () => undefined,
    });
    controller.ensureTaskWidget(context);
    await controller.openAgentSwitcher(context);
    assert.match(plain(createWidget()!.render(120)), /unavailable-child/);
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput(DOWN);
    editor.handleInput(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(switchedPaths, [], "no empty/fabricated transcript snapshot is written");
    assert.ok(
      notices.some((notice) => notice.level === "warning" && /No readable persisted transcript/.test(notice.message)),
      "the user receives an explicit unavailable-transcript warning",
    );
    await controller.openAgentSwitcher(context);
    assert.match(plain(createWidget()!.render(120)), /unavailable-child/, "unavailable history remains in /agents");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
