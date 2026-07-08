import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "shell", args:["--enable-unsafe-swiftshader","--no-sandbox"], defaultViewport:{width:1200,height:800} });
const page = await browser.newPage();
page.on("console",m=>{const t=m.text();if(t.includes("ERROR"))console.log("[c]",t);});
await page.goto("http://localhost:5173/bin-studio.html", { waitUntil:"domcontentloaded" });
await new Promise(r=>setTimeout(r,6000));
async function setSel(v){
  await page.evaluate((val)=>{
    const el=[...document.querySelectorAll('.lil-gui input')].find(i=>i.type==="number");
    if(el){ el.value=String(val); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); el.blur(); }
  }, v);
  await new Promise(r=>setTimeout(r,2500));
}
await setSel(1); await page.screenshot({path: process.argv[2]});
await setSel(9); await page.screenshot({path: process.argv[3]});
console.log("SLIDER_OK");
await browser.close();
