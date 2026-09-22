import { createGrokExec } from "../dist/index.js";

const explicit = createGrokExec({
  defaultSettings: { executablePath: "/opt/grok/bin/grok" },
});
const npxFallback = createGrokExec({
  defaultSettings: { allowNpx: true },
});
const trustedProjectPackage = createGrokExec({
  defaultSettings: { cwd: process.cwd(), allowPackageBin: true },
});

console.log(explicit("grok-4.6").modelId);
console.log(npxFallback("grok-4.6").modelId);
console.log(trustedProjectPackage("grok-4.6").modelId);
