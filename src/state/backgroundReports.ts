import { atom, getDefaultStore } from "jotai";

/**
 * Keys (`<databasePath>::<gameId>`) of database games that currently have a
 * background report running — a report kicked off from the home screen without
 * opening the game in a tab. `RecentOnlineGames` reads this to show a spinner on
 * the row and to keep the button disabled while the report is in flight, even
 * across the periodic `loadGames` refresh.
 */
export const backgroundReportsAtom = atom<ReadonlySet<string>>(new Set<string>());

export function backgroundReportKey(databasePath: string, gameId: number): string {
    return `${databasePath}::${gameId}`;
}

export function setBackgroundReportRunning(key: string, running: boolean) {
    const store = getDefaultStore();
    const current = store.get(backgroundReportsAtom);
    if (running === current.has(key)) return;
    const next = new Set(current);
    if (running) {
        next.add(key);
    } else {
        next.delete(key);
    }
    store.set(backgroundReportsAtom, next);
}
