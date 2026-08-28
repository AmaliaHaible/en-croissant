import { expect, test } from "vitest";
import { classifyPlayers } from "../collections";

test("classifies human vs engine as player-vs-engine regardless of color", () => {
    expect(classifyPlayers("human", "engine")).toBe("player-vs-engine");
    expect(classifyPlayers("engine", "human")).toBe("player-vs-engine");
});

test("classifies human vs human as player-vs-player", () => {
    expect(classifyPlayers("human", "human")).toBe("player-vs-player");
});

test("classifies engine vs engine as engine-vs-engine", () => {
    expect(classifyPlayers("engine", "engine")).toBe("engine-vs-engine");
});
