import { describe, expect, it } from "vitest";
import { headersToPGN } from "@/utils/chess";
import type { GameHeaders } from "@/utils/treeReducer";

describe("Engine Match Series & Multi-Game Logic", () => {
    it("correctly tracks score across a multi-game series", () => {
        let p1Score = 0;
        let p2Score = 0;
        let draws = 0;

        const results: ("1-0" | "0-1" | "1/2-1/2")[] = ["1-0", "1/2-1/2", "0-1", "1-0"];
        let p1IsWhite = true;

        for (const outcome of results) {
            if (outcome === "1-0") {
                if (p1IsWhite) p1Score += 1;
                else p2Score += 1;
            } else if (outcome === "0-1") {
                if (p1IsWhite) p2Score += 1;
                else p1Score += 1;
            } else {
                p1Score += 0.5;
                p2Score += 0.5;
                draws += 1;
            }
            // Alternate colors
            p1IsWhite = !p1IsWhite;
        }

        // Game 1: P1 (White) wins -> P1: 1, P2: 0
        // Game 2: P1 (Black) draws -> P1: 1.5, P2: 0.5, Draws: 1
        // Game 3: P1 (White) loses -> P1: 1.5, P2: 1.5, Draws: 1
        // Game 4: P1 (Black) / P2 (White) -> White wins -> P1: 1.5, P2: 2.5, Draws: 1
        expect(p1Score).toBe(1.5);
        expect(p2Score).toBe(2.5);
        expect(draws).toBe(1);
    });

    it("correctly formats multi-game PGN headers", () => {
        const game1: GameHeaders = {
            id: 1,
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            white: "Stockfish 17",
            black: "Leela Chess Zero",
            event: "Engine Match (4 games)",
            site: "En Croissant",
            date: "2026.08.18",
            round: "1",
            result: "1-0",
        };

        const pgn1 = headersToPGN(game1);
        expect(pgn1).toContain('[Event "Engine Match (4 games)"]');
        expect(pgn1).toContain('[White "Stockfish 17"]');
        expect(pgn1).toContain('[Black "Leela Chess Zero"]');
        expect(pgn1).toContain('[Round "1"]');
        expect(pgn1).toContain('[Result "1-0"]');

        const game2: GameHeaders = {
            id: 2,
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            white: "Leela Chess Zero",
            black: "Stockfish 17",
            event: "Engine Match (4 games)",
            site: "En Croissant",
            date: "2026.08.18",
            round: "2",
            result: "1/2-1/2",
        };

        const pgn2 = headersToPGN(game2);
        expect(pgn2).toContain('[White "Leela Chess Zero"]');
        expect(pgn2).toContain('[Black "Stockfish 17"]');
        expect(pgn2).toContain('[Round "2"]');
        expect(pgn2).toContain('[Result "1/2-1/2"]');

        // Multi-game PGN appending verification
        const multiGamePgn = `${pgn1.trim()}\n\n1. e4 e5 2. Nf3 1-0\n\n${pgn2.trim()}\n\n1. d4 Nf6 2. c4 1/2-1/2`;
        expect(multiGamePgn.split("[Event ").length - 1).toBe(2);
    });

    it("handles color alternation between engines", () => {
        const engine1 = { name: "Stockfish" };
        const engine2 = { name: "KomodoDragon" };

        let whitePlayer = engine1.name;
        let blackPlayer = engine2.name;

        const roundColors: { white: string; black: string }[] = [];

        for (let round = 1; round <= 6; round++) {
            roundColors.push({ white: whitePlayer, black: blackPlayer });
            const temp = whitePlayer;
            whitePlayer = blackPlayer;
            blackPlayer = temp;
        }

        expect(roundColors[0]).toEqual({ white: "Stockfish", black: "KomodoDragon" });
        expect(roundColors[1]).toEqual({ white: "KomodoDragon", black: "Stockfish" });
        expect(roundColors[2]).toEqual({ white: "Stockfish", black: "KomodoDragon" });
        expect(roundColors[3]).toEqual({ white: "KomodoDragon", black: "Stockfish" });
        expect(roundColors[4]).toEqual({ white: "Stockfish", black: "KomodoDragon" });
        expect(roundColors[5]).toEqual({ white: "KomodoDragon", black: "Stockfish" });
    });

    it("validates and clamps engine match game count to 2..100 with even recommendations", () => {
        function clampMatchGames(n: number): number {
            return Math.max(2, Math.min(100, Math.trunc(n)));
        }

        function isEvenMatch(n: number): boolean {
            return n % 2 === 0;
        }

        expect(clampMatchGames(0)).toBe(2);
        expect(clampMatchGames(1)).toBe(2);
        expect(clampMatchGames(12)).toBe(12);
        expect(clampMatchGames(100)).toBe(100);
        expect(clampMatchGames(150)).toBe(100);

        expect(isEvenMatch(2)).toBe(true);
        expect(isEvenMatch(12)).toBe(true);
        expect(isEvenMatch(13)).toBe(false);
        expect(isEvenMatch(100)).toBe(true);
    });

    it("preserves only completed games when a match series is aborted", () => {
        const seriesGames: {
            round: number;
            result: "1-0" | "0-1" | "1/2-1/2" | "*";
            moves: string;
        }[] = [
            { round: 1, result: "1-0", moves: "1. e4 e5 2. Nf3 Nc6 1-0" },
            { round: 2, result: "1/2-1/2", moves: "1. d4 d5 2. c4 c6 1/2-1/2" },
            { round: 3, result: "*", moves: "1. e4 c5 2. Nf3 *" }, // Aborted game
        ];

        const savedCompletedGames = seriesGames.filter((g) => g.result !== "*");

        expect(savedCompletedGames.length).toBe(2);
        expect(savedCompletedGames[0].round).toBe(1);
        expect(savedCompletedGames[1].round).toBe(2);
        expect(savedCompletedGames.some((g) => g.result === "*")).toBe(false);
    });

    it("generates timestamped filename with custom tournament name and tournament category", () => {
        function generateMatchFileName(options: {
            p1: string;
            p2: string;
            gameCount: number;
            customTournament?: string;
            timestamp: string;
        }): { fileName: string; category: "tournament" | "game" } {
            const p1Clean = options.p1.replace(/[^a-zA-Z0-9_-]/g, "_");
            const p2Clean = options.p2.replace(/[^a-zA-Z0-9_-]/g, "_");
            const custom = options.customTournament?.trim();
            const prefix = custom
                ? custom.replace(/[^a-zA-Z0-9_-]/g, "_")
                : `${p1Clean}_vs_${p2Clean}_series_${options.gameCount}games`;
            const isTournament = options.gameCount > 1 || Boolean(custom);

            return {
                fileName: `${prefix}_${options.timestamp}.pgn`,
                category: isTournament ? "tournament" : "game",
            };
        }

        const t1 = generateMatchFileName({
            p1: "Stockfish 17",
            p2: "Lc0",
            gameCount: 12,
            customTournament: "TCEC Season 2026",
            timestamp: "2026-08-18_22-55-00",
        });
        expect(t1.fileName).toBe("TCEC_Season_2026_2026-08-18_22-55-00.pgn");
        expect(t1.category).toBe("tournament");

        const t2 = generateMatchFileName({
            p1: "Stockfish 17",
            p2: "Lc0",
            gameCount: 10,
            timestamp: "2026-08-18_22-55-00",
        });
        expect(t2.fileName).toBe("Stockfish_17_vs_Lc0_series_10games_2026-08-18_22-55-00.pgn");
        expect(t2.category).toBe("tournament");
    });
});
