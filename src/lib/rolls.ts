export type RollsAndPieces = {
  rolls: number;
  pieces: number;
};

export function splitRollsAndPieces(totalPieces: number, piecesPerRoll: number): RollsAndPieces {
  if (!Number.isFinite(totalPieces) || !Number.isFinite(piecesPerRoll) || piecesPerRoll <= 0) {
    return { rolls: 0, pieces: 0 };
  }

  return {
    rolls: Math.floor(totalPieces / piecesPerRoll),
    pieces: totalPieces % piecesPerRoll,
  };
}

export function formatRollsAndPieces(totalPieces: number, piecesPerRoll: number) {
  const { rolls, pieces } = splitRollsAndPieces(totalPieces, piecesPerRoll);

  if (rolls === 0) {
    return `${pieces} pieces`;
  }

  if (pieces === 0) {
    return `${rolls} rolls`;
  }

  return `${rolls} rolls ${pieces} pieces`;
}
