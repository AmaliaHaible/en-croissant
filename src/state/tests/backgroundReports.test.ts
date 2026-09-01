import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, test } from "vitest";
import {
    backgroundReportKey,
    backgroundReportsAtom,
    setBackgroundReportRunning,
} from "../backgroundReports";

const store = getDefaultStore();

beforeEach(() => {
    store.set(backgroundReportsAtom, new Set<string>());
});

describe("backgroundReportKey", () => {
    test("combines database path and game id", () => {
        expect(backgroundReportKey("/games/lichess.db3", 42)).toBe("/games/lichess.db3::42");
    });

    test("keys for the same game id in different databases do not collide", () => {
        expect(backgroundReportKey("/a.db3", 1)).not.toBe(backgroundReportKey("/b.db3", 1));
    });
});

describe("setBackgroundReportRunning", () => {
    test("adds and removes a key", () => {
        const key = backgroundReportKey("/a.db3", 1);
        setBackgroundReportRunning(key, true);
        expect(store.get(backgroundReportsAtom).has(key)).toBe(true);

        setBackgroundReportRunning(key, false);
        expect(store.get(backgroundReportsAtom).has(key)).toBe(false);
    });

    test("tracks multiple keys independently", () => {
        setBackgroundReportRunning("a", true);
        setBackgroundReportRunning("b", true);
        setBackgroundReportRunning("a", false);

        const running = store.get(backgroundReportsAtom);
        expect(running.has("a")).toBe(false);
        expect(running.has("b")).toBe(true);
    });

    test("replaces the set identity on change so subscribers re-render", () => {
        const before = store.get(backgroundReportsAtom);
        setBackgroundReportRunning("a", true);
        expect(store.get(backgroundReportsAtom)).not.toBe(before);
    });

    test("is a no-op when the state is already correct", () => {
        setBackgroundReportRunning("a", true);
        const snapshot = store.get(backgroundReportsAtom);
        setBackgroundReportRunning("a", true);
        expect(store.get(backgroundReportsAtom)).toBe(snapshot);

        setBackgroundReportRunning("b", false);
        expect(store.get(backgroundReportsAtom)).toBe(snapshot);
    });
});
