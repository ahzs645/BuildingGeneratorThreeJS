"""Run a Blender-vs-VM parity sweep's Blender side in one bpy session.

Usage:
  blender --background FILE.blend --python tools/parity_sweep.py -- \
    OUT.json [GLB_EXPORT_DIR] [OBJECT_NAME] [CASES.json]
"""
import json
import os
import re
import signal
import sys
import time

import bpy


def apply_font_override():
    path = os.environ.get("NODE_DOJO_FONT_OVERRIDE")
    if not path:
        return
    replacement = bpy.data.fonts.load(path, check_existing=True)
    basename = os.path.basename(path).lower()
    replace_all = os.environ.get("NODE_DOJO_FONT_OVERRIDE_ALL") == "1"
    for group in bpy.data.node_groups:
        for node in group.nodes:
            for socket in node.inputs:
                current = getattr(socket, "default_value", None)
                if getattr(socket, "type", "") == "FONT" and current is not None:
                    if replace_all or os.path.basename(bpy.path.abspath(current.filepath)).lower() == basename:
                        socket.default_value = replacement
    print(f"NODE_DOJO_FONT_OVERRIDE_OK {replacement.name} <- {path}")


apply_font_override()


def apply_graph_overrides():
    for override in json.loads(os.environ.get("NODE_DOJO_PROBE_GRAPH_OVERRIDES", "[]")):
        group = bpy.data.node_groups.get(override["group"])
        node = group.nodes.get(override["node"]) if group else None
        if node is None:
            raise RuntimeError(f"missing graph override node: {override!r}")
        for name, value in override.get("inputs", {}).items():
            socket = node.inputs.get(name) or next(
                (candidate for candidate in node.inputs if candidate.identifier == name),
                None,
            )
            if socket is None:
                raise KeyError(f"graph override input not found: {node.name}.{name}")
            socket.default_value = value


apply_graph_overrides()


def apply_graph_routes():
    for route in json.loads(os.environ.get("NODE_DOJO_PROBE_GRAPH_ROUTES", "[]")):
        group = bpy.data.node_groups.get(route["group"])
        source_node = group.nodes.get(route["node"]) if group else None
        output = next(
            (node for node in group.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output),
            None,
        ) if group else None
        source = source_node.outputs.get(route["socket"]) if source_node else None
        target = next(
            (
                socket
                for socket in output.inputs
                if socket.type == "GEOMETRY"
                and (
                    not route.get("output")
                    or socket.name == route["output"]
                    or socket.identifier == route["output"]
                )
            ),
            None,
        ) if output else None
        if group is None or source is None or target is None:
            raise RuntimeError(f"invalid graph route: {route!r}")
        for link in list(target.links):
            group.links.remove(link)
        group.links.new(source, target)


apply_graph_routes()


TIMEOUT_SECONDS = 180

CASES = [
    *[
        {
            "name": f"divide x={dx:g}, divide y={dy:g}",
            "overrides": {"divide x": dx, "divide y": dy},
        }
        for dx in (0.15, 0.417, 0.85)
        for dy in (0.2, 0.633, 0.9)
    ],
    {"name": "fillet=0.3", "overrides": {"fillet": 0.3}},
    {"name": "fillet=2.5", "overrides": {"fillet": 2.5}},
    {"name": "Bin Select=0", "overrides": {"Bin Select": 0}},
    {"name": "Bin Select=11", "overrides": {"Bin Select": 11}},
    {"name": "bin wall thiccness=4", "overrides": {"bin wall thiccness": 4.0}},
    {"name": "Size X=1.2, Size Y=0.8", "overrides": {"Size X": 1.2, "Size Y": 0.8}},
]


class TimeoutError(Exception):
    pass


def alarm_handler(_signum, _frame):
    raise TimeoutError(f"evaluation exceeded {TIMEOUT_SECONDS}s")


def argv_after_dash():
    if "--" not in sys.argv:
        raise SystemExit("usage: blender --background FILE.blend --python tools/parity_sweep.py -- OUT.json")
    args = sys.argv[sys.argv.index("--") + 1 :]
    if not args:
        raise SystemExit("missing OUT.json")
    return args


def round4(value):
    return round(float(value), 4)


def bbox_for_mesh(mesh):
    if len(mesh.vertices) == 0:
        return {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]}
    mn = [float("inf"), float("inf"), float("inf")]
    mx = [float("-inf"), float("-inf"), float("-inf")]
    for vertex in mesh.vertices:
        co = vertex.co
        for i, value in enumerate((co.x, co.y, co.z)):
            mn[i] = min(mn[i], value)
            mx[i] = max(mx[i], value)
    return {"min": [round4(v) for v in mn], "max": [round4(v) for v in mx]}


def jsonable(value):
    if hasattr(value, "name"):
        return value.name
    if hasattr(value, "__len__") and not isinstance(value, str):
        return [jsonable(v) for v in value]
    return value


def material_face_vertex_counts(obj, mesh):
    slots = [mat.name if mat else None for mat in mesh.materials]
    if not slots:
        for slot in obj.material_slots:
            slots.append(slot.material.name if slot.material else None)
    counts = {}
    for poly in mesh.polygons:
        material = slots[poly.material_index] if poly.material_index < len(slots) else None
        bucket = counts.setdefault(material or "<none>", {"faces": 0, "verts": set()})
        bucket["faces"] += 1
        bucket["verts"].update(poly.vertices)
    return {
        name: {"faces": value["faces"], "verts": len(value["verts"])}
        for name, value in sorted(counts.items(), key=lambda item: item[0])
    }


def find_modifier(object_name):
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise RuntimeError(f'object "{object_name}" not found')
    for mod in obj.modifiers:
        if mod.type == "NODES" and mod.node_group is not None:
            return obj, mod
    raise RuntimeError(f'NODES modifier not found on "{object_name}"')


def modifier_interface(mod):
    name_to_identifier = {}
    saved_values = {}
    for item in mod.node_group.interface.items_tree:
        if item.item_type != "SOCKET" or item.in_out != "INPUT" or item.socket_type == "NodeSocketGeometry":
            continue
        name_to_identifier[item.name] = item.identifier
        try:
            saved_values[item.name] = jsonable(mod[item.identifier])
        except Exception:
            saved_values[item.name] = jsonable(getattr(item, "default_value", None))
    return name_to_identifier, saved_values


def set_modifier_inputs(mod, name_to_identifier, saved_values, overrides):
    for name, value in saved_values.items():
        identifier = name_to_identifier.get(name)
        if identifier is not None:
            try:
                current = mod.get(identifier)
                if current == value or (hasattr(current, "name") and current.name == value):
                    continue
                mod[identifier] = value
            except TypeError:
                # Datablock-valued sockets (materials/objects) are serialized as
                # names for reports. Keep their existing modifier value instead
                # of attempting to assign that report string back to Blender.
                pass
    for name, value in overrides.items():
        if name == "__frame":
            bpy.context.scene.frame_set(int(value))
            continue
        identifier = name_to_identifier.get(name)
        if identifier is None:
            raise KeyError(f"modifier input not found: {name}")
        if mod.get(identifier) == value:
            continue
        mod[identifier] = value


def evaluated_mesh(obj):
    # Always realize first. Object.to_mesh() may return an allocated mesh for a
    # mixed geometry set while silently omitting its instance component.
    realize_group = bpy.data.node_groups.new("__PARITY_REALIZE_INSTANCES", "GeometryNodeTree")
    realize_group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    realize_group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_input = realize_group.nodes.new("NodeGroupInput")
    realize = realize_group.nodes.new("GeometryNodeRealizeInstances")
    group_output = realize_group.nodes.new("NodeGroupOutput")
    realize_group.links.new(group_input.outputs["Geometry"], realize.inputs["Geometry"])
    realize_group.links.new(realize.outputs["Geometry"], group_output.inputs["Geometry"])
    realize_mod = obj.modifiers.new(name="__PARITY_REALIZE_INSTANCES", type="NODES")
    realize_mod.node_group = realize_group
    obj.update_tag()
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    if mesh is not None:
        return ev, mesh, (obj, realize_mod, realize_group)

    obj.modifiers.remove(realize_mod)
    bpy.data.node_groups.remove(realize_group)
    raise RuntimeError(f'could not create evaluated mesh for "{obj.name}"')


def clear_evaluated_mesh(ev, _mesh, temporary_realize):
    ev.to_mesh_clear()
    if temporary_realize is not None:
        obj, realize_mod, realize_group = temporary_realize
        obj.modifiers.remove(realize_mod)
        bpy.data.node_groups.remove(realize_group)


def evaluate_case(obj, mod, name_to_identifier, saved_values, case, raw_mesh_path=None):
    started = time.time()
    set_modifier_inputs(mod, name_to_identifier, saved_values, case["overrides"])
    ev, mesh, owned = evaluated_mesh(obj)
    try:
        if raw_mesh_path:
            with open(raw_mesh_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "positions": [list(vertex.co) for vertex in mesh.vertices],
                        "faces": [list(face.vertices) for face in mesh.polygons],
                    },
                    handle,
                )
        return {
            "combo": case,
            "status": "ok",
            "verts": len(mesh.vertices),
            "faces": len(mesh.polygons),
            "bbox": bbox_for_mesh(mesh),
            "elapsed_ms": round((time.time() - started) * 1000, 1),
        }
    finally:
        clear_evaluated_mesh(ev, mesh, owned)


def export_case_glb(obj, path):
    for scene_obj in bpy.context.view_layer.objects:
        scene_obj.select_set(False)
    obj.hide_set(False)
    obj.hide_render = False
    obj.hide_viewport = False
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_normals=True,
    )


def case_filename(index, name, extension):
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return f"{index:02d}-{slug}.{extension}"


def estimate_cosmetic_geometry(obj, mod, name_to_identifier, saved_values):
    case = {"name": "DEFAULT", "overrides": {}}
    set_modifier_inputs(mod, name_to_identifier, saved_values, {})
    ev, mesh, owned = evaluated_mesh(obj)
    try:
        counts = material_face_vertex_counts(obj, mesh)
        text_materials = ["emit.004"]
        clickme_materials = ["emit.003"]
        return {
            "method": "evaluated face material; verts are unique vertices referenced by faces with the material",
            "combo": case,
            "materials": counts,
            "text": {
                "materials": text_materials,
                "faces": sum(counts.get(name, {}).get("faces", 0) for name in text_materials),
                "verts": sum(counts.get(name, {}).get("verts", 0) for name in text_materials),
            },
            "clickme": {
                "materials": clickme_materials,
                "faces": sum(counts.get(name, {}).get("faces", 0) for name in clickme_materials),
                "verts": sum(counts.get(name, {}).get("verts", 0) for name in clickme_materials),
            },
            "total": {"faces": len(mesh.polygons), "verts": len(mesh.vertices)},
        }
    finally:
        clear_evaluated_mesh(ev, mesh, owned)


def main():
    args = argv_after_dash()
    out_path = args[0]
    export_dir = args[1] if len(args) > 1 else None
    object_name = args[2] if len(args) > 2 else "Procedural Drawer"
    cases = CASES
    if len(args) > 3:
        with open(args[3], "r", encoding="utf-8") as handle:
            cases = json.load(handle)
    if export_dir:
        os.makedirs(export_dir, exist_ok=True)
    obj, mod = find_modifier(object_name)
    # Asset-library objects can live in hidden/excluded collections. Evaluate
    # them in a clean scene, as the isolated reference renderer does, so a
    # downstream Realize Instances modifier sees the complete geometry set.
    scene = bpy.data.scenes.new("__NODE_DOJO_PARITY_SCENE")
    scene.collection.objects.link(obj)
    bpy.context.window.scene = scene
    obj.hide_render = False
    obj.hide_viewport = False
    obj.hide_set(False)
    if os.environ.get("NODE_DOJO_LOCAL_SPACE") == "1":
        # Object Info in Relative mode is evaluated against the modifier
        # object's transform. Match the browser gallery's local-space preview
        # by evaluating the source at an identity transform.
        obj.location = (0, 0, 0)
        obj.rotation_euler = (0, 0, 0)
        obj.scale = (1, 1, 1)
    name_to_identifier, saved_values = modifier_interface(mod)
    results = []
    cosmetic_geometry = estimate_cosmetic_geometry(obj, mod, name_to_identifier, saved_values)

    old_handler = signal.signal(signal.SIGALRM, alarm_handler)
    try:
        for case_index, case in enumerate(cases):
            print("SWEEP", case["name"], flush=True)
            signal.alarm(TIMEOUT_SECONDS)
            try:
                raw_mesh_export = export_dir and os.environ.get("NODE_DOJO_RAW_MESH_EXPORT") == "1"
                if raw_mesh_export:
                    filename = case_filename(case_index, case["name"], "json")
                    result = evaluate_case(
                        obj,
                        mod,
                        name_to_identifier,
                        saved_values,
                        case,
                        os.path.join(export_dir, filename),
                    )
                    result["export"] = filename
                else:
                    result = evaluate_case(obj, mod, name_to_identifier, saved_values, case)
                if export_dir and not raw_mesh_export:
                    filename = case_filename(case_index, case["name"], "glb")
                    export_case_glb(obj, os.path.join(export_dir, filename))
                    result["export"] = filename
                print(
                    f"  -> {result['verts']} verts, {result['faces']} faces, {result['elapsed_ms']} ms",
                    flush=True,
                )
            except TimeoutError as exc:
                result = {
                    "combo": case,
                    "status": "timeout",
                    "verts": None,
                    "faces": None,
                    "bbox": None,
                    "elapsed_ms": TIMEOUT_SECONDS * 1000,
                    "error": str(exc),
                }
                print(f"  !! timeout after {TIMEOUT_SECONDS}s", flush=True)
            except Exception as exc:
                result = {
                    "combo": case,
                    "status": "error",
                    "verts": None,
                    "faces": None,
                    "bbox": None,
                    "elapsed_ms": None,
                    "error": repr(exc),
                }
                print(f"  !! error: {exc!r}", flush=True)
            finally:
                signal.alarm(0)
            results.append(result)
    finally:
        signal.signal(signal.SIGALRM, old_handler)
        set_modifier_inputs(mod, name_to_identifier, saved_values, {})

    payload = {
        "source": "blender",
        "blender_version": bpy.app.version_string,
        "object": obj.name,
        "modifier": mod.name,
        "node_group": mod.node_group.name,
        "saved_values": saved_values,
        "results": results,
        "export_dir": export_dir,
        "cosmetic_geometry": cosmetic_geometry,
    }
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    print("BLENDER_SWEEP_OK ->", out_path, flush=True)


if __name__ == "__main__":
    main()
