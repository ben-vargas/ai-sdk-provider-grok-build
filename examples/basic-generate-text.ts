import { generateText } from "ai";
import { grokBuild } from "../dist/index.js";

const result = await generateText({
  model: grokBuild(),
  prompt: "Reply with exactly: hello",
});

const response = result.text.trim();
if (response !== "hello") {
  throw new Error(`Expected "hello", received ${JSON.stringify(response)}.`);
}

const sessionId = result.providerMetadata?.["grok-build"]?.sessionId;
if (typeof sessionId !== "string") {
  throw new Error("Grok Build did not return an ACP session ID.");
}

console.log("Response:", response);
console.log("Session:", sessionId);
