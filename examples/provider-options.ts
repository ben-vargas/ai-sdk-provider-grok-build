import { generateText } from "ai";
import { createGrokBuild } from "../dist/index.js";

const grok = createGrokBuild({
  // Provider-wide defaults can be overridden by call-level provider options.
  permissionMode: "default",
});

const result = await generateText({
  model: grok(),
  prompt: "Reply with exactly: options received",
  providerOptions: {
    "grok-build": {
      reasoningEffort: "low",
      permissionMode: "bypassPermissions",
    },
  },
});

console.log(result.text.trim());
console.log("Warnings:", result.warnings);
