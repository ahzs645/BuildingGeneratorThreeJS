"""Configure the Typewriter source like the live browser page before rendering."""
import os

import bpy


font_path = os.environ.get("NODE_DOJO_FONT_OVERRIDE")
if font_path:
    replacement = bpy.data.fonts.load(font_path, check_existing=True)
    for group in bpy.data.node_groups:
        for node in group.nodes:
            for socket in node.inputs:
                if getattr(socket, "type", "") == "FONT" and getattr(socket, "default_value", None) is not None:
                    socket.default_value = replacement
    print(f"TYPEWRITER_FONT_OVERRIDE_OK {replacement.name} <- {font_path}")


text = os.environ.get("NODE_DOJO_TYPEWRITER_TEXT", "NODE DOJO TYPEWRITER — now running entirely in the browser.")
frame = int(os.environ.get("NODE_DOJO_TYPEWRITER_FRAME", "240"))
root = bpy.data.node_groups.get("GN")
if root is None:
    raise RuntimeError("Typewriter root group not found: GN")

typewriter = next((node for node in root.nodes if node.bl_idname == "GeometryNodeGroup" and node.node_tree and node.node_tree.name == "_Typewriter Nodes"), None)
if typewriter is None:
    raise RuntimeError("Nested Typewriter group node not found")
text_socket = typewriter.inputs.get("Text input")
if text_socket is None:
    raise RuntimeError("Typewriter Text input socket not found")
text_socket.default_value = text

# This graph predates Blender's current component rules and connects String to
# Curves instances directly into Fill Curve. Blender 5 leaves that path empty;
# an explicit Realize Instances restores the authored behavior that the old
# graph expected (and that the GN-VM has always preserved).
inner = typewriter.node_tree
string_to_curves = inner.nodes.get("String to Curves")
fill_curve = inner.nodes.get("Fill Curve")
if string_to_curves and fill_curve:
    static_text = os.environ.get("NODE_DOJO_TYPEWRITER_STATIC_TEXT")
    if static_text is not None:
        for link in list(string_to_curves.inputs["String"].links):
            inner.links.remove(link)
        string_to_curves.inputs["String"].default_value = static_text
    direct = next((link for link in inner.links if link.from_node == string_to_curves and link.to_node == fill_curve), None)
    if direct:
        inner.links.remove(direct)
        realize = inner.nodes.get("__TYPEWRITER_REFERENCE_REALIZE") or inner.nodes.new("GeometryNodeRealizeInstances")
        realize.name = "__TYPEWRITER_REFERENCE_REALIZE"
        inner.links.new(string_to_curves.outputs["Curve Instances"], realize.inputs["Geometry"])
        inner.links.new(realize.outputs["Geometry"], fill_curve.inputs["Curve"])

# The browser intentionally shows the generated text alone, without the large
# pre-existing presentation board joined through the root Group Input.
if os.environ.get("NODE_DOJO_TYPEWRITER_PROCEDURAL_ONLY", "1") != "0":
    for link in list(root.links):
        if link.from_node.bl_idname == "NodeGroupInput" and link.to_node.name == "Join Geometry":
            root.links.remove(link)

bpy.context.scene.frame_set(frame)
bpy.context.view_layer.update()
print(f"TYPEWRITER_REFERENCE_CONFIGURED frame={frame} text={text!r}")
