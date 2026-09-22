import { generateText } from "ai";
import { createGrokExec } from "../dist/index.js";

const grok = createGrokExec({
  defaultSettings: {
    cwd: process.cwd(),
    reasoningEffort: "medium",
    permissionMode: "dontAsk",
    sandbox: "workspace-read",
    allowedTools: ["read_file", "list_dir"],
    disallowedTools: ["shell", "write_file"],
    allowRules: ["read:**"],
    denyRules: ["write:**"],
    maxTurns: 3,
    webSearch: false,
    appendRules: "Do not modify the workspace.",
    noPlan: true,
    noSubagents: true,
  },
});

const result = await generateText({
  model: grok("grok-4.6"),
  prompt: "List the top-level TypeScript configuration files.",
});
console.log(result.text);
