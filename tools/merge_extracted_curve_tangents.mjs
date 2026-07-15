// Copy only re-extracted curve tangent arrays into an existing portable dump.
// Usage: node tools/merge_extracted_curve_tangents.mjs TARGET.json SOURCE.json OBJECT
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , targetPath, sourcePath, objectName] = process.argv;
if (!targetPath || !sourcePath || !objectName) {
  throw new Error("usage: TARGET.json SOURCE.json OBJECT");
}

let targetText = process.env.NODE_DOJO_BASE_REF
  ? execFileSync("git", ["show", `${process.env.NODE_DOJO_BASE_REF}:${targetPath}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  : readFileSync(targetPath, "utf8");
const target = JSON.parse(targetText);
const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const targetObject = target.objects?.find((object) => object.name === objectName);
const sourceObject = source.objects?.find((object) => object.name === objectName);
if (!targetObject?.curves || !sourceObject?.curves || targetObject.curves.length !== sourceObject.curves.length) {
  throw new Error(`curve mismatch for ${objectName}`);
}

const objectOffset = targetText.indexOf(`"name": "${objectName}"`);
let cursor = targetText.indexOf('"curves": [', objectOffset);
if (objectOffset < 0 || cursor < 0) throw new Error(`object text not found: ${objectName}`);
const matchingBracket = (open) => {
  let depth = 0;
  for (let index = open; index < targetText.length; index++) {
    if (targetText[index] === "[") depth++;
    else if (targetText[index] === "]" && --depth === 0) return index;
  }
  throw new Error("unterminated JSON array");
};

for (let index = 0; index < targetObject.curves.length; index++) {
  const targetCurve = targetObject.curves[index];
  const sourceCurve = sourceObject.curves[index];
  if (sourceCurve.tangents?.length !== targetCurve.points?.length) {
    throw new Error(`tangent count mismatch for ${objectName} spline ${index}`);
  }
  const radiiKey = targetText.indexOf('"radii": [', cursor);
  if (radiiKey < 0) throw new Error(`radii array not found for ${objectName} spline ${index}`);
  const radiiOpen = targetText.indexOf("[", radiiKey);
  const radiiClose = matchingBracket(radiiOpen);
  const baseIndent = targetText.slice(targetText.lastIndexOf("\n", radiiKey) + 1, radiiKey);
  const tangentJson = JSON.stringify(sourceCurve.tangents, null, 1)
    .split("\n")
    .map((line, lineIndex) => lineIndex === 0 ? line : `${baseIndent}${line}`)
    .join("\n");
  const insertion = `,\n${baseIndent}"tangents": ${tangentJson}`;
  targetText = `${targetText.slice(0, radiiClose + 1)}${insertion}${targetText.slice(radiiClose + 1)}`;
  cursor = radiiClose + insertion.length + 1;
}

writeFileSync(targetPath, targetText.endsWith("\n") ? targetText : `${targetText}\n`);
console.log(`MERGE_CURVE_TANGENTS_OK ${objectName} -> ${targetPath}`);
