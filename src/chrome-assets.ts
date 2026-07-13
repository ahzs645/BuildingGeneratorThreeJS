import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { publicUrl } from "./base-url";
import type { Dump, TriSoup } from "./gnvm/index";

type Control = { name: string; label: string; min: number; max: number; step: number; value: number };
type Asset = { id: string; title: string; object: string; dump: string; reference: string; blenderStats: { verts: number; faces: number }; controls: Control[] };
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

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xf1f6ed, 0x172018, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(-4, -6, 9); scene.add(key);
const camera = new THREE.PerspectiveCamera(38, 1, .01, 5000);
const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
const model = new THREE.Group(); scene.add(model);
const material = new THREE.MeshPhysicalMaterial({ color: 0xc8e99b, roughness: .35, metalness: .06, side: THREE.DoubleSide });
let catalog: Asset[] = [], current: Asset, dump: Dump, requestId = 0, appliedId = 0, timer = 0;

function resize(): void { const box = canvas.getBoundingClientRect(); renderer.setSize(box.width, box.height, false); camera.aspect = box.width / Math.max(box.height, 1); camera.updateProjectionMatrix(); }
function frame(): void { const box = new THREE.Box3().setFromObject(model); if (box.isEmpty()) return; const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.length() * .5, 1); camera.position.set(center.x, center.y - radius * 1.6, center.z + radius * 1.1); camera.near=radius/300;camera.far=radius*100;camera.updateProjectionMatrix();orbit.target.copy(center);orbit.update(); }
function overrides(): Record<string, number> { const values: Record<string, number> = {}; for (const control of current.controls) values[control.name] = Number(document.querySelector<HTMLInputElement>(`[data-control="${control.name}"]`)?.value ?? control.value); return values; }
function renderControls(): void { controlsHost.replaceChildren(...current.controls.map((control) => { const label=document.createElement("label");label.className="assets-control";const span=document.createElement("span");span.textContent=control.label;const row=document.createElement("div");const input=document.createElement("input");input.type="range";input.min=String(control.min);input.max=String(control.max);input.step=String(control.step);input.value=String(control.value);input.dataset.control=control.name;const output=document.createElement("output");output.value=Number(control.value).toFixed(control.step < .001 ? 3 : 2);input.addEventListener("input",()=>{output.value=Number(input.value).toFixed(control.step < .001 ? 3 : 2);queue();});row.append(input,output);label.append(span,row);return label;})); reset.hidden=!current.controls.length; }
function makeMesh(soup: TriSoup): THREE.Mesh { const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.BufferAttribute(soup.positions,3));geometry.setAttribute("normal",new THREE.BufferAttribute(soup.normals,3));geometry.setIndex(new THREE.BufferAttribute(soup.indices,1));return new THREE.Mesh(geometry,material); }
async function evaluate(): Promise<void> { const id=++requestId; status.classList.remove("ready");status.textContent="Evaluating extracted graph…";const started=performance.now();const worker=new Worker(new URL("./blend-import-worker.ts",import.meta.url),{type:"module",name:"chrome-assets"});const result=await new Promise<Reply>((resolve,reject)=>{worker.onmessage=(event:MessageEvent<Reply>)=>resolve(event.data);worker.onerror=(event)=>reject(new Error(event.message));worker.postMessage({id,dump,object:current.object,overrides:overrides()});});worker.terminate();if(!result.ok)throw new Error(result.error);if(result.id<appliedId)return;appliedId=result.id;model.clear();model.add(makeMesh(result.soup));frame();vmCount.textContent=`${result.soup.stats.verts.toLocaleString()} verts · ${result.soup.stats.faces.toLocaleString()} faces`;runtime.textContent=`${((performance.now()-started)/1000).toFixed(2)}s · ${current.object}`;const exact=result.soup.stats.verts===current.blenderStats.verts&&result.soup.stats.faces===current.blenderStats.faces;status.classList.toggle("ready",exact);status.textContent=exact?"Counts match Blender":"Geometry differs from Blender reference"; }
function queue(): void { clearTimeout(timer);timer=window.setTimeout(()=>void evaluate().catch((error)=>status.textContent=String(error)),100); }
async function choose(): Promise<void> { current=catalog.find((item)=>item.id===select.value)??catalog[0];reference.src=publicUrl(current.reference);blenderCount.textContent=`${current.blenderStats.verts.toLocaleString()} verts · ${current.blenderStats.faces.toLocaleString()} faces`;renderControls();dump=await fetch(publicUrl(current.dump),{cache:"no-store"}).then((response)=>response.json());await evaluate(); }
select.addEventListener("change",()=>void choose());reset.addEventListener("click",()=>{renderControls();queue();});addEventListener("resize",resize);renderer.setAnimationLoop(()=>{orbit.update();renderer.render(scene,camera);});
fetch(publicUrl("dojo/chrome-assets/catalog.json"),{cache:"no-store"}).then((response)=>response.json()).then((items:Asset[])=>{catalog=items;for(const item of catalog){const option=document.createElement("option");option.value=item.id;option.textContent=item.title;select.append(option);}resize();return choose();}).catch((error)=>status.textContent=String(error));
