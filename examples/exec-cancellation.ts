import { streamText } from "ai";
import { grokExec } from "../dist/index.js";

const controller = new AbortController();
const result = streamText({
  model: grokExec("grok-4.6"),
  prompt: "Count slowly from one to one hundred.",
  abortSignal: controller.signal,
});

try {
  for await (const part of result.stream) {
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
      controller.abort(new Error("Example stops after the first text delta"));
    }
  }
} catch (error) {
  if (!controller.signal.aborted || error !== controller.signal.reason) {
    throw error;
  }
  console.log("\nHeadless execution aborted as expected.");
}
