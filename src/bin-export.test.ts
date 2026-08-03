import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  BIN_EXPORT_METADATA_VERSION,
  encodeBinGlb,
  encodeBinMetadata,
  encodeBinStl,
  makeBinExportMetadata,
} from "./bin-export";

class TestFileReader {
  result: string | ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((result) => {
      this.result = `data:${blob.type};base64,${Buffer.from(result).toString("base64")}`;
      this.onloadend?.();
    });
  }
}

Object.defineProperty(globalThis, "FileReader", {
  configurable: true,
  value: TestFileReader,
});

function fixtureRoot(): THREE.Group {
  const root = new THREE.Group();
  root.name = "Evaluated Recursive Bin";
  root.visible = false; // comparison display state must not suppress downloads
  root.position.set(2.25, -1.5, 0.75);
  root.rotation.set(0.2, -0.35, 0.1);
  root.scale.set(1.2, 0.8, 1.1);
  root.userData.existing = "preserved";

  const geometry = new THREE.BoxGeometry(2, 3, 4);
  const materials = Array.from({ length: 6 }, (_, index) => new THREE.MeshStandardMaterial({
    name: `Bin material ${index}`,
    color: new THREE.Color().setHSL(index / 6, 0.7, 0.5),
  }));
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.position.set(0.3, -0.2, 0.4);
  root.add(mesh);
  root.updateMatrixWorld(true);
  return root;
}

function bounds(root: THREE.Object3D): number[] {
  const box = new THREE.Box3().setFromObject(root);
  return [...box.min.toArray(), ...box.max.toArray()];
}

function triangleCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    count += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
  });
  return count;
}

function triangleSurface(root: THREE.Object3D): string[] {
  const result: string[] = [];
  const point = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index?.count ?? positions.count;
    for (let offset = 0; offset < count; offset += 3) {
      const triangle = [0, 1, 2].map((corner) => {
        const vertex = index?.getX(offset + corner) ?? offset + corner;
        point.fromBufferAttribute(positions, vertex).applyMatrix4(mesh.matrixWorld);
        // Both GLB accessors and binary STL vertices are float32. Four decimal
        // places verifies the same triangle surface without treating the last
        // float32 rounding bit as a topology change.
        return point.toArray().map((value) => value.toFixed(4)).join(",");
      });
      result.push(triangle.sort().join("|"));
    }
  });
  return result.sort();
}

function assertBoundsClose(actual: number[], expected: number[], epsilon = 1e-5): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(
    Math.abs(value - expected[index]) <= epsilon,
    `bounds[${index}] ${value} differs from ${expected[index]}`,
  ));
}

const parameters = {
  "Size X": 1.551,
  "Size Y": 2.25,
  "Bin Select": 7,
  "make exportable": true,
};

function metadata(engine: "vm" | "blender" = "vm") {
  return makeBinExportMetadata({
    parameters,
    engine,
    truthSource: engine === "blender" ? "live" : "unavailable",
    classification: "exact-surface",
    comparedParameters: engine === "blender" ? parameters : null,
    evidence: "Deterministic export fixture",
  });
}

test("Recursive Bin GLB round-trip preserves triangles, world bounds, materials, and parameter metadata", async () => {
  const source = fixtureRoot();
  const bytes = await encodeBinGlb(source, metadata("blender"));
  assert.ok(bytes.byteLength > 100);

  const loaded = (await new GLTFLoader().parseAsync(bytes, "")).scene;
  assert.equal(triangleCount(loaded), triangleCount(source));
  assert.deepEqual(triangleSurface(loaded), triangleSurface(source));
  assertBoundsClose(bounds(loaded), bounds(source));

  const materialNames = new Set<string>();
  loaded.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materialNames.add(material.name);
  });
  for (let index = 0; index < 6; index += 1) assert.ok(materialNames.has(`Bin material ${index}`));

  let embedded: unknown;
  loaded.traverse((object) => {
    if (object.userData.recursiveBin) embedded = object.userData.recursiveBin;
  });
  assert.deepEqual(embedded, metadata("blender"));
  assert.equal(source.userData.recursiveBin, undefined, "export must not mutate the live viewport root");
});

test("Recursive Bin STL round-trip preserves triangle soup and world bounds while metadata remains a sidecar", () => {
  const source = fixtureRoot();
  const bytes = encodeBinStl(source);
  const geometry = new STLLoader().parse(bytes);
  const loaded = new THREE.Mesh(geometry);

  assert.equal(geometry.index, null, "STL intentionally has no shared topology index");
  assert.equal(triangleCount(loaded), triangleCount(source));
  assert.deepEqual(triangleSurface(loaded), triangleSurface(source));
  assertBoundsClose(bounds(loaded), bounds(source));
  assert.equal(Object.keys(geometry.userData).length, 0, "STL cannot carry Recursive Bin parameters");
});

test("Recursive Bin JSON sidecar is stable and defensively snapshots parameters", () => {
  const snapshot = metadata();
  parameters["Size X"] = 9;
  const decoded = JSON.parse(encodeBinMetadata(snapshot)) as ReturnType<typeof metadata>;

  assert.equal(decoded.parameters["Size X"], 1.551);
  assert.equal(decoded.evidenceVersion, BIN_EXPORT_METADATA_VERSION);
  assert.equal(decoded.engine, "GN-VM");
  parameters["Size X"] = 1.551;
});
