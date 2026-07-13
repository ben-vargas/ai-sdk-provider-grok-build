import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
  SharedV3Warning,
} from "@ai-sdk/provider";
import type { AcpContentBlock } from "./acp/protocol.js";

export interface MappedGrokBuildPrompt {
  prompt: AcpContentBlock[];
  warnings: SharedV3Warning[];
}

function unsupported(feature: string, details: string): SharedV3Warning {
  return { type: "unsupported", feature, details };
}

function compatibility(feature: string, details: string): SharedV3Warning {
  return { type: "compatibility", feature, details };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolOutputText(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return safeStringify(output.value);
    case "execution-denied":
      return `execution denied${output.reason ? `: ${output.reason}` : ""}`;
    case "content":
      return output.value
        .map((part) =>
          part.type === "text"
            ? part.text
            : `[${part.type} result content omitted]`,
        )
        .join("\n");
  }
}

function isTextualMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    normalized === "text" ||
    normalized.startsWith("text/") ||
    /^(application\/(json|.*\+json|xml|.*\+xml|javascript|yaml|x-yaml))$/.test(
      normalized,
    )
  );
}

function fileUri(
  messageIndex: number,
  partIndex: number,
  filename?: string,
): string {
  const name = encodeURIComponent(filename ?? `file-${partIndex}`);
  return `grok-build://prompt/${messageIndex}/${partIndex}/${name}`;
}

async function readTextUrl(url: URL): Promise<string | undefined> {
  if (url.protocol !== "file:") return undefined;
  return await fs.readFile(fileURLToPath(url), "utf8");
}

async function mapFilePart(
  part: LanguageModelV3FilePart,
  messageIndex: number,
  partIndex: number,
  warnings: SharedV3Warning[],
): Promise<AcpContentBlock | undefined> {
  const topLevelType = part.mediaType.toLowerCase().split("/")[0];
  if (topLevelType === "image" || topLevelType === "audio") {
    warnings.push(
      unsupported(
        `${topLevelType} input`,
        `Grok Build 0.2.99 ACP advertises ${topLevelType}: false; the file was omitted.`,
      ),
    );
    return undefined;
  }
  if (!isTextualMediaType(part.mediaType)) {
    warnings.push(
      unsupported(
        "binary file input",
        `ACP embeddedContext does not establish support for '${part.mediaType}'; the file was omitted.`,
      ),
    );
    return undefined;
  }

  let text: string | undefined;
  let uri = fileUri(messageIndex, partIndex, part.filename);
  try {
    if (part.data instanceof URL) {
      text = await readTextUrl(part.data);
      uri = part.data.toString();
      if (text === undefined) {
        warnings.push(
          unsupported(
            "remote file URL",
            `ACP does not expose verified remote URL fetching for '${part.data.toString()}'; the file was omitted.`,
          ),
        );
      }
    } else {
      text =
        typeof part.data === "string"
          ? Buffer.from(part.data, "base64").toString("utf8")
          : Buffer.from(part.data).toString("utf8");
    }
  } catch (error) {
    warnings.push(
      unsupported(
        "file input",
        `The textual file could not be read and was omitted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return undefined;
  }

  return text === undefined
    ? undefined
    : {
        type: "resource",
        resource: { uri, text, mimeType: part.mediaType },
      };
}

function warnProviderOptions(
  value: unknown,
  warnings: SharedV3Warning[],
): void {
  if (value && typeof value === "object" && Object.keys(value).length > 0) {
    warnings.push(
      compatibility(
        "message providerOptions",
        "Only call-level providerOptions['grok-build'] are interpreted; message- and part-level options were ignored.",
      ),
    );
  }
}

export async function mapGrokBuildPrompt(
  prompt: LanguageModelV3Prompt,
  responseFormat?: LanguageModelV3CallOptions["responseFormat"],
): Promise<MappedGrokBuildPrompt> {
  const blocks: AcpContentBlock[] = [];
  const warnings: SharedV3Warning[] = [];
  const addText = (text: string): void => {
    if (!text) return;
    const previous = blocks.at(-1);
    if (previous?.type === "text") previous.text += text;
    else blocks.push({ type: "text", text });
  };

  for (const [messageIndex, message] of prompt.entries()) {
    warnProviderOptions(message.providerOptions, warnings);
    if (message.role === "system") {
      addText(`[SYSTEM]\n${message.content}\n[/SYSTEM]\n`);
      continue;
    }

    addText(`[${message.role.toUpperCase()}]\n`);
    for (const [partIndex, part] of message.content.entries()) {
      warnProviderOptions(part.providerOptions, warnings);
      switch (part.type) {
        case "text":
          addText(part.text);
          break;
        case "file": {
          const mapped = await mapFilePart(
            part,
            messageIndex,
            partIndex,
            warnings,
          );
          if (mapped) blocks.push(mapped);
          break;
        }
        case "reasoning":
          warnings.push(
            compatibility(
              "reasoning history",
              "Private reasoning history cannot be restored through ACP and was omitted.",
            ),
          );
          break;
        case "tool-call":
          addText(
            `\n[TOOL CALL ${part.toolName} ${part.toolCallId}]\n${safeStringify(part.input)}\n[/TOOL CALL]\n`,
          );
          warnings.push(
            compatibility(
              "tool-call history",
              "Prior tool calls were serialized as transcript text; execution identity was not restored.",
            ),
          );
          break;
        case "tool-result":
          addText(
            `\n[TOOL RESULT ${part.toolName} ${part.toolCallId}]\n${toolOutputText(part.output)}\n[/TOOL RESULT]\n`,
          );
          warnings.push(
            compatibility(
              "tool-result history",
              "Prior tool results were serialized as transcript text; provider-executed state was not restored.",
            ),
          );
          break;
        case "tool-approval-response":
          addText(
            `\n[TOOL APPROVAL ${part.approvalId}: ${part.approved ? "approved" : "denied"}${part.reason ? ` - ${part.reason}` : ""}]\n`,
          );
          warnings.push(
            compatibility(
              "tool approval history",
              "The approval was retained only as transcript text and cannot answer a live ACP permission request.",
            ),
          );
          break;
      }
    }
    addText(`\n[/${message.role.toUpperCase()}]\n`);
  }

  if (responseFormat?.type === "json") {
    const schema = responseFormat.schema
      ? `\nJSON Schema:\n${JSON.stringify(responseFormat.schema)}`
      : "";
    addText(
      `\n[OUTPUT FORMAT]\nReturn only valid JSON with no Markdown fences.${responseFormat.name ? ` Output name: ${responseFormat.name}.` : ""}${responseFormat.description ? ` ${responseFormat.description}` : ""}${schema}\n[/OUTPUT FORMAT]\n`,
    );
    warnings.push(
      compatibility(
        "responseFormat json",
        "Grok ACP has no schema channel. JSON output is prompt-engineered and not guaranteed to conform to the schema.",
      ),
    );
  }

  return { prompt: blocks, warnings };
}

export function mapGrokBuildCallWarnings(
  options: LanguageModelV3CallOptions,
): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  const unsupportedSettings: Array<
    [keyof LanguageModelV3CallOptions, unknown]
  > = [
    ["maxOutputTokens", options.maxOutputTokens],
    ["temperature", options.temperature],
    ["topP", options.topP],
    ["topK", options.topK],
    ["presencePenalty", options.presencePenalty],
    ["frequencyPenalty", options.frequencyPenalty],
    ["stopSequences", options.stopSequences],
    ["seed", options.seed],
    ["headers", options.headers],
  ];
  for (const [feature, value] of unsupportedSettings) {
    if (value !== undefined) {
      warnings.push(
        unsupported(
          feature,
          `Grok ACP exposes no ${feature} input; the setting was ignored.`,
        ),
      );
    }
  }
  if (options.tools && options.tools.length > 0) {
    warnings.push(
      unsupported(
        "tools",
        "ACP has no client-defined tool registration/result channel. Grok runtime tools remain available, but AI SDK tool definitions were ignored.",
      ),
    );
  }
  if (options.toolChoice && options.toolChoice.type !== "auto") {
    warnings.push(
      unsupported(
        "toolChoice",
        `ACP cannot enforce toolChoice '${options.toolChoice.type}'; it was ignored.`,
      ),
    );
  }
  return warnings;
}
