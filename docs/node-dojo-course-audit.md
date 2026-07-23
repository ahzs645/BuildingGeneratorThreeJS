# Node Dojo course-module root audit

Audit date: 2026-07-22. This covers the Intro and Modules 2–4 teaching scenes separately from the reusable generators in the browser gallery.

## Result

The four course projects contain **176 active project-local root families**, but they are not 176 independent products:

| Classification | Roots | Meaning |
| --- | ---: | --- |
| Instructional step | 113 | Small lesson snapshots with 5–53 reachable nodes |
| Empty/passthrough helper | 12 | Scene scaffolding rather than visible generators |
| Auto Smooth helper | 4 | Blender's standard smoothing modifier group |
| Complex study | 47 | Larger exercises, diagrams, or assembled lesson finales |

Strict recursive graph hashing collapses ten duplicate roots, leaving 166 structural families. The machine-readable root/member inventory is in `public/dojo/course-audit/status.json` and can be regenerated with `tools/audit-course-roots.mjs` after extracting the four scene dumps.

## Blender/browser samples

- Intro `Plane.023` / `geo` is a 1,181-node “CHALLENGE!” Blurmed title-and-arrow exercise. The browser now matches Blender's visible cached frame-1 result at **2,331 vertices / 16 faces**, with local bounds within 0.000003 units. Fill Curve dissolves the 12-sample CFF interiors on straight font segments while preserving authored Bézier anchors, and Blender-compatible normalized 4D Perlin noise reproduces every per-glyph bounce offset. The `.blend` timeline is saved at frame 1405, but its Geometry Nodes cache remains at frame 1; the gallery reference deliberately matches what the supplied file displays on open.
- Intro `Plane.019` / `Geometry Nodes.032` is the 101-node Node Dojo emblem with arced Brokenscript title, pixel-font subtitle, curved medallion, and radial spike instances. Set Curve Tilt, Sample Curve, source-frame Curve to Points interpolation, pixel-font contour extraction, and shared-corner Fill Curve welding now reproduce Blender's visible cached frame-1 result at **5,546 vertices / 2,667 faces**, with local bounds within 0.000075 units. Its Noise Texture driver is `frame/400`; as with the challenge study, the gallery preserves the cached frame-1 state visible when the supplied file opens.
- Intro `chalkboard` / `Geometry Nodes.011` is the 104-node framed challenge sign. INSTANCE-domain Delete Geometry now preserves its neighboring curve component, no-op Split Edges retains the source mesh's stored edge order, and Mesh to Curve carries normalized corner-bisector tangents into the tilted cyclic perimeter sweep. Blender and the browser both evaluate **2,226 vertices / 290 faces**, with the same raised Pixels lettering, inset face, and frame; local bounds are within 0.0031 units.
- Intro `Plane.035` / `Geometry Nodes.036` is the 64-node arrow-and-NodeTubes tab study. Blender's Bottom Left text-box pivot is now applied before the nine per-glyph 4D-noise offsets. The browser matches the supplied file's visible cached frame-1 result at **2,411 vertices / 81 faces**, with all glyph offsets within 0.000006 units and local bounds within 0.000001 units.
- Intro `Plane.034` / `Room` is the complete 163-node Node Dojo room study. Subdivide Mesh now splits the authored loose-wire outline before its edge extrusion, restoring the lower wall layout, while Merge by Distance removes the opposite-winding coincident faces where the horizontal and vertical cross-beam sweeps intersect. Blender and the browser both evaluate **3,788 vertices / 2,542 faces / 5,558 triangles**, including the floor, open entrance, four posts, both framed panel grids, plaque, and procedural text; local bounds are within 0.000002 units.
- Intro `Cube.014` / `Geometry Nodes.023` is a 1,130-node diagram of Ico Sphere and Set Material Geometry Nodes panels. POINT-domain Delete Geometry now edits curves and preserves their spline-domain cyclic state, restoring the rounded lower panel edges and a second shared row branch. Blender and the browser both evaluate **104,454 vertices / 44,423 faces** with the same composition; maximum local-bounds difference is 0.0048 units from legacy curve sampling.
- The five remaining Intro studies are now published too. `Plane.003` is an exact **4,080 / 2,479** FIRST NODETREES Room stage; `Plane.009` is topology-exact at **2,860 / 2,398** with a 0.0017-unit legacy curve-frame bounds residual; `Plane.017` is an exact **3,808 / 3,160** Room/material stage at its authored frame 1405; and the Cross and Step Bars exercises are exact at **48 / 38** and **48 / 12**. The material stage's MAT helper deliberately has an unassigned Font datablock, so Blender emits no glyph geometry. String to Curves now distinguishes that explicit null socket from an assigned-but-unavailable font, which still uses the portable outline fallback.
- The `dojo` finale in Modules 2–4 is the same authored banner-and-medallion study saved in successive course scenes. Muted-link extraction now excludes the four inactive building-lesson links, Subdivide Mesh evaluates inside the banner instances, and poly-to-Bézier conversion preserves the medallion's authored outline density. Blender and the browser both evaluate **47,435 vertices / 46,490 faces / 93,121 triangles**, with the same face-size distribution and local bounds. Small procedural wind-displacement and Workbench shading differences remain.
- Module 3 `Cube.001` / `Geometry Nodes.134` is a 212-node control-box modeling study. Compacting Convex Hull after coplanar dissolve removes its one face-interior support point, making the rounded enclosure, inset lid, raised plus control, triangular button, and curved face marks exact at **1,860 vertices / 1,609 faces / 3,502 triangles** with identical local bounds.

### Module 2 visual closure

All 22 Module 2 roots that the structural audit labeled `complex-study` have now been evaluated in isolation. The `dojo` finale is the one distinct published study. `1A` is an earlier Room-family stage, four arrow roots are identical 32-vertex single-face marker helpers, and the other sixteen roots produce no evaluated mesh surface in the supplied file. A targeted extraction of the largest empty example (`Plane.020`, 453 reachable nodes) also evaluates empty in the GN-VM with 100% handler coverage: its active output is an unbeveled wire/curve, not missing browser geometry. The exact classification and Blender counts are recorded in `public/dojo/course-audit/module-2-visual.json`.

Module 2 references a missing Windows-only Bradley's Geo Node Presets library containing `G_Parenting` and `G_Set Shade AutoSmooth`. Neither group is reachable from the representative 453-node empty closure, so that missing library does not explain its non-surface result. An equivalent auto-smooth group is present in other supplied Node Dojo projects; the parenting preset is still unavailable.

### Module 3 visual closure

Module 3 contains only four nominal complex studies. The `dojo` finale and the control-box study are the two distinct published surfaces. `Plane.078` is an earlier Room-family stage, and `Plane.083` is a 32-vertex single-face marker helper. Their exact Blender counts and classifications are recorded in `public/dojo/course-audit/module-3-visual.json`.

### Module 4 visual closure

All ten Module 4 roots labeled `complex-study` have also been evaluated in isolation. The already published `dojo` finale is its only distinct visible study. `1A.001` is an earlier Room-family stage, `Plane.007` is a 32-vertex single-face marker, and the remaining seven roots produce no evaluated mesh surface. Their exact classification is recorded in `public/dojo/course-audit/module-4-visual.json`.

### Intro visual closure

All eleven Intro roots labeled `complex-study` have been evaluated in isolation and are represented as distinct browser studies. Six were already published; the two earlier Room stages, the frame-1405 Room/material stage, Cross exercise, and Step Bars exercise close the remaining set. Their Blender counts, graph sizes, frame contract, and catalog IDs are recorded in `public/dojo/course-audit/intro-module-visual.json`.

## Porting decision

Course roots remain authoritative teaching snapshots, not missing catalog products. We publish a course root only when it represents a distinct visible exercise and passes the same Blender-reference standard as the reusable generators. Repeated lesson stages and helper roots stay in the audit inventory so they are not mistaken for unfinished products. All 47 complex studies across Intro and Modules 2–4 now have visual closure: distinct visible studies are published, while repeated stages, marker helpers, and non-surface roots remain explicitly classified in the audit inventory.

The canonical Modules 2–4 finale, all eleven Intro complex studies, and the Module 3 control-box study now meet the publication or classification evidence standard. No currently inventoried course complex study remains unaudited; future course work should be driven by a specific instructional snapshot or additional renderer/material comparison rather than by a missing-root backlog.
