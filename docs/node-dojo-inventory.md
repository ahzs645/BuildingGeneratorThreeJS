# Node Dojo active-root inventory

Generated with Blender 5.1.2 from `tools/node-dojo-projects.json` on 2026-07-12. The reports under `public/dojo/inventory/` are the authoritative object/modifier/root lists.

The pack contains **16 Blender projects**, **499 active Geometry Nodes modifiers**, and **291 project-local root families**. A root family is counted once per project even when several objects use it.

| Project | Active modifiers | Root families | Current web evidence |
| --- | ---: | ---: | --- |
| Intro Module | 82 | 52 | All roots classified; sampled typography/UI studies partial |
| New Joint Generators | 32 | 13 | Inventory complete |
| N03D 3D-printing Utilities | 77 | 39 | Inventory complete |
| Recursive Bin | 1 | 1 | Live Blender/GN-VM comparison |
| Dusty Crystal Cocoon | 2 | 1 | Active roots are Auto Smooth only |
| The Nodes Node | 17 | 12 | All 12 roots live; 6 exact/structural, 6 legacy UI-panel variants partial |
| Knit Graphic | 0 | 0 | No active Geometry Nodes modifier |
| Typewriter | 1 | 1 | Live GN-VM; supplied Pixels TTF with embedded outline fallback |
| Send Nodes Hat | 5 | 4 | All 4 roots live; 3 exact, embroidery partial |
| Module 2 | 103 | 69 | All roots classified; shared finale 100% covered but divergent |
| Module 3 | 28 | 20 | All roots classified; shared finale 100% covered but divergent |
| Module 4 | 68 | 35 | All roots classified; shared finale 100% covered but divergent |
| Chrome Crayon | 1 | 1 | Live Blender/GN-VM comparison |
| Math Clay | 33 | 14 | All 13 distinct surface roots live; shared helper represented through its consumer |
| Bubble Vessel | 6 | 3 | Live Blender/GN-VM comparison |
| Chrome Asset Library | 43 | 26 | All 26 active modifier roots represented in the browser library |

## Evidence standard for each port

A root is not considered ported merely because it evaluates without throwing. Each completed entry needs:

1. A targeted portable graph dump containing its referenced objects/collections.
2. An isolated Blender reference render.
3. Blender and GN-VM evaluated vertex/face counts.
4. Matching local-space bounds for the authored case, plus parameter cases when the root exposes meaningful controls.
5. A browser-visible entry showing Blender reference and live GN-VM output.
6. Regression tests for any new shared node semantics.

This standard is currently satisfied by Periodic Brush and Flat Stickie Pack in the Chrome Asset Library, and by the earlier dedicated comparison targets where equivalent evidence already exists.
