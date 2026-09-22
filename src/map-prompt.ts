import { promises as fs } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FilePart,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { AcpContentBlock } from "./acp/protocol.js";

export interface MappedGrokBuildPrompt {
  prompt: AcpContentBlock[];
  warnings: SharedV4Warning[];
}

export interface MappedGrokExecPrompt {
  prompt: string;
  warnings: SharedV4Warning[];
}

function unsupported(feature: string, details: string): SharedV4Warning {
  return { type: "unsupported", feature, details };
}

function compatibility(feature: string, details: string): SharedV4Warning {
  return { type: "compatibility", feature, details };
}

function hasCallerHeaders(
  headers: LanguageModelV4CallOptions["headers"],
): boolean {
  return Object.entries(headers ?? {}).some(
    ([name, value]) =>
      value !== undefined &&
      !(
        name.toLowerCase() === "user-agent" &&
        /^ai\/\d+(?:\.\d+)*(?:[-+][\w.-]+)?$/.test(value)
      ),
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolOutputText(output: LanguageModelV4ToolResultOutput): string {
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
  part: LanguageModelV4FilePart,
  messageIndex: number,
  partIndex: number,
  warnings: SharedV4Warning[],
): Promise<AcpContentBlock | undefined> {
  const topLevelType = part.mediaType.toLowerCase().split("/")[0];
  if (topLevelType === "image" || topLevelType === "audio") {
    warnings.push(
      unsupported(
        `${topLevelType} input`,
        `This provider does not accept ${topLevelType} content through this input mapping; the file was omitted.`,
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
    switch (part.data.type) {
      case "text":
        text = part.data.text;
        break;
      case "data":
        text =
          typeof part.data.data === "string"
            ? Buffer.from(part.data.data, "base64").toString("utf8")
            : Buffer.from(part.data.data).toString("utf8");
        break;
      case "url":
        text = await readTextUrl(part.data.url);
        uri = part.data.url.toString();
        if (text === undefined) {
          warnings.push(
            unsupported(
              "remote file URL",
              `ACP does not expose verified remote URL fetching for '${part.data.url.toString()}'; the file was omitted.`,
            ),
          );
        }
        break;
      case "reference": {
        const reference = part.data.reference["grok-build"];
        if (!reference) {
          warnings.push(
            unsupported(
              "file reference",
              "The file has no grok-build provider reference; it was omitted.",
            ),
          );
          break;
        }
        const referenceUrl = reference.startsWith("file:")
          ? new URL(reference)
          : isAbsolute(reference)
            ? pathToFileURL(reference)
            : undefined;
        if (!referenceUrl) {
          warnings.push(
            unsupported(
              "file reference",
              `The grok-build reference '${reference}' is not a local file path; it was omitted.`,
            ),
          );
          break;
        }
        uri = referenceUrl.toString();
        text = await readTextUrl(referenceUrl);
        break;
      }
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
  warnings: SharedV4Warning[],
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
  prompt: LanguageModelV4Prompt,
  responseFormat?: LanguageModelV4CallOptions["responseFormat"],
): Promise<MappedGrokBuildPrompt> {
  const blocks: AcpContentBlock[] = [];
  const warnings: SharedV4Warning[] = [];
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
        case "reasoning-file":
          warnings.push(
            unsupported(
              "reasoning file history",
              "ACP has no reasoning-file input channel; the part was omitted.",
            ),
          );
          break;
        case "custom":
          warnings.push(
            unsupported(
              "custom prompt part",
              `ACP has no standard input mapping for '${part.kind}'; the part was omitted.`,
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

/** Serialize roles and completed tool history into a headless-safe transcript. */
export async function mapGrokExecPrompt(
  prompt: LanguageModelV4Prompt,
  responseFormat?: LanguageModelV4CallOptions["responseFormat"],
): Promise<MappedGrokExecPrompt> {
  const mapped = await mapGrokBuildPrompt(prompt);
  const transcript = mapped.prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource" && "text" in block.resource) {
        return `\n[FILE ${block.resource.uri}]\n${block.resource.text}\n[/FILE]\n`;
      }
      return "";
    })
    .join("");
  if (responseFormat?.type !== "json" || responseFormat.schema) {
    return { prompt: transcript, warnings: mapped.warnings };
  }
  return {
    prompt: `${transcript}\n[OUTPUT FORMAT]\nReturn only valid JSON with no Markdown fences.${responseFormat.name ? ` Output name: ${responseFormat.name}.` : ""}${responseFormat.description ? ` ${responseFormat.description}` : ""}\n[/OUTPUT FORMAT]\n`,
    warnings: [
      ...mapped.warnings,
      compatibility(
        "schema-less JSON responseFormat",
        "Grok schema-less JSON output uses prompt guidance and is not constrained decoding.",
      ),
    ],
  };
}

export function mapGrokBuildCallWarnings(
  options: LanguageModelV4CallOptions,
): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  const unsupportedSettings: Array<
    [keyof LanguageModelV4CallOptions, unknown]
  > = [
    ["maxOutputTokens", options.maxOutputTokens],
    ["temperature", options.temperature],
    ["topP", options.topP],
    ["topK", options.topK],
    ["presencePenalty", options.presencePenalty],
    ["frequencyPenalty", options.frequencyPenalty],
    ["seed", options.seed],
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
  if (options.stopSequences && options.stopSequences.length > 0) {
    warnings.push(
      unsupported(
        "stopSequences",
        "Grok ACP exposes no stopSequences input; the setting was ignored.",
      ),
    );
  }
  if (hasCallerHeaders(options.headers)) {
    warnings.push(
      unsupported(
        "headers",
        "Grok ACP exposes no headers input; the setting was ignored.",
      ),
    );
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

export function mapGrokExecCallWarnings(
  options: LanguageModelV4CallOptions,
): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  const unsupportedSettings: Array<
    [keyof LanguageModelV4CallOptions, unknown]
  > = [
    ["maxOutputTokens", options.maxOutputTokens],
    ["temperature", options.temperature],
    ["topP", options.topP],
    ["topK", options.topK],
    ["presencePenalty", options.presencePenalty],
    ["frequencyPenalty", options.frequencyPenalty],
    ["seed", options.seed],
  ];
  for (const [feature, value] of unsupportedSettings) {
    if (value !== undefined) {
      warnings.push(
        unsupported(
          feature,
          `Grok CLI headless mode exposes no ${feature} flag; the setting was ignored.`,
        ),
      );
    }
  }
  if (options.stopSequences?.length) {
    warnings.push(
      unsupported(
        "stopSequences",
        "Grok CLI headless mode exposes no stop-sequence flag; the setting was ignored.",
      ),
    );
  }
  if (hasCallerHeaders(options.headers)) {
    warnings.push(
      unsupported(
        "headers",
        "Grok CLI headless mode exposes no request-header input; the headers were ignored.",
      ),
    );
  }
  if (options.tools?.length) {
    warnings.push(
      unsupported(
        "tools",
        "AI SDK tool definitions cannot be registered with the Grok CLI. Grok's provider-executed runtime tools remain available.",
      ),
    );
  }
  if (options.toolChoice && options.toolChoice.type !== "auto") {
    warnings.push(
      unsupported(
        "toolChoice",
        `Grok CLI cannot enforce AI SDK toolChoice '${options.toolChoice.type}'; it was ignored.`,
      ),
    );
  }
  return warnings;
}
