import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const directories = (process.argv.length > 2 ? process.argv.slice(2) : ["public/materialx/generated"])
  .map((directory) => path.resolve(directory));
const shaders = directories.flatMap((directory) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  return Object.entries(manifest.shaders).map(([name, record]) => ({
    name,
    vertex: fs.readFileSync(path.join(directory, record.vertex), "utf8"),
    fragment: fs.readFileSync(path.join(directory, record.fragment), "utf8"),
  }));
});
const executablePath = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(fs.existsSync);
if (!executablePath) throw new Error("Chrome or Chromium is required for the MaterialX ESSL smoke test");

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
try {
  const page = await browser.newPage();
  const results = await page.evaluate((programs) => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) throw new Error("Headless browser did not provide WebGL2");
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
      return shader;
    };
    return programs.map(({ name, vertex, fragment }) => {
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(program) || "program link failed"}`);
      return name;
    });
  }, shaders);
  for (const name of results) console.log(`MATERIALX_ESSL_SMOKE ${name}`);
} finally {
  await browser.close();
}
