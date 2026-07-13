import { streamText } from "ai";
import { createGrokBuild } from "../dist/index.js";

const grok = createGrokBuild({ cwd: process.cwd() });
const result = streamText({
  model: grok(),
  prompt:
    "Use a terminal tool to print the name field from package.json, then report it.",
  providerOptions: {
    "grok-build": { permissionMode: "bypassPermissions" },
  },
});

for await (const part of result.stream) {
  switch (part.type) {
    case "tool-input-start":
      console.log(
        `Tool started: ${part.toolName} (${part.id}), providerExecuted=${part.providerExecuted === true}`,
      );
      break;
    case "tool-input-delta":
      console.log("Tool input:", part.delta);
      break;
    case "tool-call":
      console.log(
        `Tool call: ${part.toolName} (${part.toolCallId}), providerExecuted=${part.providerExecuted === true}`,
      );
      break;
    case "tool-result":
      console.log(
        `Tool result: ${part.toolName} (${part.toolCallId}), providerExecuted=${part.providerExecuted === true}, preliminary=${part.preliminary === true}`,
      );
      console.dir(part.output, { depth: 4 });
      break;
    case "tool-error":
      console.error(
        `Tool error: ${part.toolName} (${part.toolCallId})`,
        part.error,
      );
      break;
    case "text-delta":
      process.stdout.write(part.text);
      break;
    default:
      break;
  }
}

process.stdout.write("\n");
