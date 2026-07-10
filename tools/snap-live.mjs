import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:"shell", args:["--enable-unsafe-swiftshader","--no-sandbox"], defaultViewport:{width:1200,height:800} });
const page = await browser.newPage();
page.on("console",m=>{const t=m.text(); if(t.includes("BINLIVE")||t.includes("baked")) console.log("[c]",t);});
await page.goto("http://localhost:5173/bin/live",{waitUntil:"domcontentloaded"});
await new Promise(r=>setTimeout(r,4000)); // initial bake
// set a named slider by its label
async function setParam(label,val){
  await page.evaluate(({label,val})=>{
    const ctrls=[...document.querySelectorAll('.lil-gui .controller')];
    const c=ctrls.find(c=>c.querySelector('.name')?.textContent===label);
    const inp=c?.querySelector('input[type=number]')||c?.querySelector('input');
    if(inp){ inp.value=String(val); inp.dispatchEvent(new Event('input',{bubbles:true})); inp.dispatchEvent(new Event('change',{bubbles:true})); inp.blur(); }
  },{label,val});
  await new Promise(r=>setTimeout(r,3500));
}
await setParam("Size X", 2.6); await page.screenshot({path:process.argv[2]});
await setParam("Size X", 0.708); await setParam("Size Y", 2.4); await page.screenshot({path:process.argv[3]});
console.log("LIVE_OK");
await browser.close();
