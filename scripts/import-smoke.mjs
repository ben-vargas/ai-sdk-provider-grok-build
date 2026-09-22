import {
  VERSION,
  createGrokAgent,
  createGrokBuild,
  createGrokExec,
} from "../dist/index.js";

if (VERSION !== "1.1.0") throw new Error(`Unexpected VERSION: ${VERSION}`);
for (const [name, value] of Object.entries({
  createGrokBuild,
  createGrokAgent,
  createGrokExec,
})) {
  if (typeof value !== "function") throw new Error(`Missing export: ${name}`);
}

console.log("Package import smoke test passed.");
