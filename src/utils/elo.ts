const K_FACTOR = 32;

export function updateElo(
    rating: number,
    opponentRating: number,
    score: 0 | 1,
    kFactor: number = K_FACTOR,
): number {
    const expected = 1 / (1 + 10 ** ((opponentRating - rating) / 400));
    return Math.round(rating + kFactor * (score - expected));
}
