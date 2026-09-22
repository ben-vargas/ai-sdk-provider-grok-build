export const ACP_AUTHENTICATION_REQUIRED_CODE = -32000;
export const JSON_RPC_INTERNAL_ERROR_CODE = -32603;

export interface GrokAuthenticationRemediationContext {
  authMethod: string;
  code?: string;
  availableMethods?: readonly string[];
}

export function grokAuthenticationRemediation({
  authMethod,
  code,
  availableMethods,
}: GrokAuthenticationRemediationContext): string {
  if (code === "AUTH_METHOD_NOT_AVAILABLE") {
    if (availableMethods?.length === 0) {
      return "Grok advertised no ACP authentication methods. Use the provider-only API-key mode by setting the provider 'apiKey' option, or set 'authMethod' to 'api_key' together with a valid XAI_API_KEY; 'api_key' is not an ACP-advertised method.";
    }
    return "Set the provider 'authMethod' to one of the ACP methods reported in the diagnostic above. Alternatively, use the provider-only API-key mode by setting the provider 'apiKey' option, or set 'authMethod' to 'api_key' together with a valid XAI_API_KEY; 'api_key' is not an ACP-advertised method.";
  }
  if (authMethod === "api_key") {
    return "Verify or replace the provider 'apiKey' value. When supplying the key through the environment, set 'authMethod' to 'api_key' together with a valid XAI_API_KEY.";
  }
  if (authMethod === "cached_token") {
    return "Run 'grok login' to refresh the cached CLI login. To use the provider-only API-key mode instead, set the provider 'apiKey' option, or set 'authMethod' to 'api_key' together with a valid XAI_API_KEY.";
  }
  return "Verify the credentials for the configured provider authentication method. If the method is unavailable, select one of the ACP methods listed by Grok. The provider-only 'api_key' mode is a separate alternative and requires the provider 'apiKey' option or XAI_API_KEY.";
}

const LEGACY_AUTHENTICATION_RPC_METHODS = new Set([
  "authenticate",
  "initialize",
  "session/new",
  "session/load",
  "session/set_config_option",
]);

const LEGACY_AUTHENTICATION_RPC_DIAGNOSTICS = [
  /^\s*(?:(?:internal\s+)?error:\s*)?(?:token|credential)\s+refresh\s+failed\b/i,
  /^\s*(?:(?:internal\s+)?error:\s*)?(?:authentication|login)\s+(?:is\s+)?required\b/i,
  /^\s*(?:(?:internal\s+)?error:\s*)?(?:invalid|expired)\s+access\s+token\b/i,
  /^\s*(?:(?:internal\s+)?error:\s*)?(?:unauthorized|unauthenticated)\s*[.!]?\s*$/i,
  /^\s*(?:(?:internal\s+)?error:\s*)?(?:unauthorized|unauthenticated)\s*:\s*(?:(?:invalid|expired)\s+(?:access\s+)?token|(?:access\s+)?token\s+(?:is\s+)?(?:invalid|expired)|(?:authentication|login)\s+(?:is\s+)?required|please\s+(?:authenticate|log\s+in))[.!]?\s*$/i,
];

export function isLegacyGrokAuthenticationRpcFailure(
  method: string,
  rpcDiagnostics: readonly string[],
): boolean {
  return (
    LEGACY_AUTHENTICATION_RPC_METHODS.has(method) &&
    rpcDiagnostics.some((message) =>
      LEGACY_AUTHENTICATION_RPC_DIAGNOSTICS.some((diagnostic) =>
        diagnostic.test(message),
      ),
    )
  );
}
