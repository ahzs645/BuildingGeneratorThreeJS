// Overlay compare: Blender truth (red wire) vs GN-VM (blue wire) for the bubble
// vase. Default is dual-wire so shape is comparable — solid shading hid topology
// differences and double-side fills read as solid interiors.
//
// Keys: 1 truth, 2 VM, 3 both · T/V toggle each · O/S overlay/side-by-side
// · W toggle solid/wire for VM · R reset camera
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const stat = document.getElementById("stat")!;
const truthToggle = document.getElementById("toggle-truth") as HTMLButtonElement;
const vmToggle = document.getElementById("toggle-vm") as HTMLButtonElement;
const overlayToggle = document.getElementById("view-overlay") as HTMLButtonElement;
const sideBySideToggle = document.getElementById("view-side-by-side") as HTMLButtonElement;
const vmStyleToggle = document.getElementById("toggle-vm-style") as HTMLButtonElement;
const reframeButton = document.getElementById("reframe") as HTMLButtonElement;
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
controls.autoRotateSpeed = 0.45;

scene.add(new THREE.HemisphereLight(0xdfeaff, 0x20242a, 0.95));
const key = new THREE.DirectionalLight(0xffffff, 1.35);
key.position.set(3, 6, 4);
scene.add(key);

const truthGroup = new THREE.Group();
const vmGroup = new THREE.Group();
scene.add(truthGroup, vmGroup);

type CompareMode = "overlay" | "side-by-side";
let showTruth = true;
let showVm = true;
let compareMode: CompareMode = "overlay";
let sideBySideOffset = 0;

function positionSideBySide() {
  if (compareMode !== "side-by-side") return;
  // Keep the pair in the camera's image plane. A fixed world-X offset looks
  // like two different viewing angles after orbiting close to the model, which
  // makes a seam on one side appear to pass through the other mesh.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  truthGroup.position.copy(right).multiplyScalar(-sideBySideOffset);
  vmGroup.position.copy(right).multiplyScalar(sideBySideOffset);
}

function frameAll() {
  const box = new THREE.Box3();
  if (showTruth && truthGroup.children.length) box.expandByObject(truthGroup);
  if (showVm && vmGroup.children.length) box.expandByObject(vmGroup);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3()).length();
  // Frame the pair from a neutral angle before its image-plane separation is
  // applied, so neither model starts closer or visually larger than the other.
  if (compareMode === "side-by-side") {
    camera.position.set(c.x, c.y - s * 0.65, c.z + s * 0.85);
  } else {
    camera.position.set(c.x + s * 0.85, c.y + s * 0.55, c.z + s * 0.85);
  }
  controls.target.copy(c);
  controls.update();
}

function syncComparison(reframe = true) {
  truthGroup.visible = showTruth;
  vmGroup.visible = showVm;
  controls.autoRotate = compareMode === "overlay";
  truthGroup.position.x = 0;
  vmGroup.position.x = 0;

  if (compareMode === "side-by-side") {
    const truthWidth = truthGroup.children.length
      ? new THREE.Box3().setFromObject(truthGroup).getSize(new THREE.Vector3()).x
      : 0;
    const vmWidth = vmGroup.children.length
      ? new THREE.Box3().setFromObject(vmGroup).getSize(new THREE.Vector3()).x
      : 0;
    sideBySideOffset = Math.max(truthWidth, vmWidth, 1) * 0.62;
    positionSideBySide();
  } else {
    sideBySideOffset = 0;
  }

  truthToggle.setAttribute("aria-pressed", String(showTruth));
  vmToggle.setAttribute("aria-pressed", String(showVm));
  overlayToggle.setAttribute("aria-pressed", String(compareMode === "overlay"));
  sideBySideToggle.setAttribute("aria-pressed", String(compareMode === "side-by-side"));
  vmStyleToggle.setAttribute("aria-pressed", String(vmMode === "solid"));
  vmStyleToggle.textContent = vmMode === "solid" ? "VM wire" : "VM solid";
  if (reframe) frameAll();
}

const status: string[] = [];
function report(msg: string) {
  status.push(msg);
  stat.textContent = status.join(" · ");
}

function logBBox(label: string, obj: THREE.Object3D) {
  const b = new THREE.Box3().setFromObject(obj);
  console.log(
    `BBOX ${label} min=[${b.min.toArray().map((v) => v.toFixed(1))}] max=[${b.max.toArray().map((v) => v.toFixed(1))}]`
  );
}

// ---- Truth (red wire) -------------------------------------------------------
new GLTFLoader().load("/dojo/vase_truth.glb", (gltf) => {
  let tris = 0;
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    tris += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    mesh.material = new THREE.MeshBasicMaterial({
      color: 0xff6b6b,
      wireframe: true,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
  });
  // Blender GLB is Y-up; VM soup is Z-up. Rotate truth into VM space.
  gltf.scene.rotation.x = Math.PI / 2;
  truthGroup.add(gltf.scene);
  logBBox("truth", truthGroup);
  report(`truth ${Math.round(tris).toLocaleString()} tris`);
  syncComparison();
});

// ---- VM (blue wire by default; W toggles solid) ------------------------------
let vmSolid: THREE.Mesh | null = null;
let vmWire: THREE.Mesh | null = null;
let vmMode: "wire" | "solid" = "wire";

function applyVmMode() {
  if (!vmSolid || !vmWire) return;
  if (vmMode === "wire") {
    vmSolid.visible = false;
    vmWire.visible = true;
  } else {
    vmSolid.visible = true;
    vmWire.visible = true; // light wire on top of solid
  }
  syncComparison(false);
}

// The exporter rewrites this static asset while the Vite server is running.
// Always fetch the current mesh after a page reload instead of reusing a stale
// cached preview from an earlier comparison pass.
fetch("/dojo/vase_vm.json", { cache: "no-store" })
  .then((r) => r.json())
  .then((soup) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(soup.positions), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(soup.normals), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(soup.indices), 1));
    geo.computeVertexNormals();

    // If most mid-shell normals point inward, flip index winding so FrontSide reads correctly.
    {
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const nrm = geo.attributes.normal as THREE.BufferAttribute;
      let out = 0, inn = 0;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const r = Math.hypot(x, y);
        if (r < 80 || z < 60 || z > 280) continue;
        const radial = (nrm.getX(i) * x + nrm.getY(i) * y) / r;
        if (radial > 0.15) out++;
        else if (radial < -0.15) inn++;
      }
      if (inn > out * 1.2 && geo.index) {
        const idx = geo.index.array as Uint32Array;
        for (let i = 0; i < idx.length; i += 3) {
          const t = idx[i + 1];
          idx[i + 1] = idx[i + 2];
          idx[i + 2] = t;
        }
        geo.index.needsUpdate = true;
        geo.computeVertexNormals();
        console.log("VM normals flipped (were inward)", { out, inn });
      } else {
        console.log("VM normal orientation", { out, inn });
      }
    }

    vmSolid = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: 0x3b82f6,
        roughness: 0.42,
        metalness: 0.06,
        side: THREE.FrontSide,
      })
    );
    vmWire = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0x5eb4ff,
        wireframe: true,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );

    const root = new THREE.Group();
    root.add(vmSolid, vmWire);
    // Truth GLB bakes object world transform; VM is local — apply dump object TRS.
    if (soup.object) {
      root.position.fromArray(soup.object.location);
      root.rotation.set(...(soup.object.rotation as [number, number, number]));
      root.scale.fromArray(soup.object.scale);
    }
    vmGroup.add(root);
    applyVmMode();
    logBBox("vm", vmGroup);
    report(`vm ${soup.stats.verts.toLocaleString()} verts / ${soup.stats.tris.toLocaleString()} tris (wire)`);
    syncComparison();
  })
  .catch(() => report("vm export missing — run tools/gnvm-export.ts"));

truthToggle.addEventListener("click", () => {
  showTruth = !showTruth;
  syncComparison();
});
vmToggle.addEventListener("click", () => {
  showVm = !showVm;
  syncComparison();
});
overlayToggle.addEventListener("click", () => {
  compareMode = "overlay";
  syncComparison();
});
sideBySideToggle.addEventListener("click", () => {
  compareMode = "side-by-side";
  syncComparison();
});
vmStyleToggle.addEventListener("click", () => {
  vmMode = vmMode === "wire" ? "solid" : "wire";
  applyVmMode();
});
reframeButton.addEventListener("click", () => frameAll());

addEventListener("keydown", (e) => {
  if (e.key === "1") {
    showTruth = true;
    showVm = false;
    syncComparison();
  }
  if (e.key === "2") {
    showTruth = false;
    showVm = true;
    syncComparison();
  }
  if (e.key === "3") {
    showTruth = true;
    showVm = true;
    syncComparison();
  }
  if (e.key === "t" || e.key === "T") {
    showTruth = !showTruth;
    syncComparison();
  }
  if (e.key === "v" || e.key === "V") {
    showVm = !showVm;
    syncComparison();
  }
  if (e.key === "o" || e.key === "O") {
    compareMode = "overlay";
    syncComparison();
  }
  if (e.key === "s" || e.key === "S") {
    compareMode = "side-by-side";
    syncComparison();
  }
  if (e.key === "w" || e.key === "W") {
    vmMode = vmMode === "wire" ? "solid" : "wire";
    applyVmMode();
  }
  if (e.key === "r" || e.key === "R") {
    frameAll();
  }
});

const params = new URLSearchParams(location.search);
const only = params.get("only");
if (only === "vm") showTruth = false;
if (only === "truth") showVm = false;
if (params.get("view") === "side-by-side") compareMode = "side-by-side";
if (params.get("wire") === "0" || params.get("solid") === "1") {
  vmMode = "solid";
  setTimeout(applyVmMode, 500);
  setTimeout(applyVmMode, 2000);
}
syncComparison(false);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  positionSideBySide();
  renderer.render(scene, camera);
});
