import { streamText } from "ai";
import { createGrokBuild } from "../dist/index.js";

const expectedPackageName = "ai-sdk-provider-grok-build";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function terminalOutput(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.output_for_prompt === "string") {
    return value.output_for_prompt;
  }
  if (
    Array.isArray(value.output) &&
    value.output.every((item) => typeof item === "number")
  ) {
    return Buffer.from(value.output).toString("utf8");
  }
  return typeof value.output === "string" ? value.output : undefined;
}

async function main(): Promise<void> {
  const grok = createGrokBuild({ cwd: process.cwd() });
  const result = streamText({
    model: grok(),
    prompt:
      "Use one terminal command to print only the name field from package.json, then report it.",
    providerOptions: {
      "grok-build": { permissionMode: "bypassPermissions" },
    },
  });

  const inputDeltas = new Map<string, string>();
  const calls = new Map<
    string,
    {
      name: string;
      input: unknown;
      providerExecuted: boolean;
      result?: unknown;
      resultProviderExecuted?: boolean;
    }
  >();
  let assistantText = "";
  let toolBoundary = false;

  for await (const part of result.stream) {
    switch (part.type) {
      case "tool-input-start":
        toolBoundary = true;
        inputDeltas.set(part.id, "");
        break;
      case "tool-input-delta":
        inputDeltas.set(
          part.id,
          `${inputDeltas.get(part.id) ?? ""}${part.delta}`,
        );
        break;
      case "tool-call": {
        toolBoundary = true;
        const delta = inputDeltas.get(part.toolCallId);
        calls.set(part.toolCallId, {
          name: part.toolName,
          input: delta ? JSON.parse(delta) : part.input,
          providerExecuted: part.providerExecuted === true,
        });
        break;
      }
      case "tool-result": {
        toolBoundary = true;
        const call = calls.get(part.toolCallId);
        if (!call) {
          throw new Error(
            `Received a result for unknown tool ${part.toolCallId}.`,
          );
        }
        call.result = part.output;
        call.resultProviderExecuted = part.providerExecuted === true;
        break;
      }
      case "tool-error":
        throw new Error(
          `Tool ${part.toolName} (${part.toolCallId}) failed: ${String(part.error)}`,
        );
      case "error":
        throw part.error;
      case "text-delta":
        if (toolBoundary && assistantText && !/\s$/.test(assistantText)) {
          assistantText += "\n";
        }
        toolBoundary = false;
        assistantText += part.text;
        break;
      default:
        break;
    }
  }

  if (calls.size !== 1) {
    throw new Error(
      `Expected one provider-executed tool call, saw ${calls.size}.`,
    );
  }
  const [[toolCallId, call]] = calls;
  if (!call.providerExecuted || !call.resultProviderExecuted) {
    throw new Error("The tool call and result were not provider-executed.");
  }
  if (!isRecord(call.result) || call.result.exit_code !== 0) {
    throw new Error(
      "The terminal tool did not return a successful final result.",
    );
  }
  const output = terminalOutput(call.result);
  if (!output?.split(/\r?\n/).includes(expectedPackageName)) {
    throw new Error(
      `The terminal result did not contain ${JSON.stringify(expectedPackageName)}.`,
    );
  }
  if (!assistantText.includes(expectedPackageName)) {
    throw new Error("The assistant response did not report the package name.");
  }

  console.log(`Tool call: ${call.name} (${toolCallId}), providerExecuted=true`);
  console.log("Tool input:", JSON.stringify(call.input));
  console.log(
    `Tool result: ${call.name} (${toolCallId}), providerExecuted=true`,
  );
  console.log("Tool output:", expectedPackageName);
  console.log("Assistant:");
  console.log(assistantText.trim());
}

main().catch((error: unknown) => {
  console.error(
    "Tool activity example failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
