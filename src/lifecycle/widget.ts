import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatMs } from "../helpers.js";
import {
  TASK_WIDGET_RENDER_MS,
  renderTaskWidget,
  type ThemeLike,
} from "../task-widget.js";
import type { BackgroundTask } from "../types.js";

export interface TaskWidgetController {
  ensureTaskWidget(targetCtx: ExtensionContext): void;
  clearTaskWidgetIfIdle(): void;
  dispose(): void;
}

export function createTaskWidgetController(
  foregroundTasks: Map<string, BackgroundTask>,
  backgroundTasks: Map<string, BackgroundTask>,
): TaskWidgetController {
  let widgetCtx: ExtensionContext | null = null;
  let widgetTimer: ReturnType<typeof setInterval> | null = null;
  let widgetTheme: ThemeLike | null = null;

  function stopWidget() {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

  function renderWidget(width: number): string[] {
    try {
      return renderTaskWidget({
        foregroundTasks: foregroundTasks.entries(),
        backgroundTasks: backgroundTasks.entries(),
        foregroundCount: foregroundTasks.size,
        backgroundCount: backgroundTasks.size,
        width,
        theme: widgetTheme,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const active = [
        ...Array.from(foregroundTasks.entries()),
        ...Array.from(backgroundTasks.entries()),
      ];
      if (active.length === 0) return [];
      const [, task] = active[0]!;
      return [
        truncateToWidth(
          `${task.agentType}  • ${formatMs(Date.now() - task.startedAt)}  (render error: ${msg})`,
          Math.min(width, 120),
        ),
      ];
    }
  }

  function ensureTaskWidget(targetCtx: ExtensionContext): void {
    if (widgetCtx || targetCtx.mode !== "tui") return;
    widgetCtx = targetCtx;
    targetCtx.ui.setWidget("task", (tui, theme) => {
      widgetTheme = theme ?? null;
      widgetTimer = setInterval(
        () => tui.requestRender(),
        TASK_WIDGET_RENDER_MS,
      );
      widgetTimer.unref?.();
      return {
        render: (width: number) => renderWidget(width),
        invalidate: () => {},
        dispose: () => {
          widgetTheme = null;
          stopWidget();
        },
      };
    });
  }

  function clearTaskWidgetIfIdle(): void {
    if (foregroundTasks.size > 0 || backgroundTasks.size > 0) return;
    if (widgetCtx) {
      widgetCtx.ui.setWidget("task", undefined);
      widgetCtx = null;
    }
    stopWidget();
  }

  function dispose(): void {
    if (widgetCtx) {
      widgetCtx.ui.setWidget("task", undefined);
      widgetCtx = null;
    }
    widgetTheme = null;
    stopWidget();
  }

  return { ensureTaskWidget, clearTaskWidgetIfIdle, dispose };
}
