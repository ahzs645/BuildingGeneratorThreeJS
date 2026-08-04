import { publicUrl } from "./base-url";
import type { Dump, TriSoup } from "./gnvm/index";

/**
 * THREE-free half of the shared base-shape system: the ported reference-object
 * catalog and its GN-VM evaluation. Kept renderer-agnostic so both the plain
 * `three` tools and the WebGPU painter (`three/webgpu`, a separate class copy)
 * can consume evaluated soups and build meshes with their own THREE build.
 */

export type LibraryShapeInfo = {
  id: string;
  title: string;
  /** Blender object whose NODES modifier is the evaluation target. */
  object: string;
  /** Public-relative portable dump path. */
  dump: string;
  blenderStats?: { verts: number; faces: number };
};

let catalogPromise: Promise<LibraryShapeInfo[]> | null = null;

/** The full ported reference-object catalog (104 assets, shared with the parity pages). */
export function listLibraryShapes(): Promise<LibraryShapeInfo[]> {
  catalogPromise ??= fetch(publicUrl("dojo/chrome-assets/catalog.json"))
    .then((response) => {
      if (!response.ok) throw new Error(`asset catalog unavailable (${response.status})`);
      return response.json() as Promise<LibraryShapeInfo[]>;
    })
    .then((entries) => entries.filter((entry) => entry.id && entry.dump && entry.object));
  return catalogPromise;
}

const dumpCache = new Map<string, Promise<Dump>>();
const soupCache = new Map<string, Promise<TriSoup>>();

function fetchDump(path: string): Promise<Dump> {
  let cached = dumpCache.get(path);
  if (!cached) {
    cached = fetch(publicUrl(path)).then((response) => {
      if (!response.ok) throw new Error(`dump unavailable: ${path} (${response.status})`);
      return response.json() as Promise<Dump>;
    });
    dumpCache.set(path, cached);
  }
  return cached;
}

type WorkerReply = { id: number; ok: true; soup: TriSoup } | { id: number; ok: false; error: string };

function evaluateObjectTarget(dump: Dump, objectName: string, workerName: string): Promise<TriSoup> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: workerName });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.soup);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ id: 1, dump, object: objectName, overrides: {} });
  });
}

/**
 * Evaluate a reference object's authored graph and return its result soup.
 * Cached per asset id — the catalog result is deterministic per dump.
 */
export function evaluateLibraryShape(info: LibraryShapeInfo): Promise<TriSoup> {
  let cached = soupCache.get(info.id);
  if (!cached) {
    cached = fetchDump(info.dump)
      .then((dump) => evaluateObjectTarget(dump, info.object, `base-shape-${info.id}`))
      .then((soup) => {
        if (!soup.indices.length) throw new Error(`${info.title} evaluates to no mesh surface`);
        return soup;
      });
    cached.catch(() => soupCache.delete(info.id));
    soupCache.set(info.id, cached);
  }
  return cached;
}
