import { describe, expect, it, vi } from "vitest";
import { resolveGrokLogger } from "./logger.js";

describe("resolveGrokLogger", () => {
  it("uses a supplied logger and honors explicit disablement", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    expect(resolveGrokLogger(logger, false)).toBe(logger);
    const disabled = resolveGrokLogger(false, true);
    disabled.debug("hidden");
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("uses stderr diagnostics only for verbose default logging", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    resolveGrokLogger(undefined, true).debug("visible");
    resolveGrokLogger(undefined, false).debug("hidden");
    expect(write).toHaveBeenCalledOnce();
    write.mockRestore();
  });
});
