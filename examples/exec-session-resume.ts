import { generateText } from "ai";
import { grokExec } from "../dist/index.js";

const first = await generateText({
  model: grokExec("grok-4.6"),
  prompt: "Remember the word marigold. Reply only OK.",
});
const sessionId = first.finalStep.providerMetadata?.["grok-build"]?.sessionId;
if (typeof sessionId !== "string") throw new Error("Missing session ID");

const second = await generateText({
  model: grokExec("grok-4.6", { session: { resume: sessionId } }),
  prompt: "What word did I ask you to remember?",
});
console.log(second.text);
