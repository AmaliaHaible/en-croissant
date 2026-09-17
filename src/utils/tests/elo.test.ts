import { expect, test } from "vitest";
import { updateElo } from "../elo";

test("increases rating on a win against an equally rated opponent", () => {
    expect(updateElo(1200, 1200, 1)).toBe(1216);
});

test("decreases rating on a loss against an equally rated opponent", () => {
    expect(updateElo(1200, 1200, 0)).toBe(1184);
});

test("gains more rating for beating a higher-rated opponent than an equal one", () => {
    const gainVsHigher = updateElo(1200, 1400, 1) - 1200;
    const gainVsEqual = updateElo(1200, 1200, 1) - 1200;
    expect(gainVsHigher).toBeGreaterThan(gainVsEqual);
});

test("loses less rating for losing to a higher-rated opponent than to an equal one", () => {
    const lossVsHigher = 1200 - updateElo(1200, 1400, 0);
    const lossVsEqual = 1200 - updateElo(1200, 1200, 0);
    expect(lossVsHigher).toBeLessThan(lossVsEqual);
});

test("rounds the result to the nearest integer", () => {
    expect(Number.isInteger(updateElo(1237, 1583, 1))).toBe(true);
});
