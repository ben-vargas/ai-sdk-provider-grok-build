import { generateText } from "ai";
import { grokBuild } from "../dist/index.js";

const first = await generateText({
  model: grokBuild(),
  prompt: "Remember the word papaya. Reply only: OK",
});

const sessionId = first.finalStep.providerMetadata?.["grok-build"]?.sessionId;
if (typeof sessionId !== "string") {
  throw new Error("The first call returned no grok-build sessionId.");
}

console.log("Turn 1:", first.text.trim());
console.log("Session:", sessionId);

const second = await generateText({
  model: grokBuild(),
  prompt: "What word did I ask you to remember? Reply with only that word.",
  providerOptions: {
    "grok-build": { session: { resume: sessionId } },
  },
});

console.log("Turn 2:", second.text.trim());
if (second.warnings && second.warnings.length > 0) {
  console.log("Warnings:", second.warnings);
}
