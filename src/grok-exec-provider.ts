import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import { GrokExecLanguageModel } from "./grok-exec-language-model.js";
import {
  mergeGrokExecSettings,
  validateGrokExecSettings,
  type GrokExecSettings,
} from "./settings.js";

export interface GrokExecProvider extends ProviderV4 {
  (modelId?: string, settings?: GrokExecSettings): LanguageModelV4;
  languageModel(modelId?: string, settings?: GrokExecSettings): LanguageModelV4;
  chat(modelId?: string, settings?: GrokExecSettings): LanguageModelV4;
  embeddingModel(modelId: string): never;
  imageModel(modelId: string): never;
}

export interface CreateGrokExecOptions {
  defaultSettings?: GrokExecSettings;
}

export function createGrokExec(
  options: CreateGrokExecOptions = {},
): GrokExecProvider {
  const defaults = validateGrokExecSettings(options.defaultSettings ?? {});
  const createModel = (
    modelId = defaults.defaultModel ?? "default",
    modelSettings: GrokExecSettings = {},
  ): LanguageModelV4 => {
    if (!modelId.trim()) {
      throw new NoSuchModelError({ modelId, modelType: "languageModel" });
    }
    return new GrokExecLanguageModel({
      id: modelId,
      settings: mergeGrokExecSettings(defaults, modelSettings),
    });
  };
  const provider = function grokExecModel(
    modelId?: string,
    modelSettings?: GrokExecSettings,
  ): LanguageModelV4 {
    if (new.target) {
      throw new Error(
        "The Grok Exec model function cannot be called with the new keyword.",
      );
    }
    return createModel(modelId, modelSettings);
  };
  provider.specificationVersion = "v4" as const;
  provider.languageModel = createModel;
  provider.chat = createModel;
  provider.embeddingModel = (modelId: string): never => {
    throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
  };
  provider.imageModel = (modelId: string): never => {
    throw new NoSuchModelError({ modelId, modelType: "imageModel" });
  };
  return provider as GrokExecProvider;
}

export const grokExec = createGrokExec();
