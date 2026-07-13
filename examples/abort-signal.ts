import { streamText } from "ai";
import { grokBuild } from "../dist/index.js";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let fallbackTriggered = false;
  const fallbackTimer = setTimeout(() => {
    fallbackTriggered = true;
    controller.abort();
  }, 20_000);
  let abortObserved = false;
  let streamedText = "";

  try {
    const result = streamText({
      model: grokBuild(),
      prompt:
        "Write the numbers 1 through 100, one per line. Begin immediately with 1.",
      abortSignal: controller.signal,
    });

    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        if (streamedText.length === 0) {
          process.stdout.write("Partial response: ");
        }
        streamedText += part.text;
        process.stdout.write(part.text);
        if (!controller.signal.aborted) controller.abort();
      } else if (part.type === "abort") {
        abortObserved = true;
      } else if (part.type === "error") {
        if (!isAbortError(part.error)) throw part.error;
        abortObserved = true;
      }
    }
  } catch (error) {
    if (!isAbortError(error)) throw error;
    abortObserved = true;
  } finally {
    clearTimeout(fallbackTimer);
  }

  if (streamedText.length === 0) {
    throw new Error(
      fallbackTriggered
        ? "The fallback timeout fired before the stream produced text."
        : "The stream produced no text before it ended.",
    );
  }

  process.stdout.write("\n");
  console.log("Partial characters:", streamedText.length);
  console.log(
    abortObserved
      ? "Outcome: request aborted after streaming began."
      : "Outcome: request completed before cancellation took effect.",
  );
}

main().catch((error: unknown) => {
  console.error(
    "Abort example failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
