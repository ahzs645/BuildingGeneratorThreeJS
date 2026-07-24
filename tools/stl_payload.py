"""Strict, bounded STL parsing for portable Geometry Nodes extraction.

The parser deliberately produces triangle soup: STL has no authored topology
beyond its facets, so vertices are not welded or otherwise inferred here.
"""

import hashlib
import math
import os
import struct


MAX_STL_BYTES = 32 * 1024 * 1024
MAX_STL_TRIANGLES = 200_000


class StlPayloadError(ValueError):
    """An STL cannot be embedded without crossing the portable safety boundary."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _finite_triplet(values, context):
    if len(values) != 3:
        raise StlPayloadError("STL_MALFORMED", f"{context} must contain three coordinates")
    try:
        result = [float(value) for value in values]
    except (TypeError, ValueError) as error:
        raise StlPayloadError("STL_MALFORMED", f"{context} contains an invalid number") from error
    if not all(math.isfinite(value) for value in result):
        raise StlPayloadError("STL_NONFINITE", f"{context} contains a non-finite number")
    return result


def _payload(data, stl_format, triangles):
    if len(triangles) > MAX_STL_TRIANGLES:
        raise StlPayloadError(
            "STL_TRIANGLE_LIMIT",
            f"STL contains {len(triangles)} triangles; limit is {MAX_STL_TRIANGLES}",
        )
    positions = []
    faces = []
    for triangle in triangles:
        start = len(positions)
        positions.extend(triangle)
        faces.append([start, start + 1, start + 2])
    return {
        "version": 1,
        "format": stl_format,
        "source_size_bytes": len(data),
        "source_sha256": hashlib.sha256(data).hexdigest(),
        "triangle_count": len(triangles),
        "positions": positions,
        "faces": faces,
    }


def _parse_binary(data):
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    expected_size = 84 + triangle_count * 50
    # ASCII files longer than 84 bytes have arbitrary text in the binary count
    # slot. Only apply binary-specific limits after the byte count proves that
    # this is structurally a binary STL.
    if expected_size != len(data):
        return None
    if triangle_count > MAX_STL_TRIANGLES:
        raise StlPayloadError(
            "STL_TRIANGLE_LIMIT",
            f"binary STL declares {triangle_count} triangles; limit is {MAX_STL_TRIANGLES}",
        )
    triangles = []
    for triangle_index in range(triangle_count):
        offset = 84 + triangle_index * 50
        # Validate the stored normal as well as vertices. The runtime does not
        # retain facet normals, but accepting NaN metadata would make the source
        # payload non-deterministic across readers.
        _finite_triplet(struct.unpack_from("<3f", data, offset), f"triangle {triangle_index} normal")
        vertices = [
            _finite_triplet(
                struct.unpack_from("<3f", data, offset + 12 + vertex_index * 12),
                f"triangle {triangle_index} vertex {vertex_index}",
            )
            for vertex_index in range(3)
        ]
        triangles.append(vertices)
    return _payload(data, "binary", triangles)


def _parse_ascii(data):
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError as error:
        raise StlPayloadError(
            "STL_MALFORMED",
            "STL is neither a size-consistent binary file nor strict ASCII",
        ) from error

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or lines[0].split(maxsplit=1)[0].lower() != "solid":
        raise StlPayloadError("STL_MALFORMED", "ASCII STL must begin with solid")

    triangles = []
    index = 0
    in_solid = False
    while index < len(lines):
        tokens = lines[index].split()
        keyword = tokens[0].lower()
        if keyword == "solid":
            if in_solid:
                raise StlPayloadError("STL_MALFORMED", f"nested solid at line {index + 1}")
            in_solid = True
            index += 1
            continue
        if keyword == "endsolid":
            if not in_solid:
                raise StlPayloadError("STL_MALFORMED", f"endsolid without solid at line {index + 1}")
            in_solid = False
            index += 1
            continue
        if keyword != "facet" or len(tokens) != 5 or tokens[1].lower() != "normal":
            raise StlPayloadError("STL_MALFORMED", f"expected facet normal at line {index + 1}")
        if not in_solid:
            raise StlPayloadError("STL_MALFORMED", f"facet outside solid at line {index + 1}")
        _finite_triplet(tokens[2:], f"line {index + 1} normal")
        if len(triangles) >= MAX_STL_TRIANGLES:
            raise StlPayloadError(
                "STL_TRIANGLE_LIMIT",
                f"ASCII STL exceeds the {MAX_STL_TRIANGLES} triangle limit",
            )
        if index + 6 >= len(lines):
            raise StlPayloadError("STL_MALFORMED", f"incomplete facet at line {index + 1}")
        if [part.lower() for part in lines[index + 1].split()] != ["outer", "loop"]:
            raise StlPayloadError("STL_MALFORMED", f"expected outer loop at line {index + 2}")
        vertices = []
        for vertex_offset in range(3):
            vertex_tokens = lines[index + 2 + vertex_offset].split()
            if len(vertex_tokens) != 4 or vertex_tokens[0].lower() != "vertex":
                raise StlPayloadError(
                    "STL_MALFORMED",
                    f"expected vertex at line {index + 3 + vertex_offset}",
                )
            vertices.append(_finite_triplet(
                vertex_tokens[1:],
                f"line {index + 3 + vertex_offset} vertex",
            ))
        if [part.lower() for part in lines[index + 5].split()] != ["endloop"]:
            raise StlPayloadError("STL_MALFORMED", f"expected endloop at line {index + 6}")
        if [part.lower() for part in lines[index + 6].split()] != ["endfacet"]:
            raise StlPayloadError("STL_MALFORMED", f"expected endfacet at line {index + 7}")
        triangles.append(vertices)
        index += 7

    if in_solid:
        raise StlPayloadError("STL_MALFORMED", "ASCII STL is missing endsolid")
    return _payload(data, "ascii", triangles)


def parse_stl_bytes(data):
    """Parse an in-memory STL without guessing malformed binary payloads."""
    if not isinstance(data, bytes):
        raise TypeError("STL payload must be bytes")
    if len(data) > MAX_STL_BYTES:
        raise StlPayloadError(
            "STL_SIZE_LIMIT",
            f"STL is {len(data)} bytes; limit is {MAX_STL_BYTES}",
        )
    if len(data) >= 84:
        binary = _parse_binary(data)
        if binary is not None:
            return binary
    return _parse_ascii(data)


def load_stl_payload(path):
    """Read and parse one regular file with bounds checked before allocation."""
    if not os.path.isfile(path):
        raise StlPayloadError("STL_UNAVAILABLE", "STL path is not a regular file")
    size = os.path.getsize(path)
    if size > MAX_STL_BYTES:
        raise StlPayloadError(
            "STL_SIZE_LIMIT",
            f"STL is {size} bytes; limit is {MAX_STL_BYTES}",
        )
    with open(path, "rb") as stl_file:
        data = stl_file.read(MAX_STL_BYTES + 1)
    if len(data) != size:
        raise StlPayloadError("STL_CHANGED_DURING_READ", "STL changed while it was being read")
    return parse_stl_bytes(data)
