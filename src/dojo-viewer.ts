// Minimal viewer for a geometry-nodes generator baked out of a Node Dojo .blend.
// Proves "Path A": evaluate GN in Blender -> GLB -> render on the web.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const errEl = document.getElementById("err")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(2.2, 1.6, 2.6);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.8;

// Lighting: soft studio setup so the baked mesh reads well.
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x20242a, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 5, 2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88b0ff, 1.2);
rim.position.set(-4, 2, -3);
scene.add(rim);

// Ground grid for scale.
const grid = new THREE.GridHelper(10, 40, 0x2a3340, 0x161b21);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.5;
scene.add(grid);

function frameObject(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Recenter on origin, sit on the grid.
  obj.position.sub(center);
  obj.position.y += size.y / 2;
  const radius = size.length() / 2;
  const dist = radius / Math.sin((camera.fov * Math.PI) / 180 / 2);
  camera.position.set(dist * 0.7, dist * 0.55, dist * 0.9);
  controls.target.set(0, size.y / 2, 0);
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

new GLTFLoader().load(
  "/dojo/bin.glb",
  (gltf) => {
    const root = gltf.scene;
    let meshes = 0, tris = 0;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        meshes++;
        const g = m.geometry as THREE.BufferGeometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        // Give it a decent default material if the baked one is flat.
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat && "roughness" in mat) { mat.roughness = 0.55; mat.metalness = 0.05; }
      }
    });
    scene.add(root);
    frameObject(root);
    (window as any).__READY__ = { meshes, tris: Math.round(tris) };
    console.log("VIEWER_READY", JSON.stringify((window as any).__READY__));
  },
  undefined,
  (e) => {
    errEl.textContent = "Failed to load /dojo/bin.glb\n" + (e as any)?.message;
    console.log("VIEWER_ERROR", (e as any)?.message);
  },
);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
