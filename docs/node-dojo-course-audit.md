# Node Dojo course-module root audit

Audit date: 2026-07-14. This covers the Intro and Modules 2–4 teaching scenes separately from the reusable generators in the browser gallery.

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
- Intro `Cube.014` / `Geometry Nodes.023` is a 1,130-node diagram of Ico Sphere and Set Material Geometry Nodes panels. POINT-domain Delete Geometry now edits curves and preserves their spline-domain cyclic state, restoring the rounded lower panel edges and a second shared row branch. Blender and the browser both evaluate **104,454 vertices / 44,423 faces** with the same composition; maximum local-bounds difference is 0.0048 units from legacy curve sampling.
- The `dojo` finale in Modules 2–4 is the same authored banner-and-medallion study saved in successive course scenes. Muted-link extraction now excludes the four inactive building-lesson links, Subdivide Mesh evaluates inside the banner instances, and poly-to-Bézier conversion preserves the medallion's authored outline density. Blender and the browser both evaluate **47,435 vertices / 46,490 faces / 93,121 triangles**, with the same face-size distribution and local bounds. Small procedural wind-displacement and Workbench shading differences remain.

## Porting decision

Course roots remain authoritative teaching snapshots, not missing catalog products. We will publish a course root only when it represents a distinct visible exercise and passes the same Blender-reference standard as the reusable generators. Repeated lesson stages and helper roots stay in the audit inventory so they are not mistaken for unfinished products.

The canonical Modules 2–4 finale, Intro Geometry Nodes panel diagram, Intro CHALLENGE title, Intro Node Dojo emblem, and Intro challenge chalkboard now meet the publication evidence standard and are live in the browser library. The next course work should select another distinct visible complex study rather than expanding duplicated lesson snapshots.
