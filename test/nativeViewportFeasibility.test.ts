/**
 * Platform-capability guard for the native child viewport migration.
 *
 * The approved migration was to mount the child live view through
 * `ctx.ui.custom(factory, { overlay: false })` and let a native `ScrollView`
 * inside it provide the scrollbar, wheel routing, and selection geometry.
 *
 * That is not reachable on pi 1.0.2. `showExtensionCustom` mounts a non-overlay
 * component into the host's plain `Container` editor slot
 * (`@earendil-works/pi-coding-agent` dist/modes/interactive/interactive-mode.js:
 * `editorContainer = new Container()` and
 * `editorContainer.clear(); editorContainer.addChild(component)`), and the
 * layout engine treats any component without a layout node as a leaf: it
 * renders the subtree to lines and clips it (`@earendil-works/pi-tui`
 * dist/layout.js, the `if (!node)` branch). Only `Stack` (VStack/HStack) and
 * `ScrollView` expose a layout node (`dist/components/stack.js`,
 * `dist/components/scroll-view.js`), so a ScrollView below that plain Container
 * never becomes a scroll node: the host's frame has no scrollbar geometry
 * (`getScrollbarGeometry`), no wheel target (`getScrollViewsAt`), and no
 * `primaryScrollView` for it.
 *
 * The tests below pin that difference: the engine supports the composition when
 * the view is a direct stack entry, and the real mount path cannot reach that
 * position. If Pi ever mounts extension components as layout participants, the
 * second test fails and the migration becomes actionable.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";

/** Deep import: pi-tui publishes no layout entry point in its package index. */
async function loadLayout() {
  return import("@earendil-works/pi-tui/dist/layout.js");
}

const style = (text: string): string => text;

/** A document component: a layout leaf that renders lines. */
class Lines extends Container {
  constructor(
    private readonly count: number,
    private readonly label: string,
  ) {
    super();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return Array.from({ length: this.count }, (_, index) =>
      `${this.label} ${index}`.padEnd(safeWidth).slice(0, safeWidth),
    );
  }
}

/** The child view as designed for the migration: native ScrollView + dock. */
function childView() {
  const document = new ScrollView(new Lines(200, "child"), {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "auto",
    scrollbarTrackStyle: style,
    scrollbarThumbStyle: style,
  });
  const view = new VStack([
    { component: new Text("task 1/1 · general", 0, 0), shrink: 1, minSize: 0 },
    { component: document, grow: 1, shrink: 1, minSize: 1 },
    { component: new Text("> steer", 0, 0), shrink: 1, minSize: 3 },
    { component: new Text("footer", 0, 0), shrink: 1, minSize: 0 },
  ]);
  return { view, document };
}

function parentTranscript() {
  const document = new Container();
  document.addChild(new Lines(300, "parent chat"));
  return new ScrollView(document, {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "auto",
    scrollbarTrackStyle: style,
    scrollbarThumbStyle: style,
  });
}

function boxFor(root: unknown, component: unknown): any {
  return (function walk(box: any): any {
    if (box.component === component) return box;
    for (const child of box.children ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  })(root);
}

test("the layout engine gives a stack entry's ScrollView a real viewport", async (t) => {
  const layout = await loadLayout().catch(() => undefined);
  if (!layout) {
    t.skip("pi-tui layout internals are unavailable in this version");
    return;
  }
  const transcript = parentTranscript();
  const { view, document } = childView();
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: view, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);

  const frame = layout.renderLayoutFrame(root, 80, 24, () => {});
  const box = layout.getScrollViewBox(frame, document);
  assert.ok(box, "the inner ScrollView is a scroll node of the frame");
  assert.equal(box.rect.height, 20, "it receives a real viewport height");
  assert.equal(
    layout.getScrollViewsAt(frame, 5, 5).includes(document),
    true,
    "wheel hit-testing finds it under the pointer",
  );
  assert.equal(frame.primaryScrollView, document, "it becomes the frame's primary scroll view");
  assert.ok(layout.getScrollbarGeometry(box, true), "native scrollbar geometry exists for it");
});

test("a component mounted through ui.custom(overlay:false) is a layout leaf", async (t) => {
  const layout = await loadLayout().catch(() => undefined);
  if (!layout) {
    t.skip("pi-tui layout internals are unavailable in this version");
    return;
  }
  const transcript = parentTranscript();
  const { view, document } = childView();
  // The host's mount path: the custom component lives inside a plain Container
  // that is itself a stack entry of the dock.
  const editorContainer = new Container();
  editorContainer.addChild(view as never);
  const footerContainer = new Container();
  footerContainer.addChild(new Text("parent footer", 0, 0));
  const dock = new VStack([
    { component: editorContainer, shrink: 1, minSize: 3 },
    { component: footerContainer, shrink: 1, minSize: 0 },
  ]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);

  const frame = layout.renderLayoutFrame(root, 80, 24, () => {});
  const editorBox = boxFor(frame.root, editorContainer);
  assert.ok(editorBox, "the editor container is laid out");
  assert.equal(editorBox.children.length, 0, "it is a leaf: the engine does not recurse into it");
  assert.ok(editorBox.lines.length > 0, "its subtree is rendered to lines and clipped");
  assert.equal(
    layout.getScrollViewBox(frame, document),
    undefined,
    "the child view's ScrollView never becomes a scroll node",
  );
  assert.equal(
    layout.getScrollViewsAt(frame, 5, 5).includes(document),
    false,
    "native wheel routing cannot reach it",
  );
  assert.equal(frame.primaryScrollView, transcript, "the parent chat stays the primary scroll view");
  assert.equal(editorBox.rect.height, 23, "the dock gives the mounted view the screen minus the parent chat");
});
