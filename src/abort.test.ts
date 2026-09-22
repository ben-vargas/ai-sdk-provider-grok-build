import { describe, expect, it, vi } from "vitest";
import { abortError, waitAbortably } from "./abort.js";

const FALLBACK_MESSAGE = "The test operation was aborted.";

describe("abort helpers", () => {
  it("preserves an Error supplied as the abort reason", () => {
    const controller = new AbortController();
    const reason = new Error("stop now");
    controller.abort(reason);

    expect(abortError(controller.signal, FALLBACK_MESSAGE)).toBe(reason);
  });

  it("creates a named AbortError for a non-Error reason", () => {
    const controller = new AbortController();
    controller.abort("stop now");

    expect(abortError(controller.signal, FALLBACK_MESSAGE)).toMatchObject({
      name: "AbortError",
      message: FALLBACK_MESSAGE,
    });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);

    await expect(
      waitAbortably(
        Promise.resolve("unused"),
        controller.signal,
        FALLBACK_MESSAGE,
      ),
    ).rejects.toBe(reason);
  });

  it("returns the promise result and removes its abort listener", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );

    await expect(
      waitAbortably(
        Promise.resolve("done"),
        controller.signal,
        FALLBACK_MESSAGE,
      ),
    ).resolves.toBe("done");
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("rejects a pending wait on abort and removes its listener", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    let resolveUnderlying: ((value: string) => void) | undefined;
    const underlying = new Promise<string>((resolve) => {
      resolveUnderlying = resolve;
    });
    const pending = waitAbortably(
      underlying,
      controller.signal,
      FALLBACK_MESSAGE,
    );

    controller.abort("stop now");

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: FALLBACK_MESSAGE,
    });
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
    resolveUnderlying?.("late result");
  });
});
