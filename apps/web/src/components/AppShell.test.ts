import { describe, expect, it } from "vitest";
import { modeLabel } from "./AppShell";

describe("modeLabel", () => {
  it("maps every evidence mode to its exact pill label", () => {
    expect(modeLabel("demo")).toBe("Demo");
    expect(modeLabel("live")).toBe("Docker");
    expect(modeLabel("mock")).toBe("Mock");
    expect(modeLabel(null)).toBe("Unknown");
  });
});
