import { describe, expect, it } from "vitest";
import {
  VERSION,
  createGrokAgent,
  createGrokBuild,
  createGrokExec,
} from "./index.js";

describe("package entry point", () => {
  it("exports the synchronized version and all three factories", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(manifest.version);
    expect(createGrokBuild).toBeTypeOf("function");
    expect(createGrokAgent).toBeTypeOf("function");
    expect(createGrokExec).toBeTypeOf("function");
  });
});
import { readFileSync } from "node:fs";
