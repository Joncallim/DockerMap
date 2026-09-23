import { describe, expect, it } from "vitest";
import {
  TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS,
  assertStageSixSevenIndependence
} from "./timeToAnswerEvidence";

/**
 * Stage 6/7 independence control (#335).
 *
 * Stage 6 ends when the application accepts a coherent model; stage 7 begins at
 * that instant and ends when the accepted model's expected Home content has
 * rendered. These tests pin the decision rule the capture enforces before it may
 * produce a baseline: an artificial presentation delay injected AFTER acceptance
 * must leave stage 6 alone and must move stage 7 by the injected amount.
 */
const NORMAL_STAGE_SIX = [12.4, 13.1, 11.8, 12.9, 12.2, 13.4, 12.0, 12.7, 13.0, 12.5];
const NORMAL_STAGE_SEVEN = [4.1, 5.2, 3.8, 4.6, 5.0, 4.2, 3.9, 4.8, 4.4, 4.7];

const control = (offsetMs: number) => NORMAL_STAGE_SEVEN.map((value) => value + offsetMs);

describe("stage 6/7 independence control", () => {
  it("accepts a control whose injected delay moves stage 7 and leaves stage 6 alone", () => {
    const verdict = assertStageSixSevenIndependence({
      fixture: "reference-25",
      normalStageSixMs: NORMAL_STAGE_SIX,
      normalStageSevenMs: NORMAL_STAGE_SEVEN,
      controlStageSixMs: NORMAL_STAGE_SIX.map((value) => value + 2),
      controlStageSevenMs: control(TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS)
    });
    expect(verdict.stageSevenDeltaMs).toBeCloseTo(TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS, 5);
    expect(verdict.stageSixDeltaMs).toBeLessThanOrEqual(30);
  });

  it("rejects a seam whose stage 7 ignores the delayed presentation", () => {
    // The RED case: a delayed render that does not move stage 7 means stage 7 is
    // not measuring presentation of the accepted model (for example it is the
    // same clock as stage 6, or it ends on the notification).
    expect(() =>
      assertStageSixSevenIndependence({
        fixture: "reference-25",
        normalStageSixMs: NORMAL_STAGE_SIX,
        normalStageSevenMs: NORMAL_STAGE_SEVEN,
        controlStageSixMs: NORMAL_STAGE_SIX,
        controlStageSevenMs: NORMAL_STAGE_SEVEN
      })
    ).toThrow("stage 7 only moved by");
  });

  it("rejects a seam whose stage 6 moves with the delayed presentation", () => {
    expect(() =>
      assertStageSixSevenIndependence({
        fixture: "reference-25",
        normalStageSixMs: NORMAL_STAGE_SIX,
        normalStageSevenMs: NORMAL_STAGE_SEVEN,
        controlStageSixMs: NORMAL_STAGE_SIX.map((value) => value + 200),
        controlStageSevenMs: control(TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS)
      })
    ).toThrow("stage 6 is not independent of presentation");
  });

  it("rejects a control where the delay was not actually applied", () => {
    // Stage 7 moved slightly (noise) but a sample is still shorter than the
    // injected delay, which can only mean the delay never reached the page.
    expect(() =>
      assertStageSixSevenIndependence({
        fixture: "docker-topology-change",
        normalStageSixMs: NORMAL_STAGE_SIX,
        normalStageSevenMs: NORMAL_STAGE_SEVEN,
        controlStageSixMs: NORMAL_STAGE_SIX,
        controlStageSevenMs: [220, 300, 310]
      })
    ).toThrow("shorter than the injected delay");
  });

  it("rejects a partial delay absorption below the reviewed share", () => {
    expect(() =>
      assertStageSixSevenIndependence({
        fixture: "reference-100",
        normalStageSixMs: NORMAL_STAGE_SIX,
        normalStageSevenMs: NORMAL_STAGE_SEVEN,
        controlStageSixMs: NORMAL_STAGE_SIX,
        controlStageSevenMs: control(TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS * 0.5)
      })
    ).toThrow("stage 7 only moved by");
  });

  it("refuses to judge an empty, malformed or delay-free control", () => {
    const base = {
      fixture: "reference-250",
      normalStageSixMs: NORMAL_STAGE_SIX,
      normalStageSevenMs: NORMAL_STAGE_SEVEN,
      controlStageSixMs: NORMAL_STAGE_SIX,
      controlStageSevenMs: control(TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS)
    };
    expect(() => assertStageSixSevenIndependence({ ...base, controlStageSevenMs: [] })).toThrow(
      "requires at least one sample"
    );
    expect(() =>
      assertStageSixSevenIndependence({ ...base, controlStageSixMs: [Number.NaN] })
    ).toThrow("finite non-negative samples");
    expect(() => assertStageSixSevenIndependence({ ...base, delayMs: 0 })).toThrow(
      "positive injected delay"
    );
  });
});
