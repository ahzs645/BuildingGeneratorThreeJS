/**
 * Loads the exported asset kit (public/assets/kit.glb + kit_manifest.json) and
 * renders placement lists as InstancedMeshes (one per unique mesh in each part).
 *
 * Materials are built from scratch from the source texture files — the GLB-embedded
 * materials come through as alpha-blended (depth-sorting breaks at grazing angles),
 * so they are replaced wholesale by name: building / floor / glass.
 */
import {
  BatchedMesh, Group, Matrix4, Mesh, Object3D, DoubleSide, Color,
  BufferAttribute, BufferGeometry,
  MeshStandardMaterial, MeshPhysicalMaterial, Material, Texture, TextureLoader,
  SRGBColorSpace, NoColorSpace, RepeatWrapping,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { publicUrl } from "./base-url";
import type { Placement } from "./generator";

function tex(loader: TextureLoader, url: string, srgb = false): Texture {
  const t = loader.load(url);
  t.flipY = false; // glTF UV convention
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

function buildMaterials(): Record<string, Material> {
  const loader = new TextureLoader();
  // Roughness and metalness ship as one ORM map per material (tools/optimize-textures.mjs):
  // three samples roughness from .g and metalness from .b, so the same texture
  // feeds both slots and the pair costs one request instead of two.
  const buildingOrm = tex(loader, publicUrl("textures/Material_ORM.webp"));
  const floorOrm = tex(loader, publicUrl("textures/floor_ORM.webp"));
  const building = new MeshStandardMaterial({
    name: "building",
    map: tex(loader, publicUrl("textures/Material_Base_color.webp"), true),
    normalMap: tex(loader, publicUrl("textures/Material_Normal_OpenGL.webp")),
    roughnessMap: buildingOrm,
    roughness: 1,
    metalnessMap: buildingOrm,
    metalness: 1,
    emissiveMap: tex(loader, publicUrl("textures/Material_Emissive.webp"), true),
    emissive: new Color(0xffffff),
    emissiveIntensity: 1.4,
    side: DoubleSide,
  });
  const floor = new MeshStandardMaterial({
    name: "floor",
    map: tex(loader, publicUrl("textures/floor_Base_color.webp"), true),
    normalMap: tex(loader, publicUrl("textures/floor_Normal_OpenGL.webp")),
    roughnessMap: floorOrm,
    roughness: 1,
    metalnessMap: floorOrm,
    metalness: 1,
    emissiveMap: tex(loader, publicUrl("textures/floor_Base_Emissive.webp"), true),
    emissive: new Color(0xffffff),
    emissiveIntensity: 1, // driven by the "emissive" slider in building settings (1–50)
    alphaMap: tex(loader, publicUrl("textures/floor_alpha.webp")),
    alphaTest: 0.5, // cutout — no blend-sorting artifacts
    side: DoubleSide,
  });
  const glass = new MeshPhysicalMaterial({
    name: "glass",
    color: 0x9fb8c4,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: DoubleSide,
  });
  return { building, floor, glass };
}

interface ManifestCollection {
  children?: { index: number; kind: string; name: string }[];
  missing?: boolean;
}
interface Manifest {
  collections: Record<string, ManifestCollection>;
  objects: Record<string, unknown>;
}

const MIRROR_X = new Matrix4().makeScale(-1, 1, 1);

export class Kit {
  private parts = new Map<string, Object3D>();
  private manifest!: Manifest;
  private warned = new Set<string>();
  private mirrorCache = new Map<BufferGeometry, BufferGeometry>();
  /** dry (non-wet) clones of building/floor for interior parts — main.ts injects the
   *  rain wet shader into building/floor, and interiors (ROOMS/storeinside) must stay dry */
  private dryMaterials = new Map<Material, Material>();
  /** the from-scratch materials (building / floor / glass), set during load() */
  materials!: Record<string, Material>;
  /** when set, buildGroup adds a snow-shell pass (child group "snowShell") that
   *  shares geometry + instanceMatrix with the opaque meshes — zero extra memory */
  snowShellMaterial: Material | null = null;

  /**
   * Geometry with the X-mirror baked in (negated positions/normals/tangents,
   * reversed winding). Needed because InstancedMesh transforms normals with the
   * plain instance matrix: a reflection (negative determinant) flips winding, and
   * with DoubleSide the shader then negates the normal for "back" faces — so every
   * mirrored instance would be lit with inverted normals. Baking the mirror into
   * the geometry and cancelling it in the matrix keeps every determinant positive.
   */
  private mirroredGeometry(src: BufferGeometry): BufferGeometry {
    let g = this.mirrorCache.get(src);
    if (g) return g;
    g = src.clone();
    for (const name of ["position", "normal", "tangent"]) {
      const attr = g.getAttribute(name) as BufferAttribute | undefined;
      if (!attr) continue;
      for (let i = 0; i < attr.count; i++) attr.setX(i, -attr.getX(i));
      if (name === "tangent" && attr.itemSize === 4) {
        for (let i = 0; i < attr.count; i++) attr.setW(i, -attr.getW(i));
      }
      attr.needsUpdate = true;
    }
    if (!g.index) {
      const n = g.getAttribute("position").count;
      const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) arr[i] = i;
      g.setIndex(new BufferAttribute(arr, 1));
    }
    const idx = g.index!;
    for (let i = 0; i + 2 < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
    g.computeBoundingSphere();
    this.mirrorCache.set(src, g);
    return g;
  }

  count(collection: string): number {
    const c = this.manifest.collections[collection];
    return c?.children?.length || 1;
  }

  /** Set the floor emissive intensity on BOTH the exterior floor material and its
   *  dry interior clone, so glowing rooms/storeinside track the "emissive" slider
   *  (they render with the dry clone to stay out of the rain wetness). */
  setFloorEmissive(v: number): void {
    const floor = this.materials?.floor as MeshStandardMaterial | undefined;
    if (floor) floor.emissiveIntensity = v;
    const dry = floor && (this.dryMaterials.get(floor) as MeshStandardMaterial | undefined);
    if (dry) dry.emissiveIntensity = v;
  }

  async load(glbUrl: string, manifestUrl: string): Promise<void> {
    // Build the materials BEFORE awaiting the kit. TextureLoader.load() returns a
    // Texture synchronously and starts its request immediately, so the ~13MB of
    // facade maps download alongside the GLB instead of waiting for it to finish
    // downloading and parsing first.
    const materials = buildMaterials();
    this.materials = materials;
    // dry clones for interior parts — cloned now (before main.ts injects the wet
    // shader into building/floor), so they never pick up the rain wetness
    this.dryMaterials.set(materials.building, materials.building.clone());
    this.dryMaterials.set(materials.floor, materials.floor.clone());

    const [gltf, manifest] = await Promise.all([
      new GLTFLoader().loadAsync(glbUrl),
      fetch(manifestUrl).then(r => r.json() as Promise<Manifest>),
    ]);
    this.manifest = manifest;
    // GLTFLoader sanitizes Object3D names (strips [ ] . and spaces) — recover the
    // original glTF node names through the parser associations
    const json = gltf.parser.json as { nodes?: { name?: string }[] };
    const assoc = gltf.parser.associations as Map<Object3D, { nodes?: number }>;
    for (const child of [...gltf.scene.children]) {
      const a = assoc.get(child);
      const original = a?.nodes !== undefined ? json.nodes?.[a.nodes]?.name : undefined;
      this.parts.set(original ?? child.name, child);
      child.updateMatrixWorld(true);
    }
    // replace GLB-embedded materials with the from-scratch ones (matched by name;
    // Blender exports "building", "floor", "glass")
    const fallback = materials.building;
    gltf.scene.traverse(o => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const current = mesh.material as Material;
      const name = (current?.name ?? "").toLowerCase();
      let next = fallback;
      for (const key of Object.keys(materials)) {
        if (name.includes(key)) { next = materials[key]; break; }
      }
      mesh.material = next;
    });
  }

  /** Build the scene graph for a set of placements (matrices in Blender Z-up space). */
  buildGroup(placements: Placement[]): Group {
    const group = new Group();
    const byPart = new Map<string, Matrix4[]>();
    for (const pl of placements) {
      let list = byPart.get(pl.key);
      if (!list) byPart.set(pl.key, (list = []));
      list.push(pl.matrix);
    }

    // Pass 1: resolve every placement down to the buffers it will actually draw
    // with. Grouping happens afterwards, on material, because that is what
    // decides the draw call — part names do not.
    const draws: Draw[] = [];
    const tmp = new Matrix4();
    for (const [key, matrices] of byPart) {
      // interior parts (rooms / store interiors) never see the sky — no snow shell,
      // and they use the dry material clone so the rain wetness skips them too
      const interior = key.includes("ROOMS") || key.includes("storeinside");
      const part = this.parts.get(key);
      if (!part) {
        if (!this.warned.has(key)) {
          this.warned.add(key);
          console.warn(`kit: missing part ${key}`);
        }
        continue;
      }
      part.traverse(o => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        // meshLocal = mesh transform relative to the part root (GLTFLoader splits
        // multi-material primitives into separate meshes, so material is single)
        const rootInv = new Matrix4().copy(part.matrixWorld).invert();
        const meshLocal = rootInv.multiply(mesh.matrixWorld);

        // split instances by determinant sign: mirrored placements get the
        // mirror baked into the geometry instead of the matrix (see mirroredGeometry)
        const plain: Matrix4[] = [];
        const mirrored: Matrix4[] = [];
        for (const m of matrices) {
          tmp.copy(m).multiply(meshLocal);
          if (tmp.determinant() < 0) mirrored.push(tmp.clone().multiply(MIRROR_X));
          else plain.push(tmp.clone());
        }
        // interior meshes render with the dry clone (falls back to the original for
        // glass / anything not cloned) so the rain wet shader never touches them
        const baseMat = mesh.material as Material;
        const material = interior ? (this.dryMaterials.get(baseMat) ?? baseMat) : baseMat;
        const shell = !interior &&
          (baseMat === this.materials.building || baseMat === this.materials.floor);
        for (const [geom, list] of [
          [mesh.geometry, plain],
          [mirrored.length ? this.mirroredGeometry(mesh.geometry) : null, mirrored],
        ] as const) {
          if (!geom || list.length === 0) continue;
          for (const matrix of list) draws.push({ geometry: geom, material, matrix, key, shell });
        }
      });
    }

    // Pass 2: one BatchedMesh per material. Grouping by part key instead used to
    // produce ~950 InstancedMeshes averaging two instances each — the frame was
    // spent submitting draw calls rather than drawing. BatchedMesh keeps the
    // per-object matrices, frustum culling and pickable ids that a plain merged
    // geometry would throw away.
    const byMaterial = new Map<Material, Draw[]>();
    for (const draw of draws) {
      let list = byMaterial.get(draw.material);
      if (!list) byMaterial.set(draw.material, (list = []));
      list.push(draw);
    }
    for (const [material, list] of byMaterial) group.add(buildBatch(material, list, true));

    // The snow shell is a second pass over the same geometry that only the vertex
    // shader extrudes. It can no longer share an instanceMatrix buffer the way the
    // InstancedMesh pass did, so it costs one more copy of the kit's unique
    // geometry (~2 MB) plus its own matrix texture.
    if (this.snowShellMaterial) {
      const shellDraws = draws.filter(d => d.shell);
      if (shellDraws.length) {
        const snowLayer = new Group();
        snowLayer.name = "snowShell";
        snowLayer.visible = false;
        snowLayer.add(buildBatch(this.snowShellMaterial, shellDraws, false));
        group.add(snowLayer);
      }
    }
    return group;
  }
}

/** One placed copy of a kit mesh, resolved to the buffers it will draw with. */
interface Draw {
  geometry: BufferGeometry;
  material: Material;
  matrix: Matrix4;
  /** source part name, e.g. COL[roof][2] — surfaced by the hover inspector */
  key: string;
  /** exterior building/floor surface, so it also gets a snow-shell copy */
  shell: boolean;
}

/**
 * Per-instance provenance for a BatchedMesh, indexed by the `batchId` that
 * raycasting reports. BatchedMesh has one name and one geometry for the whole
 * batch, so the inspector reads these instead.
 */
export interface BatchedInstances {
  names: string[];
  geometries: BufferGeometry[];
}

/** The provenance table for a batch, or null for anything else in the graph. */
export function batchedInstances(o: Object3D): BatchedInstances | null {
  const data = (o as BatchedMesh).isBatchedMesh
    ? (o.userData as { instances?: BatchedInstances }).instances
    : undefined;
  return data ?? null;
}

function buildBatch(material: Material, items: Draw[], castShadow: boolean): BatchedMesh {
  const unique = new Set<BufferGeometry>();
  for (const item of items) unique.add(item.geometry);
  let vertices = 0;
  let indices = 0;
  for (const geometry of unique) {
    vertices += geometry.getAttribute("position").count;
    indices += geometry.index?.count ?? 0;
  }

  const batch = new BatchedMesh(items.length, vertices, indices, material);
  batch.castShadow = castShadow;
  batch.receiveShadow = true;
  // Both BatchedMesh defaults walk all ~8.6k instances on the CPU every pass, and
  // both cost more than they save on one compact building: sorting is 2.3ms/frame
  // and per-instance culling 1ms, against a 0.28ms frame once they are off. The
  // InstancedMesh pass this replaced sorted nothing and culled per-mesh, so the
  // batch's own bounding sphere still culls the building when it leaves frame.
  batch.sortObjects = false;
  batch.perObjectFrustumCulled = false;

  // addGeometry copies into the batch's shared buffers, so each distinct geometry
  // is uploaded once no matter how many placements reference it
  const geometryIds = new Map<BufferGeometry, number>();
  const instances: BatchedInstances = { names: [], geometries: [] };
  for (const item of items) {
    let id = geometryIds.get(item.geometry);
    if (id === undefined) geometryIds.set(item.geometry, (id = batch.addGeometry(item.geometry)));
    const instanceId = batch.addInstance(id);
    batch.setMatrixAt(instanceId, item.matrix);
    instances.names[instanceId] = item.key;
    instances.geometries[instanceId] = item.geometry;
  }
  batch.userData.instances = instances;
  return batch;
}
