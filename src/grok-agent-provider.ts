import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import { AcpClientPool } from "./acp/client-pool.js";
import { GrokBuildLanguageModel } from "./grok-build-language-model.js";
import {
  mergeGrokBuildSettings,
  validateGrokBuildSettings,
  type GrokAgentSettings,
} from "./settings.js";

export interface GrokAgentProvider extends ProviderV4 {
  (modelId?: string, settings?: GrokAgentSettings): LanguageModelV4;
  languageModel(
    modelId?: string,
    settings?: GrokAgentSettings,
  ): LanguageModelV4;
  chat(modelId?: string, settings?: GrokAgentSettings): LanguageModelV4;
  embeddingModel(modelId: string): never;
  imageModel(modelId: string): never;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CreateGrokAgentOptions {
  defaultSettings?: GrokAgentSettings;
  maxClients?: number;
}

export function createGrokAgent(
  options: CreateGrokAgentOptions = {},
): GrokAgentProvider {
  const defaults = validateGrokBuildSettings(options.defaultSettings ?? {});
  const pool = new AcpClientPool({ maxClients: options.maxClients });

  const createModel = (
    modelId = defaults.defaultModel ?? "default",
    modelSettings: GrokAgentSettings = {},
  ): LanguageModelV4 => {
    if (!modelId.trim()) {
      throw new NoSuchModelError({ modelId, modelType: "languageModel" });
    }
    return new GrokBuildLanguageModel({
      id: modelId,
      settings: mergeGrokBuildSettings(defaults, modelSettings),
      clientFactory: (clientOptions) => pool.acquire(clientOptions),
      disposeClient: false,
      validateCli: true,
    });
  };

  const provider = function grokAgentModel(
    modelId?: string,
    modelSettings?: GrokAgentSettings,
  ): LanguageModelV4 {
    if (new.target) {
      throw new Error(
        "The Grok Agent model function cannot be called with the new keyword.",
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
  const typedProvider = provider as GrokAgentProvider;
  typedProvider.close = async (): Promise<void> => await pool.close();
  typedProvider[Symbol.asyncDispose] = async (): Promise<void> =>
    await pool.close();
  return typedProvider;
}

export const grokAgent = createGrokAgent();
