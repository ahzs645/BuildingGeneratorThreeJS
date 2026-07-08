import puppeteer from "puppeteer-core";

const out = process.argv[2] ?? "shot.png";
const url = process.argv[3] ?? "http://localhost:5173/";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "shell",
  args: ["--enable-unsafe-swiftshader", "--window-size=1500,950", "--no-sandbox"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const errors = [];
page.on("console", msg => console.log("[console]", msg.type(), msg.text()));
page.on("pageerror", err => { errors.push(err.message); console.log("[pageerror]", err.message); });
page.on("requestfailed", req => console.log("[reqfail]", req.failure()?.errorText, req.url()));
page.on("response", res => { if (res.status() >= 400) console.log("[http]", res.status(), res.url()); });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 12000)); // let the kit load + first frames render
await page.screenshot({ path: out });
// Probe the WebGL canvas + any error overlay text
const info = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
  return {
    hasCanvas: !!c,
    canvasSize: c ? `${c.width}x${c.height}` : null,
    glOK: !!gl,
    bodyText: document.body.innerText.slice(0, 300),
  };
});
console.log("PROBE", JSON.stringify(info));
console.log("ERROR_COUNT", errors.length);
await browser.close();
console.log("SNAP_OK", out);
