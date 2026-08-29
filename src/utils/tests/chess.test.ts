import { expect, test } from "vitest";
import { ANNOTATION_INFO, type Annotation, NAG_INFO } from "../annotation";
import { defaultPGN, getMoveText, hasMorePriority, headersToPGN } from "../chess";
import type { TreeNode } from "../treeReducer";

test("NAGs are consistent", () => {
    for (const k of Object.keys(ANNOTATION_INFO)) {
        if (k === "") continue;
        const nag = ANNOTATION_INFO[k as Annotation].nag!;
        expect(NAG_INFO.get(`$${nag}`)).toBe(k);
    }
});

test("best-move suggestion annotations are written as NAGs, not literal glyph text", () => {
    const node: TreeNode = {
        fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
        move: { from: 11, to: 27 } as TreeNode["move"],
        san: "d4",
        children: [],
        score: null,
        depth: null,
        halfMoves: 1,
        shapes: [],
        annotations: ["BM1"],
        comment: "",
    };

    const moveText = getMoveText(node, { glyphs: true, comments: false, extraMarkups: false });

    expect(moveText).toContain("$220");
    expect(moveText).not.toContain("BM1");
});

test("priority comparison", () => {
    expect(hasMorePriority([0, 0], [0])).toBe(false);
    expect(hasMorePriority([0], [0, 0])).toBe(true);
    expect(hasMorePriority([0], [1])).toBe(true);
    expect(hasMorePriority([1], [0])).toBe(false);
    expect(hasMorePriority([0, 0], [0, 1])).toBe(true);
    expect(hasMorePriority([0, 1], [0, 0])).toBe(false);
    expect(hasMorePriority([0, 1], [0, 2])).toBe(true);
    expect(hasMorePriority([0, 2], [0, 1])).toBe(false);
});

test("headersToPGN produces standard PGN metadata block", () => {
    const pgn = headersToPGN({
        id: 1,
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        white: "Magnus Carlsen",
        black: "Hikaru Nakamura",
        event: "World Championship",
        site: "Dubai",
        date: "2026.08.18",
        round: "1",
        result: "1-0",
        white_elo: 2880,
        black_elo: 2875,
        time_control: "300+2",
        eco: "B90",
        variant: "Standard",
        time: "12:34:56",
    });

    expect(pgn).toContain('[White "Magnus Carlsen"]');
    expect(pgn).toContain('[Black "Hikaru Nakamura"]');
    expect(pgn).toContain('[Event "World Championship"]');
    expect(pgn).toContain('[Site "Dubai"]');
    expect(pgn).toContain('[Date "2026.08.18"]');
    expect(pgn).toContain('[WhiteElo "2880"]');
    expect(pgn).toContain('[BlackElo "2875"]');
    expect(pgn).toContain('[TimeControl "300+2"]');
    expect(pgn).toContain('[ECO "B90"]');
    expect(pgn).toContain('[UTCTime "12:34:56"]');
    expect(pgn).toContain('[Variant "Standard"]');
    expect(pgn).toContain('[Result "1-0"]');
});

test("defaultPGN returns clean starting PGN structure", () => {
    const pgn = defaultPGN();
    expect(pgn).toContain('[Event "?"]');
    expect(pgn).toContain('[Result "*"]');
    expect(pgn.endsWith("*")).toBe(true);
});
