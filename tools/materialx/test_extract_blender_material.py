"""Focused Blender-side tests for native USD MaterialX root conversion.

Run with:
  /Applications/Blender.app/Contents/MacOS/Blender -b \
    --python tools/materialx/test_extract_blender_material.py
"""

from __future__ import annotations

import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy
from pxr import Sdf

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.materialx.extract_blender_material import convert


DIRECT_SURFACE_USDA = """#usda 1.0
def Scope "root"
{
    def Scope "_materials"
    {
        def Material "Synthetic"
        {
            custom string userProperties:blender:data_name = "Synthetic"

            def Shader "surface"
            {
                uniform token info:id = "ND_surface"
                token inputs:bsdf (
                    renderType = "BSDF"
                )
                token inputs:bsdf.connect = </root/_materials/Synthetic/NodeGraphs.outputs:layered>
                float inputs:opacity = 0.8
                bool inputs:thin_walled = 1
                token outputs:surface
            }

            def NodeGraph "NodeGraphs"
            {
                token outputs:layered (
                    renderType = "BSDF"
                )
                token outputs:layered.connect = </root/_materials/Synthetic/NodeGraphs/layer.outputs:out>

                def Shader "base"
                {
                    uniform token info:id = "ND_conductor_bsdf"
                    color3f inputs:ior = (0.73, 0.59, 0.78)
                    color3f inputs:extinction = (6.46, 5.2, 4.38)
                    float2 inputs:roughness = (0.2, 0.5)
                    float inputs:thinfilm_ior = 2.46
                    float inputs:thinfilm_thickness = 243
                    token outputs:out (
                        renderType = "BSDF"
                    )
                }

                def Shader "detail"
                {
                    uniform token info:id = "ND_conductor_bsdf"
                    color3f inputs:ior = (0.73, 0.59, 0.78)
                    color3f inputs:extinction = (6.46, 5.2, 4.38)
                    float2 inputs:roughness = (0.05, 0.1)
                    token outputs:out (
                        renderType = "BSDF"
                    )
                }

                def Shader "layer"
                {
                    uniform token info:id = "ND_mix_bsdf"
                    token inputs:bg (
                        renderType = "BSDF"
                    )
                    token inputs:bg.connect = </root/_materials/Synthetic/NodeGraphs/base.outputs:out>
                    token inputs:fg (
                        renderType = "BSDF"
                    )
                    token inputs:fg.connect = </root/_materials/Synthetic/NodeGraphs/detail.outputs:out>
                    float inputs:mix = 0.35
                    token outputs:out (
                        renderType = "BSDF"
                    )
                }
            }
        }
    }
}
"""


OPEN_PBR_USDA = """#usda 1.0
def Scope "root"
{
    def Scope "_materials"
    {
        def Material "Synthetic"
        {
            custom string userProperties:blender:data_name = "Synthetic"

            def Shader "openPbr"
            {
                uniform token info:id = "ND_open_pbr_surface_surfaceshader"
                color3f inputs:base_color = (0.2, 0.4, 0.8)
                float inputs:base_metalness = 0.75
                float inputs:base_weight = 1
                float inputs:specular_roughness.connect = </root/_materials/Synthetic/NodeGraphs/roughness.outputs:out>
                token outputs:out
            }

            def NodeGraph "NodeGraphs"
            {
                def Shader "roughness"
                {
                    uniform token info:id = "ND_multiply_float"
                    float inputs:in1 = 0.5
                    float inputs:in2 = 0.6
                    float outputs:out
                }
            }
        }
    }
}
"""


class NativeMaterialXRootTests(unittest.TestCase):
    def setUp(self) -> None:
        self.material = bpy.data.materials.get("Synthetic") or bpy.data.materials.new("Synthetic")
        self.contract = {"material": self.material.name, "properties": []}

    def convert_fixture(self, source: str):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        native = directory / "fixture.usda"
        layer = Sdf.Layer.CreateNew(str(native))
        self.assertTrue(layer.ImportFromString(source))
        layer.Save()
        output = directory / "fixture.mtlx"
        result = convert(native, self.material, output, self.contract)
        return ET.parse(output).getroot(), result

    def test_direct_surface_preserves_conductor_bsdf_graph(self) -> None:
        root, result = self.convert_fixture(DIRECT_SURFACE_USDA)
        valid, message, categories, recovered_generated, recovered_properties = result
        self.assertTrue(valid, message)
        self.assertEqual(recovered_generated, 0)
        self.assertEqual(recovered_properties, set())
        self.assertEqual(categories["base"], "conductor_bsdf")
        self.assertEqual(categories["detail"], "conductor_bsdf")
        self.assertEqual(categories["layer"], "mix")

        graph = root.find("nodegraph")
        self.assertIsNotNone(graph)
        conductors = graph.findall("conductor_bsdf")
        self.assertEqual(len(conductors), 2)
        self.assertTrue(all(node.get("type") == "BSDF" for node in conductors))
        layer = graph.find("mix")
        self.assertEqual(layer.get("type"), "BSDF")
        self.assertAlmostEqual(float(layer.find("input[@name='mix']").get("value")), 0.35)
        self.assertEqual(
            [round(float(value), 6) for value in conductors[0].find("input[@name='roughness']").get("value").split(",")],
            [0.2, 0.5],
        )
        self.assertAlmostEqual(
            float(conductors[0].find("input[@name='thinfilm_thickness']").get("value")),
            243,
        )

        surface = root.find("surface")
        self.assertIsNotNone(surface)
        bsdf = surface.find("input[@name='bsdf']")
        self.assertEqual(bsdf.get("type"), "BSDF")
        self.assertEqual(bsdf.get("nodegraph"), "NG_blender_native")
        self.assertEqual(bsdf.get("output"), "bsdf_out")
        self.assertAlmostEqual(float(surface.find("input[@name='opacity']").get("value")), 0.8)
        self.assertEqual(surface.find("input[@name='thin_walled']").get("value"), "true")

    def test_open_pbr_root_remains_standard_surface(self) -> None:
        root, result = self.convert_fixture(OPEN_PBR_USDA)
        valid, message, categories, _, _ = result
        self.assertTrue(valid, message)
        self.assertEqual(categories["roughness"], "multiply")
        self.assertIsNone(root.find("surface"))

        surface = root.find("standard_surface")
        self.assertIsNotNone(surface)
        self.assertAlmostEqual(float(surface.find("input[@name='base']").get("value")), 1)
        self.assertEqual(
            [round(float(value), 6) for value in surface.find("input[@name='base_color']").get("value").split(",")],
            [0.2, 0.4, 0.8],
        )
        self.assertAlmostEqual(float(surface.find("input[@name='metalness']").get("value")), 0.75)
        roughness = surface.find("input[@name='specular_roughness']")
        self.assertEqual(roughness.get("nodegraph"), "NG_blender_native")
        self.assertEqual(roughness.get("output"), "specular_roughness_out")


suite = unittest.defaultTestLoader.loadTestsFromTestCase(NativeMaterialXRootTests)
result = unittest.TextTestRunner(verbosity=2).run(suite)
if not result.wasSuccessful():
    raise SystemExit(1)
