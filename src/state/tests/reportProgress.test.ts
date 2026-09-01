import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, test } from "vitest";
import { reportsInProgressAtom, setReportRunning } from "../reportProgress";

const store = getDefaultStore();

beforeEach(() => {
    store.set(reportsInProgressAtom, new Set<string>());
});

describe("setReportRunning", () => {
    test("adds and removes a tab", () => {
        setReportRunning("tab-a", true);
        expect(store.get(reportsInProgressAtom).has("tab-a")).toBe(true);

        setReportRunning("tab-a", false);
        expect(store.get(reportsInProgressAtom).has("tab-a")).toBe(false);
    });

    test("tracks multiple tabs independently", () => {
        setReportRunning("tab-a", true);
        setReportRunning("tab-b", true);
        setReportRunning("tab-a", false);

        const running = store.get(reportsInProgressAtom);
        expect(running.has("tab-a")).toBe(false);
        expect(running.has("tab-b")).toBe(true);
    });

    test("replaces the set identity on change so subscribers re-render", () => {
        const before = store.get(reportsInProgressAtom);
        setReportRunning("tab-a", true);
        expect(store.get(reportsInProgressAtom)).not.toBe(before);
    });

    test("is a no-op when the state is already correct", () => {
        setReportRunning("tab-a", true);
        const snapshot = store.get(reportsInProgressAtom);
        setReportRunning("tab-a", true);
        expect(store.get(reportsInProgressAtom)).toBe(snapshot);

        setReportRunning("tab-b", false);
        expect(store.get(reportsInProgressAtom)).toBe(snapshot);
    });
});
