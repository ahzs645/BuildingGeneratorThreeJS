import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import { rangeOverrideValue } from "./chrome-asset-controls";
import type { Dump, TriSoup } from "./gnvm/index";
import { makeAttributeEmissionMaterial } from "./attribute-emission-material";
import { attachChainMaceRoughnessAttribute, makeChainMaceMaterial } from "./chain-mace-material";
import { makeChromeCrayonMaterial } from "./chrome-crayon-material";
import { makeImagePixelStipplerMaterial } from "./image-pixel-stippler-material";
import { makeBasicBlenderMaterial } from "./blender-basic-material";

type RangeControl = { type?: "range"; name: string; label: string; min: number; max: number; step: number; value: number };
type CheckboxControl = { type: "checkbox"; name: string; label: string; value: boolean };
type TextControl = { type: "text"; name: string; label: string; value: string };
type VectorControl = { type: "vector"; name: string; label: string; value: [number, number, number]; step?: number };
type SelectControl = { type: "select"; name: string; label: string; value: number | string; options: { label: string; value: number | string }[] };
type Control = RangeControl | CheckboxControl | TextControl | VectorControl | SelectControl;
type AssetFont = { url: string; family: string; requiredFor: string; fallback: string };
type Asset = { id: string; title: string; object: string; dump: string; reference: string; blenderStats: { verts: number; faces: number }; note?: string; font?: AssetFont; flatShading?: boolean; localSpace?: boolean; surfaceBounds?: boolean; workbenchColor?: [number, number, number]; material?: "image-pixel-stippler" | "attribute-emission" | "chrome-crayon" | "chain-mace"; controls: Control[] };
type Reply = { id: number; ok: true; soup: TriSoup } | { id: number; ok: false; error: string };

const canvas = document.querySelector<HTMLCanvasElement>("#assets-canvas")!;
const select = document.querySelector<HTMLSelectElement>("#assets-select")!;
const controlsHost = document.querySelector<HTMLElement>("#assets-controls")!;
const reference = document.querySelector<HTMLImageElement>("#assets-reference")!;
const status = document.querySelector<HTMLElement>("#assets-status")!;
const blenderCount = document.querySelector<HTMLElement>("#assets-blender-count")!;
const vmCount = document.querySelector<HTMLElement>("#assets-vm-count")!;
const runtime = document.querySelector<HTMLElement>("#assets-runtime")!;
const reset = document.querySelector<HTMLButtonElement>("#assets-reset")!;
const fontStatus = document.querySelector<HTMLElement>("#assets-font-status")!;
const note = document.querySelector<HTMLElement>("#assets-note")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const room = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(room, .04).texture;
room.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xf1f6ed, 0x172018, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(-4, -6, 9); scene.add(key);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 5000);
const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
const model = new THREE.Group(); scene.add(model);
const material = new THREE.MeshPhysicalMaterial({ color: 0xc8e99b, roughness: .35, metalness: .06, side: THREE.DoubleSide });
let catalog: Asset[] = [], current: Asset, dump: Dump, requestId = 0, appliedId = 0, timer = 0;
const loadedFonts = new Map<string, Promise<boolean>>();

function resize(): void { const box = canvas.getBoundingClientRect(); renderer.setSize(box.width, box.height, false); if(model.children.length)frame();else camera.updateProjectionMatrix(); }
function frame(): void { const bounds = new THREE.Box3().setFromObject(model); if (bounds.isEmpty()) return; const viewport=canvas.getBoundingClientRect();const aspect=viewport.width/Math.max(viewport.height,1);const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),radius=Math.max(size.length()*.5,1);const halfWidth=Math.max(size.x,size.y,size.z,1)*.725;camera.left=-halfWidth;camera.right=halfWidth;camera.top=halfWidth/Math.max(aspect,1e-6);camera.bottom=-camera.top;const direction=new THREE.Vector3(1,-1.25,.85).normalize();camera.position.copy(center).addScaledVector(direction,radius*3);camera.up.set(0,0,1);camera.lookAt(center);camera.near=radius/300;camera.far=radius*100;camera.updateProjectionMatrix();orbit.target.copy(center);orbit.update(); }
function overrides(): Record<string, number | boolean | string | number[]> { const values: Record<string, number | boolean | string | number[]> = {}; for (const control of current.controls) { if(control.name.startsWith("__"))continue;const input=document.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-control="${control.name}"]`); values[control.name]=control.type==="checkbox"?((input as HTMLInputElement|null)?.checked??control.value):control.type==="text"?(input?.value??control.value):control.type==="select"?(typeof control.value==="number"?Number(input?.value??control.value):(input?.value??control.value)):control.type==="vector"?Array.from(document.querySelectorAll<HTMLInputElement>(`[data-control="${control.name}"]`)).sort((a,b)=>Number(a.dataset.axis)-Number(b.dataset.axis)).map((item,index)=>Number(item.value??control.value[index])):rangeOverrideValue(control.value,input?.value,input?.dataset.dirty==="true"); } return values; }
function visibleControls(): Control[] { return current.controls.some((control)=>control.name==="__materialPreview") ? current.controls : [{type:"select",name:"__materialPreview",label:"Shader preview",value:"authored",options:[{label:"Authored Blender constants",value:"authored"},{label:"Normalized geometry diagnostic",value:"diagnostic"}]},...current.controls]; }
function renderControls(): void { const controls=visibleControls();controlsHost.replaceChildren(...controls.map((control) => { const label=document.createElement("label");label.className=`assets-control assets-${control.type??"range"}`;const span=document.createElement("span");span.textContent=control.label;const row=document.createElement("div");const input=document.createElement("input");input.dataset.control=control.name;if(control.type==="checkbox"){input.type="checkbox";input.checked=control.value;input.style.width="18px";input.style.height="18px";input.addEventListener("change",queue);row.append(input);}else if(control.type==="text"){input.type="text";input.value=control.value;input.spellcheck=false;input.addEventListener("input",queue);row.append(input);}else if(control.type==="select"){const menu=document.createElement("select");menu.dataset.control=control.name;for(const item of control.options){const option=document.createElement("option");option.value=String(item.value);option.textContent=item.label;option.selected=item.value===control.value;menu.append(option);}menu.addEventListener("change",queue);row.append(menu);}else if(control.type==="vector"){control.value.forEach((value,axis)=>{const component=input.cloneNode() as HTMLInputElement;component.type="number";component.dataset.axis=String(axis);component.step=String(control.step??.01);component.value=String(value);component.setAttribute("aria-label",`${control.label} ${"XYZ"[axis]}`);component.addEventListener("input",queue);row.append(component);});}else{input.type="range";input.min=String(control.min);input.max=String(control.max);input.step=String(control.step);input.value=String(control.value);const output=document.createElement("output");output.value=Number(control.value).toFixed(control.step < .001 ? 3 : 2);input.addEventListener("input",()=>{input.dataset.dirty="true";output.value=Number(input.value).toFixed(control.step < .001 ? 3 : 2);queue();});row.append(input,output);}label.append(span,row);return label;})); reset.hidden=!controls.length; }
function makeMesh(soup: TriSoup): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  for (const [name, attribute] of Object.entries(soup.attributes ?? {})) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  if (current.surfaceBounds && soup.indices.length) {
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const index of soup.indices) {
      const offset = index * 3;
      point.set(soup.positions[offset], soup.positions[offset + 1], soup.positions[offset + 2]);
      bounds.expandByPoint(point);
    }
    geometry.boundingBox = bounds;
  }
  const diagnosticMaterial = (): THREE.MeshPhysicalMaterial => {
    const result = material.clone();
    if (current.workbenchColor) result.color.setRGB(...current.workbenchColor);
    result.flatShading = current.flatShading ?? false;
    return result;
  };
  const previewMode=document.querySelector<HTMLSelectElement>('[data-control="__materialPreview"]')?.value;
  const useAuthored=previewMode!=="diagnostic";
  const source = (dump.objects as any[] | undefined)?.find((object) => object.name === current.object);
  const materials: THREE.Material[]=[];
  if(useAuthored&&current.material==="chain-mace")attachChainMaceRoughnessAttribute(geometry,soup.groups);
  if(useAuthored&&soup.groups.length){
    for(const [index,group] of soup.groups.entries()){
      geometry.addGroup(group.start,group.count,index);
      const materialName=group.material??(current.material==="chain-mace"?soup.groups.find((candidate)=>candidate.material)?.material:"")??"";
      const authored=current.material==="image-pixel-stippler"
        ? makeImagePixelStipplerMaterial(dump,geometry,group.material??"")
        : current.material==="chain-mace"
          ? makeChainMaceMaterial(dump,geometry,materialName)
        : current.material==="chrome-crayon"
          ? makeChromeCrayonMaterial(dump,geometry,group.material??"")
        : current.material==="attribute-emission"
          ? makeAttributeEmissionMaterial(dump,geometry,group.material??"")
          : makeAttributeEmissionMaterial(dump,geometry,group.material??"")
            ?? makeChromeCrayonMaterial(dump,geometry,group.material??"")
            ?? makeBasicBlenderMaterial(dump,group.material??"");
      if(authored instanceof THREE.MeshStandardMaterial)authored.flatShading=current.flatShading??false;
      materials.push(authored??diagnosticMaterial());
    }
  }
  if(!materials.length)materials.push(diagnosticMaterial());
  const mesh = new THREE.Mesh(geometry, materials.length===1?materials[0]:materials);
  if (!current.localSpace && source?.rotation) mesh.rotation.set(Number(source.rotation[0] ?? 0), Number(source.rotation[1] ?? 0), Number(source.rotation[2] ?? 0));
  if (!current.localSpace && source?.scale) mesh.scale.set(Number(source.scale[0] ?? 1), Number(source.scale[1] ?? 1), Number(source.scale[2] ?? 1));
  return mesh;
}
async function prepareFont(asset: Asset): Promise<void> {
  const font=asset.font;
  if(!font){fontStatus.hidden=true;fontStatus.textContent="";fontStatus.className="";return;}
  fontStatus.hidden=false;fontStatus.className="loading";fontStatus.style.fontFamily="";
  fontStatus.textContent=`${font.family} TTF is required for ${font.requiredFor}. Loading supplied font…`;
  let loading=loadedFonts.get(font.url);
  if(!loading){loading=(async()=>{try{const face=await new FontFace(font.family,`url(${JSON.stringify(publicUrl(font.url))})`).load();document.fonts.add(face);return true;}catch{return false;}})();loadedFonts.set(font.url,loading);}
  const loaded=await loading;if(current!==asset)return;
  fontStatus.className=loaded?"loaded":"fallback";
  fontStatus.style.fontFamily=loaded?`"${font.family}", ui-monospace, monospace`:"";
  fontStatus.textContent=loaded?`${font.family} TTF loaded · GN geometry uses its extracted outlines.`:`${font.family} TTF unavailable · ${font.fallback}`;
}
async function evaluate(): Promise<void> { const id=++requestId; status.classList.remove("ready");status.textContent="Evaluating extracted graph…";const started=performance.now();const worker=new Worker(new URL("./blend-import-worker.ts",import.meta.url),{type:"module",name:"chrome-assets"});const result=await new Promise<Reply>((resolve,reject)=>{worker.onmessage=(event:MessageEvent<Reply>)=>resolve(event.data);worker.onerror=(event)=>reject(new Error(event.message));worker.postMessage({id,dump,object:current.object,overrides:overrides()});});worker.terminate();if(!result.ok)throw new Error(result.error);if(result.id<appliedId)return;appliedId=result.id;model.clear();model.add(makeMesh(result.soup));frame();vmCount.textContent=`${result.soup.stats.verts.toLocaleString()} verts · ${result.soup.stats.faces.toLocaleString()} faces`;runtime.textContent=`${((performance.now()-started)/1000).toFixed(2)}s · ${current.object}`;const exact=result.soup.stats.verts===current.blenderStats.verts&&result.soup.stats.faces===current.blenderStats.faces;status.classList.toggle("ready",exact);status.textContent=exact?"Topology counts match Blender":current.note??"Geometry differs from Blender reference"; }
function queue(): void { clearTimeout(timer);timer=window.setTimeout(()=>void evaluate().catch((error)=>status.textContent=String(error)),100); }
async function choose(): Promise<void> { current=catalog.find((item)=>item.id===select.value)??catalog[0];const asset=current;window.dispatchEvent(new CustomEvent("chrome-assets-selection-change",{detail:{id:current.id,title:current.title,object:current.object,dumpUrl:current.dump}}));reference.src=publicUrl(current.reference);blenderCount.textContent=`${current.blenderStats.verts.toLocaleString()} verts · ${current.blenderStats.faces.toLocaleString()} faces`;note.textContent=current.note??"";note.hidden=!current.note;renderControls();await prepareFont(asset);if(current!==asset)return;dump=await fetch(publicUrl(current.dump),{cache:"no-store"}).then((response)=>response.json());await evaluate(); }
select.addEventListener("change",()=>{const url=new URL(location.href);url.searchParams.set("asset",select.value);history.replaceState(null,"",url);void choose();});reset.addEventListener("click",()=>{renderControls();queue();});addEventListener("resize",resize);renderer.setAnimationLoop(()=>{orbit.update();renderer.render(scene,camera);});
fetch(publicUrl("dojo/chrome-assets/catalog.json"),{cache:"no-store"}).then((response)=>response.json()).then((items:Asset[])=>{catalog=items;for(const item of catalog){const option=document.createElement("option");option.value=item.id;option.textContent=item.title;select.append(option);}const requested=new URLSearchParams(location.search).get("asset");if(requested&&catalog.some((item)=>item.id===requested))select.value=requested;resize();return choose();}).catch((error)=>status.textContent=String(error));

window.addEventListener("type-pixel-brush-graph-change", (event) => {
  if (current?.id !== "type-pixel-brush") return;
  const next = (event as CustomEvent<{ dump?: Dump }>).detail?.dump;
  if (!next) return;
  dump = next;
  queue();
});
