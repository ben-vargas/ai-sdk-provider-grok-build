import { generateText } from "ai";
import { grokBuild } from "../dist/index.js";

const result = await generateText({
  model: grokBuild(),
  prompt: "Reply with exactly: hello",
});

console.log(result.text.trim());
console.log("Session:", result.providerMetadata?.["grok-build"]?.sessionId);
