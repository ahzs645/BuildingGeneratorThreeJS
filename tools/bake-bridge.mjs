// HTTP bridge between the browser and the warm Blender bake server (file protocol).
// Run: node tools/bake-bridge.mjs [COMM_DIR] [PORT]
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const COMM = process.argv[2] || "/tmp/bin-bake-comm";
const PORT = Number(process.argv[3] || 7801);
mkdirSync(COMM, { recursive: true });

let counter = 0;
const wait = (path, timeoutMs) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (existsSync(path)) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("bake timeout")); }
    }, 40);
  });

const cors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/status") {
    const ready = existsSync(join(COMM, "server.ready"));
    const info = ready ? JSON.parse(readFileSync(join(COMM, "server.ready"), "utf8")) : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ready, ...info }));
  }

  if (url.pathname === "/bake") {
    let body = "";
    if (req.method === "POST") { for await (const c of req) body += c; }
    let params = {};
    try { params = req.method === "POST" ? JSON.parse(body || "{}") : JSON.parse(url.searchParams.get("params") || "{}"); }
    catch { res.writeHead(400); return res.end("bad params"); }

    const id = `${Date.now()}_${counter++}`;
    const reqFile = join(COMM, `req_${id}.json`);
    const resGlb = join(COMM, `res_${id}.glb`);
    const resReady = join(COMM, `res_${id}.ready`);
    const resErr = join(COMM, `res_${id}.err`);
    writeFileSync(reqFile, JSON.stringify({ params }));
    try {
      // race ready vs err
      await Promise.race([wait(resReady, 30000), wait(resErr, 30000)]);
      if (existsSync(resErr)) {
        const msg = readFileSync(resErr, "utf8");
        [resErr].forEach((f) => existsSync(f) && unlinkSync(f));
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end(msg.slice(0, 2000));
      }
      const glb = readFileSync(resGlb);
      res.writeHead(200, { "Content-Type": "model/gltf-binary", "Content-Length": glb.length });
      res.end(glb);
      for (const f of [resGlb, resReady]) if (existsSync(f)) unlinkSync(f);
    } catch (e) {
      res.writeHead(504, { "Content-Type": "text/plain" });
      res.end(String(e.message || e));
    }
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log(`BAKE_BRIDGE on http://localhost:${PORT}  comm=${COMM}`));
