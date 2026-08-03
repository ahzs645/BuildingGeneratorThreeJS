import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { stageBinFonts } from "../tools/stage-bin-fonts";

test("Recursive Bin stages validated fonts separately from unverified candidates", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bin-font-stage-"));
  try {
    const exactInput = path.join(root, "dogica-source.otf");
    const candidateInput = path.join(root, "degular-demo.otf");
    writeFileSync(exactInput, "exact-font-bytes");
    writeFileSync(candidateInput, "different-demo-font-bytes");
    const exactHash = createHash("sha256").update(readFileSync(exactInput)).digest("hex");
    const parityFile = path.join(root, "parity.json");
    writeFileSync(parityFile, JSON.stringify({
      fontOverrides: [{ source: "dogica.otf", sha256: exactHash }],
    }));

    const staged = stageBinFonts([exactInput, candidateInput], {
      repo: root,
      parityFile,
      outputRoot: path.join(root, ".local-assets/node-dojo-fonts"),
    });
    assert.equal(staged[0].status, "exact");
    assert.equal(path.basename(staged[0].output), "dogica.otf");
    assert.equal(readFileSync(staged[0].output, "utf8"), "exact-font-bytes");
    assert.equal(staged[1].status, "candidate");
    assert.match(staged[1].output, /candidates/);
    assert.equal(readFileSync(staged[1].output, "utf8"), "different-demo-font-bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
