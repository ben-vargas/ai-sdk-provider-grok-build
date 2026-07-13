import { generateText } from "ai";
import { grokBuild } from "../dist/index.js";

const first = await generateText({
  model: grokBuild(),
  prompt: "Remember the word papaya. Reply only: OK",
});

const sessionId = first.providerMetadata?.["grok-build"]?.sessionId;
if (typeof sessionId !== "string") {
  throw new Error("The first call returned no grok-build sessionId.");
}

const firstResponse = first.text.trim();
if (firstResponse !== "OK") {
  throw new Error(
    `Expected the first response to be "OK", received ${JSON.stringify(firstResponse)}.`,
  );
}

console.log("Turn 1:", firstResponse);
console.log("Session:", sessionId);
console.log("Resume: an expected session-load compatibility warning follows.");

const second = await generateText({
  model: grokBuild(),
  prompt: "What word did I ask you to remember? Reply with only that word.",
  providerOptions: {
    "grok-build": { session: { resume: sessionId } },
  },
});

const resumedResponse = second.text.trim().toLowerCase();
if (resumedResponse !== "papaya") {
  throw new Error(
    `Expected the resumed session to return "papaya", received ${JSON.stringify(second.text.trim())}.`,
  );
}

console.log("Turn 2:", resumedResponse);
if (second.warnings && second.warnings.length > 0) {
  console.log("Expected session-load compatibility warnings:", second.warnings);
}
