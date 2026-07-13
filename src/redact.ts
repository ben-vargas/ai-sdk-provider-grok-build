import type { JsonValue } from "./acp/protocol.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /^(?:authorization|proxyAuthorization|apiKey|xaiApiKey|accessToken|refreshToken|idToken|authToken|bearerToken|password|passwd|secret|clientSecret|credential|credentials|privateKey|cookie|setCookie|token)$/i;
const VALUE_COLLECTION_KEY = /^(?:env|environment|headers)$/i;
const SENSITIVE_NAME =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|private[_-]?key|cookie)/i;

function redactString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`)
    .replace(
      /\b(authorization|xai_api_key|api_key|access_token|refresh_token|password|secret)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_match, name: string, separator: string) =>
        `${name}${separator}${REDACTED}`,
    )
    .replace(
      /\b(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
      `$1${REDACTED}:${REDACTED}@`,
    );
}

function normalizeKey(key: string): string {
  return key.replace(/[-_\s]/g, "");
}

function visit(
  value: unknown,
  seen: WeakSet<object>,
  redactAllValues = false,
): JsonValue | undefined {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string")
    return redactAllValues ? REDACTED : redactString(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map(
      (item) => visit(item, seen, redactAllValues) ?? null,
    );
    seen.delete(value);
    return result;
  }

  const source = value as Record<string, unknown>;
  const namedValueIsSensitive =
    typeof source.name === "string" && SENSITIVE_NAME.test(source.name);
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(source)) {
    const normalizedKey = normalizeKey(key);
    if (redactAllValues && key !== "name") {
      result[key] = REDACTED;
      continue;
    }
    if (
      SENSITIVE_KEY.test(normalizedKey) ||
      (key === "value" && (redactAllValues || namedValueIsSensitive))
    ) {
      result[key] = REDACTED;
      continue;
    }
    const redacted = visit(
      item,
      seen,
      VALUE_COLLECTION_KEY.test(normalizedKey),
    );
    if (redacted !== undefined) result[key] = redacted;
  }
  seen.delete(value);
  return result;
}

/** Creates a JSON-compatible copy with credential-bearing fields and strings removed. */
export function redactSensitiveData(value: unknown): JsonValue | undefined {
  return visit(value, new WeakSet());
}
