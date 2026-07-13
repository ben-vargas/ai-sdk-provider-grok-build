import { generateText } from "ai";
import { grokBuild } from "../dist/index.js";

try {
  const result = await generateText({
    model: grokBuild("not-a-real-grok-model"),
    prompt: "Reply only: hello",
  });

  // Grok ACP 0.2.99 has no verified model setter. A bad requested model can
  // therefore complete with the runtime model and a compatibility warning.
  const modelWarnings = (result.warnings ?? []).filter(
    (warning) =>
      warning.type === "compatibility" && warning.feature === "model selection",
  );
  if (modelWarnings.length === 0) {
    throw new Error(
      "The bad model ID produced neither an error nor a model-selection warning.",
    );
  }

  console.log("Request used the runtime model instead of the bad model ID.");
  console.log("Warnings:", modelWarnings);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Bad model request failed:", message);
}
