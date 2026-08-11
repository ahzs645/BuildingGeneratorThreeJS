# Interface review — desktop and mobile

> **Status: all twenty findings resolved.** Each finding keeps the measurement
> that prompted it; the **Fixed** note at the end of each records what the same
> measurement reads now. Re-verified headlessly at the same six viewports, with
> `npm test` (614) and `tsc --noEmit` green.

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

**Fixed** — all three strips use `max(12px, env(safe-area-inset-left/right))`
in the mobile block. Read from the CSS, not observed on hardware (see Scope).

### C4 — `vh` instead of `dvh` in the sheet

`studio-kit.css:560` — `.st-sheet.is-open { height: calc(62vh + …) }`. On iOS
Safari `vh` resolves against the *largest* viewport, so with the browser
toolbars visible the open sheet is taller than the space available and its last
control row falls under the toolbar. `dvh` (with a `vh` fallback) fixes it. The
same applies to `studio-menu.css:3` (`padding: 8vh 16px 6vh`) and
`asset-library.css:4` (`max-height: 90vh`).

**Fixed** — the sheet declares `vh` then `dvh`, so the second wins where
supported and the first is the fallback. The tool menu's backdrop padding and
max-height are `dvh` too.

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
`runtime failed` chip, so all ten routes carry the same fact. In the tablet band
the chip track is the first thing to give — at 834px it rendered "runtime li".

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
exceptions. `surface-workspace-toolbar.css` adds four more:
group labels at **8 px** (`:35`), area labels at **9 px** (`:82`), mode buttons
at **10 px** (`:73`), and `surface-tool-selector.css:31` family labels at 9 px.
These are the smallest text in the app and they sit in the toolbar, i.e. the
part of `/paint` that a phone user has to read while scrolling it horizontally.

**Fixed** — all four are `var(--st-fs-micro)` (11 px), the kit's floor.

### D4 — Sub-44 px touch targets in the same toolbar

`surface-workspace-toolbar.css:91` sets `min-height: 36px` for the toolbar's
buttons, selects and `.st-btn`s on mobile, against `--st-touch: 44px` which the
kit applies everywhere else on the phone. Same file, one line below the
breakpoint that acknowledges mobile exists.

**Fixed** — `var(--st-touch)`. A sweep of every interactive element at 390×844
across all ten routes now reports zero targets under the minimum, the one
exception being the visually-hidden file input behind the Import label.

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

## Verification

Re-measured headlessly at all six viewports, across all ten routes:

- No horizontal page overflow anywhere (`scrollWidth == clientWidth`).
- No page errors or failed navigations on any route/viewport pair.
- Zero sub-44px touch targets on a 390×844 phone.
- `npm test` — 614 tests, 612 pass, 2 skipped, 0 fail.
- `tsc --noEmit` and `npm run build` clean.

## Scope and limitations

- Run headlessly on SwiftShader, so `/paint` fell back to WebGL2 and the WebGPU
  path was not exercised. No real-device testing (no iOS Safari, no Android
  Chrome) — the safe-area and `dvh` findings are read from the CSS, not observed
  on hardware.
- The referenced Google Drive folder holds `No3d Tools`, `New Folder With
  Items 7`, and a 252 MB `No3d Tools.zip`. No Blender-side interface comparison
  was made against those files; the findings above are about this app's own UI.
