import assert from "node:assert/strict";
import test from "node:test";
import {
  binBlenderBridgeEndpoint,
  probeBinBlenderBridge,
  requestBinBlenderBake,
  type BinBridgeFetch,
} from "./bin-blender-bridge";

test("Recursive Bin live Blender bridge is local-only and remains deterministic offline", async () => {
  let requested = false;
  const fetcher: BinBridgeFetch = async () => {
    requested = true;
    throw new Error("must not fetch");
  };

  assert.equal(binBlenderBridgeEndpoint("example.com"), null);
  assert.deepEqual(await probeBinBlenderBridge(fetcher, "example.com"), {
    available: false,
    endpoint: null,
    detail: "The live Blender bridge is local-only",
  });
  assert.equal(requested, false);
});

test("Recursive Bin bridge preflight and bake request use the documented HTTP contract", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer;
  const fetcher: BinBridgeFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/status")) return new Response(JSON.stringify({
      ready: true,
      dependencies: {
        completeForGeometry: false,
        missingFonts: [{ name: "dogica.otf", path: "/missing/dogica.otf" }],
        missingImages: [{ name: "bed.png", path: "/missing/bed.png" }],
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    return new Response(glb, { status: 200, headers: { "Content-Type": "model/gltf-binary" } });
  };

  const status = await probeBinBlenderBridge(fetcher, "127.0.0.1");
  assert.equal(status.available, true);
  assert.equal(status.endpoint, "http://127.0.0.1:7801");
  assert.equal(status.dependencyComplete, false);
  assert.deepEqual(status.missingFonts, ["dogica.otf"]);
  assert.deepEqual(status.missingImages, ["bed.png"]);

  const parameters = { "Bin Select": 4, "make exportable": true };
  assert.deepEqual(new Uint8Array(await requestBinBlenderBake(fetcher, "127.0.0.1", parameters)), new Uint8Array(glb));
  assert.equal(calls[1].url, "http://127.0.0.1:7801/bake");
  assert.equal(calls[1].init?.method, "POST");
  assert.equal(calls[1].init?.body, JSON.stringify(parameters));
  assert.deepEqual(calls[1].init?.headers, { "Content-Type": "application/json" });
});

test("Recursive Bin bridge reports offline, HTTP, and empty-payload failures without Blender", async () => {
  const offline: BinBridgeFetch = async () => { throw new Error("connection refused"); };
  assert.equal((await probeBinBlenderBridge(offline, "localhost")).available, false);

  const rejected: BinBridgeFetch = async () => new Response("bake timeout", { status: 504 });
  await assert.rejects(
    requestBinBlenderBake(rejected, "localhost", {}),
    /Blender bake failed \(504\): bake timeout/,
  );

  const empty: BinBridgeFetch = async () => new Response(new ArrayBuffer(0), { status: 200 });
  await assert.rejects(requestBinBlenderBake(empty, "localhost", {}), /empty GLB payload/);
});
