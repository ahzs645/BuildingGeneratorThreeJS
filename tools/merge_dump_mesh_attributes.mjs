#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const [targetPath, sourcePath, objectName, component = "mesh", ...attributeNames] = process.argv.slice(2);
if (!targetPath || !sourcePath || !objectName || !attributeNames.length) {
  throw new Error(
    "usage: merge_dump_mesh_attributes.mjs TARGET SOURCE OBJECT [mesh|evaluated_mesh] ATTRIBUTE [...]",
  );
}
if (!["mesh", "evaluated_mesh"].includes(component)) {
  throw new Error(`unsupported mesh component: ${component}`);
}

const [targetText, sourceText] = await Promise.all(
  [targetPath, sourcePath].map((path) => readFile(path, "utf8")),
);
const target = JSON.parse(targetText);
const source = JSON.parse(sourceText);
const targetObject = target.objects?.find((object) => object.name === objectName);
const sourceObject = source.objects?.find((object) => object.name === objectName);
if (!targetObject?.[component] || !sourceObject?.[component]) {
  throw new Error(`missing ${objectName}.${component} in target or source dump`);
}
const matchingBrace = (text, open) => {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  throw new Error(`unclosed object at byte ${open}`);
};

const objectNameNeedle = `"name": ${JSON.stringify(objectName)}`;
const objectNameAt = targetText.indexOf(objectNameNeedle);
if (objectNameAt < 0) throw new Error(`object text not found: ${objectName}`);
const objectOpen = targetText.lastIndexOf("{", objectNameAt);
const objectClose = matchingBrace(targetText, objectOpen);
const componentNeedle = `"${component}": {`;
const componentAt = targetText.indexOf(componentNeedle, objectNameAt);
if (componentAt < 0 || componentAt > objectClose) {
  throw new Error(`component text not found: ${objectName}.${component}`);
}
const componentOpen = targetText.indexOf("{", componentAt);
const componentClose = matchingBrace(targetText, componentOpen);
const attributesNeedle = `"attributes": {`;
const attributesAt = targetText.indexOf(attributesNeedle, componentOpen);
if (attributesAt < 0 || attributesAt > componentClose) {
  throw new Error(`attributes text not found: ${objectName}.${component}.attributes`);
}
const attributesOpen = targetText.indexOf("{", attributesAt);
const attributesClose = matchingBrace(targetText, attributesOpen);
const lineStart = targetText.lastIndexOf("\n", attributesAt) + 1;
const attributeIndent = `${targetText.slice(lineStart, attributesAt)} `;
const existingAttributes = Object.keys(targetObject[component].attributes ?? {});
const blocks = attributeNames.map((name) => {
  const attribute = sourceObject[component].attributes?.[name];
  if (!attribute) throw new Error(`missing extracted ${objectName}.${component}.attributes.${name}`);
  if (existingAttributes.includes(name)) throw new Error(`target already contains ${name}`);
  const json = JSON.stringify(attribute, null, 1).split("\n");
  return `${attributeIndent}${JSON.stringify(name)}: ${json[0]}${json.slice(1).map((line) => `\n${attributeIndent}${line}`).join("")}`;
});
const separator = existingAttributes.length ? "," : "";
const merged = `${targetText.slice(0, attributesClose)}${separator}\n${blocks.join(",\n")}\n${targetText.slice(attributesClose)}`;
await writeFile(targetPath, merged);
console.log(`MERGED_DUMP_ATTRIBUTES ${objectName}.${component}: ${attributeNames.join(", ")}`);
