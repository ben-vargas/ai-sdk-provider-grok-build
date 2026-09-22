import type { JsonValue } from "./acp/protocol.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const TRUNCATED_OBJECT_KEY = "__truncated__";
const TRUNCATED_STRING_SUFFIX = `…${TRUNCATED}`;
const DIAGNOSTIC_DATA_LIMIT_BYTES = 8 * 1024;
const DIAGNOSTIC_DATA_MAX_DEPTH = 8;
const DIAGNOSTIC_DATA_MAX_ENTRIES = 64;
const DIAGNOSTIC_DATA_MAX_NODES = 256;
const DIAGNOSTIC_DATA_MAX_STRING_BYTES = 1024;
const DIAGNOSTIC_STRING_WORK_CODE_UNITS = DIAGNOSTIC_DATA_MAX_STRING_BYTES * 2;
const DIAGNOSTIC_CLASSIFICATION_CODE_UNITS = 128;
const ANSI_ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;
const SENSITIVE_KEY =
  /^(?:authorization|proxyAuthorization|apiKey|xaiApiKey|accessToken|refreshToken|idToken|authToken|bearerToken|password|passwd|secret|clientSecret|credential|credentials|privateKey|cookie|setCookie|token)$/i;
const VALUE_COLLECTION_KEY = /^(?:env|environment|headers)$/i;
const SENSITIVE_NAME =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|private[_-]?key|cookie)/i;
const INLINE_SENSITIVE_TEXT =
  /\b(https?:\/\/)([^\s/:@]*):([^\s/@]+)@|(?<![A-Za-z0-9_])(["']?)(authorization|proxy[_-]?authorization)\4(\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\r\n]+)|(?<![A-Za-z0-9_])(["']?)(xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)\8(\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|-----BEGIN[^\r\n]*PRIVATE KEY[^\r\n]*?-----[\s\S]*?(?:-----END[^\r\n]*PRIVATE KEY[^\r\n]*?-----|$)|[^\r\n]+)|\b(Bearer|Basic)\s+([^\s,;]+)/gi;
const INLINE_DIAGNOSTIC_SENSITIVE_TEXT =
  /\b(https?:\/\/)([^\s/:@]*):([^\s/@]+)@|(?<![:A-Za-z0-9_])(["']?)(authorization|proxy[_-]?authorization)\4([ \t]*[:=][ \t]*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\r\n]+)|(?<![:A-Za-z0-9_])(["']?)(xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)\8([ \t]*[:=][ \t]*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|-----BEGIN[^\r\n]*PRIVATE KEY[^\r\n]*?-----[\s\S]*?(?:-----END[^\r\n]*PRIVATE KEY[^\r\n]*?-----|$)|[^\r\n]+)|\b(Bearer|Basic)\s+([^\s,;]+)/gi;
const SENSITIVE_TEXT_HINT =
  /authorization|api|token|password|passwd|secret|credential|private|cookie|bearer|basic|https?:\/\//i;
const SENSITIVE_TEXT_OBFUSCATION_HINT =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const MULTILINE_SENSITIVE_TEXT_HINT =
  /-----[\s\S]*PRIVATE KEY|(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization)["']?\s*[:=]|(?:^|[^A-Za-z0-9_])["']?(?:xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)["']?\s*[:=]\s*(?:[|>](?:(?:[+-][1-9]?)|(?:[1-9][+-]?))?\s*(?:#.*)?)?(?=\r\n|\r|\n|\u2028|\u2029|$)/im;
const LOGGER_TARGET = /(?:^|[\s\]])[A-Za-z0-9_.-]+(?:::[A-Za-z0-9_.-]+)+:\s*/g;

function looksLikeStandaloneCredential(
  scheme: string,
  credential: string,
): boolean {
  if (/^(?:sk|xai|gh[pousr]|ya29)[-_]/i.test(credential)) return true;
  if (/^eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}$/.test(credential))
    return true;
  if (scheme.toLowerCase() === "basic") {
    return (
      credential.length >= 8 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(credential) &&
      (credential.length >= 16 || /[0-9+/=]/.test(credential))
    );
  }
  return (
    credential.length >= 16 ||
    (credential.length >= 8 &&
      /[0-9]/.test(credential) &&
      /[-._~+/=]/.test(credential))
  );
}

function containsStandaloneCredential(value: string): boolean {
  const credentialPattern = /\b(Bearer|Basic)\s+([^\s,;]+)/gi;
  for (
    let match = credentialPattern.exec(value);
    match;
    match = credentialPattern.exec(value)
  ) {
    const scheme = match[1];
    const credential = match[2];
    if (
      scheme !== undefined &&
      credential !== undefined &&
      looksLikeStandaloneCredential(scheme, credential)
    ) {
      return true;
    }
  }
  return false;
}

function canonicalizeSensitiveText(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE, "").replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    "",
  );
}

function replaceQuotedValue(
  rawValue: string,
  replacement: (value: string) => string,
): string {
  const quote = rawValue[0];
  if (quote !== '"' && quote !== "'") return replacement(rawValue);
  const closed = rawValue.length > 1 && rawValue.endsWith(quote);
  const value = rawValue.slice(1, closed ? -1 : undefined);
  return `${quote}${replacement(value)}${closed ? quote : ""}`;
}

function redactAuthorizationValue(value: string): string {
  const leading = value.match(/^[ \t]*/)?.[0] ?? "";
  const trailing = value.match(/[ \t]*$/)?.[0] ?? "";
  const end = value.length - trailing.length;
  const core = value.slice(leading.length, end);
  const scheme = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:[ \t]+)[\s\S]+$/.exec(core);
  return `${leading}${scheme ? `${scheme[1]} ${REDACTED}` : REDACTED}${trailing}`;
}

interface RedactSensitiveTextOptions {
  diagnosticContext?: boolean;
  truncatedAtEnd?: boolean;
}

type SensitiveQuote = '"' | "'";

function findUnclosedSensitiveQuote(value: string): SensitiveQuote | undefined {
  let quote: SensitiveQuote | undefined;
  let escaped = false;
  for (let offset = 0; offset < value.length; offset++) {
    const character = value[offset];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (
        character === "'" &&
        quote === "'" &&
        value[offset + 1] === "'"
      ) {
        offset++;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (
      (character === '"' || character === "'") &&
      (offset === 0 || /[\s=,:;]/.test(value[offset - 1] ?? ""))
    ) {
      quote = character;
    }
  }
  return quote;
}

function findSensitiveClosingQuote(
  value: string,
  quote: SensitiveQuote,
): number {
  let escaped = false;
  for (let offset = 0; offset < value.length; offset++) {
    const character = value[offset];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (
      character === "'" &&
      quote === "'" &&
      value[offset + 1] === "'"
    ) {
      offset++;
    } else if (character === quote) {
      return offset;
    }
  }
  return -1;
}

interface SensitiveTextScannerState {
  authorizationContinuation: boolean;
  authorizationSchemeNeedsParameter: boolean;
  inPrivateKey: boolean;
  pendingAuthorizationValue: boolean;
  pendingSensitiveValue: boolean;
  sensitiveBlockIndent?: number;
  sensitiveQuote?: SensitiveQuote;
}

export interface RedactedSensitiveLineWindow {
  maxCodeUnits: number;
  selection: "start" | "end";
}

function createSensitiveTextScannerState(): SensitiveTextScannerState {
  return {
    authorizationContinuation: false,
    authorizationSchemeNeedsParameter: false,
    inPrivateKey: false,
    pendingAuthorizationValue: false,
    pendingSensitiveValue: false,
  };
}

function updateStateAfterPendingSensitiveValue(
  line: string,
  state: SensitiveTextScannerState,
  hasTerminalSensitiveLabel: boolean,
  hasTerminalAuthorizationLabel: boolean,
): void {
  state.sensitiveQuote = findUnclosedSensitiveQuote(line.trim());
  state.pendingSensitiveValue =
    state.sensitiveQuote === undefined && hasTerminalSensitiveLabel;
  state.pendingAuthorizationValue =
    state.sensitiveQuote === undefined && hasTerminalAuthorizationLabel;
}

function redactMultilineSensitiveLine(
  rawLine: string,
  state: SensitiveTextScannerState,
  options: RedactSensitiveTextOptions,
): string {
  let output = rawLine;
  const redactLine = (): void => {
    const leading = rawLine.match(/^[ \t]*/)?.[0] ?? "";
    output = `${leading}${REDACTED}`;
  };
  const controlStrippedLine = canonicalizeSensitiveText(rawLine);
  const sensitiveLabel =
    /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization|xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)["']?\s*[:=]/i;
  const privateKeyMarker =
    /-----(?:BEGIN|END)[^\r\n]*PRIVATE KEY[^\r\n]*?-----/i;
  const controlJoinedSensitiveBoundary =
    (!sensitiveLabel.test(rawLine) &&
      sensitiveLabel.test(controlStrippedLine)) ||
    (!privateKeyMarker.test(rawLine) &&
      privateKeyMarker.test(controlStrippedLine));
  const line = options.diagnosticContext
    ? controlStrippedLine.replace(LOGGER_TARGET, (target) =>
        " ".repeat(target.length),
      )
    : controlStrippedLine;
  if (controlJoinedSensitiveBoundary) redactLine();
  const trimmed = line.trim();
  const beginsDiagnosticRecord =
    /^(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b[:\s-]*/i.test(trimmed);
  const beginsPrivateKey = /-----BEGIN[^\r\n]*PRIVATE KEY[^\r\n]*?-----/i.test(
    line,
  );
  const endsPrivateKey = /-----END[^\r\n]*PRIVATE KEY[^\r\n]*?-----/i.test(
    line,
  );
  if (state.sensitiveQuote) {
    const activeQuote = state.sensitiveQuote;
    const closingQuote = findSensitiveClosingQuote(line, activeQuote);
    if (closingQuote >= 0) {
      const leading = line.match(/^[ \t]*/)?.[0] ?? "";
      output = `${leading}${REDACTED}${activeQuote}`;
    } else {
      redactLine();
    }
    if (closingQuote >= 0) {
      state.sensitiveQuote = undefined;
      state.pendingSensitiveValue = Boolean(
        line.slice(closingQuote + 1).trim(),
      );
    }
    return output;
  }
  if (state.inPrivateKey) {
    redactLine();
    if (endsPrivateKey) {
      state.inPrivateKey = false;
      const endMarker = /-----END[^\r\n]*PRIVATE KEY[^\r\n]*?-----/i.exec(line);
      state.pendingSensitiveValue = Boolean(
        endMarker && line.slice(endMarker.index + endMarker[0].length).trim(),
      );
    }
    return output;
  }
  if (beginsPrivateKey) {
    redactLine();
    state.inPrivateKey = !endsPrivateKey;
    state.pendingSensitiveValue = false;
    if (endsPrivateKey) {
      const endMarker = /-----END[^\r\n]*PRIVATE KEY[^\r\n]*?-----/i.exec(line);
      state.pendingSensitiveValue = Boolean(
        endMarker && line.slice(endMarker.index + endMarker[0].length).trim(),
      );
    }
    return output;
  }
  if (state.sensitiveBlockIndent !== undefined) {
    if (!trimmed) {
      redactLine();
      return output;
    }
    const indentation = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indentation > state.sensitiveBlockIndent) {
      redactLine();
      return output;
    }
    state.sensitiveBlockIndent = undefined;
  }
  const sensitiveAssignment =
    /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization|xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)["']?\s*[:=]\s*(.*)$/i.exec(
      line,
    );
  const hasTerminalSensitiveLabel =
    /(?:^|[^A-Za-z0-9_])["']?(?:xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)["']?\s*[:=]\s*$/i.test(
      line,
    );
  const hasTerminalAuthorizationLabel =
    /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization)["']?\s*[:=]\s*$/i.test(
      line,
    );
  const hasEmptyAuthorizationParameter =
    /^[,;]?\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=\s*$/.test(trimmed);
  const sensitiveBlock =
    /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization|xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)["']?\s*[:=]\s*[|>](?:(?:[+-][1-9]?)|(?:[1-9][+-]?))?\s*(?:#.*)?$/i.test(
      line,
    );
  if (sensitiveBlock) {
    state.sensitiveBlockIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    return output;
  }
  state.sensitiveQuote = findUnclosedSensitiveQuote(
    sensitiveAssignment?.[1] ?? "",
  );
  if (state.sensitiveQuote) return output;
  if (state.pendingSensitiveValue) {
    if (!trimmed) return output;
    if (!options.diagnosticContext || !beginsDiagnosticRecord) {
      redactLine();
      updateStateAfterPendingSensitiveValue(
        line,
        state,
        hasTerminalSensitiveLabel,
        hasTerminalAuthorizationLabel,
      );
      return output;
    }
    state.pendingSensitiveValue = false;
    state.pendingAuthorizationValue = false;
  }
  if (hasTerminalSensitiveLabel) {
    state.pendingSensitiveValue = true;
    return output;
  }
  if (state.pendingAuthorizationValue) {
    if (!trimmed) return output;
    if (options.diagnosticContext && beginsDiagnosticRecord) {
      state.pendingAuthorizationValue = false;
      state.authorizationContinuation = false;
    } else {
      if (hasTerminalSensitiveLabel || hasTerminalAuthorizationLabel) {
        state.pendingSensitiveValue = hasTerminalSensitiveLabel;
        state.pendingAuthorizationValue = hasTerminalAuthorizationLabel;
        return output;
      }
      state.sensitiveQuote = findUnclosedSensitiveQuote(trimmed);
      if (state.sensitiveQuote) {
        redactLine();
        state.pendingAuthorizationValue = false;
        return output;
      }
      state.authorizationContinuation = true;
      state.authorizationSchemeNeedsParameter =
        /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(trimmed);
      if (!state.authorizationSchemeNeedsParameter) {
        output = redactAuthorizationValue(line);
      }
      state.pendingAuthorizationValue = false;
      return output;
    }
  }
  if (state.authorizationSchemeNeedsParameter) {
    if (!trimmed) return output;
    redactLine();
    state.sensitiveQuote = findUnclosedSensitiveQuote(trimmed);
    if (hasTerminalSensitiveLabel || hasEmptyAuthorizationParameter) {
      state.pendingSensitiveValue = true;
      state.pendingAuthorizationValue = hasTerminalAuthorizationLabel;
      state.authorizationSchemeNeedsParameter = false;
      return output;
    }
    state.authorizationSchemeNeedsParameter = false;
    state.authorizationContinuation =
      /^[,;]?\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/.test(trimmed);
    return output;
  }
  if (state.authorizationContinuation) {
    if (!trimmed) {
      state.authorizationContinuation = false;
      return output;
    }
    if (/^[,;]?\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/.test(trimmed)) {
      redactLine();
      state.sensitiveQuote = findUnclosedSensitiveQuote(trimmed);
      if (hasTerminalSensitiveLabel || hasEmptyAuthorizationParameter) {
        state.pendingSensitiveValue = true;
        state.pendingAuthorizationValue = hasTerminalAuthorizationLabel;
      }
      return output;
    }
    state.authorizationContinuation = false;
  }

  const authorization =
    /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization)["']?\s*[:=]\s*(.*)$/i.exec(
      line,
    );
  if (!authorization) return output;
  const rawValue = (authorization[1] ?? "").trim();
  if (!rawValue) {
    state.pendingAuthorizationValue = true;
  } else if (rawValue[0] !== '"' && rawValue[0] !== "'") {
    state.authorizationContinuation = true;
    state.authorizationSchemeNeedsParameter =
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(rawValue);
  }
  return output;
}

function redactInlineSensitiveText(
  value: string,
  options: RedactSensitiveTextOptions,
): string {
  const inlineSensitiveText = options.diagnosticContext
    ? INLINE_DIAGNOSTIC_SENSITIVE_TEXT
    : INLINE_SENSITIVE_TEXT;
  const redacted = value.replace(
    inlineSensitiveText,
    (
      match,
      protocol: string | undefined,
      _username: string | undefined,
      _password: string | undefined,
      authorizationQuote: string | undefined,
      authorizationName: string | undefined,
      authorizationSeparator: string | undefined,
      authorizationValue: string | undefined,
      sensitiveQuote: string | undefined,
      sensitiveName: string | undefined,
      sensitiveSeparator: string | undefined,
      sensitiveValue: string | undefined,
      scheme: string | undefined,
      credential: string | undefined,
    ) => {
      if (protocol) return `${protocol}${REDACTED}:${REDACTED}@`;
      if (authorizationName && authorizationValue !== undefined) {
        return `${authorizationQuote ?? ""}${authorizationName}${
          authorizationQuote ?? ""
        }${authorizationSeparator ?? ""}${replaceQuotedValue(
          authorizationValue,
          redactAuthorizationValue,
        )}`;
      }
      if (sensitiveName && sensitiveValue !== undefined) {
        return `${sensitiveQuote ?? ""}${sensitiveName}${
          sensitiveQuote ?? ""
        }${sensitiveSeparator ?? ""}${replaceQuotedValue(
          sensitiveValue,
          () => REDACTED,
        )}`;
      }
      return scheme &&
        credential &&
        looksLikeStandaloneCredential(scheme, credential)
        ? `${scheme} ${REDACTED}`
        : match;
    },
  );
  if (!options.truncatedAtEnd) return redacted;
  return redacted.replace(
    /\b(https?:\/\/)([^\s/]*)$/gi,
    (_match, protocol: string, authority: string) =>
      `${protocol}${REDACTED}:${REDACTED}${authority.endsWith("…") ? "…" : ""}`,
  );
}

function boundSensitiveLine(
  rawLine: string,
  window: RedactedSensitiveLineWindow | undefined,
): string {
  if (!window || rawLine.length <= window.maxCodeUnits) return rawLine;
  if (window.selection === "start") {
    let prefix = rawLine.slice(0, Math.max(0, window.maxCodeUnits - 1));
    const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      prefix = prefix.slice(0, -1);
    }
    return `${prefix}…`;
  }
  let suffix = rawLine.slice(-Math.max(0, window.maxCodeUnits - 1));
  const firstCodeUnit = suffix.charCodeAt(0);
  if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) {
    suffix = suffix.slice(1);
  }
  return `…${suffix}`;
}

function redactOversizedSensitiveLine(
  rawLine: string,
  state: SensitiveTextScannerState,
  options: RedactSensitiveTextOptions,
  window: RedactedSensitiveLineWindow,
): string {
  const hasActiveSensitiveState =
    state.authorizationContinuation ||
    state.authorizationSchemeNeedsParameter ||
    state.inPrivateKey ||
    state.pendingAuthorizationValue ||
    state.pendingSensitiveValue ||
    state.sensitiveBlockIndent !== undefined ||
    state.sensitiveQuote !== undefined;
  if (!hasActiveSensitiveState) {
    const scanWindowCodeUnits = 4 * 1024;
    const carryCodeUnits = 256;
    let hasSensitiveSyntax = false;
    for (
      let offset = 0;
      offset < rawLine.length;
      offset += scanWindowCodeUnits
    ) {
      const probe = rawLine.slice(
        Math.max(0, offset - carryCodeUnits),
        Math.min(rawLine.length, offset + scanWindowCodeUnits),
      );
      if (
        SENSITIVE_TEXT_HINT.test(probe) ||
        SENSITIVE_TEXT_OBFUSCATION_HINT.test(probe)
      ) {
        hasSensitiveSyntax = true;
        break;
      }
    }
    if (!hasSensitiveSyntax) return boundSensitiveLine(rawLine, window);
  }
  const leading = rawLine.match(/^[ \t]*/)?.[0] ?? "";
  const redactedLine = `${leading}${REDACTED}`;
  const canonicalLine = canonicalizeSensitiveText(rawLine);
  const line = options.diagnosticContext
    ? canonicalLine.replace(LOGGER_TARGET, (target) =>
        " ".repeat(target.length),
      )
    : canonicalLine;
  const trimmed = line.trim();
  const beginsDiagnosticRecord =
    /^(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b[:\s-]*/i.test(trimmed);
  const beginsPrivateKey = /-----BEGIN[^\r\n]*PRIVATE KEY[^\r\n]*?-----/i.test(
    line,
  );
  const endsPrivateKey = /-----END[^\r\n]*PRIVATE KEY[^\r\n]*?-----/i.test(
    line,
  );
  const hasTerminalSensitiveLabel =
    /(?:^|[^A-Za-z0-9_])["']?(?:xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)["']?\s*[:=]\s*$/i.test(
      line,
    );
  const hasTerminalAuthorizationLabel =
    /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization)["']?\s*[:=]\s*$/i.test(
      line,
    );

  if (state.sensitiveQuote) {
    const closingQuote = findSensitiveClosingQuote(line, state.sensitiveQuote);
    if (closingQuote >= 0) {
      state.sensitiveQuote = undefined;
      state.pendingSensitiveValue = Boolean(
        line.slice(closingQuote + 1).trim(),
      );
    }
    return redactedLine;
  }
  if (state.inPrivateKey) {
    if (endsPrivateKey) state.inPrivateKey = false;
    return redactedLine;
  }
  if (beginsPrivateKey) {
    state.inPrivateKey = !endsPrivateKey;
    state.pendingSensitiveValue = false;
    return redactedLine;
  }
  if (state.sensitiveBlockIndent !== undefined) {
    const indentation = leading.length;
    if (!trimmed || indentation > state.sensitiveBlockIndent) {
      return redactedLine;
    }
    state.sensitiveBlockIndent = undefined;
  }
  if (state.pendingSensitiveValue) {
    if (!trimmed) return redactedLine;
    if (!options.diagnosticContext || !beginsDiagnosticRecord) {
      updateStateAfterPendingSensitiveValue(
        line,
        state,
        hasTerminalSensitiveLabel,
        hasTerminalAuthorizationLabel,
      );
      return redactedLine;
    }
    state.pendingSensitiveValue = false;
    state.pendingAuthorizationValue = false;
  }
  if (state.pendingAuthorizationValue) {
    if (!trimmed) return redactedLine;
    if (options.diagnosticContext && beginsDiagnosticRecord) {
      state.pendingAuthorizationValue = false;
      state.authorizationContinuation = false;
    } else {
      if (hasTerminalSensitiveLabel || hasTerminalAuthorizationLabel) {
        state.pendingSensitiveValue = hasTerminalSensitiveLabel;
        state.pendingAuthorizationValue = hasTerminalAuthorizationLabel;
        return redactedLine;
      }
      state.sensitiveQuote = findUnclosedSensitiveQuote(trimmed);
      state.pendingAuthorizationValue = false;
      if (state.sensitiveQuote) return redactedLine;
      state.authorizationContinuation = true;
      state.authorizationSchemeNeedsParameter =
        /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(trimmed);
      return redactedLine;
    }
  }
  if (state.authorizationSchemeNeedsParameter) {
    if (!trimmed) return redactedLine;
    state.authorizationSchemeNeedsParameter = false;
    state.authorizationContinuation =
      /^[,;]?\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/.test(trimmed);
    return redactedLine;
  }
  if (state.authorizationContinuation) {
    if (!trimmed) {
      state.authorizationContinuation = false;
      return boundSensitiveLine(rawLine, window);
    }
    if (/^[,;]?\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/.test(trimmed)) {
      return redactedLine;
    }
    state.authorizationContinuation = false;
  }

  const sensitiveBlock =
    /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization|xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)["']?\s*[:=]\s*[|>](?:(?:[+-][1-9]?)|(?:[1-9][+-]?))?\s*(?:#.*)?$/i.test(
      line,
    );
  if (sensitiveBlock) {
    state.sensitiveBlockIndent = leading.length;
    return redactedLine;
  }
  if (/\bhttps?:\/\/[^\s/:@]*:[^\s/@]+@/i.test(line)) {
    return `https://${REDACTED}:${REDACTED}…`;
  }
  if (containsStandaloneCredential(line)) return redactedLine;
  if (hasTerminalSensitiveLabel || hasTerminalAuthorizationLabel) {
    state.pendingSensitiveValue = hasTerminalSensitiveLabel;
    state.pendingAuthorizationValue = hasTerminalAuthorizationLabel;
    return redactedLine;
  }
  const authorizationAssignment =
    /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization)["']?\s*[:=]/i.test(
      line,
    );
  const sensitiveAssignment =
    /(?:^|[^A-Za-z0-9_])["']?(?:xai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|cookie|set[_-]?cookie|token)["']?\s*[:=]/i.test(
      line,
    );
  if (authorizationAssignment) {
    state.authorizationContinuation = true;
    state.authorizationSchemeNeedsParameter =
      /(?:^|[^A-Za-z0-9_])["']?(?:authorization|proxy[_-]?authorization)["']?\s*[:=]\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*$/i.test(
        line,
      );
    return redactedLine;
  }
  if (sensitiveAssignment) return redactedLine;
  return boundSensitiveLine(rawLine, window);
}

/** @internal Streams sanitized lines so diagnostic callers can stop early. */
export function visitRedactedSensitiveTextLines(
  value: string,
  options: RedactSensitiveTextOptions,
  visitor: (line: string) => boolean,
  window?: RedactedSensitiveLineWindow,
): void {
  const state = createSensitiveTextScannerState();
  const lineBreak = /\r\n|\r|\n|\u2028|\u2029/g;
  let start = 0;
  const emit = (rawLine: string, truncatedAtEnd: boolean): boolean => {
    const oversized = window && rawLine.length > window.maxCodeUnits;
    const line = oversized ? rawLine : boundSensitiveLine(rawLine, window);
    const multilineRedacted = oversized
      ? redactOversizedSensitiveLine(rawLine, state, options, window)
      : redactMultilineSensitiveLine(line, state, options);
    return visitor(
      redactInlineSensitiveText(multilineRedacted, {
        ...options,
        truncatedAtEnd: truncatedAtEnd || oversized,
      }),
    );
  };
  for (
    let match = lineBreak.exec(value);
    match;
    match = lineBreak.exec(value)
  ) {
    if (!emit(value.slice(start, match.index), false)) return;
    start = match.index + match[0].length;
  }
  emit(value.slice(start), options.truncatedAtEnd ?? false);
}

/** @internal Redacts credential-bearing text without changing standalone prose heuristics. */
export function redactSensitiveText(
  value: string,
  options: RedactSensitiveTextOptions = {},
): string {
  if (
    !SENSITIVE_TEXT_HINT.test(value) &&
    !SENSITIVE_TEXT_OBFUSCATION_HINT.test(value)
  ) {
    return value;
  }
  if (
    !options.diagnosticContext &&
    !SENSITIVE_TEXT_OBFUSCATION_HINT.test(value) &&
    ((!value.includes("\n") &&
      !value.includes("\r") &&
      !value.includes("\u2028") &&
      !value.includes("\u2029")) ||
      !MULTILINE_SENSITIVE_TEXT_HINT.test(value))
  ) {
    return redactInlineSensitiveText(value, options);
  }
  const chunks: string[] = [];
  const lineBreak = /\r\n|\r|\n|\u2028|\u2029/g;
  let delimiterStart = 0;
  visitRedactedSensitiveTextLines(value, options, (line) => {
    chunks.push(line);
    lineBreak.lastIndex = delimiterStart;
    const delimiter = lineBreak.exec(value);
    if (delimiter) {
      chunks.push(delimiter[0]);
      delimiterStart = delimiter.index + delimiter[0].length;
    }
    return true;
  });
  return chunks.join("");
}

function canonicalizeSensitiveIdentifier(value: string): string {
  return canonicalizeSensitiveText(value);
}

function normalizeKey(key: string): string {
  return canonicalizeSensitiveIdentifier(key).replace(/[-_\s]/g, "");
}

function classifyDiagnosticKey(key: string): {
  redactAllValues: boolean;
  sensitive: boolean;
} {
  if (key.length > DIAGNOSTIC_CLASSIFICATION_CODE_UNITS) {
    return { redactAllValues: false, sensitive: true };
  }
  const normalizedKey = normalizeKey(key);
  return {
    redactAllValues: VALUE_COLLECTION_KEY.test(normalizedKey),
    sensitive: SENSITIVE_KEY.test(normalizedKey),
  };
}

function isSensitiveDiagnosticName(name: string): boolean {
  if (name.length > DIAGNOSTIC_CLASSIFICATION_CODE_UNITS) return true;
  const canonicalName = canonicalizeSensitiveIdentifier(name);
  return (
    SENSITIVE_NAME.test(canonicalName) || SENSITIVE_KEY.test(normalizeKey(name))
  );
}

function defineJsonProperty(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
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
    return redactAllValues ? REDACTED : redactSensitiveText(value);
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
    typeof source.name === "string" && isSensitiveDiagnosticName(source.name);
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(source)) {
    const normalizedKey = normalizeKey(key);
    if (redactAllValues && key !== "name") {
      defineJsonProperty(result, key, REDACTED);
      continue;
    }
    if (
      SENSITIVE_KEY.test(normalizedKey) ||
      (key === "value" && (redactAllValues || namedValueIsSensitive))
    ) {
      defineJsonProperty(result, key, REDACTED);
      continue;
    }
    const redacted = visit(
      item,
      seen,
      VALUE_COLLECTION_KEY.test(normalizedKey),
    );
    if (redacted !== undefined) defineJsonProperty(result, key, redacted);
  }
  seen.delete(value);
  return result;
}

/** Creates a JSON-compatible copy with credential-bearing fields and strings removed. */
export function redactSensitiveData(value: unknown): JsonValue | undefined {
  return visit(value, new WeakSet());
}

interface DiagnosticVisitState {
  nodes: number;
}

interface DiagnosticVisitResult {
  value?: JsonValue;
  serializedBytes: number;
  truncated: boolean;
  truncationMarkerOmitted?: boolean;
}

interface DiagnosticKeyResult {
  key: string;
  serializedBytes: number;
  truncated: boolean;
}

interface StoredDiagnosticEntry {
  key: string;
  serializedBytes: number;
}

function serializedByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function serializedStringByteLength(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const TRUNCATED_SERIALIZED_BYTES = serializedStringByteLength(TRUNCATED);
const TRUNCATED_SUFFIX_SERIALIZED_BYTES = serializedStringByteLength(
  TRUNCATED_STRING_SUFFIX,
);
const OBJECT_TRUNCATION_ENTRY_BYTES =
  serializedStringByteLength(TRUNCATED_OBJECT_KEY) +
  1 +
  serializedByteLength(true);

function omittedTruncation(): DiagnosticVisitResult {
  return {
    serializedBytes: 0,
    truncated: true,
    truncationMarkerOmitted: true,
  };
}

function truncatePrefixWithSuffix(
  value: string,
  suffix: string,
  maxBytes: number,
): string | undefined {
  if (serializedStringByteLength(suffix) > maxBytes) return undefined;
  const complete = `${value}${suffix}`;
  if (serializedStringByteLength(complete) <= maxBytes) return complete;

  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join("")}${suffix}`;
    if (serializedStringByteLength(candidate) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${codePoints.slice(0, low).join("")}${suffix}`;
}

function truncateStringToSerializedBytes(
  value: string,
  maxBytes: number,
  forceTruncated = false,
): DiagnosticVisitResult {
  const fullBytes = serializedStringByteLength(value);
  if (!forceTruncated && fullBytes <= maxBytes) {
    return { value, serializedBytes: fullBytes, truncated: false };
  }
  if (TRUNCATED_SUFFIX_SERIALIZED_BYTES <= maxBytes) {
    const bounded = truncatePrefixWithSuffix(
      value,
      TRUNCATED_STRING_SUFFIX,
      maxBytes,
    );
    if (bounded !== undefined) {
      return {
        value: bounded,
        serializedBytes: serializedStringByteLength(bounded),
        truncated: true,
      };
    }
  }
  if (TRUNCATED_SERIALIZED_BYTES <= maxBytes) {
    return {
      value: TRUNCATED,
      serializedBytes: TRUNCATED_SERIALIZED_BYTES,
      truncated: true,
    };
  }
  return omittedTruncation();
}

function boundedDiagnosticWorkString(value: string): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= DIAGNOSTIC_STRING_WORK_CODE_UNITS) {
    return { value, truncated: false };
  }
  let bounded = value.slice(0, DIAGNOSTIC_STRING_WORK_CODE_UNITS);
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    bounded = bounded.slice(0, -1);
  }
  return { value: bounded, truncated: true };
}

function diagnosticString(
  value: string,
  maxBytes: number,
): DiagnosticVisitResult {
  const work = boundedDiagnosticWorkString(value);
  const redacted = redactSensitiveText(work.value, {
    truncatedAtEnd: work.truncated,
  });
  return truncateStringToSerializedBytes(
    redacted,
    Math.min(maxBytes, DIAGNOSTIC_DATA_MAX_STRING_BYTES),
    work.truncated,
  );
}

function diagnosticMarker(maxBytes: number): DiagnosticVisitResult {
  const marker = truncateStringToSerializedBytes(TRUNCATED, maxBytes);
  return { ...marker, truncated: true };
}

function allocateDiagnosticKey(
  rawKey: string,
  usedKeys: ReadonlySet<string>,
): DiagnosticKeyResult {
  const bounded = diagnosticString(rawKey, DIAGNOSTIC_DATA_MAX_STRING_BYTES);
  const base = typeof bounded.value === "string" ? bounded.value : TRUNCATED;
  let key = base;
  let collisionIndex = 2;
  while (key === TRUNCATED_OBJECT_KEY || usedKeys.has(key)) {
    const suffix = `#${String(collisionIndex)}`;
    key =
      truncatePrefixWithSuffix(
        base,
        suffix,
        DIAGNOSTIC_DATA_MAX_STRING_BYTES,
      ) ?? suffix;
    collisionIndex++;
  }
  return {
    key,
    serializedBytes: serializedStringByteLength(key),
    truncated: bounded.truncated,
  };
}

function appendArrayTruncationMarker(
  result: JsonValue[],
  entryBytes: number[],
  currentBytes: number,
  maxBytes: number,
): { bytes: number; markerAppended: boolean } {
  let bytes = currentBytes;
  while (true) {
    const markerIncrement =
      (result.length > 0 ? 1 : 0) + TRUNCATED_SERIALIZED_BYTES;
    if (bytes + markerIncrement <= maxBytes) {
      result.push(TRUNCATED);
      entryBytes.push(markerIncrement);
      return { bytes: bytes + markerIncrement, markerAppended: true };
    }
    if (result.length === 0) {
      return { bytes, markerAppended: false };
    }
    result.pop();
    bytes -= entryBytes.pop() ?? 0;
  }
}

function appendObjectTruncationMarker(
  result: Record<string, JsonValue>,
  entries: StoredDiagnosticEntry[],
  currentBytes: number,
  maxBytes: number,
): { bytes: number; markerAppended: boolean } {
  let bytes = currentBytes;
  while (true) {
    const markerIncrement =
      (entries.length > 0 ? 1 : 0) + OBJECT_TRUNCATION_ENTRY_BYTES;
    if (bytes + markerIncrement <= maxBytes) {
      defineJsonProperty(result, TRUNCATED_OBJECT_KEY, true);
      return { bytes: bytes + markerIncrement, markerAppended: true };
    }
    const removed = entries.pop();
    if (!removed) return { bytes, markerAppended: false };
    delete result[removed.key];
    bytes -= removed.serializedBytes;
  }
}

function visitDiagnostic(
  value: unknown,
  seen: WeakSet<object>,
  state: DiagnosticVisitState,
  depth: number,
  maxBytes: number,
  redactAllValues = false,
): DiagnosticVisitResult | undefined {
  state.nodes++;
  if (state.nodes > DIAGNOSTIC_DATA_MAX_NODES)
    return diagnosticMarker(maxBytes);
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }
  if (typeof value === "string") {
    return diagnosticString(redactAllValues ? REDACTED : value, maxBytes);
  }
  if (typeof value === "bigint")
    return diagnosticString(value.toString(), maxBytes);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    const primitive = value as JsonValue;
    const bytes = serializedByteLength(primitive);
    return bytes <= maxBytes
      ? { value: primitive, serializedBytes: bytes, truncated: false }
      : diagnosticMarker(maxBytes);
  }
  if (typeof value !== "object")
    return diagnosticString(String(value), maxBytes);
  if (depth >= DIAGNOSTIC_DATA_MAX_DEPTH || seen.has(value))
    return diagnosticMarker(maxBytes);
  if (maxBytes < 2) return omittedTruncation();

  seen.add(value);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    const entryBytes: number[] = [];
    let bytes = 2;
    let entriesOmitted = value.length > DIAGNOSTIC_DATA_MAX_ENTRIES;
    let truncated = entriesOmitted;
    for (
      let index = 0;
      index < Math.min(value.length, DIAGNOSTIC_DATA_MAX_ENTRIES);
      index++
    ) {
      const commaBytes = result.length > 0 ? 1 : 0;
      const childBudget = Math.max(0, maxBytes - bytes - commaBytes);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      const child =
        descriptor === undefined
          ? {
              value: null,
              serializedBytes: serializedByteLength(null),
              truncated: false,
            }
          : "value" in descriptor
            ? (visitDiagnostic(
                descriptor.value,
                seen,
                state,
                depth + 1,
                childBudget,
                redactAllValues,
              ) ?? {
                value: null,
                serializedBytes: serializedByteLength(null),
                truncated: false,
              })
            : diagnosticMarker(childBudget);
      if (child.value === undefined || child.truncationMarkerOmitted) {
        entriesOmitted = true;
        truncated = true;
        break;
      }
      const increment = commaBytes + child.serializedBytes;
      if (bytes + increment > maxBytes) {
        entriesOmitted = true;
        truncated = true;
        break;
      }
      result.push(child.value);
      entryBytes.push(increment);
      bytes += increment;
      truncated ||= child.truncated;
    }
    const marker = entriesOmitted
      ? appendArrayTruncationMarker(result, entryBytes, bytes, maxBytes)
      : undefined;
    if (marker) bytes = marker.bytes;
    seen.delete(value);
    return {
      value: result,
      serializedBytes: bytes,
      truncated,
      truncationMarkerOmitted: marker ? !marker.markerAppended : undefined,
    };
  }

  const source = value as Record<string, unknown>;
  const nameDescriptor = Object.getOwnPropertyDescriptor(source, "name");
  const namedValueIsSensitive =
    nameDescriptor !== undefined &&
    (!("value" in nameDescriptor) ||
      (typeof nameDescriptor.value === "string" &&
        isSensitiveDiagnosticName(nameDescriptor.value)));
  const result: Record<string, JsonValue> = {};
  const entries: StoredDiagnosticEntry[] = [];
  const usedKeys = new Set<string>([TRUNCATED_OBJECT_KEY]);
  let bytes = 2;
  let enumeratedEntryCount = 0;
  let ownEntryCount = 0;
  let entriesOmitted = false;
  let truncated = false;
  for (const rawKey in source) {
    enumeratedEntryCount++;
    if (!Object.hasOwn(source, rawKey)) {
      if (enumeratedEntryCount > DIAGNOSTIC_DATA_MAX_ENTRIES) break;
      continue;
    }
    if (ownEntryCount === DIAGNOSTIC_DATA_MAX_ENTRIES) {
      entriesOmitted = true;
      truncated = true;
      break;
    }
    ownEntryCount++;
    const key = allocateDiagnosticKey(rawKey, usedKeys);
    const classification = classifyDiagnosticKey(rawKey);
    const itemDescriptor = Object.getOwnPropertyDescriptor(source, rawKey);
    const commaBytes = entries.length > 0 ? 1 : 0;
    const entryOverhead = commaBytes + key.serializedBytes + 1;
    const childBudget = Math.max(0, maxBytes - bytes - entryOverhead);
    const child =
      redactAllValues && rawKey !== "name"
        ? diagnosticString(REDACTED, childBudget)
        : classification.sensitive ||
            (rawKey === "value" && (redactAllValues || namedValueIsSensitive))
          ? diagnosticString(REDACTED, childBudget)
          : itemDescriptor === undefined || !("value" in itemDescriptor)
            ? diagnosticMarker(childBudget)
            : visitDiagnostic(
                itemDescriptor.value,
                seen,
                state,
                depth + 1,
                childBudget,
                classification.redactAllValues,
              );
    if (!child) continue;
    if (child.value === undefined || child.truncationMarkerOmitted) {
      entriesOmitted = true;
      truncated = true;
      break;
    }
    const increment = entryOverhead + child.serializedBytes;
    if (bytes + increment > maxBytes) {
      entriesOmitted = true;
      truncated = true;
      break;
    }
    defineJsonProperty(result, key.key, child.value);
    usedKeys.add(key.key);
    entries.push({ key: key.key, serializedBytes: increment });
    bytes += increment;
    truncated ||= key.truncated || child.truncated;
  }
  const marker = entriesOmitted
    ? appendObjectTruncationMarker(result, entries, bytes, maxBytes)
    : undefined;
  if (marker) bytes = marker.bytes;
  seen.delete(value);
  return {
    value: result,
    serializedBytes: bytes,
    truncated,
    truncationMarkerOmitted: marker ? !marker.markerAppended : undefined,
  };
}

/** Redacts and structurally bounds data retained on public diagnostic errors. */
export function redactSensitiveDiagnosticData(
  value: unknown,
): JsonValue | undefined {
  const result = visitDiagnostic(
    value,
    new WeakSet(),
    { nodes: 0 },
    0,
    DIAGNOSTIC_DATA_LIMIT_BYTES,
  );
  if (!result || result.value === undefined) return undefined;
  return result.serializedBytes <= DIAGNOSTIC_DATA_LIMIT_BYTES
    ? result.value
    : { __truncated__: true };
}
