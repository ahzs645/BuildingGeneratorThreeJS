# Interface review — desktop and mobile

> **Status: all twenty findings resolved.** Each finding keeps the measurement
> that prompted it; the **Fixed** note at the end of each records what the same
> measurement reads now. Re-verified headlessly at the same six viewports, with
> `npm test` and `tsc --noEmit` green — 753 tests, 751 pass, 2 skipped, 0 fail
> at the time of writing, and the suite is still growing, so treat that number
> as a date stamp rather than a constant.
>
> **An independent audit falsified several claims in this document** and found
> four regressions in the fixes. Everything it falsified is corrected inside
> the finding it belongs to; the regressions and the tests that could not fail
> are in *Third pass* below.
>
> **A fourth pass opened the mobile sheet**, which no harness here had ever
> done — a collapsed sheet hides its body, so every control a phone user taps
> was invisible to the sweep that claimed to measure them. Seven more findings,
> all resolved, in *Fourth pass* below; `npm run test:mobile` is the harness
> that drives them.
>
> **A fifth pass loaded all 104 assets** in the library rather than the one the
> fourth pass happened to tap. The catalog is healthy — every path resolves,
> every asset installs on the object it names — and one empty-state sentence
> was wrong. `npm run test:library`.

Reviewed against `main` at commit `b618e21`, driven headlessly through Chromium
(SwiftShader) at six viewports: 1440×900, 1280×800, 1024×768, 834×1112,
844×390, and 390×844. All ten routes were visited at desktop and phone size;
`/building`, `/paint`, and `/crayon` were additionally measured across the
intermediate widths.

Numbers below are measured, not estimated — each finding names the element and
the value that was read off the live page.

## Summary

The shell is in good shape. `studio-kit.css` is a real design system, the
ink/surface palette clears WCAG AA on every surface (worst pair is `--st-ink-3`
on `--st-raised` at 4.91:1), the grid shell means no panel can ever cover the
geometry, and the dock/sheet split is a genuine exclusive render path rather
than CSS-hidden duplicates.

The problems cluster in five areas, in rough priority order:

1. **A dead band between 821 px and 1180 px** where the desktop layout survives
   but the viewport does not. This is the most serious issue found.
2. **The Building Generator never re-frames its camera**, so its headline
   parameter produces no visible change.
3. **Toolbars clip instead of wrapping**, hiding primary controls on both
   desktop and phone.
4. **Mobile chrome details** — a hidden entry point, an overlapping FAB, missing
   safe-area insets.
5. **Design-system drift and mobile payload**, both slow-burn rather than acute.

---

## A. Responsive layout

### A1 — The 821–1180 px band collapses the viewport (critical)

`MOBILE_STUDIO_QUERY` switches to the phone layout at `max-width: 820px`. Below
1180 px the nav's section switcher is hidden. Between those two numbers nothing
else changes: the 56 px rail, the 300 px left dock and the 320 px inspector all
stay at full width, so 676 px of a 834 px screen is chrome.

Measured `.st-viewport` widths:

| Viewport | Route | Viewport width | Docks |
| --- | --- | --- | --- |
| 834×1112 (iPad portrait) | `/building` | **158 px** | 300 + 320 |
| 834×1112 | `/crayon` | **158 px** | 300 + 320 |
| 834×1112 | `/paint` | 284 px | 154 + 340 |
| 1024×768 (iPad landscape) | `/building` | 348 px | 300 + 320 |
| 1024×768 | `/crayon` | 348 px (407 px tall) | 300 + 320 |
| 1280×800 | `/building` | 604 px | 300 + 320 |

At 834 px the Building Generator renders the tower into a 158 px-wide slit
between two full-height dock columns. The tool is unusable on the most common
tablet size, and an iPad reports `pointer: coarse` with a tall viewport, so the
landscape escape hatch in the media query does not catch it either.

Options, cheapest first:

- Raise the mobile breakpoint to ~1024 px so tablets get the sheet.
- Or add an intermediate rule: one dock at a time (the inspector collapses into
  a tab of the left dock), keeping a minimum viewport width of ~480 px.
- Or make `--st-dock-w` / `--st-inspector-w` fluid — `clamp(220px, 22vw, 300px)`
  — so the docks give ground before the viewport does.

The nav already anticipates this band (`@media (max-width: 1180px)` hides the
switcher); the body layout just never got the matching rule.

**Fixed** — `studio-kit.css` gains a 821–1180px block: the rail collapses to 0
(the nav keeps its section switcher instead, `studio-nav.css`) and both docks
become `clamp(196px, 25vw, …)`. Parameter rows go two-line in the band, since a
196px dock cannot spare 96px for a label and still leave a draggable track.

| Viewport | Route | Before | After |
| --- | --- | --- | --- |
| 834×1112 | `/building` | 158 px | **417 px** |
| 834×1112 | `/bin` | 158 px | **514 px** |
| 1024×768 | `/crayon` | 348 px | **512 px** |
| 834×1112 | slider track | 39 px | **126 px** |

### A2 — Phone landscape leaves almost no viewport

At 844×390 the chrome is nav 104 px + toolbar 50–70 px + status 30 px + collapsed
sheet 45 px. Measured `.st-viewport` heights:

- `/building` — 220 px of 390 px
- `/paint` — **127 px of 390 px**

`studio-shell.css:118` already shortens the sheet handle under
`(max-height: 500px)`. The nav needs the same treatment: in landscape it should
collapse to one row (`--st-nav-h: 44px`) with the section switcher moving into
the Tools menu, rather than keeping the two-row 104 px stack.

**Fixed** — the nav is one row in landscape (`--st-nav-h: 52px`; lead ·
switcher · trail across 844px, switcher items keeping their 44px touch height),
the toolbar 42px and the status bar 28px. `/paint` goes from **127 px to 179 px**
of viewport. The rules live in `studio-nav.css`, after the mobile block they
override — in the kit they lost on load order.

### A3 — The Surface Studio toolbar clips rather than wraps

`.surface-painter-page .st-toolbar` is `overflow-x: auto` with a
`min-width: max-content` child, so it scrolls. Measured content width is 940 px
on every viewport:

| Viewport | Toolbar client width | Hidden |
| --- | --- | --- |
| 1440×900 | 884 px | 56 px |
| 1280×800 | 730 px | 210 px |
| 390×844 | 390 px | **550 px** |

Group positions on a 390 px phone: Surface `10–369`, Projection `377–600`,
Mode `608–784`, Document `792–930`. **Mode** — the Orbit/Draw/Flower switch,
the control that decides whether a touch orbits the model or paints on it — sits
entirely off-screen, as do Undo and Clear, behind a horizontal scroll with no
visible affordance (the strip has `scrollbar-width: thin` on desktop and the
kit hides scrollbars on mobile).

A painting tool's mode switch should not be discoverable only by swiping a strip
that gives no sign it scrolls. Suggested: let the toolbar wrap
(`flex-wrap: wrap`) on desktop, and on phones promote Mode into the viewport as
a small fixed segmented control (or into the sheet's tab bar) and move
Document/history into the sheet.

**Fixed** — the strip wraps instead of scrolling on desktop, so **nothing is
hidden at any desktop width** (0 px clipped at 1440 and at 1280, from 56 and
210). A phone is too narrow for wrapping to help — four groups would stack into
a 200px toolbar — so it still scrolls there, but Mode is `position: sticky;
left: 0; order: -1`: pinned to the leading edge, always reachable, with an inset
shadow at the trailing edge so the strip reads as scrollable.

**This fix had a cost it never measured — see R1.** "Nothing is hidden" was
true and "the strip is now 221 px tall at 1024×768" was also true. The phone
treatment described above is unchanged; what changed is how many groups are in
the strip for it to handle.

### A4 — Node-editor header clips on desktop

On `/crayon` at 1440×900 the docked node editor's own toolbar runs past the
viewport column: the **Save** button renders as "Sav", and the hint text ends at
"Identifiers mapped determi…". The React Flow attribution also lands under the
minimap. The 250 px `--st-node-dock` height leaves the graph itself about 180 px
tall, which is under one node's worth of vertical space.

**Fixed** — `.blender-flow-toolbar` wraps rather than clips (0 px hidden, from
14 px), and the dock is `clamp(250px, 32vh, 380px)` — 289 px in a 900 px window.
Wrapping does not clip, so the search popup anchored in that row survives it.

---

## B. Viewport and camera

### B1 — `/building` never re-frames (high impact)

`src/main.ts:658` sets a fixed 3/4 framing once, after the kit loads:

```ts
camera.position.set(9, 5.5, 11);
controls.target.set(0, 3, 0);
```

Nothing recomputes it afterwards. The resize observer at `src/main.ts:669` only
updates `camera.aspect` and the render targets.

Consequences, all reproduced:

- Setting **Floors** from 6 to 40 changes nothing visible. The status bar
  updates to "40 floors · 7 × 3" and the render is pixel-identical, because the
  extra 34 floors are above the frustum. Floors is the first slider in the dock
  and the generator's headline parameter.
- On a 390×664 phone viewport the building is cropped on all four sides.
- On the 158 px tablet slit (A1) only a sliver of façade is visible.

There is also no **Reframe** control on this page, and it is the only 3D route
without one — `/vase` (`VaseComparePage.tsx:32`), `/typewriter`
(`TypewriterPage.tsx:24`), `/bin` (`BinComparePage.tsx:159`) and `/gallery`
(`DojoGalleryPage.tsx:32`) all have one.

Fix: frame from the generated bounds after each rebuild (or at minimum on
floor/length/width changes), and add a Reframe button to the toolbar.

**Fixed** — `frameBuilding()` solves the distance from `getBounds()` and keeps
whatever direction the user has orbited to, so re-framing never steals their
angle. It runs after each rebuild (keyed on the three dimension params, so the
other fifteen never nudge the camera), on a step change in viewport aspect, and
from a new **Reframe** button in the toolbar — the last 3D route to get one.
`controls.maxDistance` follows the subject now, because a 40 × 40 × 40 tower
needs ~160 units against the authored ceiling of 120. Floors 6 → 40 frames the
whole tower; the phone and tablet viewports show the whole building.

### B2 — Every camera fit ignores aspect ratio, and there are five of them

`src/camera-fit.ts:19` fits using the vertical half-FOV only:

```ts
const halfFov = THREE.MathUtils.degToRad(camera.fov * .5);
const distance = Math.max(sphere.radius * padding / Math.sin(halfFov), 1);
```

In a portrait viewport the *horizontal* FOV is the narrower of the two, so a
wide object overflows the sides even though the fit "succeeded". Visible on
`/bin` at 390×844, where the drawer is cut off at the right edge.

The same aspect-blind expression is written out five separate times, so the bug
is five bugs:

| File | Line |
| --- | --- |
| `src/camera-fit.ts` | 19 |
| `src/bin-compare.ts` | 555 (`frameComparison`) |
| `src/dojo-gallery.ts` | 119 |
| `src/blend-studio/runtime.ts` | 857 |
| `src/blend-import.ts` | 257 |

`camera-fit.ts` already exists as the shared helper — only `typewriter.ts` calls
it. Routing the other four through it, with the smaller of the two half-angles,
fixes portrait framing everywhere at once:

```ts
const halfFovY = THREE.MathUtils.degToRad(camera.fov * .5);
const halfFovX = Math.atan(Math.tan(halfFovY) * camera.aspect);
const halfFov = Math.min(halfFovY, halfFovX);
```

**Fixed** — `camera-fit.ts` exports `fitDistanceForRadius(camera, radius,
padding)`, taking the smaller of the two half-angles, and all five sites call it
— plus `main.ts`, which had no fit at all. `/bin` at 390×844 frames the drawer
inside the viewport instead of running off the right edge.

### B3 — Aspect-change reframing exists in exactly one place

`src/bin-compare.ts:1076` re-frames when the viewport aspect moves by more than
18 %, which is exactly the right behaviour for a tool that switches between a
300 px dock layout and a full-bleed phone sheet. Nothing else does this, so
rotating a phone or opening the sheet leaves every other tool mis-framed. Worth
lifting into a shared helper alongside `camera-fit.ts`.

**Fixed** — lifted into `createAspectGate(threshold)` in `camera-fit.ts`. The
Bin uses the shared version and the Building Generator's resize observer uses it
too. A drag-resize never clears the gate, so it cannot fight an orbit in
progress.

---

## C. Mobile

### C1 — The Studio home page has no entry point on a phone

On `/` at 390×844 the viewport shows only the "3D VIEWPORT · EVALUATED GEOMETRY"
watermark. The dropzone, **Browse asset library**, and **Try included bin
sample** all live in the left dock, which on mobile is inside a *collapsed*
sheet labelled "Source · Checks". A first-time phone visitor lands on an empty
dark screen with no call to action; on desktop the same page shows the dropzone
immediately.

Either open the sheet by default when no graph is loaded, or give
`.st-tool-state` / the watermark a real CTA button on mobile.

**Fixed** — `StudioShell` takes `sheetInitiallyOpen`, and `/` passes it while
nothing is loaded. The sheet opens to its peek detent showing Source: the
dropzone and **Browse asset library** are visible on load, with the viewport
still visible above them.

### C2 — The node-editor FAB sits on top of the status bar

Measured on `/crayon` at 390×844:

- `.graph-toggle` — top 740, bottom 784, x 220–376
- `.st-statusbar` — top 768, bottom 799, full width

16 px of vertical overlap, and the button covers the right half of the strip
horizontally. The status bar is described in `studio-kit.css` as the tool's only
state readout, so it should not be coverable. `studio-shell.css:155` positions
the FAB at `bottom: calc(60px + safe-area)`; it needs to clear
`--st-sheet-collapsed + --st-status-h` instead.

**Fixed** — the FAB is pinned at
`calc(var(--st-sheet-collapsed) + var(--st-status-h) + 12px)`. Measured on the
same phone: FAB bottom 757, status bar top 768 — 11 px of clearance, from 16 px
of overlap.

### C3 — No horizontal safe-area insets on the chrome

`env(safe-area-inset-*)` appears in the sheet, the overlay and the asset
library, but `.st-nav`, `.st-toolbar` and `.st-statusbar` all use flat
`padding: … 10px`. On a notched phone in landscape — the same orientation that
already suffers from A2 — the breadcrumb and the leading status text run under
the notch and the home indicator's side inset.

**Fixed** — all three strips use `max(12px, env(safe-area-inset-left/right))`.
Read from the CSS, not observed on hardware (see Scope).

**The first fix did not apply to the nav — the strip this finding is about.**
It wrote `.st-nav { padding-left: max(10px, env(…)) }` into the kit's mobile
block, at one class. `studio-nav.css` declares `padding: 5px 10px 6px` on
`.st-nav` in *its* mobile block: same specificity, later-loading file, and a
shorthand, so it reset both inline sides to a flat 10px. Measured at 390×844
and 844×390 on every route: nav `padding-left` **10px**, toolbar and status bar
12px — the toolbar and status bar worked, the breadcrumb did not. This is the
same load-order hazard A2's comment documents, one section further down the
same file. The prose above also said 12px while the nav said 10px.

The rule is now `.st-shell .st-nav, .st-shell .st-toolbar, .st-shell
.st-statusbar` — two classes, so a bare-class `padding` shorthand added later
by any stylesheet loses regardless of order — and it lives outside the mobile
block with its own media query. Measured after: **12px on all three strips**,
at 390×844 and 844×390, and still 12px after a bare `.st-nav { padding: 5px
10px 6px }` rule is appended to the live document, which is the check
`tools/test-interface-measurements.mjs` runs.

### C4 — `vh` instead of `dvh` in the sheet

`studio-kit.css:560` — `.st-sheet.is-open { height: calc(62vh + …) }`. On iOS
Safari `vh` resolves against the *largest* viewport, so with the browser
toolbars visible the open sheet is taller than the space available and its last
control row falls under the toolbar. `dvh` (with a `vh` fallback) fixes it. The
same applies to `studio-menu.css:3` (`padding: 8vh 16px 6vh`) and
`asset-library.css:4` (`max-height: 90vh`).

**Fixed** — the sheet declares `vh` then `dvh`, so the second wins where
supported and the first is the fallback. The tool menu's backdrop padding and
max-height are `dvh` too, and — after a second pass found it missed —
`asset-library.css`, the third file this finding names: `padding: 5vh` gains
`padding-block: 5dvh` and `max-height: 90vh` gains `max-height: 90dvh`. The
regression test opens all three files now; it opened two.

### C5 — The open sheet hides what you are adjusting

`62vh` plus a 104 px nav and a 50 px toolbar leaves roughly 200 px of viewport
while the sheet is open, and on `/building` that remaining strip shows the
cropped middle of the façade. Dragging a slider gives you almost no visual
feedback on the thing you are changing. A two-detent sheet (a ~35 % "peek" stop
before the full 62 %) would fix this without new components — the handle is
already a button, it just needs a third state.

**Fixed** — the sheet has three detents and the handle cycles them:
collapsed → peek (34 dvh) → open (62 dvh) → collapsed, the label naming the next
step. Peek is also what `sheetInitiallyOpen` opens to (C1).

---

## D. Consistency and design-system drift

### D1 — Nav status chips are used by two pages out of ten

`useStudioStatusChips` is called only in `BlendBridgePage.tsx:852` and
`CrayonComparePage.tsx:102`. On the other eight routes the nav's `.st-nav-chips`
track renders empty, so the top-right of the bar reads differently depending on
which tool you are in and the trailing buttons shift position between routes.
Either give every tool one or two chips, or drop the affordance and let the
status bar carry state.

**Fixed** — chips are published in keyed groups (`runtime`, `page`) so more
than one publisher can coexist; before, whichever hook ran last replaced the
other's chips wholesale, which is *why* only two routes ever showed one. Both
runtime hooks in `page-runtime.ts` publish a `starting` / `runtime live` /
`runtime failed` chip, so nine of the ten routes carry the same fact. In the
tablet band the chip track is the first thing to give — at 834px it rendered
"runtime li".

**Nine, not ten.** `/materialx` mounts `mountMaterialXLab(root)` in a bare
`useEffect` — it is not a `{ createTool }` module, so the page called neither
runtime hook and published nothing. Measured at 1440×900: `.st-nav-chips`
**0 × 0** on `/materialx` against 88–237px on the other nine. The test that
was meant to cover this counted `useStudioRuntimeChip(` calls inside
`page-runtime.ts` and got 2, which is true and says nothing about whether a
route reaches one.

`page-runtime.ts` now exports `useRuntimePhaseChip(phase)`; both runtime hooks
call it and `/materialx` calls it directly from its own load/ready/error state,
so the three words a chip can say are still defined once. Measured after:
`.st-nav-chips` **114.5 × 28, "runtime live"** on `/materialx`, and a chip on
all ten routes at every desktop viewport.

### D2 — Three parameter-row implementations

- `.st-row` (the kit) — `96px | 1fr | 46px`, used by `/building`.
- `.bin-compare-page .st-row` — retuned to `112px | 1fr | 68px`, min-height 34 px
  (`bin-compare.css:16`).
- `.assets-control` — a bespoke label-above-slider row built imperatively in
  `src/chrome-assets.ts:173`, with its own input, output and select styling that
  duplicates `.st-select` / `.st-input` (`chrome-assets.css:31–42`).

The third one is the problem: because it is not a `.st-row`, none of the kit's
mobile rules apply to it. Inside the phone sheet its labels stay at 12 px where
every other tool's rows are bumped to 13 px, and any future touch-target work on
`.st-row` will silently skip `/chrome-assets`.

**Fixed** — the kit gains `.st-row.st-row-stacked`, a label-above variant of
THE row, and `chrome-assets.ts` emits it with `.st-input` / `.st-select` instead
of restating their styling. The wrapper the imperative builder emits is
`display: contents`, so the control and its readout are grid items of the row
itself and the kit's mobile rules land where they should. The inline 18px
checkbox sizing is gone too — it was overriding the sheet's 28px touch size.

### D3 — Type scale below the kit's own floor

`studio-kit.css:48` states 11 px is the floor for read text, with three named
exceptions. `surface-workspace-toolbar.css` adds three more:
group labels at **8 px** (`:35`), area labels at **9 px** (`:82`) and mode
buttons at **10 px** (`:73`); `surface-tool-selector.css` adds three of its
own: family labels at **9 px** (`:31`), tool glyphs at **9 px** (`:88`) and the
`Unavailable` caption at **8 px** (`:111`). These are the smallest text in the
app and they sit in the toolbar and the tool rail, i.e. the part of `/paint` a
user reads first.

**Fixed — the three in `surface-workspace-toolbar.css` first, the three in
`surface-tool-selector.css` after a second pass caught them.** The earlier note
here said "all four", counting six sites as four and claiming a file the fix
never opened. Measured live on `/paint` at 1440×900 before the second pass:
family label ×2 at 9px, tool glyph ×10 at 9px, `Unavailable` at 8px. All six
are `var(--st-fs-micro)` (11 px) now; measured after, zero elements under 11px
render text in `.st-nav`, `.st-toolbar`, `.st-statusbar` or
`.surface-tool-selector`, on all ten routes at all six viewports.

Two things this finding does **not** cover, so the claim above is not read as
wider than it is. The 9 px node-category badge is one of the kit's three named
exceptions and `.paint-node-badge` is the same badge in the painter's lil-gui
skin, so both stay. And `surface-painter.css` carries roughly a dozen more
8–10 px labels in that lil-gui skin — `.surface-projection-summary`,
`.surface-projection-layers legend`, the generator context caption — which D3
never listed and this pass did not change. They are a real instance of the same
drift; they are just not this finding.

### D4 — Sub-44 px touch targets in the same toolbar

`surface-workspace-toolbar.css:91` sets `min-height: 36px` for the toolbar's
buttons, selects and `.st-btn`s on mobile, against `--st-touch: 44px` which the
kit applies everywhere else on the phone. Same file, one line below the
breakpoint that acknowledges mobile exists.

**Fixed** — `var(--st-touch)`. A sweep of every interactive element at 390×844
across all ten routes reports zero targets under the minimum, the exceptions
being the visually-hidden file input behind the Import label and
`input[type=range]`, whose 44 px hit area the kit gives it under an 18 px bar.
The negative assertions covering this were literal blacklists —
`doesNotMatch(/min-height: 36px/)` passes on 38 px — and now parse the number:
every `height` / `min-height` in either file's mobile block is 0 or ≥ 44.

### D5 — `⌘K` is shown on every platform

`StudioNav.tsx:80` renders a literal `⌘K` cap and `StudioMenu.tsx:232` shows
"⌘K toggle · Esc close". The handler accepts `ctrlKey` too, so the *behaviour*
is cross-platform but the *label* is not: Windows and Linux users are told a
shortcut that does not exist for them. The cap is hidden below 520 px but shown
at 521–820 px, i.e. on tablets with no keyboard at all.

**Fixed** — `SHORTCUT_LABEL` resolves to `⌘K` on Apple platforms and `Ctrl K`
elsewhere, and the cap only renders under
`@media (any-pointer: fine) and (min-width: 521px)` — where a keyboard
plausibly exists.

### D6 — The ⌘K menu is a directory, not a palette

Pressing ⌘K opens a static list. There is no filter input, no arrow-key
navigation between entries, and no fuzzy matching — the affordances that
shortcut implies. It is also 944 px tall on a 900 px desktop viewport, so the
last section (Chrome Crayon Compare) is below the fold with the scroll living on
the backdrop and no visual hint. Adding a filter field at the top would both
meet the expectation and solve the overflow.

**Fixed** — a filter field takes initial focus and matches every term against
section, title, description and badge, reporting "n of 11". ↑/↓ move a highlight
through the filtered list and Enter navigates. The panel is `max-height: 86dvh`
with its own scroll and a sticky filter row, so it no longer outgrows the
viewport.

### D7 — The gallery's section title shows the selected model

`DojoGalleryPage.tsx:18` uses `.st-section-title` for `#title`, which the runtime
overwrites with the selected model's name. The result reads as "CHROME CRAYON"
in uppercase mono meta styling directly above a list of all five models — it
looks like a category header for a list it does not describe.

**Fixed** — `#title` moves into the panel header's meta slot ("BAKED MODELS ·
Chrome Crayon"), and the section is titled "Models · 5 bakes".

---

## E. Mobile payload

Not strictly interface, but it is what a phone user experiences as the
interface.

- `public/dojo` is 871 MB. Individual assets a tool fetches on demand:
  `gallery/hat-front.glb` **38.2 MB**, `chrome-assets/geometry-nodes-001/dump.json`
  **33.2 MB**, `n03d/benchy/dump.json` 27.3 MB, `joints/bubble-putty/dump.json`
  26.1 MB.
- `/vase` fetches `vase_truth.glb` (12.5 MB) plus `vase_vm.json` (14.3 MB) on
  every visit — and `vase-compare.ts:176` passes `cache: "no-store"`, so the
  14 MB JSON is re-downloaded every single time, never served from cache.
- There is no byte-level progress anywhere. `dojo-gallery.ts:145` sets one
  status string, "loading Blender bake…", and leaves it there. Selecting
  **Send Nodes Hat** on a phone is a 38 MB silent wait that reads as a hang.

Cheapest wins: drop `cache: "no-store"` on the vase JSON, wire `GLTFLoader`'s
`onProgress` into the existing `.st-state` status line, and precompress the JSON
dumps (they gzip extremely well). Draco/meshopt on the large GLBs is the bigger
but more durable fix.

**Fixed** — three changes, and one more bug found while making them:

- `src/load-progress.ts` formats byte-level progress; the gallery and both vase
  loads report `loading… 42% of 38.2 MB` into their existing `.st-state` line
  instead of one string that never changes.
- The gallery was appending `?v=${Date.now()}` to every GLB request — a
  cache-buster that re-downloaded up to 38 MB every time a model was reselected.
  Removed; these bakes are immutable for the life of a session.
- The vase's `cache: "no-store"` is now
  `import.meta.env.DEV ? "no-store" : "default"`. The comment on it was right —
  the exporter rewrites that file while Vite is running — but only in
  development. A deployed build has no exporter behind it, and the flag cost
  every visitor a fresh 14 MB.

Precompressing the dumps and putting Draco or meshopt on the large GLBs is the
durable next step; that is a build-pipeline change rather than an interface one.

---

## What is working well

Worth stating explicitly so none of it gets "fixed":

- **Contrast.** Every ink/surface pair clears AA. `--st-ink-3`, the most common
  colour in the app, is 5.19:1 on `--st-panel`; `--st-ink-4` is correctly held to
  the 3:1 non-text threshold and used only as a watermark.
- **The grid shell.** `position: fixed` on `.st-shell` sidesteps the iOS 100vh
  bug entirely, and docks-as-columns means no floating panel can occlude the
  geometry.
- **Exclusive render paths.** `StudioShell.tsx:118` renders either docks or the
  sheet, never both, so ids and file inputs exist exactly once. This is the
  detail most codebases get wrong.
- **Touch on the canvas.** OrbitControls sets `touchAction: 'none'` itself, so
  the 3D routes handle one- and two-finger gestures without page-scroll fights.
- **`bindStatusLine`.** One status treatment per tool, with tone and message
  bound together, is a genuinely good constraint.

## Follow-up

Three things surfaced after the fixes went in.

### The phone breadcrumb spent its width twice

Not one of the twenty — it was an observation, not a finding — but it is two
lines. At 390px the crumb rendered "Building Genera… / Hong Kong Building
Gener…": both halves truncated, and the section half is already spelled out by
the switcher directly below it, highlighted. On mobile the section and its
separator are hidden and the tool name takes the whole crumb.

### The test glob had been running two thirds of the suite

`"test": "tsx --test src/**/*.test.ts"` — unquoted, so the shell expanded it,
and npm runs scripts under `sh`, where `**` is just `*`. It matched
`src/*/*.test.ts` and nothing else: every test file directly under `src/` and
everything three levels deep never ran. That is 102 tests, including all of
`src/bin-interface.test.ts` and both `src/react/blend-studio/*.test.ts` files.

Quoting the pattern hands it to Node's own test runner, which walks it
properly. The suite went from 614 tests to 716 with that one change.

One of the tests that had stopped running was failing. `bin-interface.test.ts`
asserted that `bin-compare.ts` contains
`if (!canvas.isConnected) renderer.forceContextLoss()` — the deferred WebGL
release on a breakpoint remount. The behaviour is intact, but it moved into
`releaseToolContext` in `canvas-viewport.ts` at some point, and the assertion
pinned the line's old address rather than the contract. It now asserts that the
runtime delegates and that the helper does the connectivity-checked release.

### Regression cover

`src/react/studio/studio-interface.test.ts` locks in all twenty findings plus
the slider. Two of them cannot be verified any other way here: a safe-area inset
needs a notched phone, and `dvh` only diverges from `vh` where a browser toolbar
retracts, so those assert against the source that encodes them. The rest are
there because they are one careless edit away from returning — the review found
the same aspect-blind camera fit copied into five files.

Writing that file caught a regression in my own fix: pinning Mode to the leading
edge of the Paint toolbar (A3) made it the most-tapped control in the strip, and
I had left its buttons at 36px — the exact drift D4 was about. They are
`--st-touch` now, and phone landscape drops the four group captions to pay back
the height.

### The overlays were never in the sweep

Both modals open on demand, so neither the asset library nor the ⌘K menu ever
appeared in the viewport sweep that found the other sub-minimum targets. Opening
the library on a phone shows it works — full screen, two-up grid, scrolls — and
that it kept its own copy of two findings from this review:

- **Touch targets.** 26px filter chips, a 28px Close, a 28px search field: the
  same drift as D4, in a surface D4 never looked at.
- **A clipped strip with no affordance.** `.asset-library-categories` scrolls
  horizontally with the scrollbar hidden, so on a 390px phone "Studies" was cut
  mid-word and "Scenes" was off the end entirely — the same shape as A3.
- **Its own breakpoint.** The overlay went full-screen at `max-width: 720px`
  while the shell switches at 820px, so a 721–820px phone opened the desktop
  dialog inside a mobile shell — and a phone in landscape got a 353px-tall
  dialog whose cards were cut off mid-title.

Fixed: the overlay follows `MOBILE_STUDIO_QUERY`, the categories wrap instead of
scrolling, and touch sizing is keyed on `(pointer: coarse)` rather than a width
— an 834px tablet in portrait answers "is this a finger?" the same way a phone
does. The favourite star keeps its 30px circle and gets its 44px from a pad
around it. The ⌘K menu had the identical width-keyed bug and got the same rule.

Measured after: chips, Close and search all 44px on phone, phone-landscape and
tablet; 0px of category overflow; the star's pad confirmed live 4px outside the
visible circle; desktop unchanged at its dense 26/28px.

### A row of one is a row of one

`.st-btn-row` is a two-up grid (`1.4fr 1fr`). "Browse asset library" was its
only child, so it took the 1.4fr column — 271px of dropzone above it, 158px of
button — and left the 1fr column standing empty. `:has(> :only-child)` gives a
lone button the whole row, which fixes the class rather than the one call site.

## Second pass — the dropdowns

Three findings from a pass over every `<select>` in the app, measured the same
way.

### Two settings had no control at all

`/building`'s inspector is React; the lil-gui panel it replaced is still built
and mounted into `#building-gui-dock`, which `BuildingPage.tsx` renders
`hidden`. Two of the runtime's settings were only ever in that panel:
**tone mapping** (AgX · ACES · None · Blender Standard LUT) and
**environment** (Studio Room · Blender studio EXR). Measured on the live page:
82 lil-gui controllers inside a `display: none` dock, and no element anywhere in
the document offering either choice.

Neither list is fixed — the LUT joins it when
`post.loadBlenderColorProfile()` validates and the EXR when it parses, both
after the inspector has rendered — so they are published
(`subscribeAtmosphereOptions`) rather than read once. The EXR availability
probe moved out of `Environment.addGui()`, where it would have made the
inspector's choices depend on a legacy panel existing.

**Fixed** — both are `.st-select` rows in the Atmosphere inspector's Lighting
section, in the kit's `st-row-stacked` variant ("Blender Standard (LUT)" does
not survive the 1fr of a 320px column). Measured after, at 1440×900: four tone
options and two environment options, and against a 360×260 crop of the
viewport — AgX → None **4.53/255 mean, 63.9 % of channels changed**, AgX → ACES
6.12 and 46.8 %, AgX → LUT 3.76 and 68.3 %, Room → EXR 4.13 and 45.1 %, with
AgX → AgX **0.00 across every channel**, so the differences are the transform
and not renderer noise. The value round-trips: the hidden panel's own selects
read back what the inspector set.

### A combobox with 105 options and no name

`/typewriter`'s "Base object" was a `.st-section-title` div followed by a
sibling `<select>` — not a `<label for>`, so the accessibility tree read
`combobox ""`. Confirmed live before the fix; it reads
`combobox "Base object"` after.

### The same 104-entry catalogue, fronted three ways

`/typewriter` (Base object) and `/paint` (Reference object) each listed the
shape catalogue as a 105-option native `<select>` — nothing to type at, and a
full-screen wheel on a phone — while `/chrome-assets` already fronted the same
list with a text field over a `<datalist>` plus prev/next.

**Fixed** — one picker: `.st-searchable` in the kit,
`react/studio/searchable-select.ts` for the behaviour (matching, wrap-around
stepping, the value contract) and `SearchableSelect.tsx` for the markup. The
two imperative runtimes bind the same helper the React component binds, so
matching a typed name to an id exists once rather than three times.
`chrome-assets.css` gave up its copy of the picker's layout.

The value contract is what the runtimes read, and it did not change: the field
shows a title, the picker's value stays the id — `typewriter.ts`'s loader,
`/paint`'s reference lookup and the catalog's `?asset=` all still key on it.
Measured after: 105 datalist entries on `/typewriter` and `/paint`, 104 on
`/chrome-assets`; typing a title loads the shape (209 verts joined), the next
arrow steps and loads the following one, Clear returns the field to "None ·
text only"; on `/chrome-assets` the arrows still drive `?asset=`. `/paint`'s
toolbar keeps its desktop shape exactly — 0 px clipped and 143 px tall at 1440
and 1280, the same as with the 170 px select it replaced. (Re-measured later at
1024×768 it was 221 px, not the 205 px recorded here, and R1 is what that
number turned into.)

### The tablet never got the touch rules

Every touch rule in the kit is written against `.st-sheet`, and a tablet keeps
the docks: at 834×1112 the picker's arrows measured 28×28 and dock selects
28 px tall. `@media (pointer: coarse)` now sizes dock selects, dock inputs and
the picker's arrows at `--st-touch`, the same "is this a finger?" test the
overlays already use. Measured across `/typewriter`, `/chrome-assets`,
`/paint` and `/building` at 390×844 (sheet open) and 834×1112: **zero targets
under 44 px**, from four.

Two knock-on effects, both measured, both paid for:

- 44 px arrows in a ~200 px dock left `/typewriter`'s field **78 px**. In that
  band — coarse pointer, 821–1180 px — the field takes the row and the arrows
  split the one below it: **180 px** field, arrows 86×44.
- The same arrows made `/paint`'s Surface group 426 px wide in the 398 px
  toolbar column an 834 px tablet leaves, and 28 px of "Import…" went behind a
  scroll whose affordance only exists on phones (A3 again, one level down). The
  group wraps now, as the strip already does: 0 px clipped, at the cost of
  33 px of strip height (271 → 320) at that one viewport class. Desktop and
  phone are untouched. That 320 px is what R1 measures and fixes; the Surface
  group whose width forced the wrap is no longer in the strip at all.

Suite after this pass: `npm test` 733 tests, 731 pass, 2 skipped, 0 fail;
`tsc --noEmit` clean. `studio-interface.test.ts` gains six tests, one of them
behavioural — the picker's matcher, because "a half-typed word must not commit
the entry that happens to start with it" is a rule no source-text assertion
can express.

## Third pass — what an independent audit falsified

Someone re-measured the fixes above against the live app rather than against
the notes, and several of the notes were wrong. Four of the fixes had also
introduced defects of their own. Every claim it falsified has been corrected in
place above — C3, C4, D1, D3, D4 each carry the correction inside the finding
— and the four regressions are below with before/after numbers at the six
review viewports.

The common thread is worth naming, because it is the reason this section
exists: **every one of these was invisible to the tests that were supposed to
cover it.** A source-text assertion cannot see the cascade (C3 shipped a
declaration that a later file overrode), cannot see a number that only exists
after layout (A3 reported "0 px clipped" and never measured height), and cannot
fail at all if it pins a spelling the file has never used (A1) or forbids one
the code never had (B2). `tools/test-interface-measurements.mjs` now drives six
viewports across ten routes in a real browser and asserts the rendered result;
`npm run test:interface`. Reverting each fix below makes it fail, which was
checked rather than assumed.

### R1 — the A3 toolbar wrap traded a clip for a very tall toolbar

A3 stopped `/paint`'s toolbar clipping by letting it wrap, and reported "0 px
clipped" without measuring what wrapping cost. Five groups of controls — 967 px
of them — in an 864 px column is two rows, and four in the tablet band.
Measured `.st-toolbar` height:

| Viewport | Before | After | Share of the window |
| --- | --- | --- | --- |
| 1440×900 | 143 px | **85 px** | 15.9% → 9.4% |
| 1280×800 | 143 px | **85 px** | 17.9% → 10.6% |
| 1024×768 | 221 px | **85 px** | 28.8% → 11.1% |
| 834×1112 | 320 px | **143 px** | 28.8% → 12.9% |
| 844×390 | 75 px | 75 px | 19.2% |
| 390×844 | 96 px | 96 px | 11.4% |

Wrapping was not the problem; five groups in the strip was. What a hand on the
canvas reaches for mid-stroke is **Mode** — whether a touch orbits the model or
paints on it, the control A3 was originally about — and **Document**, undo and
clear. Those are 329 px together and fit one row everywhere. **Surface**
(preset · 105-object picker · Import) and **Projection** (target · Pick) are
622 px of the 967 px and are set-up: you choose a surface once and then paint.
They are an inspector section now (`SurfaceDocumentSetup`), which on a phone is
the sheet's Options tab, and they are kit `.st-row`s there — so the sheet's
44 px sizing and the tablet band's two-line rows reach them, which they never
did as flex children of a toolbar group.

The **Area** group is simply gone: `usesDrawingArea` is true for exactly the
four Blender brushes, which are exactly the tools that render
`SurfaceProjectionPanel`, and that panel already owns Area size, Projection
height, Drop to first contact and Remove area. It was a second copy of four
controls.

Nothing is clipped at any of the six viewports — 0 px on nine of the ten
route/viewport pairs and 3 px on `/paint?engine=blender` at 390×844, where the
sticky Mode group keeps the six-button switch pinned to the leading edge. The
phone treatment stays exactly as A3 left it; with two groups it usually has
nothing to do.

### R2 — chrome strips overflowed onto the adjacent dock in the tablet band

`.st-toolbar` and `.st-statusbar` got `overflow-x: auto` inside the kit's
*mobile* block, so the 821–1180 px band A1 created had `overflow-x: visible`
and their children drew straight over the neighbouring dock. Measured distance
past the strip's own box:

| Viewport | Route | Element | Past the box |
| --- | --- | --- | --- |
| 834×1112 | `/` | "Blender bridge · localhost" | **413 px** (53 px beyond the window) |
| 834×1112 | `/crayon` | "Hide node editor" | 121.8 px, over the inspector |
| 834×1112 | `/building` | status readout | 208.5 px |
| 1024×768 | `/` | "Blender bridge · localhost" | 270.5 px |
| 1280×800 | `/` | "Blender bridge · localhost" | 114.5 px |

`.st-shell` is `overflow: hidden`, so the page never grew and the
`scrollWidth == clientWidth` check in Verification below saw none of it.
Element-level overflow is the metric, and it is what the browser harness now
measures.

`overflow-x` moved to the base rules, so both strips scroll at every width
rather than only on a phone, with `scrollbar-width: thin` where a pointer can
see one and `none` on a coarse pointer. Measured after: **zero** children
rendering past a non-scrolling strip, on all ten routes at all six viewports.

One thing this does not fix, measured and left: in the band the status line
still gives all its ground to the trailing readout, because the desktop rule
makes `.st-state` the only shrinkable item. On `/paint` at 834×1112 it renders
"I." — 23.1px — and it did before this change too, identically, so it is a
pre-existing condition of the band rather than a cost of the scroll. Paying it
properly means deciding per tool which readout the band drops, the way
`/paint` already drops its stroke counter on a phone.

### R3 — the sheet handle was 39 px in phone landscape

`studio-shell.css` shortened the handle to `min-height: 34px` under
`(max-height: 500px)` to buy back viewport height, and it measured **39 px** at
844×390 on all ten routes: the only sub-44 px target at that viewport, and the
only control that opens the panels at all. It is `var(--st-touch)` now —
**44 px**, all ten routes — and `--st-sheet-collapsed` follows it, since that
token reserves the handle's height in the body grid. The grip's margins pay
back most of the difference; the net cost is 5 px of a 390 px screen, and
`/paint`'s viewport goes 199 px → 189 px.

### R4 — three more sub-minimum targets, and an unbounded status line

Found in the same audit, all measured:

- **`.st-tabs button` was 11 px tall.** `padding: 0`, `font: 700 11px/1`, no
  height, inside a 36 px strip — so the hit area was the type: `/` "Nodes"
  38.6 × 11, `/bin` "Build Bin" 69.5 × 11 at 1440×900. Under WCAG 2.2's
  24 × 24 at every viewport except inside the phone sheet. The button stretches
  to the strip now (36 px, and `var(--st-touch)` under `(pointer: coarse)` so a
  tablet with docks is covered too) and the selected underline moved to an
  inset shadow, which the old outset spread would have drawn below the strip.
- **`.bin-toolbar-button`** — Reframe, 58.5 × 13 px for the same reason. It is
  `inline-flex` with `min-height: 26px` now.
- **`.st-nav-sections a`** — "Lab" measured 43.7 × 44 in landscape. `min-width:
  var(--st-touch)`: a target that misses on one axis misses.
- **N4, the phone status bar had no width bound.** `.st-statusbar > .st-state`
  is `flex: 0 0 auto` on mobile for a good reason — shrunk against 390 px it
  rendered one letter of the message — but "does not shrink" is not "may be any
  width". A runtime error written into `[data-status-text]` took the strip's
  `scrollWidth` past 1,500 px on every route measured and to 7,643 px on
  `/crayon` in the audit's run. `max-width: 100%` bounds it at one screenful
  and hands the rest back to the kit's ellipsis; the same bound covers the
  bare-`<span>` form `/crayon` and `/building` use. Measured with a 200-character
  error injected at 390×844: `/paint` **1,555 px → 404 px**, `/typewriter`
  1,768 → 617, `/chrome-assets` 1,642 → 491, `/gallery` and `/materialx`
  1,541 → 390.

### N5 — the asset library's sheet layout was left at the old breakpoint

The overlay's own `max-width: 720px` breakpoint was raised to the shell's
820 px, but only for going full-screen: `.asset-library-categories { flex-wrap:
wrap }`, the wrapped header and the stacked filter column stayed behind the
720 px query. So 721–820 px got the full-screen sheet with the desktop dialog's
*scrolling* category strip — the exact bug the breakpoint change was made to
close, in a 100 px band. Latent rather than broken today, because seven
category chips happen to fit at those widths. Those three rules are at the
shell's breakpoint now; the card grid keeps a width query of its own, because
"how many columns fit" is a question about pixels — forcing two up at 820 px
would give 394 px cards whose square thumbnails are taller than the viewport.

### The tests that could not fail

Six assertions in `studio-interface.test.ts` were strengthened, and each
strengthened form was checked by reverting the fix it covers and watching it go
red:

| Was | Is |
| --- | --- |
| **A1** required one exact single-line spelling of a rule `studio-nav.css` has never used, so it could not fail | parses every `display: none` rule in the file and asserts none of them hides `.st-nav-sections` |
| **C3** matched the kit's `padding-left` declaration, which is exactly what was present and overridden | computes selector specificity, asserts the inset rule out-specifies every `padding` shorthand matching a chrome strip in any shell stylesheet, and parses the 12 px floor rather than spelling it |
| **D1** counted `useStudioRuntimeChip(` calls in one file and asserted 2 | reads the route table out of `App.tsx` and asserts every routed page reaches a publisher — a new route is covered the day it is added |
| **D3 / D4** opened one of the two files the finding named, with blacklists (`/font: 700 8px/`, `/min-height: 36px/`) that `font: 500 8px` and `38px` walk straight past | opens both, parses every literal px font size and asserts none is under 11, parses every mobile `height`/`min-height` and asserts each is 0 or ≥ 44 |
| **B2** forbade `radius / Math.sin(THREE.MathUtils…` — a spelling the code never had — and its positive match was satisfied by an unused import | forbids `/ Math.sin(` outright outside `camera-fit.ts` (the bug's shape, not a spelling) and requires an assigned call taking `camera` |
| **C4** never opened `asset-library.css`, one of the three files the finding names | opens it, and asserts every `Nvh` in the file has an `Ndvh` beside it |

The rest of what text cannot see is in the browser harness.

## Fourth pass — the sheet, opened

Every phone measurement above was taken on a sheet nothing had opened. That is
the whole of this pass: on a phone the docks do not exist, every control the
layout owns is re-rendered into `.st-sheet`, and the sheet starts collapsed. A
collapsed sheet sets `[hidden]` on its body, so `getClientRects()` returns
nothing for the buttons, selects and checkboxes behind it — and
`tools/test-interface-measurements.mjs` filters on exactly that,
`element.getClientRects().length > 0`. Its phone sweep runs `[controls]` across
the whole page, which reads as app-wide coverage and is not: it measured the
nav, the toolbar, the status bar and a 44px handle. **Nothing a phone user
actually taps has ever been in it.**

So `tools/test-mobile-sheets.mjs` taps the handle first. Eleven routes — the
ten, plus the two states only a query parameter reaches — at 390×844 and
844×390, driven through all three detents, every tab walked with the sheet
genuinely open, then the FAB, its full-screen overlay, the asset library and
the tool directory. `npm run test:mobile`.

One of the seven findings below is already recorded in *Scope and limitations*
above as "known and unfixed because no finding named them", and a second sits
under a scope note in the browser harness itself. Neither was a judgement the
harness made. They were pixels it could not see.

### M1 — the peek detent shows 17 px of panel in phone landscape

`34dvh` of a 390 px-tall window is 133 px. The sheet spends 116 px of that
before a control gets a pixel: a 44 px handle, a 44 px tab strip, and the
body's 10 px padding and 10 px gap. Measured `.st-sheet-panel` client height at
844×390, against the content behind it:

| Route | Panel | Content |
| --- | --- | --- |
| `/building` | **17 px** | 1,405 px |
| `/paint?engine=putty` | **17 px** | 1,284 px |
| `/crayon` | **17 px** | 639 px |
| `/` | **17 px** | 311 px |
| `/paint` | **17 px** | 100 px |
| `/bin` | 79 px | 1,754 px |
| `/chrome-assets` | 79 px | 1,414 px |
| `/typewriter` | 79 px | 835 px |
| `/gallery` | 79 px | 529 px |
| `/materialx` | 79 px | 496 px |
| `/vase` | 79 px | 415 px |

17 px on every route that has a tab strip to pay for, 79 px on every route that
does not. 17 px is the top edge of one label: on `/building` the sheet renders
the word "BUILD SYSTEM" cut through the middle and nothing else. The detent
that exists so you can watch the geometry while you drag a slider does not show
the slider.

The open detent was not much better: `62dvh` is 242 px, 126 px of panel, one
parameter row. Its top edge sat at 147 px — 53 px below the toolbar — so it
covered all but a sliver of the viewport to buy that one row.

The portrait numbers are fine and unchanged: 34dvh of 844 px is 287 px, which
is 171 px of panel.

**Fixed** — the landscape block in `studio-kit.css` re-cuts both detents against
the chrome the sheet carries rather than against the screen. Peek is `56dvh`;
open runs to `calc(100dvh - var(--st-nav-h))`, which stops under the nav
instead of at an arbitrary fraction, so the section switcher stays reachable
with the panels up. Re-measured at 844×390:

| | Peek | Open |
| --- | --- | --- |
| Routes with a tab strip | 17 px → **102 px** | 126 px → **222 px** |
| Routes without one | 79 px → **164 px** | 188 px → **284 px** |

390×844 is untouched by the change and measures the same as before: 171 px of
panel at peek, 407 px at open.

**And then a screenshot of the fix showed it was not finished.** 102 px of panel
passed every assertion this pass added, and rendered: "BUILD SYSTEM",
"GENERATOR · 15 inputs", the word "Floors" — and its slider one scroll notch
below the fold. The detent that exists so you can drag a control and watch the
geometry still did not show a control. Nothing in the numbers said so, because
"the panel is at least one touch row tall" is not the same claim as "a control
is in it".

The cause was not height. `.st-sheet .st-row` goes two-line — label above a
44 px track — because 390 px cannot fit a 96 px label, a draggable track and a
readout on one line. **A landscape phone is 844 px wide.** It was paying 70 px
a row for a layout that narrowness forced, on a screen that is not narrow, and
leaving two thirds of its width empty to do it. The landscape block puts the
row back on one line (116 px label · track · readout, the row still 44 px tall)
and does the same for `.st-field` — which stacks in landscape not because of
the phone rules but because 844 px falls inside the 821–1180 px *tablet* band,
so both match at once.

| At 844×390 | Before | After |
| --- | --- | --- |
| Controls visible at peek on `/building` | 0 | **1** (Floors, draggable) |
| Controls visible at open on `/building` | 2 | **3** |
| `/typewriter` at open | text area, clipped Frame label | text area, Frame slider, Play, Evaluate |

Portrait keeps the two-line row, and so does the tablet band: both were checked
by screenshot, not by inference.

### M2 — five 28 × 28 checkboxes inside the sheet

`--st-touch` is 44 px and the app holds itself to it everywhere the harness
looks. `.st-sheet input[type=checkbox]` was 28 × 28, and `/building`'s Details
tab renders five of them — measured at both phone viewports.

**Fixed** — the target is `var(--st-touch)`; the painted box stays 28 px, drawn
by `::before` so the hit area and the box can differ. Re-measured at 44 × 44 on
both phone viewports. lil-gui is excluded by `:not(.lil-gui *)`: its checkbox
is a 44 × 28 toggle switch with a knob of its own.

### M3 — `/chrome-assets`' node-editor entry point is a bar, not a button

`studio-shell.css` places the mobile FAB at `position: fixed; right: 14px`,
above the sheet handle and the status bar. `chrome-assets.css` corner-anchors
the same button for desktop at `position: absolute; left: 14px` — one class
against one class, in a lazily-imported stylesheet that lands after the shell's,
so it won outright. The button was then absolute with *both* `left` and `right`
set, which stretches an auto-width box:

| Viewport | Measured | `/crayon`'s, for comparison |
| --- | --- | --- |
| 390×844 | **362 × 44** | 156.1 × 44 pill |
| 844×390 | **816 × 44** | 156.1 × 44 pill |

This is C3's cascade failure again, in a different file: a rule that is correct
and loses.

**Fixed** — the shell's rule is scoped through `.st-shell`, which out-specifies
any bare page-level `.assets-shell .graph-toggle` in either load order, and it
now sets `left: auto` explicitly rather than leaving the inset to whatever a
page happens to declare. The button is 267.9 × 44 at both phone viewports now
— its own label's width — anchored to the same corner, at the same height above
the status bar, as `/crayon`'s 156.1 × 44.

### M4 — 9 px and 10 px labels in the Options tab of `/paint`

D3 fixed the type floor in the nav, toolbar, status bar and tool rail, and the
browser harness's own note on that scope said of `surface-painter.css`'s
lil-gui skin: "Widening this selector list is how that would get fixed, and it
should be widened." Widened — into the sheet rather than into lil-gui — it
finds three more in the same file, outside that skin, on both phone viewports:

| Element | Size | Text |
| --- | --- | --- |
| `.paint-node-tabs > span` | 9 px | "Active settings" |
| `.surface-active-generator-context small` | 9 px | "Procedural generator" |
| `.surface-active-generator-context > span` | 10 px | the generator glyph |

The first is the meta slot of a `.st-panel-header`, which the kit sets at the
floor; the page overrode the size along with the colour. On a phone that header
is the first line of the Options tab.

**Fixed** — all three take `var(--st-fs-micro)`.

### M5 — the asset library's category chips are 33.6 px wide

N5 raised this overlay's breakpoint to the shell's and gave its buttons
`min-height: var(--st-touch)`. The chips are label-width, so height was the
only axis that got the minimum: measured in the phone sheet, "All" is
33.6 × 44 and "Text" is 42.3 × 44. `studio-nav.css` had already been through
exactly this and spelled out the reason — "a target that misses the minimum on
one axis is a target that misses the minimum" — for a switcher item that
measured 43.7 × 44.

**Fixed** — `min-width: var(--st-touch)` alongside the min-height.

The star on each card is *not* in this list, though the first run of the
harness said it was, 104 times. It is a 30 px circle whose tap area is
`::after { position: absolute; inset: -7px }`, which is 44 px and which
`getBoundingClientRect()` cannot see. The harness now measures a target as its
box plus any negative-inset pseudo-element, which is what the app means by one.

### M6 — a 268 × 14.8 px link that only exists after an import

`/` before an import is not `/`. The Nodes tab, the Target and Apply-to fields,
the source card and the node-graph FAB all appear only once a graph installs,
and every sweep of this route — including the first version of this pass — had
measured a cold load. Driving the asset library one step further, into "tap the
first card", reaches that state, and the Source tab's card carries a
**268 × 14.8 px** link, "Side-by-side Blender compare →".

The kit already sizes standalone links in the sheet:
`.st-sheet .st-section > a { min-height: var(--st-touch) }`. The child
combinator was the whole of the problem — this link sits in a `.st-card`'s copy
column, one level further in, and the rule stopped a level short.

**Fixed** — the selector covers `.st-card` and its descendants as well.
`.st-card` is a kit component whose links are always their own row, so it is
named in the kit rather than the page that happens to use it; prose links live
inside `.st-finding` or a `<p>` and are still untouched.

### M7 — a tab index that can outrun its tabs

Not measured — reached by reading, and fixed because it is cheap. The sheet's
tab list is not fixed length: `/` publishes a Nodes tab only once a graph is
installed, so clearing the target takes three tabs back to two. The selected
index was stored raw, so an index of 2 would match no tab and render a strip
with nothing selected above a body with every panel hidden — an open sheet
showing nothing at all. The index is now clamped to the list.

### What the sheet got right

Recorded because a review that only lists faults implies the rest was not
checked. Across all 22 route/viewport pairs:

- The handle's three-detent cycle returns where it started on every route,
  including the one that starts at peek rather than collapsed.
- Exactly one panel is visible at every detent and on every tab; the tab strip
  and the panels never disagree.
- Every panel with more content than height scrolls, and none scrolls
  horizontally.
- The collapsed sheet clears the status bar on every route — the body's
  `padding-bottom: var(--st-sheet-collapsed)` holds.
- The node overlay opens full-screen (390 × 844 and 844 × 390, edge to edge)
  and closes again on both routes that offer an entry point from a cold load.
  `/`'s appears only once a graph is installed and was not driven.
- The tool directory opens, scrolls inside a backdrop that scrolls, closes on
  Escape, and has no target under 44 px.
- No page errors on any route at either viewport. `/bin` logs one
  `ERR_CONNECTION_REFUSED`: it probes a local Blender bake bridge on port 7801
  and falls back to the GN-VM preview when nothing answers, which is the
  intended dev-only behaviour.
- Every state named above was also looked at, not only measured. That is how
  M1's first fix was caught being half a fix: a panel can pass "tall enough to
  hold a control" while the control sits below its fold, and only a picture
  says so. The measurements are the regression cover; the screenshots are what
  decides whether the measurement was asking the right question.
- The Surface Studio's brush rail *looks* like it clips and does not. Seven of
  its brushes render up to 863 px past the panel's right edge at 390×844, four
  up to 409 px at 844×390, and every one of them is a swipe away: the rail is a
  horizontal scroller in the mobile block. The first version of this harness
  measured overflow against the panel and reported all eleven as unreachable
  controls. "Past the edge" and "out of reach" are different questions, and
  only the second one is a defect — so the check now asks whether anything
  between the control and the panel scrolls sideways, or whether the panel
  itself has grown to hold it, before it calls anything clipped.

## Fifth pass — the asset library, loaded

The fourth pass tapped one card. There are 104, each pointing at an extracted
dump and a Blender reference render, and nothing had ever checked that the
other 103 still resolve. A renamed file under `public/dojo/` breaks one card in
a grid of a hundred and four; a dump whose shape drifted breaks the studio only
for whoever taps that card. `npm test` cannot see either — they are files, not
code — and the interface harnesses open the library and measure it without ever
picking anything out of it.

`tools/test-asset-library.mjs` (`npm run test:library`) checks the paths on
disk, then the overlay, then loads every asset through `/?asset=<id>` — the
deep link the parity lab uses, which runs the same `loadLibraryAsset` a card
runs.

**The catalog is healthy.** All 104 entries have unique ids and every `dump`,
`reference`, `authoredReference` and `shaderMetadata` path exists in `public/`.
All 104 install: the source card names the right asset, a runnable target is
discovered, and — the check worth having — the studio opens on the object the
catalog names rather than on whichever target was discovered first. Zero page
errors, zero failed requests across the sweep. The six category chips partition
the catalog exactly: 13 Drawing + 5 Text + 8 Stickers + 35 Fabrication + 25
Studies + 18 Scenes = 104. Search narrows and clears. Favourites and recents
persist across a re-open.

### L1 — an empty Recent or Favorites reported a failed search

One sentence covered three different empty grids, and it was the search's:

> No assets match “”.

That is what a fresh profile saw on opening Recent or Favorites — the
search-miss copy, quoting a query nobody had typed, in curly quotes around
nothing. Neither list is empty because a search failed; they are empty because
you have not used the library yet.

**Fixed** — the filter is only named when there is one. Recent reads "Nothing
opened yet — assets you load appear here", Favorites reads "No favorites yet —
tap ★ on a card to keep it here", and a category with a live search says which
category it searched.

### What the library got right

Including the failure paths, which are the part of "can it load" that only
shows up when it cannot. Each was forced by intercepting the request:

| Forced failure | What the user gets |
| --- | --- |
| Catalog returns 500 | The overlay opens and says "Asset catalog failed (500)", styled as an error |
| An asset's dump 404s | "Asset failed · Asset dump failed (404)" in the Source panel; the studio keeps its previous state |
| A dump parses but is not a graph | "Asset failed · The selected JSON is not a BlendBridge graph dump" |
| Every reference render 404s | The grid still lists, filters and loads; only the pictures are gone |

No uncaught error in any of the four, and the overlay never blocks the way out.

The grid's thumbnails are `loading="lazy"` inside the scrolling grid, which is
also why the first version of this check called 88 of them broken: an
unscrolled grid has not requested most of its images, and `complete &&
naturalWidth > 0` is false for a request that has not been made. The harness
scrolls the grid before it judges.

### Not fixed — what 104 cards actually weigh

Reported rather than changed, because the fix is a change to committed binaries
and that is the repository owner's call:

- **The reference renders are 35.4 MB in total** — 104 PNGs at 768 × 768,
  averaging 349 KB and topping out at 743 KB, drawn into cards about 180 px
  wide. Lazy loading means you only pay for what you scroll past, but scrolling
  to the bottom of the library on a phone downloads 35 MB of full-size renders
  to show them at a fifth of their size. WebP at display resolution would be
  roughly a tenth of that.
- **The dumps total 1.07 GB**, and the largest single asset is 34 MB
  (`geometry-nodes-001`), with `n03d-benchy-material-preview` at 28 MB and
  `joint-bubble-putty` at 27 MB. Every one of them loads — that is what the
  sweep says — but over localhost. On a phone on cellular, tapping that card is
  a 34 MB download with a spinner and no size shown anywhere in the UI.

Neither is a defect in the interface; both are things a phone pays for that the
interface never mentions.

## Verification

Re-measured headlessly at all six viewports, across all ten routes
(`npm run test:interface`, and reverting any fix above makes it fail):

- No horizontal page overflow anywhere (`scrollWidth == clientWidth`), and no
  element-level overflow either: zero children rendering past a non-scrolling
  chrome strip.
- No page errors or failed navigations on any route/viewport pair.
- A non-empty nav status chip on all ten routes at every desktop viewport.
- Zero sub-44px touch targets on a 390×844 phone, and zero under WCAG 2.2's
  24 × 24 in the shell chrome at every other viewport.
- Zero elements rendering text below 11 px in the nav, toolbar, status bar or
  Surface tool rail.
- `.st-toolbar` under 20% of the window height at every viewport, on every route.
- `npm test` — **753 tests, 751 pass, 2 skipped, 0 fail** (`src/gnvm/volume.test.ts`
  carries a wall-clock assertion that trips under load from a concurrent
  headless browser run; it passes in isolation, and the browser harness is a
  separate script for exactly that reason).
- Both overlays opened and measured at phone, phone-landscape, tablet and desktop.
- `tsc --noEmit` clean.

And, for the fourth pass, re-measured with the sheet actually open
(`npm run test:mobile`, 11 routes × 2 phone viewports, reverting any of M1–M7
makes it fail):

- The handle's three-detent cycle returns to its starting detent on every
  route, and visits all three on the way.
- Exactly one sheet panel is visible at every detent and on every tab, and
  every tab's panel renders something.
- No panel under 44 px of client height, and nothing taller than its panel
  without a scroll to reach it.
- Zero sub-44 px targets inside an open sheet, in the tool directory, or in the
  asset library — measuring a target as its box plus any negative-inset
  pseudo-element, which is what the app means by one.
- Zero elements below the 11 px floor inside an open sheet, outside the kit's
  three named exceptions and the lil-gui skin.
- The collapsed sheet clears the status bar on every route; the node overlay
  opens full-screen and closes; the tool directory closes on Escape.
- `/` driven through an actual import — open the sheet, open the asset library,
  tap a card — publishes its third tab, keeps exactly one tab selected as the
  list grows from two to three, and every one of the three walks clean.
- No page errors on any route at either phone viewport.

And for the fifth (`npm run test:library`):

- All 104 catalog entries have unique ids, and every `dump`, `reference`,
  `authoredReference` and `shaderMetadata` path they name exists in `public/`.
- All 104 install into the studio, each on the object the catalog names, with
  a runnable target discovered and no page error or failed request.
- The grid renders 104 cards with zero unresolved reference renders once the
  lazy images have been scrolled past.
- All six category chips filter to a non-empty grid; search narrows and clears;
  an empty Recent or Favorites says why it is empty rather than quoting a
  search nobody ran.

With `npm run test:interface` re-run after these changes and still green at all
six viewports, `npm test` at **760 tests, 758 pass, 2 skipped, 0 fail**, and
`tsc --noEmit` clean.

## The slider

Requested separately: the fill-bar slider lil-gui uses, in place of the kit's
rail-and-round-thumb. The studio already shows that widget in the Surface
painter's lil-gui panel, so matching it is a consistency win as much as a
preference.

CSS cannot read an `<input type=range>`'s value, and no filled-portion
pseudo-element exists that both Chromium and WebKit implement — only Firefox
has `::-moz-range-progress`. So `src/react/studio/range-fill.ts` publishes the
percentage to each element as `--st-fill` and the track paints itself from it,
through two publishers: an inline style for controlled React inputs (exact, no
listener — the value and the fill are written in the same render), and a
delegated listener plus MutationObserver for everything else, which is what
covers the sliders imperative runtimes build. Verified: 29 sliders on
`/building`, 10 on `/bin`, none missing a fill.

The input's own box is the hit area and `::-*-track` is the painted bar inside
it, which is what lets a phone keep a 44px target under an 18px bar.

**One deliberate deviation.** lil-gui's `.fill` has no background — only a 2px
right border in `--number-color` is visible, so its slider is a flat track with
a thin knob line. The kit colours the fill, because a dock stacks fifteen to
twenty-nine of these and a filled bar reads as a magnitude at a glance where a
bare knob does not. It is one token: setting `--st-slider-fill: transparent`
gives the literal lil-gui widget and changes nothing else.

lil-gui's number is also an editable text field; the kit's readout is still an
`<output>` on most pages and an `<input type=number>` on `/bin`. Making every
readout editable is a separate change with its own parsing and clamping per
call site, so it was left alone.

## Scope and limitations

- Run headlessly on SwiftShader, so `/paint` fell back to WebGL2 and the WebGPU
  path was not exercised. No real-device testing (no iOS Safari, no Android
  Chrome) — the safe-area and `dvh` findings are read from the CSS, not observed
  on hardware. Chromium's CDP has no `Emulation.setSafeAreaInsets` in the build
  used here, so what the browser harness checks for C3 is the *cascade* — that
  all three strips resolve the same inline padding, and still do after a
  bare-class shorthand is appended to the live document — not the inset value.
- Three sub-minimum targets were known and unfixed because no finding named
  them, and the harness did not assert on them rather than pretending
  otherwise: the kit's 18 × 18 px checkbox on desktop (28 px in the phone
  sheet), `/chrome-assets`' 331 × 16.8 px "Modulate in Procedural Studio" link,
  and the desktop slider's deliberate 20 px hit area under an 18 px bar. The
  first two are real WCAG 2.2 failures for a mouse. **The phone sheet's copy is
  fixed** (M2); the desktop 18 px box and the link are unchanged, and are still
  not asserted on.
- The `surface-painter.css` lil-gui skin still carries 8–10 px labels (see D3).
  `npm run test:mobile` excludes `.lil-gui *` from its type sweep by name
  rather than by silence, so the exclusion is visible in the harness.
- The fourth pass is two phone viewports, not six: it is a check on the sheet,
  which only exists below 821 px or on a coarse pointer under 500 px tall. The
  tablet band keeps the docks and is covered by `npm run test:interface`.
- `.st-metric span` is one of the kit's three named sub-11 px exceptions — 10 px
  uppercase mono, for captions like "WEB WORKER". `/paint?engine=putty` writes
  a sentence into it ("Blob 2 selected"), which is prose at 10 px inside the
  phone sheet. Left alone: the rule is the kit's and the misuse is the page's,
  so the fix is a content decision rather than a type one.
- `UnifiedSurfaceStudioShell.tsx` carries the same 9 px/10 px active-generator
  card that M4 fixed in `surface-painter.css`, in its own stylesheet. Nothing
  imports the component, so no harness can see it and it was left untouched
  rather than edited blind.
- Driving `/` through an import surfaced one thing that is **not** a mobile
  finding and is recorded so it is not lost: with a library asset installed —
  283 groups, 2,115 nodes, the Nodes tab populated — the status line still
  reads "Import a Blender graph to begin" and the viewport stays empty, with
  the runtime chip on "GN-VM idle". Measured identically at 390×844 and at
  1440×900 over 60 s, so it is not the sheet and not the phone. The page has an
  explicit `Apply to preview` and an auto-evaluation policy that can resolve to
  Manual, so the empty viewport is plausibly the intended manual path; the
  stale status sentence is harder to defend. Neither was chased here — this
  pass is about the mobile layout, and a fix on either belongs to whoever owns
  that evaluation policy.
- The referenced Google Drive folder holds `No3d Tools`, `New Folder With
  Items 7`, and a 252 MB `No3d Tools.zip`. No Blender-side interface comparison
  was made against those files; the findings above are about this app's own UI.
