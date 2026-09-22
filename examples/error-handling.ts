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

  // Grok 1.x advertises valid choices before the provider calls the setter. A
  // bad ID can therefore warn and retain the advertised current model.
  const modelWarnings = (result.warnings ?? []).filter(
    (warning) => warning.feature === "model selection",
  );
  if (modelWarnings.length === 0) {
    throw new Error(
      "The bad model ID produced neither an error nor a model-selection warning.",
    );
  }

  console.log(
    "Grok did not select the unavailable model and retained its advertised current model.",
  );
  console.log("Expected model-selection warnings:", modelWarnings);
}

main().catch((error: unknown) => {
  console.error(
    "Error-handling example failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
