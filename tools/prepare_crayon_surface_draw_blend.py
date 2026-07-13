"""Create an interactive Blender Chrome Crayon surface-drawing test file."""
import math
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
out_path = os.path.abspath(args[0])
source = bpy.data.objects["CHROME CRAYON OBJECT"]
source.name = "CHROME CRAYON — DRAW HERE"
source.matrix_world.identity()
source.data.name = "Chrome Crayon drawing curves"
source.data.dimensions = "3D"
source.data.splines.clear()

# A single zero-length starter spline keeps Curve Edit mode and the Draw tool
# available immediately. The first real drag creates the authored spline.
starter = source.data.splines.new("POLY")
starter.points.add(1)
starter.points[0].co = (0.0, 0.0, 5.0, 1.0)
starter.points[1].co = (0.001, 0.0, 5.0, 1.0)

nodes = next(modifier for modifier in source.modifiers if modifier.type == "NODES" and modifier.node_group)
identifiers = {
    item.name: item.identifier
    for item in nodes.node_group.interface.items_tree
    if item.item_type == "SOCKET" and item.in_out == "INPUT"
}
for name, value in {
    "Line Thiccness": 6.0,
    "Peak Height": 10.0,
    "resolution": 0.8,
    "Sigilize": 0,
    "Soften": 0,
    "FLATTEN": False,
    "Extrude Base": 1.0,
    "SPIRO": 1,
}.items():
    nodes[identifiers[name]] = value

scene = bpy.context.scene
setup = bpy.data.collections.get("SURFACE DRAW TEST") or bpy.data.collections.new("SURFACE DRAW TEST")
if setup.name not in scene.collection.children:
    scene.collection.children.link(setup)

# Same browser test surface, scaled by 20 so Chrome Crayon receives its native
# ~100-unit authoring coordinates.
bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, radius=60.0, location=(0.0, 0.0, -60.0))
target = bpy.context.object
target.name = "TARGET — WOBBLED SURFACE"
for collection in list(target.users_collection):
    collection.objects.unlink(target)
setup.objects.link(target)
for vertex in target.data.vertices:
    point = vertex.co.copy()
    wobble = 1.0 + 0.075 * math.sin((point.z / 20.0) * 2.4) * math.cos(math.atan2(point.y, point.x) * 5.0)
    vertex.co *= wobble
target.data.update()
target_material = bpy.data.materials.new("Target green")
target_material.diffuse_color = (0.12, 0.25, 0.19, 1.0)
target.data.materials.append(target_material)
target.hide_select = True

# A real faced grid: Blender's Curve Draw surface-depth mode can raycast it,
# while wire display gives the same yellow canvas seen in the tutorial.
columns, rows = 16, 10
width, height, z = 96.0, 60.0, 6.0
vertices = [
    (-width / 2 + width * x / columns, -height / 2 + height * y / rows, z)
    for y in range(rows + 1) for x in range(columns + 1)
]
faces = []
for y in range(rows):
    for x in range(columns):
        a = y * (columns + 1) + x
        faces.append((a, a + 1, a + columns + 2, a + columns + 1))
patch_mesh = bpy.data.meshes.new("Chrome Crayon drawing patch")
patch_mesh.from_pydata(vertices, [], faces)
patch_mesh.update()
patch = bpy.data.objects.new("DRAWING AREA — DRAW INSIDE GRID", patch_mesh)
setup.objects.link(patch)
patch.display_type = "WIRE"
patch.color = (1.0, 0.72, 0.05, 1.0)
patch.show_wire = True
patch.show_all_edges = True
patch.hide_render = True
patch.hide_select = True

shrink = source.modifiers.get("PROJECT CHROME TO TARGET") or source.modifiers.new("PROJECT CHROME TO TARGET", "SHRINKWRAP")
shrink.target = target
shrink.wrap_method = "PROJECT"
shrink.wrap_mode = "ABOVE_SURFACE"
shrink.use_project_x = False
shrink.use_project_y = False
shrink.use_project_z = True
shrink.use_positive_direction = False
shrink.use_negative_direction = True
shrink.project_limit = 120.0
shrink.offset = 0.35

# Put the original helper out of the way but retain it because the authored
# node tree references it through Object Info.
helper = bpy.data.objects.get("prox.002")
if helper:
    helper.hide_select = True

paint = scene.tool_settings.curve_paint_settings
paint.depth_mode = "SURFACE"
paint.surface_offset = 0.02
paint.use_offset_absolute = True
paint.surface_plane = "NORMAL_VIEW"

bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
bpy.context.view_layer.objects.active = source
source.select_set(True)
target.select_set(False)
patch.select_set(False)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.curve.select_all(action="DESELECT")

# Configure every 3D viewport because the supplied file may reopen in any
# stored workspace. Top view keeps the drawing plane and target aligned.
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type != "VIEW_3D":
            continue
        space = area.spaces.active
        space.shading.type = "MATERIAL"
        space.overlay.show_floor = False
        space.overlay.show_axis_x = False
        space.overlay.show_axis_y = False
        space.overlay.show_relationship_lines = False
        region = next((candidate for candidate in area.regions if candidate.type == "WINDOW"), None)
        if region and bpy.context.window:
            try:
                with bpy.context.temp_override(window=bpy.context.window, screen=screen, area=area, region=region):
                    bpy.ops.view3d.view_axis(type="TOP", align_active=False)
                    bpy.ops.view3d.view_selected(use_all_regions=False)
                    bpy.ops.wm.tool_set_by_id(name="builtin.draw")
            except RuntimeError as error:
                print(f"VIEW_SETUP_WARNING {screen.name}: {error}")

scene["Chrome Crayon instructions"] = "Draw inside the yellow grid. Curve Draw depth is Surface. GN generates the chrome mesh; Shrinkwrap projects it to TARGET."
bpy.ops.wm.save_as_mainfile(filepath=out_path)
print(f"CRAYON_SURFACE_DRAW_BLEND_OK -> {out_path}")
