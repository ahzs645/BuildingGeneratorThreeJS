/**
 * Shared authoring identity for the Chrome Crayon graph. Reusing this config
 * means the Create brush lab and the Dev parity view open the same saved draft
 * instead of quietly maintaining two unrelated copies of the Blender graph.
 */
export const chromeCrayonEditorConfig = {
  dumpUrl: "dojo/crayon/dump.json",
  objectName: "CHROME CRAYON OBJECT",
  rootGroupName: "CHROME CRAYON 3D _4.3_DEC2024",
  events: {
    change: "crayon-graph-change",
    nodeSelect: "crayon-node-select",
    resize: "crayon-graph-resize",
  },
  storageKey: "crayon-gnvm-draft",
  downloadFileName: "chrome-crayon-edited.json",
} as const;
