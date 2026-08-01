"""Create Blender truth for modifier-instance Bake cache-state extraction.

Run with Blender, not CPython:
  blender --background --factory-startup --python \
    tools/blender_bake_state_fixture.py -- OUTPUT.json [RETAINED_WORKDIR]

The three objects deliberately share one node group. Blender then leaves one
modifier unbaked, bakes one to disk, and packs the third into the blend. The
JSON is a small provenance fixture; the temporary blend/cache are discarded.
"""

import bpy
import contextlib
import ctypes
import json
import os
import sys
import tempfile


args = sys.argv[sys.argv.index("--") + 1:]
if not args:
    raise RuntimeError("Expected OUTPUT.json after --")
output_path = os.path.abspath(args[0])
retained_workdir = os.path.abspath(args[1]) if len(args) > 1 else None


class NodesModifierBake43(ctypes.Structure):
    _fields_ = [
        ("bake_id", ctypes.c_int),
        ("flag", ctypes.c_uint32),
        ("bake_mode", ctypes.c_uint8),
        ("bake_target", ctypes.c_int8),
        ("_pad", ctypes.c_char * 6),
        ("directory", ctypes.c_void_p),
        ("frame_start", ctypes.c_int),
        ("frame_end", ctypes.c_int),
        ("data_blocks_num", ctypes.c_int),
        ("active_data_block", ctypes.c_int),
        ("data_blocks", ctypes.c_void_p),
        ("packed", ctypes.c_void_p),
    ]


def has_packed_data(bake):
    raw = NodesModifierBake43.from_address(bake.as_pointer())
    if raw.bake_id != bake.bake_id:
        raise RuntimeError("NodesModifierBake DNA layout did not match Blender")
    return bool(raw.packed)


def make_shared_group():
    group = bpy.data.node_groups.new("Shared Bake Fixture", "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_input = group.nodes.new("NodeGroupInput")
    group_output = group.nodes.new("NodeGroupOutput")
    bake = group.nodes.new("GeometryNodeBake")
    bake.name = "Fixture Bake"
    bake.bake_items.new("GEOMETRY", "Geometry")
    group.links.new(group_input.outputs["Geometry"], bake.inputs["Geometry"])
    group.links.new(bake.outputs["Geometry"], group_output.inputs["Geometry"])
    return group


def make_object(name, group):
    mesh = bpy.data.meshes.new(f"{name} Mesh")
    mesh.from_pydata(
        [(-1.0, -1.0, 0.0), (1.0, -1.0, 0.0), (0.0, 1.0, 0.0)],
        [],
        [(0, 1, 2)],
    )
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    modifier = obj.modifiers.new("GeometryNodes", "NODES")
    modifier.node_group = group
    return obj, modifier


def activate(obj):
    for selected in bpy.context.selected_objects:
        selected.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.context.view_layer.update()


def replace_with_live_quad(obj):
    """Change the live modifier input after baking to prove cache ownership."""
    obj.data.clear_geometry()
    obj.data.from_pydata(
        [(-2.0, -2.0, 0.0), (2.0, -2.0, 0.0), (2.0, 2.0, 0.0), (-2.0, 2.0, 0.0)],
        [],
        [(0, 1, 2, 3)],
    )
    obj.data.update()


workdir_context = (
    contextlib.nullcontext(retained_workdir)
    if retained_workdir
    else tempfile.TemporaryDirectory(prefix="node-dojo-bake-state-")
)
with workdir_context as workdir:
    os.makedirs(workdir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    group = make_shared_group()
    objects = {}
    for label in (
        "unbaked",
        "disk-backed",
        "packed",
        "animation-packed",
        "unknown-default-disk",
    ):
        objects[label] = make_object(f"Bake Fixture {label}", group)

    animation_obj, animation_modifier = objects["animation-packed"]
    animation_obj.shape_key_add(name="Basis")
    animated_key = animation_obj.shape_key_add(name="Animated")
    animated_key.data[2].co.y = 3.0
    animated_key.value = 0.0
    animated_key.keyframe_insert("value", frame=1)
    animated_key.value = 1.0
    animated_key.keyframe_insert("value", frame=3)

    blend_path = os.path.join(workdir, "bake-state-fixture.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)

    disk_obj, disk_modifier = objects["disk-backed"]
    disk_modifier.bake_target = "DISK"
    disk_modifier.bake_directory = os.path.join(workdir, "disk-cache")
    disk_bake = disk_modifier.bakes[0]
    disk_bake.bake_mode = "STILL"
    activate(disk_obj)
    disk_result = sorted(bpy.ops.object.geometry_node_bake_single(
        "EXEC_DEFAULT",
        session_uid=disk_obj.session_uid,
        modifier_name=disk_modifier.name,
        bake_id=disk_bake.bake_id,
    ))

    packed_obj, packed_modifier = objects["packed"]
    packed_modifier.bake_target = "PACKED"
    packed_bake = packed_modifier.bakes[0]
    packed_bake.bake_mode = "STILL"
    activate(packed_obj)
    packed_result = sorted(bpy.ops.object.geometry_node_bake_single(
        "EXEC_DEFAULT",
        session_uid=packed_obj.session_uid,
        modifier_name=packed_modifier.name,
        bake_id=packed_bake.bake_id,
    ))

    animation_modifier.bake_target = "PACKED"
    animation_bake = animation_modifier.bakes[0]
    animation_bake.bake_mode = "ANIMATION"
    animation_bake.use_custom_simulation_frame_range = True
    animation_bake.frame_start = 1
    animation_bake.frame_end = 3
    activate(animation_obj)
    animation_result = sorted(bpy.ops.object.geometry_node_bake_single(
        "EXEC_DEFAULT",
        session_uid=animation_obj.session_uid,
        modifier_name=animation_modifier.name,
        bake_id=animation_bake.bake_id,
    ))

    # Deliberately diverge the live inputs after the caches are complete. The
    # extractor must recover the baked triangle/animation rather than these
    # authored replacements.
    replace_with_live_quad(disk_obj)
    replace_with_live_quad(packed_obj)
    animated_key.data[2].co.y = 9.0
    animation_obj.data.update()

    unknown_modifier = objects["unknown-default-disk"][1]
    unknown_modifier.bake_target = "DISK"
    unknown_modifier.bake_directory = ""

    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    unbaked_bake = objects["unbaked"][1].bakes[0]
    disk_meta_dir = os.path.join(
        disk_modifier.bake_directory,
        str(disk_bake.bake_id),
        "meta",
    )
    disk_meta_files = sorted(
        name for name in os.listdir(disk_meta_dir) if name.endswith(".json")
    )
    payload = {
        "blender_version": bpy.app.version_string,
        "contract": "modifier-instance GeometryNodeBake cache state",
        "shared_node_group": group.name,
        "cases": [
            {
                "object": objects["unbaked"][0].name,
                "bake_id": unbaked_bake.bake_id,
                "expected_status": "unbaked",
                "packed_pointer": has_packed_data(unbaked_bake),
                "disk_meta_files": 0,
            },
            {
                "object": disk_obj.name,
                "bake_id": disk_bake.bake_id,
                "expected_status": "disk-backed",
                "operator_result": disk_result,
                "packed_pointer": has_packed_data(disk_bake),
                "disk_meta_files": len(disk_meta_files),
                "live_input_vertices_after_bake": 4,
                "cached_output_vertices": 3,
            },
            {
                "object": packed_obj.name,
                "bake_id": packed_bake.bake_id,
                "expected_status": "packed",
                "operator_result": packed_result,
                "packed_pointer": has_packed_data(packed_bake),
                "disk_meta_files": 0,
                "live_input_vertices_after_bake": 4,
                "cached_output_vertices": 3,
            },
            {
                "object": animation_obj.name,
                "bake_id": animation_bake.bake_id,
                "expected_status": "packed",
                "operator_result": animation_result,
                "packed_pointer": has_packed_data(animation_bake),
                "disk_meta_files": 0,
                "expected_cache_frames": [1, 2, 3],
                "live_frame_3_apex_y_after_bake": 9.0,
                "cached_frame_3_apex_y": 3.0,
            },
            {
                "object": objects["unknown-default-disk"][0].name,
                "bake_id": objects["unknown-default-disk"][1].bakes[0].bake_id,
                "expected_status": "unknown",
                "configured_target": "DISK",
                "configured_directory": "",
                "packed_pointer": has_packed_data(objects["unknown-default-disk"][1].bakes[0]),
                "disk_meta_files": 0,
            },
        ],
        "provenance": (
            "Generated by tools/blender_bake_state_fixture.py using Blender's "
            "synchronous geometry_node_bake_single operator."
        ),
    }
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as output:
        json.dump(payload, output, indent=2)
        output.write("\n")

print(f"NODE_DOJO_BAKE_STATE_FIXTURE_OK {output_path}")
