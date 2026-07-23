import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const metadataPath = path.resolve(process.argv[2] ?? "public/dojo/chrome-assets/shader-metadata.json");
const outputPath = path.resolve(process.argv[3] ?? "public/materialx/ui-normal-band-prototype.mtlx");
const reportPath = path.resolve(process.argv[4] ?? "public/materialx/ui-normal-band.report.json");
const sourceText = fs.readFileSync(metadataPath, "utf8");
const metadata = JSON.parse(sourceText);

const socketValue = (node, identifier) => node?.inputs?.find(
  (socket) => socket.identifier === identifier || socket.name === identifier,
)?.value;

function topology(materialName, tree) {
  const nodes = tree.nodes ?? [];
  const links = tree.links ?? [];
  const node = (name) => nodes.find((candidate) => candidate.name === name);
  const output = nodes.find((candidate) => candidate.type === "ShaderNodeOutputMaterial" && candidate.props?.is_active_output);
  const surface = links.find((link) => link.to_node === output?.name && link.to_socket === "Surface");
  const mix = node(surface?.from_node);
  if (surface?.from_type !== "NodeSocketColor" || mix?.type !== "ShaderNodeMix" || mix.props?.data_type !== "RGBA") return null;
  const rampLink = links.find((link) => link.to_node === mix.name && link.to_socket === "A_Color");
  const colorLink = links.find((link) => link.to_node === mix.name && link.to_socket === "B_Color");
  const ramp = node(rampLink?.from_node);
  const attribute = node(colorLink?.from_node);
  const mappingLink = links.find((link) => link.to_node === ramp?.name && link.to_socket === "Fac");
  const mapping = node(mappingLink?.from_node);
  const normalLink = links.find((link) => link.to_node === mapping?.name && link.to_socket === "Vector");
  const texcoord = node(normalLink?.from_node);
  const elements = ramp?.props?.color_ramp?.elements;
  const rotation = socketValue(mapping, "Rotation");
  const factor = Number(socketValue(mix, "Factor_Float"));
  const property = attribute?.props?.attribute_name;
  if (ramp?.type !== "ShaderNodeValToRGB" || ramp.props?.color_ramp?.interpolation !== "CONSTANT"
    || attribute?.type !== "ShaderNodeAttribute" || !/^[A-Za-z_]\w*$/.test(property)
    || mapping?.type !== "ShaderNodeMapping" || texcoord?.type !== "ShaderNodeTexCoord"
    || normalLink?.from_socket !== "Normal" || !Array.isArray(elements) || elements.length < 2
    || !Array.isArray(rotation) || rotation.length !== 3 || !rotation.every(Number.isFinite)
    || !Number.isFinite(factor)) return null;

  const active = new Set([output.name]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      if (active.has(link.to_node) && !active.has(link.from_node)) {
        active.add(link.from_node);
        changed = true;
      }
    }
  }
  return {
    materialName,
    nodeTypes: [...active].map((name) => node(name)?.type).filter(Boolean).sort(),
    property,
    rotation,
    factor,
    ramp: elements.map((element) => ({
      position: Number(element.position),
      color: element.color.slice(0, 3).map(Number),
    })),
    disconnectedNodeTypes: nodes.filter((candidate) => !active.has(candidate.name)).map((candidate) => candidate.type).sort(),
  };
}

const matches = Object.entries(metadata.materials ?? {})
  .map(([name, tree]) => topology(name, tree))
  .filter(Boolean);
if (matches.length !== 1) throw new Error(`Expected one normal-band/color-property topology, found ${matches.length}`);
const match = matches[0];
const number = (value) => Number(value).toPrecision(12).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1");
const vector = (values) => values.map(number).join(", ");
// MaterialX's official GLSL rotate3d implementation uses the opposite signed
// matrix convention from Blender's Mapping node for column-vector evaluation.
// Negating each axis is a node-semantic lowering, independent of material name.
const degrees = match.rotation.map((value) => -value * 180 / Math.PI);

const bandNodes = match.ramp.slice(1).map((entry, index) => `
    <ifgreatereq name="normal_band_${index + 1}" type="color3">
      <input name="value1" type="float" nodename="normal_band_factor" />
      <input name="value2" type="float" value="${number(entry.position)}" />
      <input name="in1" type="color3" value="${vector(entry.color)}" />
      <input name="in2" type="color3" ${index ? `nodename="normal_band_${index}"` : `value="${vector(match.ramp[0].color)}"`} />
    </ifgreatereq>`).join("");
const lastBand = `normal_band_${match.ramp.length - 1}`;
const xml = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <!-- Generated from a topology match in portable Blender shader metadata.
       The standard_surface emission wrapper is an explicit diagnostic
       substitute for Blender's non-portable color-to-Surface coercion. -->
  <nodegraph name="NG_ui_normal_band">
    <normal name="object_normal" type="vector3" space="object" />
    <rotate3d name="normal_rotate_x" type="vector3">
      <input name="in" type="vector3" nodename="object_normal" />
      <input name="amount" type="float" value="${number(degrees[0])}" />
      <input name="axis" type="vector3" value="1, 0, 0" />
    </rotate3d>
    <rotate3d name="normal_rotate_y" type="vector3">
      <input name="in" type="vector3" nodename="normal_rotate_x" />
      <input name="amount" type="float" value="${number(degrees[1])}" />
      <input name="axis" type="vector3" value="0, 1, 0" />
    </rotate3d>
    <rotate3d name="normal_rotate_z" type="vector3">
      <input name="in" type="vector3" nodename="normal_rotate_y" />
      <input name="amount" type="float" value="${number(degrees[2])}" />
      <input name="axis" type="vector3" value="0, 0, 1" />
    </rotate3d>
    <dotproduct name="normal_band_factor" type="float">
      <input name="in1" type="vector3" nodename="normal_rotate_z" />
      <input name="in2" type="vector3" value="0.333333333333, 0.333333333333, 0.333333333333" />
    </dotproduct>${bandNodes}
    <geompropvalue name="geometry_color" type="color3">
      <input name="geomprop" type="string" value="${match.property}" />
      <input name="default" type="color3" value="0, 0, 0" />
    </geompropvalue>
    <mix name="band_color_mix" type="color3">
      <input name="bg" type="color3" nodename="${lastBand}" />
      <input name="fg" type="color3" nodename="geometry_color" />
      <input name="mix" type="float" value="${number(match.factor)}" />
    </mix>
    <output name="color" type="color3" nodename="band_color_mix" />
  </nodegraph>
  <standard_surface name="SS_ui_normal_band_diagnostic" type="surfaceshader">
    <input name="base" type="float" value="0" />
    <input name="specular" type="float" value="0" />
    <input name="emission" type="float" value="1" />
    <input name="emission_color" type="color3" nodegraph="NG_ui_normal_band" output="color" />
  </standard_surface>
  <surfacematerial name="UiNormalBandSemanticRecovery" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SS_ui_normal_band_diagnostic" />
  </surfacematerial>
</materialx>
`;

const report = {
  schemaVersion: 1,
  source: {
    metadata: path.relative(process.cwd(), metadataPath),
    sha256: crypto.createHash("sha256").update(sourceText).digest("hex"),
    blenderVersion: metadata.blender_version,
    discoveredMaterial: match.materialName,
    discovery: "unique active Normal -> Mapping -> CONSTANT ColorRamp mixed with a named color property",
    sourceBlendAvailable: false,
  },
  activeGraph: {
    nodeTypes: match.nodeTypes,
    disconnectedNodeTypes: match.disconnectedNodeTypes,
    geometryProperties: [{ name: match.property, type: "color3", domain: "point", required: true }],
  },
  diagnosticLowering: {
    coordinateFixture: "identity-transformed probe makes object and world normals equivalent for this diagnostic",
    rotationRadians: match.rotation,
    esslRotationDegrees: degrees,
    rotationConvention: "Blender Mapping XYZ radians lowered to official ESSL rotate3d by negating each axis amount",
    constantRamp: match.ramp,
    mixFactor: match.factor,
    materialX: path.relative(process.cwd(), outputPath),
    portableNodes: ["normal", "rotate3d", "dotproduct", "ifgreatereq", "geompropvalue", "mix", "standard_surface"],
  },
  capability: {
    supportedSemantics: [
      "normal-coordinate branch on an identity-transformed probe",
      "XYZ Euler Mapping rotation",
      "CONSTANT color ramp",
      `typed point geometry property ${match.property}:color3`,
      "RGBA MIX factor",
    ],
    substitutedSemantics: [
      {
        kind: "texture-coordinate-normal-space",
        source: "ShaderNodeTexCoord.Normal (Blender native USD export declares world space)",
        diagnosticSubstitute: "object-space normal on an identity-transformed probe",
        reason: "The official standalone ESSL graph path did not preserve the requested world-space normal; transformed-geometry parity remains gated",
      },
      {
        kind: "surface-coercion",
        source: "NodeSocketColor -> ShaderNodeOutputMaterial.Surface",
        diagnosticSubstitute: "standard_surface emission",
        reason: "Blender's implicit color-to-surface coercion has no portable MaterialX source NodeDef in the extracted metadata",
      },
    ],
    extractionBlockers: ["The source .blend is not supplied, so Blender native USD/MaterialX export cannot be audited"],
    parityReady: false,
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, xml);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`MATERIALX_UI_NORMAL_BAND ${match.materialName} -> ${outputPath}`);
console.log(`MATERIALX_UI_CAPABILITY ${reportPath}`);
