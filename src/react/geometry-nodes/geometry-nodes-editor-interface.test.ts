import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Regression cover for the Geometry Nodes editor's touch and framing review.
 *
 * These are source-text assertions for the same reason
 * `src/react/studio/studio-interface.test.ts` gives: a headless browser cannot
 * see most of them. `--st-touch` is a hit-target contract rather than a pixel a
 * screenshot shows, and the framing bug only appears when a fit computed for
 * one stage is displayed in another — which needs two live layouts, not one.
 * The rest are here because they are one careless edit from returning: the
 * whole finding was that add and delete lived behind `contextmenu` alone, which
 * a touch device cannot raise.
 */

const repo = new URL("../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, repo), "utf8");

const editor = read("src/react/geometry-nodes/GeometryNodesEditor.tsx");
const editorCss = read("src/react/pages/crayon-compare.css");
const graphModel = read("src/geometry-nodes/graph-model.ts");

/** The mobile block in crayon-compare.css, which must track MOBILE_STUDIO_QUERY. */
const mobileBlock = (): string => {
  const start = editorCss.indexOf("@media (max-width: 820px), ((pointer: coarse) and (max-height: 500px)) {");
  assert.ok(start > 0, "crayon-compare.css must carry the mobile block");
  return editorCss.slice(start);
};

// —— A touch device cannot raise `contextmenu`, so add and delete were unreachable.
test("both menus have a touch route that does not need a right button", () => {
  // A long press on the stage, routed to the same openers the mouse uses.
  assert.match(editor, /onPointerDown=\{onStagePointerDown\}/);
  assert.match(editor, /const onStagePointerDown = \(event: React\.PointerEvent/);
  assert.match(editor, /if \(event\.pointerType === "mouse"\) return;/);
  assert.match(editor, /window\.setTimeout\(\(\) => \{[\s\S]*?openNodeMenuAt\(clientX, clientY, nodeId\)[\s\S]*?openAddMenuAt\(clientX, clientY\)/);
  assert.match(editor, /LONG_PRESS_MS = \d+/);
  // Movement past the slop is a pan, not a press.
  assert.match(editor, /Math\.hypot\(event\.clientX - pending\.x, event\.clientY - pending\.y\) > LONG_PRESS_SLOP_PX\) cancelLongPress\(\)/);
  // The release that completes a long press must not close the menu it opened.
  assert.match(editor, /if \(swallowPaneClick\.current\) \{\s*\n\s*swallowPaneClick\.current = false;\s*\n\s*return;/);
  // A visible affordance too, because a long press announces nothing.
  assert.match(editor, /\{isMobile && <button className="graph-add-node"/);
  assert.match(editor, /title="Add a node · Shift\+A">\+ Add<\/button>/);
});

test("the desktop right-click path is untouched", () => {
  assert.match(editor, /onPaneContextMenu=\{openAddMenu\}/);
  assert.match(editor, /onNodeContextMenu=\{openNodeMenu\}/);
  assert.match(editor, /onEdgeContextMenu=\{openEdgeMenu\}/);
  assert.match(editor, /const openAddMenu = \(event: MouseEvent \| React\.MouseEvent\): void => \{\s*\n\s*event\.preventDefault\(\);/);
  // The Add button is mobile-only: this strip already scrolls its own controls
  // on a 1120px desktop window, and desktop has right-click and ⇧A.
  assert.doesNotMatch(editor, /className="graph-add-node"[\s\S]{0,80}\}\}(?![\s\S]{0,400}isMobile)/);
});

// —— Blender opens Add with ⇧A; the editor bound F3, ⇧D and ⌘C/X/V but not it.
test("Shift+A opens the add menu at the pointer", () => {
  const binding = editor.match(/if \(event\.shiftKey && !event\.metaKey && !event\.ctrlKey && !event\.altKey && event\.key\.toLowerCase\(\) === "a"\) \{[\s\S]*?\n      \}/);
  assert.ok(binding, "no ⇧A binding");
  assert.match(binding[0], /event\.preventDefault\(\)/);
  assert.match(binding[0], /pointerSeen\.current \? lastPointer\.current : stageCentre\(\)/);
  assert.match(binding[0], /openAddMenuAt\(spot\.x, spot\.y\)/);
  // ⇧D must still reach duplicate rather than being swallowed by the new branch.
  assert.ok(
    editor.indexOf('event.key.toLowerCase() === "a"') < editor.indexOf('event.key.toLowerCase() === "d" && ids.length'),
    "⇧A must not shadow ⇧D",
  );
});

// —— A menu opened from the right edge of a 390px phone rendered 190px off it.
test("both popups are clamped into the viewport", () => {
  assert.match(editor, /function clampMenuToViewport/);
  assert.match(editor, /window\.innerWidth - box\.width - margin/);
  assert.match(editor, /const spot = clampMenuToViewport\(clientX, clientY, ADD_MENU_BOX\)/);
  assert.match(editor, /const spot = clampMenuToViewport\(clientX, clientY, CONTEXT_MENU_BOX\)/);
  // The node still lands where the user pointed; only the popup box moves.
  assert.match(editor, /flow\?\.screenToFlowPosition\(\{ x: clientX, y: clientY \}\)/);
  // The 70vh the clamp assumes has to exist in CSS for both menus, and the
  // popups must be border-box or the border and padding push the real box past
  // the footprint the clamp reserved (which put the context menu 4px off a
  // 390px phone).
  assert.match(editorCss, /\.graph-popup \{ box-sizing: border-box;/);
  assert.match(editorCss, /\.graph-add-menu \{ display: flex; flex-direction: column; width: 280px; max-height: min\(420px,70vh\)/);
  assert.match(mobileBlock(), /\.graph-context-menu \{ max-height: 70vh/);
  assert.match(editor, /MENU_MAX_VIEWPORT_FRACTION = \.7/);
  // The row list has to give up height when 70vh caps the menu; a fixed 350px
  // list ran ~90px past a 273px menu at 844x390, unreachable behind `hidden`.
  assert.match(editorCss, /\.graph-add-menu > div \{ flex: 1 1 auto; min-height: 0; max-height: 350px/);
});

// —— A fit computed for the desktop dock, displayed in the phone overlay.
test("the working-set framing is computed against the stage it lands in", () => {
  // The size of the set gives way, not the readable scale it is drawn at: the
  // limit walks down until the stage can hold that many at the zoom floor.
  assert.doesNotMatch(editor, /graphWorkingSetNodeIds\(graph, 12\)/);
  assert.match(editor, /for \(let limit = WORKING_SET_LIMIT; limit >= WORKING_SET_MIN_NODES; limit -= 1\)/);
  assert.match(editor, /if \(fitted >= WORKING_SET_MIN_ZOOM\) break;/);
  assert.match(editor, /const stage = stageRef\.current\?\.getBoundingClientRect\(\)/);
  assert.match(editor, /fitZoomForBounds\(flow\.getNodesBounds\(candidates\), stage\.width, stage\.height, WORKING_SET_PADDING\)/);
  // The smallest set still may not be cropped — there would be nothing left.
  assert.match(editor, /minZoom: Math\.min\(WORKING_SET_MIN_ZOOM, fitted\)/);
  // Mirrors getViewportForBounds in @xyflow/system: padding is a fraction of
  // the stage, halved per side. A different formula would silently re-crop.
  assert.match(editor, /Math\.floor\(\(width - width \/ \(1 \+ padding\)\) \* \.5\) \* 2/);
});

test("the editor re-frames itself when its stage changes shape", () => {
  // Two failures, one observer. The host dispatches its resize event in the
  // frame the overlay opens, before the lazy editor chunk exists to hear it.
  // And the mount-time framing runs in a `requestAnimationFrame` that beats
  // React Flow's own measurement pass, so `fitView` sees zero measured nodes
  // and returns without touching the viewport — the docked editor at 1440x900
  // opened at zoom 1 with none of its output chain framed.
  assert.match(editor, /new ResizeObserver\(/);
  assert.match(editor, /observer\.observe\(stage\)/);
  assert.match(editor, /previous\.width \* \.05/);
  // Annotated graphs open on their authored view centre and must not be refit.
  assert.match(editor, /if \(!reshaped \|\| annotatedRef\.current\) return;/);
  // The observer must not list frameWorkingSet as a dependency: it re-identifies
  // on every node change, so a drag would rebuild the observer and refit.
  const effect = editor.match(/const observer = new ResizeObserver\([\s\S]*?\n  \}, \[flow\]\);/);
  assert.ok(effect, "the ResizeObserver effect must depend on [flow] alone");
  assert.match(editor, /frameWorkingSetRef\.current\(0\)/);
});

// —— "69 nodes · 6…", "double-cl…", "Identifiers …" — three truncated strings.
test("the status bar drops to one message on a phone", () => {
  const footer = editor.match(/<footer className=\{`graph-statusbar[\s\S]*?<\/footer>/);
  assert.ok(footer, "no status bar");
  assert.match(footer[0], /\{!isMobile && <span>\{graph \? `\$\{graph\.nodes\.length\} nodes/);
  // The link diagnostic survives on a phone only when it has something to say.
  assert.match(footer[0], /\(!isMobile \|\| Boolean\(graph\?\.unresolvedLinks\.length\)\)/);
  // Double-click is not the mobile route into a group — the ◆ marker is.
  assert.match(footer[0], /isMobile \? "Tap a node · ◆ enters a group/);
  assert.match(mobileBlock(), /\.graph-statusbar\.compact \{ grid-template-columns: minmax\(0, 1fr\) auto/);
});

// —— Measured at 390x844 and 844x390.
test("the mobile overlay clears its own graph", () => {
  const block = mobileBlock();
  // 46x134 of a 390x711 stage, sitting on a node in the bottom-left corner.
  assert.match(block, /\.st-overlay \.react-flow__controls \{ display: none/);
  // The attribution is 60x15 in the same corner as the 130x84 minimap.
  assert.match(block, /\.st-overlay \.annotation-minimap \{ bottom: 30px/);
  // The search input measured 42px: `height: 100%` of a bordered 44px wrapper.
  assert.match(block, /\.st-overlay \.graph-search \{ height: calc\(var\(--st-touch\) \+ 2px\)/);
  // Menu rows are hit targets now that a finger can open them.
  assert.match(block, /\.graph-add-menu > div button,\s*\n\s*\.graph-context-menu button \{ min-height: var\(--st-touch\)/);
  // A long press must not raise the platform's text-selection callout instead.
  assert.match(block, /\.st-overlay \.blender-flow-stage \{ -webkit-touch-callout: none/);
});

// —— The add menu showed "Capture Attribute" four times and "Group" twenty.
test("add-menu variants keep the dump-harvested catalog and still read apart", () => {
  // The constraint the catalog exists for stays documented on the function.
  assert.match(graphModel, /keeps socket definitions and evaluator support aligned without a\n \* parallel hand-maintained registry/);
  assert.match(graphModel, /function nameTemplateVariants/);
  assert.match(graphModel, /family: `\$\{node\.type\} \$\{nested\}`/);
  // A group node is named by the tree it instances, as Blender titles it.
  assert.match(graphModel, /label: node\.label\?\.trim\(\) \|\| nested \|\| String\(node\.props\?\.bl_label \?\? node\.name\)/);
  // The menu groups by watching the family key change across a sorted list.
  assert.match(editor, /const templateFamilies = useMemo/);
  assert.match(editor, /if \(current && current\.key === template\.family\)/);
  assert.match(editor, /\{family\.varied && <h4>\{family\.label\}<span>\{family\.templates\.length\}<\/span><\/h4>\}/);
  assert.match(editor, /<b>\{template\.variant \?\? template\.label\}<\/b>/);
  // Search has to reach the variant text, or "vector" finds no Capture Attribute.
  assert.match(editor, /\$\{template\.label\} \$\{template\.variant \?\? ""\} \$\{template\.type\}/);
  // 60 rows was under the crayon dump's 114 templates.
  assert.match(editor, /const ADD_MENU_MAX_ROWS = 120/);
});
