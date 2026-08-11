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
- Three sub-minimum targets are known and unfixed because no finding named
  them, and the harness does not assert on them rather than pretending
  otherwise: the kit's 18 × 18 px checkbox on desktop (28 px in the phone
  sheet), `/chrome-assets`' 331 × 16.8 px "Modulate in Procedural Studio" link,
  and the desktop slider's deliberate 20 px hit area under an 18 px bar. The
  first two are real WCAG 2.2 failures for a mouse.
- The `surface-painter.css` lil-gui skin still carries 8–10 px labels (see D3).
- The referenced Google Drive folder holds `No3d Tools`, `New Folder With
  Items 7`, and a 252 MB `No3d Tools.zip`. No Blender-side interface comparison
  was made against those files; the findings above are about this app's own UI.
