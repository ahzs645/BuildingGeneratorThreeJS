import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type FontOverride = { source: string; sha256: string };

export type StagedBinFont = {
  input: string;
  output: string;
  sha256: string;
  status: "exact" | "candidate";
  expectedSource?: string;
};

function digest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function stageBinFonts(
  inputs: string[],
  options: { repo?: string; parityFile?: string; outputRoot?: string } = {},
): StagedBinFont[] {
  const repo = options.repo ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parityFile = options.parityFile ?? path.join(repo, "public/dojo/bin-geometry-parity.json");
  const outputRoot = options.outputRoot ?? path.join(repo, ".local-assets/node-dojo-fonts");
  const parity = JSON.parse(readFileSync(parityFile, "utf8")) as { fontOverrides?: FontOverride[] };
  const expected = parity.fontOverrides ?? [];
  const exactDir = path.join(outputRoot, "exact");
  const candidateDir = path.join(outputRoot, "candidates");
  mkdirSync(exactDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });

  return inputs.map((input) => {
    const absoluteInput = path.resolve(input);
    const sha256 = digest(absoluteInput);
    const match = expected.find((font) => font.sha256.toLowerCase() === sha256);
    const output = match
      ? path.join(exactDir, match.source)
      : path.join(candidateDir, path.basename(absoluteInput));
    copyFileSync(absoluteInput, output);
    return {
      input: absoluteInput,
      output,
      sha256,
      status: match ? "exact" : "candidate",
      ...(match ? { expectedSource: match.source } : {}),
    };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error("Usage: npx tsx tools/stage-bin-fonts.ts FONT [FONT ...]");
    process.exitCode = 1;
  } else {
    for (const result of stageBinFonts(inputs)) {
      console.log(`${result.status.toUpperCase()} ${result.sha256} ${result.output}`);
    }
  }
}
