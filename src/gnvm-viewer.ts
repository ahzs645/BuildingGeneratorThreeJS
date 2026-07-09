// Live in-browser viewer: runs the geometry-nodes VM on the dumped bin graph and
// rebuilds the mesh whenever a slider (auto-generated from the node group's
// interface) changes. No Blender at runtime — pure TypeScript.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import GUI from "lil-gui";
import { runGenerator, Dump, TriSoup } from "./gnvm/index";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const statEl = document.getElementById("stat")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 5000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.7;

// Keep the key light gentle: the bin floors face +Z and wash out to gray under
// a hot top light + ACES, hiding the blue material the graph assigns them.
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x20242a, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(3, 6, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88b0ff, 1.0);
rim.position.set(-5, 2, -3);
scene.add(rim);
const grid = new THREE.GridHelper(400, 40, 0x2a3340, 0x161b21);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.4;
scene.add(grid);

// Material palette keyed by the .blend material name the VM assigns per face.
// Base colors taken from the dump's Principled BSDF/Emission nodes:
//   '3D' = blue bins, '3D.004' = red highlight, 'emit*' = white glow, 'mat' = body gray.
function materialFor(name: string | null): THREE.Material {
  const n = (name ?? "").toLowerCase();
  if (n === "3d.004" || n.includes("red")) {
    return new THREE.MeshStandardMaterial({ color: 0xff2b2b, emissive: 0x7a0000, emissiveIntensity: 1.2, roughness: 0.5 });
  }
  if (n === "3d") {
    return new THREE.MeshStandardMaterial({ color: 0x0838ff, roughness: 0.45, metalness: 0.05 });
  }
  if (n.startsWith("emit")) {
    return new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xbfc8d4, emissiveIntensity: 0.6, roughness: 0.7 });
  }
  if (n.includes("chrome") || n.includes("metal")) {
    return new THREE.MeshStandardMaterial({ color: 0xcfd6dd, metalness: 0.9, roughness: 0.2 });
  }
  if (n.includes("bed")) {
    return new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85, metalness: 0.0 });
  }
  return new THREE.MeshStandardMaterial({ color: 0x8d97a3, metalness: 0.05, roughness: 0.6 });
}

function soupToMesh(soup: TriSoup): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  const mats: THREE.Material[] = [];
  soup.groups.forEach((g, i) => {
    geo.addGroup(g.start, g.count, i);
    mats.push(materialFor(g.material));
  });
  if (!soup.groups.length) mats.push(materialFor(null));
  return new THREE.Mesh(geo, mats.length > 1 ? mats : mats[0]);
}

let current: THREE.Mesh | null = null;
let framed = false;
function frame(mesh: THREE.Mesh) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  mesh.position.sub(center);
  const radius = Math.max(size.length() / 2, 0.001);
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360);
  camera.position.set(dist * 0.75, dist * 0.5, dist * 0.95);
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

// ---- GUI range heuristic (Blender exposes unbounded floats) ----------------
function rangeFor(name: string, socket: string, def: number): [number, number, number] {
  const n = name.toLowerCase();
  if (socket.includes("Bool")) return [0, 1, 1];
  if (name === "Bin Select") return [0, 40, 1];
  if (n.startsWith("size")) return [0.1, 10, 0.01];
  if (n.startsWith("divide")) return [0, 1, 0.001];
  if (socket.includes("Int")) return [0, 40, 1];
  // gap / wall / fillet / print layers: scale from default
  const hi = Math.max(50, Math.abs(def) * 3);
  return [0, hi, hi / 1000];
}

async function main() {
  const dump = (await (await fetch("/dojo/dump_bin.json")).json()) as Dump;

  // Initial params: the saved modifier input values (matches the .blend's look).
  const objName = "Procedural Drawer";
  const obj = dump.objects?.find((o) => o.name === objName);
  const savedInputs: Record<string, any> = {};
  for (const m of obj?.modifiers ?? []) if (m.input_values) Object.assign(savedInputs, m.input_values);

  // Interface -> GUI. Reuse the group referenced by the modifier.
  const groupName = obj?.modifiers?.find((m) => m.node_group)?.node_group!;
  const iface = (dump.node_groups[groupName] as any).interface as any[];
  const params: Record<string, any> = {};
  const meta: { name: string; socket: string }[] = [];
  for (const it of iface) {
    if (it.item_type !== "SOCKET" || it.in_out !== "INPUT") continue;
    if (it.socket_type === "NodeSocketGeometry") continue;
    const val = it.name in savedInputs ? savedInputs[it.name] : it.default;
    params[it.name] = it.socket_type.includes("Bool") ? !!val : (typeof val === "number" ? val : 0);
    meta.push({ name: it.name, socket: it.socket_type });
  }

  async function rebuild() {
    const t0 = performance.now();
    const res = await runGenerator(dump, { object: objName, overrides: params });
    const ms = (performance.now() - t0).toFixed(0);
    if (current) {
      scene.remove(current);
      (current.geometry as THREE.BufferGeometry).dispose();
    }
    current = soupToMesh(res.soup);
    current.rotation.x = -Math.PI / 2; // Blender Z-up -> three.js Y-up
    scene.add(current);
    if (!framed) { frame(current); framed = true; }
    const missing = res.coverage.missingTypes.length;
    statEl.innerHTML =
      `<span class="ok">${res.soup.stats.verts.toLocaleString()} verts / ${res.soup.stats.tris.toLocaleString()} tris</span> · ` +
      `${ms} ms · ${res.coverage.handled} handlers · ` +
      (missing ? `<span class="warn">${missing} node types via fallback</span>` : `<span class="ok">100% coverage</span>`);
  }

  const gui = new GUI({ title: "bin generator · GN-VM" });
  for (const { name, socket } of meta) {
    if (socket.includes("Bool")) {
      gui.add(params, name).onChange(rebuild);
    } else {
      const [lo, hi, step] = rangeFor(name, socket, params[name] ?? 1);
      gui.add(params, name, lo, hi, step).onChange(rebuild);
    }
  }
  rebuild();
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

main().catch((e) => {
  statEl.innerHTML = `<span style="color:#ff9a9a">error: ${e.message}</span>`;
  console.log("GNVM_VIEWER_ERROR", e.message, e.stack);
});
