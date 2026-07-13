import { streamText } from "ai";
import { grokBuild } from "../dist/index.js";

const result = streamText({
  model: grokBuild(),
  prompt: "What is 17 + 25? Think briefly, then give the number.",
  providerOptions: {
    "grok-build": { reasoningEffort: "low" },
  },
});

let reasoningStarted = false;
let answerStarted = false;

for await (const part of result.stream) {
  if (part.type === "reasoning-delta") {
    if (!reasoningStarted) {
      reasoningStarted = true;
      process.stdout.write("Reasoning: ");
    }
    process.stdout.write(part.text);
  } else if (part.type === "text-delta") {
    if (!answerStarted) {
      answerStarted = true;
      process.stdout.write(reasoningStarted ? "\nAnswer: " : "Answer: ");
    }
    process.stdout.write(part.text);
  }
}

process.stdout.write("\n");
