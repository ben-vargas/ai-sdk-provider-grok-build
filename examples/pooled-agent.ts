import { generateText } from "ai";
import { createGrokAgent } from "../dist/index.js";

const agent = createGrokAgent({
  defaultSettings: { cwd: process.cwd(), reasoningEffort: "medium" },
});

try {
  const first = await generateText({
    model: agent("grok-4.6"),
    prompt: "Name the package in package.json.",
  });
  const second = await generateText({
    model: agent("grok-4.6"),
    prompt: "Name the package license.",
  });
  console.log(first.text);
  console.log(second.text);
} finally {
  await agent.close();
}
