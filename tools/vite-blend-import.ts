import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const BLENDER_TIMEOUT_MS = 10 * 60 * 1000;

function blenderBinary(): string {
  if (process.env.BLENDER_BIN) return process.env.BLENDER_BIN;
  const mac = "/Applications/Blender.app/Contents/MacOS/Blender";
  return existsSync(mac) ? mac : "blender";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function runBlender(input: string, output: string): Promise<{ log: string; version: string }> {
  const executable = blenderBinary();
  const script = resolve(process.cwd(), "tools/dump_blend.py");
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, ["--background", input, "--python", script, "--", output], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const append = (chunk: Buffer) => {
      if (log.length < 2_000_000) log += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2500).unref();
    }, BLENDER_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start Blender (${executable}): ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const tail = log.trim().split("\n").slice(-18).join("\n");
        reject(new Error(signal ? `Blender extraction timed out (${signal}).` : `Blender extraction failed (${code}).\n${tail}`));
        return;
      }
      const version = log.match(/Blender\s+([0-9.]+)/)?.[1] ?? "unknown";
      resolveRun({ log, version });
    });
  });
}

async function receiveBlend(req: IncomingMessage, path: string): Promise<number> {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) callback(new Error("The .blend file is larger than the 1 GB local import limit."));
      else callback(null, chunk);
    },
  });
  await pipeline(req, limiter, createWriteStream(path, { flags: "wx" }));
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(7);
    await file.read(header, 0, header.length, 0);
    if (header.toString("ascii") !== "BLENDER") throw new Error("This file does not have a valid Blender header.");
  } finally {
    await file.close();
  }
  return bytes;
}

async function handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const filename = String(req.headers["x-blend-filename"] ?? "uploaded.blend");
  if (!filename.toLowerCase().endsWith(".blend")) {
    json(res, 415, { error: "Choose a .blend file, or load a previously extracted .json in the browser." });
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "blendbridge-"));
  const input = join(dir, "input.blend");
  const output = join(dir, "dump.json");
  try {
    const bytes = await receiveBlend(req, input);
    const run = await runBlender(input, output);
    const dump = JSON.parse(await readFile(output, "utf8"));
    dump.import_meta = {
      filename: filename.replace(/[\u0000-\u001f]/g, ""),
      bytes,
      blender_version: dump.blender_version ?? run.version,
      extracted_at: new Date().toISOString(),
      transient: true,
    };
    json(res, 200, dump);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("BLEND_IMPORT_ERROR", message);
    json(res, message.includes("larger than") ? 413 : 422, { error: message });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/blend-import/health" && req.method === "GET") {
    const executable = blenderBinary();
    json(res, 200, {
      available: executable === "blender" || existsSync(executable),
      executable,
      max_upload_bytes: MAX_UPLOAD_BYTES,
      transient: true,
    });
    return;
  }
  if (url.pathname !== "/api/blend-import") {
    next();
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  void handleImport(req, res);
}

export function blendImportPlugin(): Plugin {
  return {
    name: "blendbridge-local-import",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
