import type { GrokBuildLogger } from "./settings.js";

const noopLogger: GrokBuildLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const stderrLogger: GrokBuildLogger = {
  debug: (message) => process.stderr.write(`[grok-build:debug] ${message}\n`),
  info: (message) => process.stderr.write(`[grok-build:info] ${message}\n`),
  warn: (message) => process.stderr.write(`[grok-build:warn] ${message}\n`),
  error: (message) => process.stderr.write(`[grok-build:error] ${message}\n`),
};

export function resolveGrokLogger(
  logger: GrokBuildLogger | false | undefined,
  verbose: boolean | undefined,
): GrokBuildLogger {
  if (logger === false) return noopLogger;
  return logger ?? (verbose ? stderrLogger : noopLogger);
}
