# Client-side `.blend` decoder

## What this is

`src/blend` reads a `.blend` file in the browser and produces the same portable
node dump `tools/dump_blend.py` produces from inside Blender. No server, no
local Blender install, no upload.

```text
.blend bytes
  -> src/blend/decompress.ts   zstd / gzip / raw envelope
  -> src/blend/blend-file.ts   file header, block table, pointer resolution
  -> src/blend/sdna.ts         the file's own DNA struct catalogue
  -> src/blend/to-dump.ts      bNodeTree / Object / Material -> portable dump
  -> src/gnvm                  the existing browser Geometry Nodes runtime
```

The previous boundary is unchanged and still authoritative: when the local
Blender service is reachable, `BlendBridgePage` keeps using it, because Blender
extracts strictly more (base meshes, evaluated matrices, node properties, packed
images, font outlines). The browser decoder is what runs when Blender is not
there — on the static deploy, or on any machine without it.

## How a `.blend` is read

A Blender file is self-describing: it carries the exact C layout of every struct
it was written with in its `DNA1` block. That is what lets a decoder that was
never compiled against Blender 5.1 read a Blender 5.1 file.

**Envelope.** Files may be raw, gzip (older Blender), or zstd (3.0+). Blender
writes zstd as a *seekable* stream — several independent frames plus a trailing
skippable frame holding the seek table — so the decoder needs a reader that
walks concatenated frames. `fzstd` does; the one-shot decoders in Node and the
platform do not (Node's `zlib.zstdDecompress` returns only the first frame).

**Header.** Two layouts exist, and the second is new enough to be worth stating:

| | classic | Blender 5.0+ |
|---|---|---|
| bytes | `BLENDER` + ptr + endian + 3 digits | `BLENDER` + 2 size digits + ptr + 2 format digits + endian + 4 digits |
| example | `BLENDER-v403` | `BLENDER17-01v0500` |
| block record | 20 B (32-bit) / 24 B (64-bit) | 32 B: `code`, `SDNAnr`, then 64-bit `old`, `len`, `nr` |

The 64-bit block fields are what let a single block exceed 4 GB. Both layouts
are implemented and tested; `parseBlendHeader` picks by looking for digits where
the classic header keeps its pointer marker.

**Structs.** Blender pads its structs explicitly with `_pad` members, so DNA
fields are contiguous — a member's offset is the sum of the preceding member
sizes. Pointers resolve through a sorted table of block addresses, including
pointers that land *inside* a block, which is how `ListBase` arrays and interior
references work. A pointer's concrete type comes from the block record rather
than the declaration, so `ModifierData *` reads back as the `NodesModifierData`
that was actually written. `BlendStruct.field` also follows Blender's
struct-inheritance idiom (a derived struct embeds its base as the first member),
which is what makes `modifier.name`, `modifier.type`, and the `next` pointer of
a modifier list work at all.

## What it produces

`objects` (name, type, transforms, visibility, material slots, mesh statistics),
`collections`, `node_groups`, `shader_node_groups`, `materials`, `images`, and
for every tree: `nodes` with their sockets and unlinked values, `links` with
endpoint identifiers and multi-input ordering, and the full `interface` tree
including panels, defaults, ranges, and subtypes. Geometry Nodes modifiers carry
`input_values` bound identifier-first with the friendly-name aliases the
extractor also emits, including attribute bindings and datablock references.

## How it is verified

Blender stays the reference. `tools/blend-parity.ts` runs `tools/dump_blend.py`
under real Blender on a corpus, decodes the same files in TypeScript, and
compares every structural field, reporting differences grouped by field path.

```bash
npm run blend:parity -- "/path/to/blend/corpus" --cache .blend-parity-cache
```

Integers that Blender only documents in C headers — flag bits, display shapes,
property subtypes — are not remembered or guessed. `tools/blend-calibrate-enums.ts`
pairs each raw DNA value with the identifier Blender reported for the same
socket, node, or interface item and solves for the mapping, printing anything
ambiguous or unseen. `src/blend/enums.ts` records the result and marks which
entries are calibrated.

```bash
npm run blend:calibrate -- .blend-parity-cache "/path/to/blend/corpus"
```

`tools/blend-introspect.ts` prints the struct catalogue of any file, which is
how the layouts above were established rather than assumed.

### Measured result

Against the full 47-file Node Dojo `.blend` corpus (Blender 5.0 files, reference
dumps produced by Blender 5.1.2):

```text
compared 2,616,779 fields across 47 files
71,853 explained differences · 0 unexplained
```

Every difference falls into a declared gap or one of the two intentional
differences below; the harness exits non-zero if any field disagrees for a
reason that is not on that list. Names, identifiers, socket types, linked state,
enabled/hide/hide-value flags, mute, custom colour, frame parents, link
endpoints and multi-input ordering, the whole interface tree with defaults,
ranges and subtypes, object types, transforms, matrices, material slots and mesh
statistics, and every Geometry Nodes modifier binding match exactly.

Two scoping notes, because a comparison that quietly skips work is not parity:

- 1,080 sockets (0.04%) belong to nodes whose socket count Blender changed while
  loading the file. Positional pairing is meaningless there, so the harness
  reports them as `socket.not_compared` rather than passing them silently.
- The corpus is Blender 5.0 files read by Blender 5.1.2, which is what exercises
  `VERSION_UPGRADE_NOT_APPLIED` at all. Reference dumps taken with the same
  Blender that wrote the files would not produce those categories.

`SOCK_UNAVAIL` is worth one specific note. Compared directly by socket
identifier across the corpus, bit 3 reproduces Blender's `enabled` on 178,205
sockets and disagrees on 104 — every one of them on a node that Blender's
version upgrade had already restructured.

## Declared gaps

The decoder reports what it cannot supply instead of approximating it. Every
gap arrives as a `PortableGap` on the decode result and is shown in the studio's
import panel.

| code | why Blender is required |
|---|---|
| `NODE_PROPERTIES_NOT_DECODED` | Node enum/mode/data-type properties are untagged integers in `custom1/custom2` and storage structs. Mapping them to RNA identifiers needs a Blender-derived table per node type. |
| `MENU_SOCKET_VALUE_UNRESOLVED` | Menu socket defaults are integers whose enum items the node defines at runtime. |
| `BASE_MESH_NOT_EMBEDDED` | Vertex, edge, face, and attribute payloads are not extracted; `mesh_stats` counts are. |
| `STL_PAYLOAD_NOT_EMBEDDED` | Import STL reads a path on the authoring machine. |
| `FONT_OUTLINES_NOT_EMBEDDED` | String to Curves needs Blender-evaluated vector-font outlines. |
| `IMAGE_PIXELS_NOT_EMBEDDED` | Packed and external image pixels are not decoded. |
| `WORLD_MATRIX_RECOMPOSED` | Matrices are recomposed from stored transforms and parent chains, not read from an evaluated depsgraph. |
| `TREE_ANIMATION_NOT_DECODED` | Animated node values (F-curves, drivers) are not decoded. |
| `VERSION_UPGRADE_NOT_APPLIED` | Opening an older file in a newer Blender runs version-upgrade passes that can add nodes and sockets. The decoder reads the file as authored and reports the authoring build. |
| `SOCKET_DISPLAY_SHAPE_INFERRED` | Blender recomputes socket shapes from its field/structure inference pass, so stored shapes are a hint. |
| `HOOK_MODIFIER_PAYLOAD_PARTIAL` | Hook vertex indices and falloff are not decoded. |
| `LINKED_LIBRARY_NOT_RESOLVED` | A linked datablock's contents live in another `.blend`; this file stores only the reference. |

Two differences from Blender's dump are intentional rather than gaps:

- `link.to_idx` — Blender 5.x no longer exposes `NodeSocket.index` through RNA,
  so its extractor writes `null`. The decoder writes the real index.
- Unregistered node types — Blender reports `NodeUndefined` for a node whose
  add-on is missing; the decoder reports the `idname` the file stores.

## Consequences worth knowing

A dump from this decoder is a complete, browsable, editable **graph**. It is not
yet an evaluable program for every file, because GN-VM node handlers read
properties such as `operation` and `data_type` that live behind
`NODE_PROPERTIES_NOT_DECODED`. Closing that gap is the natural next step: build
a calibrated node-property table the same way `blend-calibrate-enums.ts` builds
the flag and subtype tables, so the mapping is evidence rather than memory.
