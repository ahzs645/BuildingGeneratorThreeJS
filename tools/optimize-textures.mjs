/**
 * Re-encodes the building kit's facade maps from PNG to WebP and packs the
 * single-channel roughness/metalness pairs into one ORM texture.
 *
 *   node tools/optimize-textures.mjs [--size 2048] [--out public/textures]
 *
 * Two separate wins:
 *   - WebP roughly halves the transfer at full resolution; --size halves it again
 *     per step down, and cuts GPU memory quadratically (a 2048² RGBA map costs
 *     ~22 MB of VRAM with mipmaps, a 1024² one ~5.6 MB).
 *   - Roughness and metalness are single-channel data stored in RGB PNGs. glTF's
 *     ORM convention packs them into one texture (G = roughness, B = metalness),
 *     which is exactly what three.js samples, so one request feeds both maps.
 *
 * Colour management is deliberately bypassed for the data maps: normal, roughness
 * and metalness carry numbers, not colour, so an ICC transform would corrupt them.
 * Verify with `--verify`, which decodes both sides and compares channel means.
 */
import sharp from "sharp";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

/** Authoring PNGs, kept out of public/ so Vite never ships them alongside the WebP. */
const SOURCE_DIR = "procedural-hong-kong-building/source/textures";

/** sRGB colour maps: lossy WebP at a quality that leaves no visible banding. */
const COLOUR_MAPS = [
  "Material_Base_color",
  "Material_Emissive",
  "floor_Base_color",
  "floor_Base_Emissive",
];

/**
 * Data maps. Normals get a higher quality than colour: they feed a lighting
 * calculation, so chroma error there shows up as shading noise across the facade.
 */
const DATA_MAPS = [
  { name: "Material_Normal_OpenGL", quality: 95 },
  { name: "floor_Normal_OpenGL", quality: 95 },
  { name: "floor_alpha", quality: 95 },
];

/** roughness → G, metalness → B, matching glTF's occlusion-roughness-metalness packing. */
const ORM_MAPS = [
  { out: "Material_ORM", roughness: "Material_Roughness", metalness: "Material_Metallic" },
  { out: "floor_ORM", roughness: "floor_Roughness", metalness: "floor_Metallic" },
];

function parseArgs(argv) {
  const args = { size: 2048, out: "public/textures", verify: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--size") args.size = Number(argv[++i]);
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--verify") args.verify = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.size) || args.size < 1) {
    throw new Error(`--size must be a positive integer, got ${args.size}`);
  }
  return args;
}

/** Raw single channel at the target size, with no colour transform applied. */
async function channel(name, size, index = 0) {
  const { data, info } = await sharp(path.join(SOURCE_DIR, `${name}.png`))
    .resize(size, size, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(size * size);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels + index];
  return out;
}

async function writeOrm({ out, roughness, metalness }, size, outDir) {
  const [rough, metal] = await Promise.all([channel(roughness, size), channel(metalness, size)]);
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = 255;          // no baked occlusion — neutral so an aoMap read stays a no-op
    rgb[i * 3 + 1] = rough[i];
    rgb[i * 3 + 2] = metal[i];
  }
  const file = path.join(outDir, `${out}.webp`);
  // 90 rather than the normals' 95: fine roughness detail is expensive to encode
  // losslessly (at 95 the packed map came out larger than the two source PNGs)
  // and a roughness error of a few 1/255 is imperceptible, unlike a normal error.
  await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
    .webp({ quality: 90 })
    .toFile(file);
  return file;
}

async function reportSize(label, file, sources) {
  const after = (await stat(file)).size;
  let before = 0;
  for (const source of sources) before += (await stat(path.join(SOURCE_DIR, `${source}.png`))).size;
  const kb = (n) => `${Math.round(n / 1024)}k`;
  console.log(
    `${label.padEnd(26)} ${kb(before).padStart(6)} -> ${kb(after).padStart(6)}` +
    `  (${Math.round((1 - after / before) * 100)}% smaller)`,
  );
  return { before, after };
}

/** Decoded channel means, to prove re-encoding did not shift the data maps. */
async function verify(name, file, size) {
  const original = await sharp(path.join(SOURCE_DIR, `${name}.png`)).resize(size, size, { fit: "fill" }).stats();
  const encoded = await sharp(file).stats();
  const drift = original.channels.slice(0, 3).map((c, i) => {
    const other = encoded.channels[i];
    return other ? Math.abs(c.mean - other.mean) : 0;
  });
  const worst = Math.max(...drift);
  console.log(`  verify ${name.padEnd(24)} max channel-mean drift ${worst.toFixed(3)} / 255`);
  return worst;
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
console.log(`encoding at ${args.size}x${args.size} into ${args.out}\n`);

let before = 0;
let after = 0;
const drifts = [];

for (const name of COLOUR_MAPS) {
  const file = path.join(args.out, `${name}.webp`);
  await sharp(path.join(SOURCE_DIR, `${name}.png`))
    .resize(args.size, args.size, { fit: "fill" })
    .webp({ quality: 90 })
    .toFile(file);
  const sizes = await reportSize(name, file, [name]);
  before += sizes.before; after += sizes.after;
}

for (const { name, quality } of DATA_MAPS) {
  const file = path.join(args.out, `${name}.webp`);
  await sharp(path.join(SOURCE_DIR, `${name}.png`))
    .resize(args.size, args.size, { fit: "fill" })
    .webp({ quality })
    .toFile(file);
  const sizes = await reportSize(name, file, [name]);
  before += sizes.before; after += sizes.after;
  if (args.verify) drifts.push(await verify(name, file, args.size));
}

for (const orm of ORM_MAPS) {
  const file = await writeOrm(orm, args.size, args.out);
  const sizes = await reportSize(`${orm.out} (packed)`, file, [orm.roughness, orm.metalness]);
  before += sizes.before; after += sizes.after;
}

const kb = (n) => `${Math.round(n / 1024)}k`;
console.log(`\nTOTAL ${kb(before)} -> ${kb(after)}  (${Math.round((1 - after / before) * 100)}% smaller)`);
if (drifts.length) {
  const worst = Math.max(...drifts);
  console.log(`worst data-map drift: ${worst.toFixed(3)} / 255`);
  if (worst > 2) {
    console.error("data map drifted more than 2/255 — colour management is interfering");
    process.exit(1);
  }
}
