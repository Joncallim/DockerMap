import { describe, expect, it } from "vitest";
import type { RuntimeMode } from "@dockermap/contracts";
import {
  EVIDENCE_KINDS,
  type EvidenceKind,
  type EvidenceMode,
  type Claim,
  claimAuthority,
  demoSample,
  derived,
  evidenceLabel,
  inferred,
  observed,
  resolveEvidenceMode,
  unavailable
} from "./evidence";

describe("evidence vocabulary", () => {
  it("1. EVIDENCE_KINDS has exactly the five kinds declared by EvidenceKind", () => {
    const expected: EvidenceKind[] = ["observed", "derived", "inferred", "demo", "unavailable"];
    expect(EVIDENCE_KINDS).toEqual(expected);
    // Compile-time guard lives on the declaration in evidence.ts:
    // `as const satisfies readonly EvidenceKind[]` — adding a kind to one side
    // without the other fails `npm run typecheck`. The old `satisfies` here
    // merely restated that annotation and could never fail, so it was dropped.
  });

  it("2. every label and description is non-empty after trim and every label is short", () => {
    for (const kind of EVIDENCE_KINDS) {
      const { label, description } = evidenceLabel(kind);
      expect(label.trim().length, `${kind} label`).toBeGreaterThan(0);
      expect(description.trim().length, `${kind} description`).toBeGreaterThan(0);
      expect(label.length, `${kind} label length`).toBeLessThanOrEqual(32);
    }
  });

  it("3. all five labels and all five descriptions are distinct", () => {
    const labels = EVIDENCE_KINDS.map((kind) => evidenceLabel(kind).label);
    const descriptions = EVIDENCE_KINDS.map((kind) => evidenceLabel(kind).description);
    expect(new Set(labels).size).toBe(5);
    expect(new Set(descriptions).size).toBe(5);
  });

  it("4. evidenceLabel throws on an unknown kind", () => {
    // Deliberate contract-drift simulation cast: typed callers can never pass
    // this, so it exercises the runtime backstop for a kind cast from untyped
    // data (G-01, G-24).
    expect(() => evidenceLabel("nonsense" as EvidenceKind)).toThrow(/Unknown evidence kind/);
    // Prototype keys resolve through the prototype chain, so a bare index
    // lookup would "find" them and fail OPEN; the Object.hasOwn guard must
    // make each one throw (P3-4).
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(() => evidenceLabel(key as EvidenceKind)).toThrow(/Unknown evidence kind/);
    }
  });

  it("5. resolveEvidenceMode returns the correct mode for every input combination", () => {
    const cases: { input: { demoMode: boolean; healthMode: RuntimeMode | null }; expected: EvidenceMode | null }[] = [
      { input: { demoMode: false, healthMode: "docker" }, expected: "live" },
      { input: { demoMode: false, healthMode: "mock" }, expected: "mock" },
      { input: { demoMode: false, healthMode: null }, expected: null },
      { input: { demoMode: true, healthMode: "docker" }, expected: "demo" },
      { input: { demoMode: true, healthMode: "mock" }, expected: "demo" },
      { input: { demoMode: true, healthMode: null }, expected: "demo" }
    ];
    for (const { input, expected } of cases) {
      expect(resolveEvidenceMode(input)).toBe(expected);
    }
    // Deliberate contract-drift simulation cast: a RuntimeMode value outside the
    // union must fail closed to null (G-24), never to a guessed mode.
    expect(resolveEvidenceMode({ demoMode: false, healthMode: "other" as RuntimeMode })).toBeNull();
    // G-15 lock is test 7 (live mode still asserts host truth). The f(x) === f(x)
    // determinism asserts were removed in #71 remediation as vacuous — they pass
    // for any function; determinism per input is implied by the pure truth table above.
  });

  it("6. claimAuthority maps modes to the correct authority", () => {
    const cases: { mode: EvidenceMode | null; expected: "host" | "sample" | "none" }[] = [
      { mode: "live", expected: "host" },
      { mode: "mock", expected: "sample" },
      { mode: "demo", expected: "sample" },
      { mode: null, expected: "none" }
    ];
    for (const { mode, expected } of cases) {
      expect(claimAuthority(mode)).toBe(expected);
    }
  });

  it("7. live mode still asserts host truth (correct behavior resumes)", () => {
    expect(claimAuthority("live")).toBe("host");
    const claim = observed(42);
    expect(claim.kind).toBe("observed");
    expect(claim.value).toBe(42);
    expect(evidenceLabel(claim.kind).label).toBe("Observed");
  });

  it("8. unavailable requires a non-empty detail string", () => {
    expect(() => unavailable("")).toThrow(/non-empty/);
    expect(() => unavailable("   ")).toThrow(/non-empty/);
    const claim = unavailable("Live resource collectors are not wired yet");
    expect(claim).toEqual({
      kind: "unavailable",
      value: null,
      detail: "Live resource collectors are not wired yet"
    });
  });

  it("9. type-level: unavailable value is null (compile-time gate via @ts-expect-error)", () => {
    const claim: Claim<number> = unavailable("Not wired");
    // This must be a compile error: value is possibly 'null' on the unavailable arm.
    if (false) {
      // @ts-expect-error TS18047: 'claim.value' is possibly 'null'.
      claim.value.toFixed(1);
    }
    // The gate is compile-time: the @ts-expect-error above is self-checking — if
    // the TS18047 error ever disappears, the now-unused directive itself fails
    // `npm run typecheck`. The `if (false)` keeps the statement from running at
    // runtime (vitest strips types but keeps statements), so the null invariant
    // is asserted directly below instead of via a misleading try/catch wrapper.
    expect(claim.value).toBeNull();
  });

  it("10. constructors produce the expected Claim shapes", () => {
    expect(observed(1)).toEqual({ kind: "observed", value: 1 });
    expect(derived(2)).toEqual({ kind: "derived", value: 2 });
    expect(inferred(3)).toEqual({ kind: "inferred", value: 3 });
    expect(demoSample(4)).toEqual({ kind: "demo", value: 4 });
  });
});
