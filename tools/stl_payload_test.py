import math
import struct
import unittest
from pathlib import Path

from stl_payload import (
    MAX_STL_BYTES,
    StlPayloadError,
    load_stl_payload,
    parse_stl_bytes,
)

FIXTURE = Path(__file__).parent / "fixtures" / "import-stl-triangle.stl"


ASCII_TRIANGLE = b"""solid triangle
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid triangle
"""


def binary_stl(vertices, normal=(0.0, 0.0, 1.0)):
    triangle = struct.pack("<12fH", *(normal + vertices[0] + vertices[1] + vertices[2]), 0)
    return b"portable STL".ljust(80, b"\0") + struct.pack("<I", 1) + triangle


class StlPayloadTests(unittest.TestCase):
    def test_checked_fixture_loads_as_the_authored_ascii_triangle(self):
        payload = load_stl_payload(FIXTURE)
        self.assertEqual(payload["format"], "ascii")
        self.assertEqual(payload["source_size_bytes"], FIXTURE.stat().st_size)
        self.assertEqual(payload["triangle_count"], 1)
        self.assertEqual(
            payload["positions"],
            [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]],
        )
        self.assertEqual(payload["faces"], [[0, 1, 2]])

    def test_ascii_triangle_is_preserved_as_triangle_soup(self):
        payload = parse_stl_bytes(ASCII_TRIANGLE)
        self.assertEqual(payload["format"], "ascii")
        self.assertEqual(payload["triangle_count"], 1)
        self.assertEqual(payload["positions"], [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        self.assertEqual(payload["faces"], [[0, 1, 2]])
        self.assertEqual(len(payload["source_sha256"]), 64)

    def test_binary_triangle_preserves_float32_vertices(self):
        data = binary_stl(((0.125, -2.5, 3.0), (4.0, 5.0, 6.0), (-7.0, 8.0, 9.0)))
        payload = parse_stl_bytes(data)
        self.assertEqual(payload["format"], "binary")
        self.assertEqual(payload["positions"][0], [0.125, -2.5, 3.0])
        self.assertEqual(payload["faces"], [[0, 1, 2]])

    def test_nonfinite_binary_coordinates_are_rejected(self):
        with self.assertRaisesRegex(StlPayloadError, "non-finite"):
            parse_stl_bytes(binary_stl(((math.nan, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0))))

    def test_malformed_binary_count_does_not_read_past_the_payload(self):
        malformed = bytearray(binary_stl(((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0))))
        struct.pack_into("<I", malformed, 80, 2)
        with self.assertRaisesRegex(StlPayloadError, "neither a size-consistent binary"):
            parse_stl_bytes(bytes(malformed))

    def test_oversized_input_is_rejected_before_parsing(self):
        with self.assertRaisesRegex(StlPayloadError, "limit"):
            parse_stl_bytes(b"x" * (MAX_STL_BYTES + 1))


if __name__ == "__main__":
    unittest.main()
