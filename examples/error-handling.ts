import { generateText } from "ai";
import { grokBuild } from "../dist/index.js";

async function main(): Promise<void> {
  let result;
  console.log(
    "Invalid model: expecting a request failure or model-selection warning.",
  );
  try {
    result = await generateText({
      model: grokBuild("not-a-real-grok-model"),
      prompt: "Reply only: hello",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("Bad model request failed as expected:", message);
    return;
  }

  // Grok ACP 0.2.99 has no verified model setter. A bad requested model can
  // therefore complete with the runtime model and a model-selection warning.
  const modelWarnings = (result.warnings ?? []).filter(
    (warning) => warning.feature === "model selection",
  );
  if (modelWarnings.length === 0) {
    throw new Error(
      "The bad model ID produced neither an error nor a model-selection warning.",
    );
  }

  console.log("Request used the runtime model instead of the bad model ID.");
  console.log("Expected model-selection warnings:", modelWarnings);
}

main().catch((error: unknown) => {
  console.error(
    "Error-handling example failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
