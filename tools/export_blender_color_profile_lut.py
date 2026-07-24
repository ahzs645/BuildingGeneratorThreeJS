"""Export a browser-ready 1D LUT from Blender's active OpenColorIO config.

Run with Blender so the generated samples use the exact OCIO build/config that
produced the authored references:

  blender --background --python tools/export_blender_color_profile_lut.py -- \
    OUT.json [SIZE]

The fixed profile is Blender Standard + Medium High Contrast on an sRGB
display. The JSON stores linear-display values because Three.js applies the
sRGB output transfer after the custom color-profile pass.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

import bpy
import PyOpenColorIO as ocio


def srgb_to_linear(value: float) -> float:
    if value <= 0.04045:
        return value / 12.92
    return ((value + 0.055) / 1.055) ** 2.4


args = sys.argv[sys.argv.index("--") + 1 :]
if not args:
    raise RuntimeError("expected OUT.json [SIZE]")
out_path = os.path.abspath(args[0])
size = int(args[1]) if len(args) > 1 else 256
if size < 2:
    raise ValueError("SIZE must be at least two")

config_path = os.path.join(
    bpy.utils.resource_path("LOCAL"),
    "datafiles",
    "colormanagement",
    "config.ocio",
)
config = ocio.Config.CreateFromFile(config_path)

display = ocio.DisplayViewTransform()
display.setSrc("Linear Rec.709")
display.setDisplay("sRGB")
display.setView("Standard")
pipeline = ocio.LegacyViewingPipeline()
pipeline.setDisplayViewTransform(display)
pipeline.setLooksOverride("Medium High Contrast")
pipeline.setLooksOverrideEnabled(True)
processor = pipeline.getProcessor(config, config.getCurrentContext()).getDefaultCPUProcessor()

values = []
max_cross_channel_error = 0.0
for index in range(size):
    source = index / (size - 1)
    display_rgb = processor.applyRGB([source, source, source])
    max_cross_channel_error = max(
        max_cross_channel_error,
        abs(display_rgb[0] - display_rgb[1]),
        abs(display_rgb[1] - display_rgb[2]),
    )
    values.append(srgb_to_linear(display_rgb[0]))

with open(config_path, "rb") as handle:
    config_sha256 = hashlib.sha256(handle.read()).hexdigest()
payload = {
    "schemaVersion": 1,
    "profile": "standard-medium-high-contrast",
    "sourceColorSpace": "Linear Rec.709",
    "display": "sRGB",
    "viewTransform": "Standard",
    "look": "Medium High Contrast",
    "domain": [0.0, 1.0],
    "outputEncoding": "linear-sRGB-display",
    "interpolation": "linear",
    "size": size,
    "configSha256": config_sha256,
    "maxNeutralCrossChannelError": max_cross_channel_error,
    "values": values,
}
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
print(f"BLENDER_COLOR_PROFILE_LUT_OK {out_path} ({size} samples)")
