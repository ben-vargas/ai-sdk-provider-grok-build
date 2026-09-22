import { generateText } from "ai";
import { createGrokBuild } from "../dist/index.js";

const grok = createGrokBuild({
  // Provider-wide defaults can be overridden by call-level provider options.
  permissionMode: "default",
});

console.log("Provider default: permissionMode=default");
console.log(
  "Configured call overrides: reasoningEffort=low, permissionMode=bypassPermissions",
);
console.log("Model and reasoning are selected through ACP session config.");

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

const response = result.text.trim();
if (response !== "options received") {
  throw new Error(
    `Expected "options received", received ${JSON.stringify(response)}.`,
  );
}
console.log("Response:", response);
console.log("Warnings:", result.warnings?.length ? result.warnings : "none");
