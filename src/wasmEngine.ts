import { Color, Piece, Shogi } from 'shogi.js'
import type { Kind } from 'shogi.js'
import type { EngineConfig, ParsedMove } from './types'
import type { EngineProviderResult } from './engineProviders'

type MoveCandidate = {
  usi: string
  score: number
}

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

const FILES = '123456789'
const RANKS = 'abcdefghi'
const PROMOTED_KINDS = new Set<Kind>(['TO', 'NY', 'NK', 'NG', 'UM', 'RY'])

function boardBuilder() {
  const builder = (globalThis as { __buildShogiFromParsedMoves__?: (moves: ParsedMove[], moveIndex: number) => Shogi }).__buildShogiFromParsedMoves__
  if (!builder) throw new Error('board builder unavailable')
  return builder
}

function usiSquare(x: number, y: number) {
  return `${FILES[x - 1]}${RANKS[y - 1]}`
}

function moveToUsi(fromX: number, fromY: number, toX: number, toY: number, promote = false) {
  return `${usiSquare(fromX, fromY)}${usiSquare(toX, toY)}${promote ? '+' : ''}`
}

function dropToUsi(kind: Kind, toX: number, toY: number) {
  const map: Partial<Record<Kind, string>> = {
    FU: 'P',
    KY: 'L',
    KE: 'N',
    GI: 'S',
    KI: 'G',
    KA: 'B',
    HI: 'R',
  }
  const symbol = map[kind]
  if (!symbol) throw new Error(`drop kind unsupported: ${kind}`)
  return `${symbol}*${usiSquare(toX, toY)}`
}

function pieceScore(kind: Kind) {
  return PIECE_VALUE[kind] ?? 0
}

function evaluateBoard(shogi: Shogi) {
  let score = 0

  for (let x = 1; x <= 9; x += 1) {
    for (let y = 1; y <= 9; y += 1) {
      const piece = shogi.get(x, y)
      if (!piece) continue
      const value = pieceScore(piece.kind)
      const advance = piece.color === Color.Black ? (10 - y) * 4 : (y - 1) * 4
      const center = 12 - (Math.abs(5 - x) + Math.abs(5 - y))
      score += piece.color === Color.Black ? value + advance + center : -(value + advance + center)
    }
  }

  const blackHands = shogi.getHandsSummary(Color.Black) as Partial<Record<Kind, number>>
  for (const [kind, count] of Object.entries(blackHands) as [Kind, number][]) {
    score += pieceScore(kind) * count * 0.9
  }
  const whiteHands = shogi.getHandsSummary(Color.White) as Partial<Record<Kind, number>>
  for (const [kind, count] of Object.entries(whiteHands) as [Kind, number][]) {
    score -= pieceScore(kind) * count * 0.9
  }

  return score
}

function cloneShogi(shogi: Shogi) {
  const clone = new Shogi({ preset: 'HIRATE' })
  clone.initializeFromSFENString(shogi.toSFENString())
  return clone
}

function canPromoteMove(kind: Kind, fromY: number, toY: number, color: Color) {
  if (!Piece.canPromote(kind) || PROMOTED_KINDS.has(kind)) return false
  if (color === Color.Black) return fromY <= 3 || toY <= 3
  return fromY >= 7 || toY >= 7
}

function mandatoryPromotion(kind: Kind, toY: number, color: Color) {
  if (color === Color.Black) return (kind === 'FU' || kind === 'KY') ? toY === 1 : kind === 'KE' ? toY <= 2 : false
  return (kind === 'FU' || kind === 'KY') ? toY === 9 : kind === 'KE' ? toY >= 8 : false
}

function generateMoves(shogi: Shogi): MoveCandidate[] {
  const color = shogi.turn
  const moves: MoveCandidate[] = []

  for (let x = 1; x <= 9; x += 1) {
    for (let y = 1; y <= 9; y += 1) {
      const piece = shogi.get(x, y)
      if (!piece || piece.color !== color) continue

      for (const move of shogi.getMovesFrom(x, y)) {
        const capture = shogi.get(move.to.x, move.to.y)
        const promoteAllowed = canPromoteMove(piece.kind, y, move.to.y, color)
        const mustPromote = mandatoryPromotion(piece.kind, move.to.y, color)
        const promotedKind = Piece.promote(piece.kind)
        const tactical = (capture ? pieceScore(capture.kind) * 0.8 : 0) + (promoteAllowed ? Math.max(pieceScore(promotedKind) - pieceScore(piece.kind), 0) * 0.35 : 0)

        if (mustPromote) {
          moves.push({ usi: moveToUsi(x, y, move.to.x, move.to.y, true), score: tactical + 12 })
          continue
        }

        moves.push({ usi: moveToUsi(x, y, move.to.x, move.to.y, false), score: tactical })
        if (promoteAllowed) {
          moves.push({ usi: moveToUsi(x, y, move.to.x, move.to.y, true), score: tactical + 10 })
        }
      }
    }
  }

  for (const drop of shogi.getDropsBy(color)) {
    if (!drop.kind) continue
    const aroundCenter = 10 - (Math.abs(5 - drop.to.x) + Math.abs(5 - drop.to.y))
    moves.push({ usi: dropToUsi(drop.kind as Kind, drop.to.x, drop.to.y), score: aroundCenter })
  }

  return moves.sort((a, b) => b.score - a.score)
}

function applyUsiMove(shogi: Shogi, usi: string) {
  const dropMatch = usi.match(/^([PLNSGBR])\*([1-9])([a-i])$/)
  if (dropMatch) {
    const kindMap: Record<string, Kind> = { P: 'FU', L: 'KY', N: 'KE', S: 'GI', G: 'KI', B: 'KA', R: 'HI' }
    shogi.drop(Number(dropMatch[2]), RANKS.indexOf(dropMatch[3]) + 1, kindMap[dropMatch[1]], shogi.turn)
    return
  }

  const moveMatch = usi.match(/^([1-9])([a-i])([1-9])([a-i])(\+)?$/)
  if (!moveMatch) throw new Error(`invalid usi move: ${usi}`)
  shogi.move(
    Number(moveMatch[1]),
    RANKS.indexOf(moveMatch[2]) + 1,
    Number(moveMatch[3]),
    RANKS.indexOf(moveMatch[4]) + 1,
    moveMatch[5] === '+',
  )
}

function search(shogi: Shogi, depth: number, alpha: number, beta: number): number {
  if (depth === 0) {
    const evalScore = evaluateBoard(shogi)
    return shogi.turn === Color.Black ? evalScore : -evalScore
  }

  const moves = generateMoves(shogi).slice(0, depth >= 3 ? 18 : 28)
  if (moves.length === 0) {
    const evalScore = evaluateBoard(shogi)
    return shogi.turn === Color.Black ? evalScore : -evalScore
  }

  let best = -Infinity
  for (const move of moves) {
    const next = cloneShogi(shogi)
    applyUsiMove(next, move.usi)
    const score = -search(next, depth - 1, -beta, -alpha)
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }

  return best
}

function chooseDepth(config?: EngineConfig) {
  const think = config?.thinkTimeMs ?? 1200
  const quality = config?.mobileQuality ?? 'auto'
  if (quality === 'light') return think >= 900 ? 2 : 1
  if (quality === 'standard') return think >= 2000 ? 3 : 2
  if (think >= 2200) return 3
  if (think >= 900) return 2
  return 1
}

function principalVariation(shogi: Shogi, depth: number) {
  const pv: string[] = []
  let current = cloneShogi(shogi)

  for (let ply = 0; ply < Math.min(depth, 3); ply += 1) {
    const moves = generateMoves(current).slice(0, 16)
    if (moves.length === 0) break

    let bestMove = moves[0].usi
    let bestScore = -Infinity
    for (const move of moves) {
      const next = cloneShogi(current)
      applyUsiMove(next, move.usi)
      const score = -search(next, Math.max(depth - ply - 1, 0), -Infinity, Infinity)
      if (score > bestScore) {
        bestScore = score
        bestMove = move.usi
      }
    }

    pv.push(bestMove)
    applyUsiMove(current, bestMove)
  }

  return pv
}

export async function analyzeWithBrowserEngine(moves: ParsedMove[], currentMoveIndex: number, config?: EngineConfig): Promise<EngineProviderResult> {
  const shogi = boardBuilder()(moves, currentMoveIndex)
  return analyzeShogiPosition(shogi, config)
}

export async function analyzePositionFromSfenWithBrowserEngine(sfen: string, _moveCount: number, config?: EngineConfig): Promise<EngineProviderResult> {
  const shogi = new Shogi({ preset: 'HIRATE' })
  shogi.initializeFromSFENString(sfen)
  return analyzeShogiPosition(shogi, config)
}

async function analyzeShogiPosition(shogi: Shogi, config?: EngineConfig): Promise<EngineProviderResult> {
  const depth = chooseDepth(config)
  const rootMoves = generateMoves(shogi).slice(0, depth >= 3 ? 18 : 24)
  if (rootMoves.length === 0) {
    return {
      source: 'wasm',
      available: false,
      evaluation: 0,
      bestMove: '候補なし',
      pv: [],
      depth,
      reason: 'legal moves unavailable',
      statusMessage: '合法手を生成できず解析不可',
    }
  }

  let bestMove = rootMoves[0].usi
  let bestScore = -Infinity
  for (const move of rootMoves) {
    const next = cloneShogi(shogi)
    applyUsiMove(next, move.usi)
    const score = -search(next, Math.max(depth - 1, 0), -Infinity, Infinity)
    if (score > bestScore) {
      bestScore = score
      bestMove = move.usi
    }
  }

  const scoreFromBlack = shogi.turn === Color.Black ? bestScore : -bestScore
  const pv = principalVariation(shogi, depth)

  return {
    source: 'wasm',
    available: true,
    evaluation: scoreFromBlack,
    bestMoveUsi: bestMove,
    pv,
    depth,
    statusMessage: `端末内探索エンジンで深さ ${depth} を読んだ。`,
  }
}
