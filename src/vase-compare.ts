// Overlay compare: Blender truth GLB (red wireframe) vs the GN-VM's exported
// tri-soup (blue solid) for the bubble vase. Keys: 1 truth only, 2 vm only, 3 both.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const stat = document.getElementById("stat")!;
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
controls.autoRotateSpeed = 0.6;

scene.add(new THREE.HemisphereLight(0xdfeaff, 0x20242a, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(3, 6, 4);
scene.add(key);

const truthGroup = new THREE.Group();
const vmGroup = new THREE.Group();
scene.add(truthGroup, vmGroup);

let framed = false;
function frame(obj: THREE.Object3D) {
  if (framed) return;
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3()).length();
  camera.position.set(c.x + s * 0.9, c.y + s * 0.7, c.z + s * 0.9);
  controls.target.copy(c);
  framed = true;
}

const status: string[] = [];
function report(msg: string) {
  status.push(msg);
  stat.textContent = status.join(" · ");
}

function logBBox(label: string, obj: THREE.Object3D) {
  const b = new THREE.Box3().setFromObject(obj);
  console.log(`BBOX ${label} min=[${b.min.toArray().map((v) => v.toFixed(1))}] max=[${b.max.toArray().map((v) => v.toFixed(1))}]`);
}

// Blender truth: red wireframe over a faint shell so shape reads at any angle.
new GLTFLoader().load("/dojo/vase_truth.glb", (gltf) => {
  let tris = 0;
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    tris += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    mesh.material = new THREE.MeshBasicMaterial({ color: 0xff5252, wireframe: true, transparent: true, opacity: 0.28 });
  });
  // Blender GLB is Y-up; our VM soup is Blender Z-up. Rotate truth to match VM space.
  gltf.scene.rotation.x = Math.PI / 2;
  truthGroup.add(gltf.scene);
  frame(truthGroup);
  logBBox("truth", truthGroup);
  report(`truth ${Math.round(tris).toLocaleString()} tris`);
});

// VM export: solid blue.
fetch("/dojo/vase_vm.json")
  .then((r) => r.json())
  .then((soup) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(soup.positions), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(soup.normals), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(soup.indices), 1));
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide })
    );
    // VM output is in the object's local space; the truth GLB bakes the object's
    // world transform. Apply it so the two overlay.
    if (soup.object) {
      mesh.position.fromArray(soup.object.location);
      mesh.rotation.set(...(soup.object.rotation as [number, number, number]));
      mesh.scale.fromArray(soup.object.scale);
    }
    vmGroup.add(mesh);
    frame(vmGroup);
    logBBox("vm", vmGroup);
    report(`vm ${soup.stats.verts.toLocaleString()} verts / ${soup.stats.tris.toLocaleString()} tris`);
  })
  .catch(() => report("vm export missing — run tools/gnvm-export.ts"));

addEventListener("keydown", (e) => {
  if (e.key === "1") { truthGroup.visible = true; vmGroup.visible = false; }
  if (e.key === "2") { truthGroup.visible = false; vmGroup.visible = true; }
  if (e.key === "3") { truthGroup.visible = true; vmGroup.visible = true; }
});
// ?only=vm / ?only=truth for headless snapshots
const only = new URLSearchParams(location.search).get("only");
if (only === "vm") truthGroup.visible = false;
if (only === "truth") vmGroup.visible = false;

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
