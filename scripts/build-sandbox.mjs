import { build } from "esbuild";
import { writeFileSync } from "fs";

const r = await build({
  entryPoints: ["lib/sandbox/inside.ts"], bundle: true, write: false, format: "iife", platform: "neutral",
  target: "es2022", minify: true, legalComments: "none",
});
const code = r.outputFiles[0].text;
writeFileSync("lib/sandbox/bundle.gen.ts", `export default ${JSON.stringify(code)};\n`);

await build({
  entryPoints: ["lib/sandbox/server.ts"], bundle: true, outfile: "sandbox-runner.js", platform: "node", format: "cjs",
  target: "node22", external: ["isolated-vm"], legalComments: "none",
});
