import { basename, resolve } from "@tauri-apps/api/path";
import { info } from "@tauri-apps/plugin-log";
import { commands, events, type DatabaseInfo } from "@/bindings";
import type { DatabaseConversionState } from "@/state/atoms";
import { downloadChessCom } from "@/utils/chess.com/api";
import { query_games } from "@/utils/db";
import { getDatabasesDir } from "@/utils/directories";
import { downloadLichess } from "@/utils/lichess/api";
import type { Session } from "@/utils/session";
import { unwrap } from "@/utils/unwrap";

export type LinkedAccount = {
    type: "lichess" | "chesscom";
    title: string;
    token?: string;
};

export type PlayerGroup = {
    name: string;
    sessions: Session[];
};

export function getPlayerGroups(sessions: Session[]): PlayerGroup[] {
    const playerNames = Array.from(
        new Set(sessions.map((s) => s.player ?? s.lichess?.username ?? s.chessCom?.username)),
    ).filter((name): name is string => !!name);

    return playerNames.map((name) => ({
        name,
        sessions: sessions.filter(
            (s) =>
                s.player === name || s.lichess?.username === name || s.chessCom?.username === name,
        ),
    }));
}

export function getLinkedAccounts(sessions: Session[]): LinkedAccount[] {
    const accounts: LinkedAccount[] = [];
    for (const session of sessions) {
        if (session.lichess?.account) {
            accounts.push({
                type: "lichess",
                title: session.lichess.username,
                token: session.lichess.accessToken,
            });
        }
        if (session.chessCom?.stats) {
            accounts.push({ type: "chesscom", title: session.chessCom.username });
        }
    }
    return accounts;
}

export function getAccountDbFilename(account: LinkedAccount): string {
    return `${account.title}_${account.type}.db3`;
}

export function getSessionTotalGames(session: Session): number {
    if (session.lichess?.account?.perfs) {
        const perfs = session.lichess.account.perfs;
        return (
            (perfs.ultraBullet?.games ?? 0) +
            (perfs.bullet?.games ?? 0) +
            (perfs.blitz?.games ?? 0) +
            (perfs.rapid?.games ?? 0) +
            (perfs.classical?.games ?? 0) +
            (perfs.correspondence?.games ?? 0)
        );
    }
    if (session.chessCom?.stats) {
        let total = 0;
        for (const stat of Object.values(session.chessCom.stats)) {
            if (stat.record) {
                total += stat.record.win + stat.record.loss + stat.record.draw;
            }
        }
        return total;
    }
    return 0;
}

async function getLastGameDate(database: DatabaseInfo): Promise<number | null> {
    const games = await query_games(database.file, {
        options: {
            page: 1,
            pageSize: 1,
            sort: "date",
            direction: "desc",
            skipCount: false,
        },
    });
    if (games.count! > 0 && games.data[0].date && games.data[0].time) {
        const [year, month, day] = games.data[0].date.split(".").map(Number);
        const [hour, minute, second] = games.data[0].time.split(":").map(Number);
        return Date.UTC(year, month - 1, day, hour, minute, second);
    }
    return null;
}

export async function downloadAccountGames({
    account,
    database,
    totalGames,
    setConversionState,
    setProgress,
}: {
    account: LinkedAccount;
    database: DatabaseInfo | null;
    totalGames: number;
    setConversionState: (
        update: (prev: DatabaseConversionState) => DatabaseConversionState,
    ) => void;
    setProgress?: (progress: number) => void;
}): Promise<void> {
    const { type, title, token } = account;
    const downloadedGames = database?.type === "success" ? database.game_count : 0;
    const lastGameDate = database ? await getLastGameDate(database) : null;

    if (type === "lichess") {
        await downloadLichess(
            title,
            lastGameDate,
            totalGames - downloadedGames,
            setProgress ?? (() => {}),
            token,
        );
    } else {
        await downloadChessCom(title, lastGameDate);
    }

    const databaseDir = await getDatabasesDir();
    const pgnPath = await resolve(databaseDir, `${title}_${type}.pgn`);
    try {
        info(`converting ${pgnPath} ${lastGameDate}`);
        const filename = title + (type === "lichess" ? " Lichess" : " Chess.com");
        const dbPath = pgnPath.replace(".pgn", ".db3");
        const sourceFileName = await basename(pgnPath);
        setConversionState((prev) => ({
            ...prev,
            inProgress: true,
            targetDatabasePath: dbPath,
            targetDatabaseTitle: filename,
            sourceFileName,
        }));
        unwrap(
            await commands.convertPgn(
                [pgnPath],
                dbPath,
                lastGameDate ? lastGameDate / 1000 : null,
                filename,
                null,
            ),
        );
        events.progressEvent.emit({
            id: `${type}_${title}`,
            progress: 100,
            finished: true,
        });
        await commands.deleteEmptyGames(dbPath);
    } catch (e) {
        console.error(e);
    } finally {
        setConversionState((prev) => ({
            ...prev,
            inProgress: false,
            totalGames: 0,
            elapsedSeconds: 0,
            targetDatabasePath: null,
            targetDatabaseTitle: null,
            sourceFileName: null,
        }));
    }
}
