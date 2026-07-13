import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import { GrokBuildLanguageModel } from "./grok-build-language-model.js";
import {
  mergeGrokBuildSettings,
  validateGrokBuildSettings,
  type GrokBuildSettings,
} from "./settings.js";

export interface GrokBuildProvider extends ProviderV4 {
  (modelId?: string, settings?: GrokBuildSettings): LanguageModelV4;
  languageModel(
    modelId?: string,
    settings?: GrokBuildSettings,
  ): LanguageModelV4;
  chat(modelId?: string, settings?: GrokBuildSettings): LanguageModelV4;
  embeddingModel(modelId: string): never;
  imageModel(modelId: string): never;
}

export function createGrokBuild(
  settings: GrokBuildSettings = {},
): GrokBuildProvider {
  const defaults = validateGrokBuildSettings(settings);

  const createModel = (
    modelId = defaults.defaultModel ?? "default",
    modelSettings: GrokBuildSettings = {},
  ): LanguageModelV4 => {
    if (!modelId.trim()) {
      throw new NoSuchModelError({ modelId, modelType: "languageModel" });
    }
    return new GrokBuildLanguageModel({
      id: modelId,
      settings: mergeGrokBuildSettings(defaults, modelSettings),
    });
  };

  const provider = function grokBuildModel(
    modelId?: string,
    modelSettings?: GrokBuildSettings,
  ): LanguageModelV4 {
    if (new.target) {
      throw new Error(
        "The Grok Build model function cannot be called with the new keyword.",
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

  return provider as GrokBuildProvider;
}

export const grokBuild = createGrokBuild();
