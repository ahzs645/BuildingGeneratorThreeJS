"""Create a dependency-repaired copy of a Blender file without changing source.

Only exact filename matches are accepted. Images are packed into the copy;
Import STL files are copied beside it and rebound to a relative path.

Usage:
  blender --background SOURCE.blend \
    --python tools/repair_blend_dependencies.py -- \
    OUTPUT.blend ASSET_DIRECTORY
"""
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

import bpy


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) != 2:
    raise SystemExit("expected OUTPUT.blend ASSET_DIRECTORY")
output_path = Path(args[0]).expanduser().resolve()
asset_directory = Path(args[1]).expanduser().resolve()
source_path = Path(bpy.data.filepath).resolve()
if not asset_directory.is_dir():
    raise FileNotFoundError(f"asset directory not found: {asset_directory}")
if source_path == output_path:
    raise RuntimeError("output must not overwrite the source .blend")


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


assets = {}
for candidate in sorted(path for path in asset_directory.rglob("*") if path.is_file()):
    key = candidate.name.casefold()
    if key in assets and assets[key] != candidate:
        raise RuntimeError(
            f"ambiguous dependency filename {candidate.name}: "
            f"{assets[key]} and {candidate}"
        )
    assets[key] = candidate


def authored_basename(datablock_name, filepath):
    filepath_name = Path(filepath.replace("\\", "/")).name if filepath else ""
    # Blender suffixes duplicate datablock names with .001, .002, and so on;
    # those suffixes are not part of the source filename.
    clean_name = re.sub(r"\.\d{3}$", "", datablock_name)
    for name in (filepath_name, clean_name):
        if name.casefold() in assets:
            return name
    return filepath_name or clean_name


recovered = []
unresolved = []
for image in bpy.data.images:
    authored_path = getattr(image, "filepath", "") or ""
    if (
        not authored_path
        or authored_path == "<builtin>"
        or image.source in {"GENERATED", "VIEWER"}
        or image.packed_file is not None
        or os.path.isfile(bpy.path.abspath(authored_path))
    ):
        continue
    name = authored_basename(image.name, authored_path)
    candidate = assets.get(name.casefold())
    if candidate is None:
        unresolved.append({
            "kind": "image",
            "datablock": image.name,
            "authored_path": authored_path,
            "expected_filename": name,
        })
        continue
    image.filepath = str(candidate)
    image.reload()
    if image.size[0] <= 0 or image.size[1] <= 0:
        raise RuntimeError(f"image did not decode: {candidate}")
    image.pack()
    recovered.append({
        "kind": "image",
        "datablock": image.name,
        "source": str(candidate),
        "sha256": digest(candidate),
        "bytes": candidate.stat().st_size,
        "size": [int(image.size[0]), int(image.size[1])],
        "packed": True,
    })


dependency_directory = output_path.with_suffix("").with_name(
    f"{output_path.stem}.dependencies"
)
for tree in bpy.data.node_groups:
    if tree.bl_idname != "GeometryNodeTree":
        continue
    for node in tree.nodes:
        if node.bl_idname != "GeometryNodeImportSTL":
            continue
        path_socket = next((
            socket for socket in node.inputs
            if socket.identifier == "Path" or socket.name == "Path"
        ), None)
        if path_socket is None or path_socket.is_linked:
            continue
        authored_path = str(path_socket.default_value or "")
        if not authored_path or os.path.isfile(bpy.path.abspath(authored_path)):
            continue
        expected = Path(authored_path.replace("\\", "/")).name
        candidate = assets.get(expected.casefold())
        if candidate is None:
            unresolved.append({
                "kind": "stl",
                "node_group": tree.name,
                "node": node.name,
                "authored_path": authored_path,
                "expected_filename": expected,
            })
            continue
        dependency_directory.mkdir(parents=True, exist_ok=True)
        target = dependency_directory / expected
        if candidate.resolve() != target.resolve():
            shutil.copy2(candidate, target)
        path_socket.default_value = f"//{dependency_directory.name}/{expected}"
        recovered.append({
            "kind": "stl",
            "node_group": tree.name,
            "node": node.name,
            "source": str(candidate),
            "portable_path": path_socket.default_value,
            "sha256": digest(target),
            "bytes": target.stat().st_size,
        })


output_path.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(output_path))
manifest_path = output_path.with_suffix(".dependencies.json")
manifest_path.write_text(json.dumps({
    "schema_version": 1,
    "source": str(source_path),
    "output": str(output_path),
    "matching_policy": "case-insensitive exact filename; Blender duplicate suffix ignored",
    "recovered": recovered,
    "unresolved": unresolved,
}, indent=2) + "\n", encoding="utf-8")
print(
    f"DEPENDENCY_REPAIR_OK recovered={len(recovered)} "
    f"unresolved={len(unresolved)} -> {output_path}"
)
