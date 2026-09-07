import { describe, expect, it } from "vitest";
import { ATLAS_OVERVIEW_ENABLED } from "./feature";

describe("Atlas parallel-route feature gate", () => {
  it("is disabled in the default build", () => {
    expect(ATLAS_OVERVIEW_ENABLED).toBe(false);
  });
});
