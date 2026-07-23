import fs from "node:fs";

const [targetPath, sourcePath, objectName, attributeName] = process.argv.slice(2);
if (!targetPath || !sourcePath || !objectName || !attributeName) {
  throw new Error(
    "usage: node tools/inject_dump_mesh_attribute.mjs TARGET.json SOURCE.json OBJECT ATTRIBUTE",
  );
}

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const sourceObject = source.objects?.find((object) => object.name === objectName);
const attribute = sourceObject?.mesh?.attributes?.[attributeName];
if (!attribute) throw new Error(`source attribute not found: ${objectName}.${attributeName}`);

const targetText = fs.readFileSync(targetPath, "utf8");
const target = JSON.parse(targetText);
const targetObject = target.objects?.find((object) => object.name === objectName);
if (!targetObject?.mesh) throw new Error(`target mesh not found: ${objectName}`);
if (targetObject.mesh.attributes?.[attributeName]) {
  throw new Error(`target attribute already exists: ${objectName}.${attributeName}`);
}

// Preserve the committed dump byte-for-byte outside the one inserted payload.
// Re-stringifying a 100+ MB graph dump obscures a small extraction correction
// behind an enormous precision/formatting diff.
const objectMarker = `${JSON.stringify("name")}: ${JSON.stringify(objectName)}`;
const objectOffset = targetText.indexOf(objectMarker);
if (objectOffset < 0) throw new Error(`object marker not found: ${objectName}`);
const meshOffset = targetText.indexOf('"mesh": {', objectOffset);
const attributesOffset = targetText.indexOf('"attributes": {', meshOffset);
if (meshOffset < 0 || attributesOffset < 0) throw new Error(`mesh attributes marker not found: ${objectName}`);
const insertOffset = targetText.indexOf("\n", attributesOffset) + 1;
const indent = targetText.slice(insertOffset, targetText.indexOf('"', insertOffset));
const payload = JSON.stringify(attribute, null, 2)
  .split("\n")
  .map((line, index) => index === 0 ? line : `${indent}${line}`)
  .join("\n");
const insertion = `${indent}${JSON.stringify(attributeName)}: ${payload},\n`;
fs.writeFileSync(targetPath, targetText.slice(0, insertOffset) + insertion + targetText.slice(insertOffset));
console.log(`INJECT_DUMP_ATTRIBUTE_OK ${objectName}.${attributeName} -> ${targetPath}`);
