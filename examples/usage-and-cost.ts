import { generateText } from "ai";
import { grokBuild } from "../dist/index.js";

const result = await generateText({
  model: grokBuild(),
  prompt: "Reply with exactly three words about testing.",
});

const metadata = result.providerMetadata?.["grok-build"];

console.log("Text:", result.text.trim());
console.log("Usage:", {
  inputTokens: result.usage.inputTokens,
  cachedReadTokens: result.usage.inputTokenDetails.cacheReadTokens,
  outputTokens: result.usage.outputTokens,
  reasoningTokens: result.usage.outputTokenDetails.reasoningTokens,
  totalTokens: result.usage.totalTokens,
});
console.log("Per-model usage:", metadata?.modelUsage ?? "not reported");
console.log("Cost: not reported by the Grok ACP usage payload");
