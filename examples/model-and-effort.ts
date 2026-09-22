import { generateText } from "ai";
import { createGrokAgent } from "../dist/index.js";

const agent = createGrokAgent();

try {
  const result = await generateText({
    model: agent("grok-4.6"),
    reasoning: "high",
    prompt: "Explain the package entry point in one sentence.",
    providerOptions: {
      "grok-build": { model: "grok-4.6", reasoningEffort: "low" },
    },
  });
  console.log(result.text);
  console.log(result.finalStep.providerMetadata?.["grok-build"]);
} finally {
  await agent.close();
}
