import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  Spacer,
  Text,
  type Component,
  type Focusable,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";

import type {
  ChildBuiltinSelectorData,
  ChildHistoryPickerData,
  ChildModelOption,
} from "../types.js";

export interface ChildSelectorTheme {
  fg(color: string, text: string): string;
}

export interface ChildSelectorBaseOptions {
  tui: TUI;
  theme: ChildSelectorTheme | null;
  rows: number;
}

export interface ChildSelectorOptions extends ChildSelectorBaseOptions {
  data: ChildBuiltinSelectorData;
  onSelect(command: string): void;
  onCancel(): void;
}

export interface ChildHistoryPickerOptions extends ChildSelectorBaseOptions {
  data: ChildHistoryPickerData;
  onSelect(taskId: string): void;
  onCancel(): void;
}

export interface ChildSelectorComponent extends Component {
  focused: boolean;
  handleInput(data: string): void;
  setViewportRows(rows: number): void;
  dispose(): void;
}

const SELECTOR_HINT =
  "Enter select · Esc cancel · Ctrl+S set-default is disabled · affects only this child";

function selectListTheme(theme: ChildSelectorTheme | null): SelectListTheme {
  const color = (token: string, text: string) => theme?.fg(token, text) ?? text;
  return {
    selectedPrefix: (text) => color("accent", text),
    selectedText: (text) => color("accent", text),
    description: (text) => color("muted", text),
    scrollInfo: (text) => color("dim", text),
    noMatch: () => color("warning", "  No matching child choices"),
  };
}

function maxVisibleRows(rows: number, fixedRows: number, itemCount: number): number {
  const available = Math.max(1, Math.floor(rows) - fixedRows);
  return Math.max(1, Math.min(10, itemCount || 1, available));
}

abstract class ChildSelectorBase extends Container implements ChildSelectorComponent, Focusable {
  abstract handleInput(data: string): void;
  abstract setViewportRows(rows: number): void;

  protected readonly tui: TUI;
  protected readonly theme: ChildSelectorTheme | null;
  protected readonly rows: number;
  protected readonly searchInput: Input;
  private _focused = true;

  constructor(options: ChildSelectorBaseOptions) {
    super();
    this.tui = options.tui;
    this.theme = options.theme;
    this.rows = options.rows;
    this.searchInput = new Input();
    this.searchInput.focused = true;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  protected color(token: string, text: string): string {
    return this.theme?.fg(token, text) ?? text;
  }

  dispose(): void {
    this.focused = false;
  }

  protected requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}

/** Searchable child model list built only from the selected child's data. */
export class ChildModelSelectorComponent extends ChildSelectorBase {
  private readonly models: ChildModelOption[];
  private readonly currentModel: { provider: string; id: string } | undefined;
  private readonly onSelectCommand: (command: string) => void;
  private readonly onCancelCommand: () => void;
  private readonly listContainer = new Container();
  private visibleRows: number;
  private selectList: SelectList;

  constructor(options: ChildSelectorOptions & { data: Extract<ChildBuiltinSelectorData, { kind: "model" }> }) {
    super(options);
    this.currentModel = options.data.currentModel;
    this.onSelectCommand = options.onSelect;
    this.onCancelCommand = options.onCancel;
    const byReference = new Map<string, ChildModelOption>();
    for (const model of options.data.models) {
      if (!model.provider || !model.id) continue;
      byReference.set(`${model.provider}\0${model.id}`, model);
    }
    this.models = [...byReference.values()].sort((left, right) => {
      const leftCurrent = left.provider === this.currentModel?.provider && left.id === this.currentModel?.id;
      const rightCurrent = right.provider === this.currentModel?.provider && right.id === this.currentModel?.id;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
    });
    this.visibleRows = maxVisibleRows(this.rows, 10, this.models.length);
    this.addChild(new DynamicBorder((text) => this.color("border", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.color("accent", "Select Child Model"), 0, 0));
    this.addChild(new Text(this.color("muted", "Search the models available to this child session"), 0, 0));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.color("dim", SELECTOR_HINT), 0, 0));
    this.addChild(new DynamicBorder((text) => this.color("border", text)));
    this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
    this.selectList = this.createList(this.models, this.currentReference());
    this.listContainer.addChild(this.selectList);
  }

  private currentReference(): string | undefined {
    return this.currentModel ? `${this.currentModel.provider}/${this.currentModel.id}` : undefined;
  }

  private createList(models: ChildModelOption[], selectedValue?: string): SelectList {
    const items: SelectItem[] = models.map((model) => {
      const isCurrent = model.provider === this.currentModel?.provider && model.id === this.currentModel?.id;
      return {
        value: `${model.provider}/${model.id}`,
        label: `${isCurrent ? "✓ " : "  "}${model.provider}/${model.id} — ${model.name}`,
      };
    });
    const list = new SelectList(items, this.visibleRows, selectListTheme(this.theme));
    const selectedIndex = selectedValue ? items.findIndex((item) => item.value === selectedValue) : -1;
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    list.onSelect = (item) => this.onSelectCommand(`/model ${item.value}`);
    list.onCancel = () => this.onCancelCommand();
    return list;
  }

  private applyFilter(query: string, repaint = true): void {
    const filtered = query
      ? fuzzyFilter(this.models, query, (model) => `${model.id} ${model.provider} ${model.name}`)
      : this.models;
    const selected = this.selectList.getSelectedItem()?.value ?? this.currentReference();
    const next = this.createList(filtered, selected);
    this.listContainer.clear();
    this.listContainer.addChild(next);
    this.selectList = next;
    if (repaint) this.requestRender();
  }

  setViewportRows(rows: number): void {
    const visibleRows = maxVisibleRows(rows, 10, this.models.length);
    if (visibleRows === this.visibleRows) return;
    this.visibleRows = visibleRows;
    this.applyFilter(this.searchInput.getValue(), false);
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.up") ||
      keybindings.matches(data, "tui.select.down") ||
      keybindings.matches(data, "tui.select.confirm") ||
      keybindings.matches(data, "tui.select.cancel")) {
      this.selectList.handleInput(data);
      this.requestRender();
      return;
    }
    this.searchInput.handleInput(data);
    this.applyFilter(this.searchInput.getValue());
  }
}

/** Searchable selector for the exact thinking levels supported by this child. */
export class ChildThinkingSelectorComponent extends ChildSelectorBase {
  private readonly levels: string[];
  private readonly onSelectCommand: (command: string) => void;
  private readonly onCancelCommand: () => void;
  private readonly selectListChildIndex: number;
  private selectListVisibleRows: number;
  private selectList: SelectList;

  constructor(options: ChildSelectorOptions & { data: Extract<ChildBuiltinSelectorData, { kind: "thinking" }> }) {
    super(options);
    this.levels = [...options.data.levels];
    this.selectListVisibleRows = maxVisibleRows(this.rows, 10, this.levels.length);
    this.onSelectCommand = options.onSelect;
    this.onCancelCommand = options.onCancel;
    this.addChild(new DynamicBorder((text) => this.color("border", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.color("accent", "Thinking Level"), 0, 0));
    this.addChild(new Text(this.color("muted", "Choose a level supported by this child model"), 0, 0));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.selectList = this.createList(this.levels, options.data.currentLevel);
    this.selectListChildIndex = this.children.length;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.color("dim", SELECTOR_HINT), 0, 0));
    this.addChild(new DynamicBorder((text) => this.color("border", text)));
    this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
  }

  private createList(levels: string[], selectedLevel: string): SelectList {
    const items: SelectItem[] = levels.map((level) => ({
      value: level,
      label: `${level === selectedLevel ? "✓ " : "  "}${level}`,
    }));
    const list = new SelectList(
      items,
      this.selectListVisibleRows,
      selectListTheme(this.theme),
      { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 },
    );
    const currentIndex = items.findIndex((item) => item.value === selectedLevel);
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
    list.onSelect = (item) => this.onSelectCommand(`/thinking ${item.value}`);
    list.onCancel = () => this.onCancelCommand();
    return list;
  }

  private applyFilter(query: string, repaint = true): void {
    const filtered = query ? fuzzyFilter(this.levels, query, (level) => level) : this.levels;
    const selected = this.selectList.getSelectedItem()?.value ?? this.levels[0] ?? "off";
    const next = this.createList(filtered, selected);
    this.children[this.selectListChildIndex] = next;
    this.selectList = next;
    if (repaint) this.requestRender();
  }

  setViewportRows(rows: number): void {
    const visibleRows = maxVisibleRows(rows, 10, this.levels.length);
    if (visibleRows === this.selectListVisibleRows) return;
    this.selectListVisibleRows = visibleRows;
    this.applyFilter(this.searchInput.getValue(), false);
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    const isNavigation = keybindings.matches(data, "tui.select.up") ||
      keybindings.matches(data, "tui.select.down") ||
      keybindings.matches(data, "tui.select.confirm") ||
      keybindings.matches(data, "tui.select.cancel");
    if (isNavigation) {
      this.selectList.handleInput(data);
      this.requestRender();
      return;
    }
    this.searchInput.handleInput(data);
    this.applyFilter(this.searchInput.getValue());
  }
}

export class ChildHistoryPickerComponent extends ChildSelectorBase {
  private readonly sessions: ChildHistoryPickerData["sessions"];
  private readonly onSelectTask: (taskId: string) => void;
  private readonly onCancelPicker: () => void;
  private readonly listContainer = new Container();
  private visibleRows: number;
  private selectList: SelectList;

  constructor(options: ChildHistoryPickerOptions) {
    super(options);
    this.sessions = [...options.data.sessions].sort(
      (left, right) => right.startedAt - left.startedAt || left.taskId.localeCompare(right.taskId),
    );
    this.onSelectTask = options.onSelect;
    this.onCancelPicker = options.onCancel;
    this.visibleRows = maxVisibleRows(this.rows, 10, this.sessions.length);
    this.addChild(new DynamicBorder((text) => this.color("border", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.color("accent", "Browse Durable Child History"), 0, 0));
    this.addChild(new Text(this.color("muted", "Read-only project database transcripts; no task is resumed"), 0, 0));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.color("dim", "Enter browse transcript · Esc back · search by task, name, agent, or status"), 0, 0));
    this.addChild(new DynamicBorder((text) => this.color("border", text)));
    this.selectList = this.createList(this.sessions, options.data.currentTaskId);
    this.listContainer.addChild(this.selectList);
    this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
  }

  private createList(
    sessions: ChildHistoryPickerData["sessions"],
    selectedTaskId: string,
  ): SelectList {
    const items: SelectItem[] = sessions.map((session) => ({
      value: session.taskId,
      label: `${session.taskId === selectedTaskId ? "✓ " : "  "}#${session.taskId} · ${session.sessionName} · ${session.status}`,
      description: `${session.agentType}${session.description ? ` — ${session.description}` : ""}`,
    }));
    const list = new SelectList(items, this.visibleRows, selectListTheme(this.theme));
    const selectedIndex = items.findIndex((item) => item.value === selectedTaskId);
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    list.onSelect = (item) => this.onSelectTask(item.value);
    list.onCancel = () => this.onCancelPicker();
    return list;
  }

  private applyFilter(query: string, repaint = true): void {
    const filtered = query
      ? fuzzyFilter(
          this.sessions,
          query,
          (session) => `${session.taskId} ${session.sessionName} ${session.agentType} ${session.description} ${session.status}`,
        )
      : this.sessions;
    const selected = this.selectList.getSelectedItem()?.value;
    const next = this.createList(filtered, selected ?? "");
    this.listContainer.clear();
    this.listContainer.addChild(next);
    this.selectList = next;
    if (repaint) this.requestRender();
  }

  setViewportRows(rows: number): void {
    const visibleRows = maxVisibleRows(rows, 10, this.sessions.length);
    if (visibleRows === this.visibleRows) return;
    this.visibleRows = visibleRows;
    this.applyFilter(this.searchInput.getValue(), false);
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (
      keybindings.matches(data, "tui.select.up") ||
      keybindings.matches(data, "tui.select.down") ||
      keybindings.matches(data, "tui.select.confirm") ||
      keybindings.matches(data, "tui.select.cancel")
    ) {
      this.selectList.handleInput(data);
      this.requestRender();
      return;
    }
    this.searchInput.handleInput(data);
    this.applyFilter(this.searchInput.getValue());
  }
}

export function createChildSelector(options: ChildSelectorOptions): ChildSelectorComponent {
  return options.data.kind === "model"
    ? new ChildModelSelectorComponent({ ...options, data: options.data })
    : new ChildThinkingSelectorComponent({ ...options, data: options.data });
}

export function createChildHistoryPicker(
  options: ChildHistoryPickerOptions,
): ChildHistoryPickerComponent {
  return new ChildHistoryPickerComponent(options);
}
