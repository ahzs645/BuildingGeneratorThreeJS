"""Evaluate reusable Geometry Nodes groups for Blender/browser parity.

Usage:
  blender --background SOURCE.blend --python tools/blender_group_parity_probe.py -- \
    CASES.json ASSET_SLUG OUT.json

The cases file is shared with ``tools/gnvm-group-parity.ts``. Each suite is
evaluated through a temporary wrapper node tree, so the source .blend is never
modified or saved.
"""
import bpy
import hashlib
import json
import math
import os
import sys
import time


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) != 3:
    raise SystemExit("usage: CASES.json ASSET_SLUG OUT.json")
cases_path, asset_slug, out_path = args

with open(cases_path, "r", encoding="utf-8") as handle:
    manifest = json.load(handle)

asset = next(
    (candidate for candidate in manifest["assets"] if candidate["slug"] == asset_slug),
    None,
)
if asset is None:
    raise RuntimeError(f"asset not found in cases manifest: {asset_slug!r}")


def round6(value):
    return round(float(value), 6)


def mesh_bounds(mesh):
    if not mesh or not mesh.vertices:
        return {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]}
    return {
        "min": [
            round6(min(vertex.co[axis] for vertex in mesh.vertices))
            for axis in range(3)
        ],
        "max": [
            round6(max(vertex.co[axis] for vertex in mesh.vertices))
            for axis in range(3)
        ],
    }


def mesh_signature(mesh):
    points = sorted(
        tuple(round6(vertex.co[axis]) for axis in range(3))
        for vertex in mesh.vertices
    )
    return hashlib.sha256(
        json.dumps(points, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def seed_object(suite, case_index):
    source_name = suite.get("seedObject")
    if source_name:
        source = bpy.data.objects.get(source_name)
        if source is None:
            raise RuntimeError(f"seed object not found: {source_name!r}")
        if source.type in {"MESH", "CURVE"}:
            data = source.data.copy()
        else:
            evaluated = source.evaluated_get(bpy.context.evaluated_depsgraph_get())
            data = bpy.data.meshes.new_from_object(evaluated)
        obj = bpy.data.objects.new(
            f"__FONT_PARITY_{asset_slug}_{case_index}", data
        )
        obj.matrix_world = source.matrix_world.copy()
        return obj
    mesh = bpy.data.meshes.new(f"__FONT_PARITY_{asset_slug}_{case_index}")
    if suite.get("seed") == "cube":
        mesh.from_pydata(
            [
                [-0.5, -0.5, -0.5],
                [0.5, -0.5, -0.5],
                [0.5, 0.5, -0.5],
                [-0.5, 0.5, -0.5],
                [-0.5, -0.5, 0.5],
                [0.5, -0.5, 0.5],
                [0.5, 0.5, 0.5],
                [-0.5, 0.5, 0.5],
            ],
            [],
            [
                [0, 3, 2, 1],
                [4, 5, 6, 7],
                [0, 1, 5, 4],
                [1, 2, 6, 5],
                [2, 3, 7, 6],
                [4, 7, 3, 0],
            ],
        )
    obj = bpy.data.objects.new(f"__FONT_PARITY_{asset_slug}_{case_index}", mesh)
    active_name = suite.get("activeObject")
    if active_name:
        active = bpy.data.objects.get(active_name)
        if active is None:
            raise RuntimeError(f"active object not found: {active_name!r}")
        obj.matrix_world = active.matrix_world.copy()
    return obj


def geometry_socket(sockets, preferred=None):
    if preferred:
        socket = sockets.get(preferred)
        if socket is not None:
            return socket
    return next((socket for socket in sockets if socket.type == "GEOMETRY"), None)


def evaluate_suite_case(suite, case, case_index):
    target = bpy.data.node_groups.get(suite["group"])
    if target is None:
        raise RuntimeError(f"node group not found: {suite['group']!r}")

    wrapper = bpy.data.node_groups.new(
        f"__FONT_PARITY_WRAPPER_{case_index}", "GeometryNodeTree"
    )
    wrapper.interface.new_socket(
        name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry"
    )
    group_node = wrapper.nodes.new("GeometryNodeGroup")
    group_node.node_tree = target
    wrapper_output = wrapper.nodes.new("NodeGroupOutput")

    target_geometry_input = geometry_socket(group_node.inputs, suite.get("geometryInput"))
    if target_geometry_input is not None:
        wrapper.interface.new_socket(
            name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry"
        )
        wrapper_input = wrapper.nodes.new("NodeGroupInput")
        wrapper.links.new(
            geometry_socket(wrapper_input.outputs),
            target_geometry_input,
        )

    for name, value in case.get("inputs", {}).items():
        socket = group_node.inputs.get(name)
        if socket is None:
            raise KeyError(f"group input not found: {suite['group']}.{name}")
        try:
            socket.default_value = value
        except Exception as error:
            raise RuntimeError(
                f"cannot assign {suite['group']}.{name}={value!r}: {error!r}"
            ) from error

    source = geometry_socket(group_node.outputs, suite.get("output"))
    target_output = geometry_socket(wrapper_output.inputs)
    if source is None or target_output is None:
        raise RuntimeError(f"geometry output not found: {suite['group']!r}")
    realize = wrapper.nodes.new("GeometryNodeRealizeInstances")
    wrapper.links.new(source, realize.inputs["Geometry"])
    wrapper.links.new(realize.outputs["Geometry"], target_output)

    scene = bpy.data.scenes.new(f"__FONT_PARITY_SCENE_{case_index}")
    obj = seed_object(suite, case_index)
    scene.collection.objects.link(obj)
    bpy.context.window.scene = scene
    obj.hide_viewport = False
    obj.hide_render = False
    modifier = obj.modifiers.new("__FONT_PARITY", "NODES")
    modifier.node_group = wrapper

    started = time.perf_counter()
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    try:
        triangles = 0
        if mesh:
            mesh.calc_loop_triangles()
            triangles = len(mesh.loop_triangles)
        return {
            "name": case["name"],
            "inputs": case.get("inputs", {}),
            "status": "ok",
            "verts": len(mesh.vertices) if mesh else 0,
            "faces": len(mesh.polygons) if mesh else 0,
            "triangles": triangles,
            "bbox": mesh_bounds(mesh),
            "vertexPositionSha256": mesh_signature(mesh) if mesh else None,
            "elapsedMs": elapsed_ms,
        }
    finally:
        evaluated.to_mesh_clear()


results = []
case_index = 0
for suite in asset["suites"]:
    suite_results = []
    cases = suite.get("cases") or manifest.get("profiles", {}).get(suite.get("profile"))
    if not cases:
        raise RuntimeError(
            f"suite has no cases or valid profile: {asset_slug} / {suite['group']}"
        )
    for case in cases:
        try:
            suite_results.append(evaluate_suite_case(suite, case, case_index))
        except Exception as error:
            suite_results.append(
                {
                    "name": case["name"],
                    "inputs": case.get("inputs", {}),
                    "status": "error",
                    "error": repr(error),
                }
            )
        case_index += 1
    results.append(
        {
            "group": suite["group"],
            "output": suite.get("output"),
            "seed": suite.get("seed"),
            "seedObject": suite.get("seedObject"),
            "profile": suite.get("profile"),
            "cases": suite_results,
        }
    )

payload = {
    "schemaVersion": 1,
    "runtime": "blender",
    "blenderVersion": ".".join(str(value) for value in bpy.app.version),
    "sourceBlend": bpy.data.filepath,
    "asset": asset_slug,
    "suites": results,
}
os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
print(
    f"BLENDER_GROUP_PARITY_OK {asset_slug}: "
    f"{sum(len(suite['cases']) for suite in results)} cases -> {out_path}"
)
