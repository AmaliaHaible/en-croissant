import { atom, getDefaultStore } from "jotai";

/**
 * Tab values that currently have an analysis report running.
 *
 * A report (`commands.analyzeGame`) keeps running in the backend even after its
 * tab stops being viewed, but its result is delivered into that tab's per-mount
 * tree store. `BoardsPage` unmounts non-active tab panels for performance, which
 * would destroy that store mid-report — the annotations would land on a
 * discarded store and the panel would stay stuck on "generating". Tabs listed
 * here are kept mounted until their report finishes.
 */
export const reportsInProgressAtom = atom<ReadonlySet<string>>(new Set<string>());

export function setReportRunning(tab: string, running: boolean) {
    const store = getDefaultStore();
    const current = store.get(reportsInProgressAtom);
    if (running === current.has(tab)) return;
    const next = new Set(current);
    if (running) {
        next.add(tab);
    } else {
        next.delete(tab);
    }
    store.set(reportsInProgressAtom, next);
}
