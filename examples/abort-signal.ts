import { streamText } from "ai";
import { grokBuild } from "../dist/index.js";

const controller = new AbortController();
const timer = setTimeout(() => controller.abort("example timeout"), 1_000);
let aborted = false;

try {
  const result = streamText({
    model: grokBuild(),
    prompt:
      "Write a numbered list from 1 through 100 with one short fact per item.",
    abortSignal: controller.signal,
  });

  for await (const part of result.stream) {
    if (part.type === "text-delta") process.stdout.write(part.text);
    if (part.type === "abort") aborted = true;
  }
} catch (error) {
  if (!controller.signal.aborted) throw error;
  aborted = true;
} finally {
  clearTimeout(timer);
}

process.stdout.write("\n");
console.log(
  aborted ? "Request aborted." : "Request completed before the timeout.",
);
