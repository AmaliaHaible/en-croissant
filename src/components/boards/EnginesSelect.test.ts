import { describe, expect, it } from "vitest";
import { pickAutoEngine } from "./EnginesSelect";

describe("pickAutoEngine", () => {
    it("auto-selects the first engine when none is selected", () => {
        const a = { id: "a" };
        const b = { id: "b" };
        expect(pickAutoEngine(null, [a, b])).toBe(a);
    });

    it("leaves the selection untouched when the engines list is empty", () => {
        const a = { id: "a" };
        expect(pickAutoEngine(a, [])).toBe(a);
    });

    it("keeps the current engine when the list re-fetches a new object with the same id", () => {
        // Regression test: enginesAtom's async storage re-parses JSON on every
        // refetch, so the "same" engine comes back as a brand-new object
        // reference even though nothing changed. That must not be treated as a
        // user-driven engine change, or callers reset engine-specific settings
        // (like the selected variant) whenever it happens.
        const a = { id: "a" };
        const aRefetched = { id: "a" };
        expect(pickAutoEngine(a, [aRefetched])).toBe(a);
    });
});
