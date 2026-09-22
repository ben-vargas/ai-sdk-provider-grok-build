import { generateText, Output } from "ai";
import { z } from "zod";
import { grokExec } from "../dist/index.js";

const result = await generateText({
  model: grokExec("grok-4.6"),
  output: Output.object({
    schema: z.object({
      packageName: z.string(),
      scripts: z.array(z.string()),
    }),
  }),
  prompt: "Read package.json and summarize its package name and script names.",
});

console.log(result.output);
