import { Color, Piece, Shogi } from 'shogi.js'
import type { Kind } from 'shogi.js'
import type { MoveFeatures } from './moveRanker'

const RANKS = 'abcdefghi'
const PIECE_VALUE: Record<Kind, number> = {
  FU: 100,
  KY: 320,
  KE: 360,
  GI: 420,
  KI: 520,
  KA: 650,
  HI: 780,
  OU: 20000,
  TO: 520,
  NY: 520,
  NK: 520,
  NG: 520,
  UM: 900,
  RY: 1020,
}

function pieceScore(kind: Kind) {
  return PIECE_VALUE[kind] ?? 0
}

function findKing(shogi: Shogi, color: Color) {
  for (let x = 1; x <= 9; x += 1) {
    for (let y = 1; y <= 9; y += 1) {
      const piece = shogi.get(x, y)
      if (piece?.color === color && piece.kind === 'OU') return { x, y }
    }
  }
  return null
}

function canCaptureSquare(shogi: Shogi, target: { x: number; y: number }, attacker: Color) {
  for (let x = 1; x <= 9; x += 1) {
    for (let y = 1; y <= 9; y += 1) {
      const piece = shogi.get(x, y)
      if (!piece || piece.color !== attacker) continue
      if (shogi.getMovesFrom(x, y).some((move) => move.to.x === target.x && move.to.y === target.y)) return true
    }
  }
  return false
}

function kingDangerLevel(shogi: Shogi, color: Color) {
  const king = findKing(shogi, color)
  if (!king) return 0
  const opponent = color === Color.Black ? Color.White : Color.Black
  let pressure = 0

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const x = king.x + dx
      const y = king.y + dy
      if (x < 1 || x > 9 || y < 1 || y > 9) continue
      if (canCaptureSquare(shogi, { x, y }, opponent)) pressure += dx === 0 && dy === 0 ? 5 : 2
    }
  }

  return pressure
}

function bishopLanePressure(after: Shogi, toX: number, toY: number, color: Color) {
  const directions = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
  const opponent = color === Color.Black ? Color.White : Color.Black
  const enemyKing = findKing(after, opponent)
  let score = 0

  for (const [dx, dy] of directions) {
    let x = toX + dx
    let y = toY + dy
    while (x >= 1 && x <= 9 && y >= 1 && y <= 9) {
      const piece = after.get(x, y)
      if (piece) {
        if (piece.color !== color) score += piece.kind === 'OU' ? 220 : pieceScore(piece.kind) * 0.18
        break
      }
      if (enemyKing) {
        const d = Math.abs(enemyKing.x - x) + Math.abs(enemyKing.y - y)
        if (d <= 2) score += 18 - d * 5
      }
      x += dx
      y += dy
    }
  }

  return score
}

function rookLanePressure(after: Shogi, toX: number, toY: number, color: Color) {
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const opponent = color === Color.Black ? Color.White : Color.Black
  const enemyKing = findKing(after, opponent)
  let score = 0

  for (const [dx, dy] of directions) {
    let x = toX + dx
    let y = toY + dy
    while (x >= 1 && x <= 9 && y >= 1 && y <= 9) {
      const piece = after.get(x, y)
      if (piece) {
        if (piece.color !== color) score += piece.kind === 'OU' ? 220 : pieceScore(piece.kind) * 0.16
        break
      }
      if (enemyKing) {
        const d = Math.abs(enemyKing.x - x) + Math.abs(enemyKing.y - y)
        if (d <= 2) score += 14 - d * 4
      }
      x += dx
      y += dy
    }
  }

  return score
}

function parseMove(usi: string) {
  const dropMatch = usi.match(/^([PLNSGBR])\*([1-9])([a-i])$/)
  if (dropMatch) {
    const kindMap: Record<string, Kind> = { P: 'FU', L: 'KY', N: 'KE', S: 'GI', G: 'KI', B: 'KA', R: 'HI' }
    return {
      drop: true,
      kind: kindMap[dropMatch[1]],
      to: { x: Number(dropMatch[2]), y: RANKS.indexOf(dropMatch[3]) + 1 },
      promote: false,
    }
  }

  const moveMatch = usi.match(/^([1-9])([a-i])([1-9])([a-i])(\+)?$/)
  if (!moveMatch) return null
  return {
    drop: false,
    from: { x: Number(moveMatch[1]), y: RANKS.indexOf(moveMatch[2]) + 1 },
    to: { x: Number(moveMatch[3]), y: RANKS.indexOf(moveMatch[4]) + 1 },
    promote: moveMatch[5] === '+',
  }
}

function applyUsiMove(shogi: Shogi, usi: string) {
  const parsed = parseMove(usi)
  if (!parsed) throw new Error(`invalid usi move: ${usi}`)
  if (parsed.drop) {
    shogi.drop(parsed.to.x, parsed.to.y, parsed.kind, shogi.turn)
    return
  }
  const from = parsed.from
  if (!from) throw new Error(`missing move source: ${usi}`)
  shogi.move(from.x, from.y, parsed.to.x, parsed.to.y, parsed.promote)
}

export function extractMoveFeatures(before: Shogi, usi: string): MoveFeatures {
  const parsed = parseMove(usi)
  if (!parsed) {
    return {
      isDrop: 0, isBishopDrop: 0, isRookDrop: 0, isEdgeDrop: 0, isCheck: 0,
      captureValue: 0, promotionGain: 0, hangPenalty: 0, kingDangerDelta: 0,
      enemyKingPressure: 0, ownKingDefense: 0, centralControl: 0,
    }
  }

  const mover = before.turn
  const opponent = mover === Color.Black ? Color.White : Color.Black
  const beforeDanger = kingDangerLevel(before, mover)
  const capture = before.get(parsed.to.x, parsed.to.y)
  const after = new Shogi({ preset: 'HIRATE' })
  after.initializeFromSFENString(before.toSFENString())
  applyUsiMove(after, usi)
  const afterDanger = kingDangerLevel(after, mover)
  const movedPiece = after.get(parsed.to.x, parsed.to.y)
  const isCheck = !!findKing(after, opponent) && canCaptureSquare(after, findKing(after, opponent)!, mover)
  const canBeTaken = !!movedPiece && movedPiece.kind !== 'OU' && canCaptureSquare(after, parsed.to, opponent)
  const defended = canCaptureSquare(after, parsed.to, mover)
  const hangPenalty = canBeTaken ? pieceScore(movedPiece!.kind) * (defended ? 1.2 : 2.4) : 0
  const sourceFrom = !parsed.drop ? parsed.from : undefined
  const sourcePiece = sourceFrom ? before.get(sourceFrom.x, sourceFrom.y) : null
  const promotionGain = sourcePiece && Piece.canPromote(sourcePiece.kind)
    ? Math.max(0, pieceScore(Piece.promote(sourcePiece.kind)) - pieceScore(sourcePiece.kind))
    : 0
  const enemyKing = findKing(after, opponent)
  const ownKing = findKing(after, mover)
  const enemyKingPressure = movedPiece?.kind === 'KA' || movedPiece?.kind === 'UM'
    ? bishopLanePressure(after, parsed.to.x, parsed.to.y, mover)
    : movedPiece?.kind === 'HI' || movedPiece?.kind === 'RY'
      ? rookLanePressure(after, parsed.to.x, parsed.to.y, mover)
      : enemyKing ? Math.max(0, 12 - (Math.abs(enemyKing.x - parsed.to.x) + Math.abs(enemyKing.y - parsed.to.y)) * 2) : 0
  const ownKingDefense = ownKing ? Math.max(0, 10 - (Math.abs(ownKing.x - parsed.to.x) + Math.abs(ownKing.y - parsed.to.y)) * 2) : 0
  const centralControl = Math.max(0, 8 - (Math.abs(5 - parsed.to.x) + Math.abs(5 - parsed.to.y)))

  return {
    isDrop: parsed.drop ? 1 : 0,
    isBishopDrop: parsed.drop && parsed.kind === 'KA' ? 1 : 0,
    isRookDrop: parsed.drop && parsed.kind === 'HI' ? 1 : 0,
    isEdgeDrop: parsed.drop && (parsed.to.x === 1 || parsed.to.x === 9) ? 1 : 0,
    isCheck: isCheck ? 1 : 0,
    captureValue: capture ? pieceScore(capture.kind) : 0,
    promotionGain,
    hangPenalty,
    kingDangerDelta: afterDanger - beforeDanger,
    enemyKingPressure,
    ownKingDefense,
    centralControl,
  }
}
