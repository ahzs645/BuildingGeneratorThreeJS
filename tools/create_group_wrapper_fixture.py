"""Save a non-destructive Geometry Nodes group wrapper for visual parity.

Usage:
  blender --background SOURCE.blend \
    --python tools/create_group_wrapper_fixture.py -- \
    CASES.json ASSET_SLUG GROUP_NAME CASE_NAME OUT.blend [OBJECT_NAME]

The source file is opened read-only by Blender. A new object and wrapper node
tree are added in memory, the selected case inputs are applied to the nested
group node, and the result is saved to ``OUT.blend``. Packed fonts already
present in the source are preserved in the copy.
"""
import json
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) not in {5, 6}:
    raise SystemExit(
        "usage: CASES.json ASSET_SLUG GROUP_NAME CASE_NAME OUT.blend "
        "[OBJECT_NAME]"
    )
cases_path, asset_slug, group_name, case_name, out_path = args[:5]
object_name = args[5] if len(args) == 6 else "__FONT_PARITY_CAPTURE"

with open(cases_path, "r", encoding="utf-8") as handle:
    manifest = json.load(handle)

asset = next(
    (candidate for candidate in manifest["assets"] if candidate["slug"] == asset_slug),
    None,
)
if asset is None:
    raise RuntimeError(f"asset not found in cases manifest: {asset_slug!r}")

suite = next(
    (candidate for candidate in asset["suites"] if candidate["group"] == group_name),
    None,
)
if suite is None:
    raise RuntimeError(f"group suite not found for {asset_slug}: {group_name!r}")

suite_cases = suite.get("cases")
if suite_cases is None:
    suite_cases = manifest.get("profiles", {}).get(suite.get("profile"))
if not suite_cases:
    raise RuntimeError(f"suite has no cases: {asset_slug} / {group_name}")

case = next(
    (candidate for candidate in suite_cases if candidate["name"] == case_name),
    None,
)
if case is None:
    raise RuntimeError(
        f"case not found for {asset_slug} / {group_name}: {case_name!r}"
    )

target = bpy.data.node_groups.get(group_name)
if target is None:
    raise RuntimeError(f"node group not found: {group_name!r}")

wrapper_name = f"__FONT_PARITY_CAPTURE_{asset_slug}"
wrapper = bpy.data.node_groups.new(wrapper_name, "GeometryNodeTree")
wrapper.interface.new_socket(
    name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry"
)
group_node = wrapper.nodes.new("GeometryNodeGroup")
group_node.name = "Representative Font Helper"
group_node.label = f"{group_name}: {case_name}"
group_node.node_tree = target
wrapper_output = wrapper.nodes.new("NodeGroupOutput")

for name, value in case.get("inputs", {}).items():
    socket = group_node.inputs.get(name)
    if socket is None:
        raise KeyError(f"group input not found: {group_name}.{name}")
    try:
        socket.default_value = value
    except Exception as error:
        raise RuntimeError(
            f"cannot assign {group_name}.{name}={value!r}: {error!r}"
        ) from error

source = next(
    (
        socket
        for socket in group_node.outputs
        if socket.type == "GEOMETRY"
        and (not suite.get("output") or socket.name == suite["output"])
    ),
    None,
)
if source is None:
    raise RuntimeError(f"geometry output not found: {group_name!r}")
target_output = next(
    socket for socket in wrapper_output.inputs if socket.type == "GEOMETRY"
)
realize = wrapper.nodes.new("GeometryNodeRealizeInstances")
wrapper.links.new(source, realize.inputs["Geometry"])
wrapper.links.new(realize.outputs["Geometry"], target_output)

mesh = bpy.data.meshes.new(f"{object_name}_seed")
obj = bpy.data.objects.new(object_name, mesh)
obj["font_parity_asset"] = asset_slug
obj["font_parity_group"] = group_name
obj["font_parity_case"] = case_name
obj["font_parity_inputs_json"] = json.dumps(
    case.get("inputs", {}), sort_keys=True, separators=(",", ":")
)
bpy.context.scene.collection.objects.link(obj)
modifier = obj.modifiers.new("__FONT_PARITY_CAPTURE", "NODES")
modifier.node_group = wrapper

for scene_object in list(bpy.context.scene.objects):
    scene_object.hide_render = scene_object != obj

bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.context.view_layer.update()

out_path = os.path.abspath(out_path)
os.makedirs(os.path.dirname(out_path), exist_ok=True)
if os.path.exists(out_path):
    raise RuntimeError(f"refusing to overwrite existing fixture: {out_path}")
bpy.ops.wm.save_as_mainfile(filepath=out_path, compress=True)
print(
    "FONT_PARITY_WRAPPER_OK "
    f"{asset_slug} / {group_name} / {case_name} -> {out_path}"
)
