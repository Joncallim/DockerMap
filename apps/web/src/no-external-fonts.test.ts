import { describe, expect, it } from "vitest";
import document from "../index.html?raw";

describe("production typography boundary", () => {
  it("does not require an external font CDN", () => {
    expect(document).not.toMatch(/fonts\.(googleapis|gstatic)\.com/i);
    expect(document).not.toMatch(/<link[^>]+rel=["']preconnect["']/i);
  });
});
