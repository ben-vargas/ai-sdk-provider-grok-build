import { describe, expect, it } from "vitest";
import { toolInputContainsMarker } from "./live-smoke-input.mjs";

describe("toolInputContainsMarker", () => {
  it("finds a shell-serialized Windows marker after parsing tool input once", () => {
    const marker = String.raw`C:\Users\alice\AppData\Local\Temp\permission-bypass-marker`;
    const input = JSON.stringify({
      command: `node marker.js ${JSON.stringify(marker)}`,
    });

    expect(toolInputContainsMarker(input, marker)).toBe(true);
  });

  it("falls back safely for malformed JSON input", () => {
    expect(toolInputContainsMarker("run /tmp/marker }", "/tmp/marker")).toBe(
      true,
    );
  });
});
