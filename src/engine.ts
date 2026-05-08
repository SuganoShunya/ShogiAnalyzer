import { Color, Piece, Shogi } from 'shogi.js'
import type { Kind } from 'shogi.js'
import type { EngineConfig, EngineLine, ParsedMove } from './types'
import { getEngineProvider, summarizeEvaluation, type EngineSource } from './engineProviders'

export type EngineDisplayLine = {
  move: string
  moveUsi: string
  evaluation: number
  pv: string[]
  depth: number
}

export type EngineResult = {
  source: EngineSource
  evaluation: number
  bestMove: string
  bestMoveUsi?: string
  pv: string[]
  depth: number
  lines?: EngineDisplayLine[]
  summary: string
  statusMessage?: string
}

const pieceKanjiMap: Record<Kind, string> = {
  FU: '歩',
  KY: '香',
  KE: '桂',
  GI: '銀',
  KI: '金',
  KA: '角',
  HI: '飛',
  OU: '玉',
  TO: 'と',
  NY: '杏',
  NK: '圭',
  NG: '全',
  UM: '馬',
  RY: '龍',
}

const usiDropMap: Record<string, Kind> = {
  P: 'FU',
  L: 'KY',
  N: 'KE',
  S: 'GI',
  G: 'KI',
  B: 'KA',
  R: 'HI',
}

function applyMovesForEngine(moves: ParsedMove[], moveIndex: number) {
  const builder = (globalThis as { __buildShogiFromParsedMoves__?: (moves: ParsedMove[], moveIndex: number) => Shogi }).__buildShogiFromParsedMoves__
  if (!builder) throw new Error('board builder unavailable')
  return builder(moves, moveIndex)
}

function toJapaneseSquare(x: number, y: number) {
  return `${x}${'一二三四五六七八九'[y - 1]}`
}

function describeDirection(player: '先手' | '後手', fromX: number, fromY: number, _toX: number, toY: number, competing: Array<{ from: { x: number; y: number } }>) {
  if (competing.length === 0) return ''

  const sameFile = competing.some((candidate) => candidate.from.x === fromX)
  const horizontal = player === '先手'
    ? competing.map((candidate) => candidate.from.x).sort((a, b) => b - a)
    : competing.map((candidate) => candidate.from.x).sort((a, b) => a - b)

  let suffix = ''
  if (sameFile) {
    suffix += '直'
  } else if (horizontal.length > 0) {
    if (fromX === horizontal[0]) suffix += '右'
    else if (fromX === horizontal[horizontal.length - 1]) suffix += '左'
  }

  const movement = player === '先手' ? fromY - toY : toY - fromY
  if (movement > 0) suffix += '上'
  else if (movement < 0) suffix += '引'
  else suffix += '寄'

  return suffix
}

function usiMoveToJapanese(move: string, shogi: Shogi, previousTo?: { x: number; y: number }) {
  const dropMatch = move.match(/^([PLNSGBR])\*([1-9])([a-i])$/)
  if (dropMatch) {
    const x = Number(dropMatch[2])
    const y = 'abcdefghi'.indexOf(dropMatch[3]) + 1
    const square = previousTo && previousTo.x === x && previousTo.y === y ? '同' : toJapaneseSquare(x, y)
    return `${square}${pieceKanjiMap[usiDropMap[dropMatch[1]]]}打`
  }

  const moveMatch = move.match(/^([1-9])([a-i])([1-9])([a-i])(\+)?$/)
  if (!moveMatch) return move

  const fromX = Number(moveMatch[1])
  const fromY = 'abcdefghi'.indexOf(moveMatch[2]) + 1
  const toX = Number(moveMatch[3])
  const toY = 'abcdefghi'.indexOf(moveMatch[4]) + 1
  const promote = moveMatch[5] === '+'
  const piece = shogi.get(fromX, fromY)
  if (!piece) return move

  const player = piece.color === Color.Black ? '先手' : '後手'
  const square = previousTo && previousTo.x === toX && previousTo.y === toY ? '同' : toJapaneseSquare(toX, toY)
  const displayKind = promote ? Piece.promote(piece.kind) : piece.kind
  const competing = shogi
    .getMovesTo(toX, toY, piece.kind, piece.color)
    .filter((candidate) => candidate.from)
    .map((candidate) => ({ from: { x: candidate.from!.x, y: candidate.from!.y } }))
    .filter((candidate) => !(candidate.from.x === fromX && candidate.from.y === fromY))

  const suffix = describeDirection(player, fromX, fromY, toX, toY, competing)
  return `${square}${pieceKanjiMap[displayKind]}${suffix}${promote ? '成' : ''}`
}

function convertUsiPvToJapanese(moves: string[], parsedMoves: ParsedMove[], currentMoveIndex: number) {
  const shogi = applyMovesForEngine(parsedMoves, currentMoveIndex)
  let previousTo: { x: number; y: number } | undefined
  const result: string[] = []

  for (const move of moves) {
    const notation = usiMoveToJapanese(move, shogi, previousTo)
    result.push(notation)

    const dropMatch = move.match(/^([PLNSGBR])\*([1-9])([a-i])$/)
    if (dropMatch) {
      const x = Number(dropMatch[2])
      const y = 'abcdefghi'.indexOf(dropMatch[3]) + 1
      shogi.drop(x, y, usiDropMap[dropMatch[1]], shogi.turn)
      previousTo = { x, y }
      continue
    }

    const moveMatch = move.match(/^([1-9])([a-i])([1-9])([a-i])(\+)?$/)
    if (!moveMatch) continue
    const fromX = Number(moveMatch[1])
    const fromY = 'abcdefghi'.indexOf(moveMatch[2]) + 1
    const toX = Number(moveMatch[3])
    const toY = 'abcdefghi'.indexOf(moveMatch[4]) + 1
    const promote = moveMatch[5] === '+'
    shogi.move(fromX, fromY, toX, toY, promote)
    previousTo = { x: toX, y: toY }
  }

  return result
}

function convertEngineLinesToJapanese(lines: EngineLine[] | undefined, parsedMoves: ParsedMove[], currentMoveIndex: number): EngineDisplayLine[] | undefined {
  if (!lines || lines.length === 0) return undefined

  return lines.map((line) => {
    const shogi = applyMovesForEngine(parsedMoves, currentMoveIndex)
    return {
      move: usiMoveToJapanese(line.moveUsi, shogi),
      moveUsi: line.moveUsi,
      evaluation: line.evaluation,
      pv: convertUsiPvToJapanese(line.pv ?? [], parsedMoves, currentMoveIndex),
      depth: line.depth ?? 0,
    }
  })
}

function fallbackResult(reason: string | undefined, currentMoveIndex: number): EngineResult {
  const evaluation = 0
  return {
    source: 'mock',
    evaluation,
    bestMove: '候補なし',
    pv: [],
    depth: 0,
    summary: summarizeEvaluation(evaluation, currentMoveIndex, 'mock'),
    statusMessage: reason ? `軽量解析にフォールバック: ${reason}` : '解析結果を取得できず軽量解析で表示中',
  }
}

export async function analyzePosition(
  moves: ParsedMove[],
  currentMoveIndex: number,
  config?: EngineConfig,
): Promise<EngineResult> {
  const provider = getEngineProvider(config)
  const result = await provider.analyzePosition(moves, currentMoveIndex, config)

  if (result.available && (result.bestMoveUsi || result.bestMove)) {
    const evaluation = result.evaluation ?? 0
    const bestMoveUsi = result.bestMoveUsi
    const shogi = applyMovesForEngine(moves, currentMoveIndex)
    return {
      source: result.source,
      evaluation,
      bestMove: bestMoveUsi ? usiMoveToJapanese(bestMoveUsi, shogi) : result.bestMove ?? '候補なし',
      bestMoveUsi,
      pv: bestMoveUsi ? convertUsiPvToJapanese(result.pv ?? [], moves, currentMoveIndex) : (result.pv ?? []),
      depth: result.depth ?? 0,
      lines: convertEngineLinesToJapanese(result.lines, moves, currentMoveIndex),
      summary: summarizeEvaluation(evaluation, currentMoveIndex, result.source),
      statusMessage: result.statusMessage,
    }
  }

  if (provider.id === 'mock' && result.bestMove) {
    const evaluation = result.evaluation ?? 0
    return {
      source: 'mock',
      evaluation,
      bestMove: result.bestMove,
      pv: result.pv ?? [],
      depth: result.depth ?? 0,
      summary: summarizeEvaluation(evaluation, currentMoveIndex, 'mock'),
      statusMessage: result.statusMessage,
    }
  }

  const mockProvider = getEngineProvider({ provider: 'mock' })
  const fallback = await mockProvider.analyzePosition(moves, currentMoveIndex, config)
  return {
    source: 'mock',
    evaluation: fallback.evaluation ?? 0,
    bestMove: fallback.bestMove ?? '候補なし',
    pv: fallback.pv ?? [],
    depth: fallback.depth ?? 0,
    summary: summarizeEvaluation(fallback.evaluation ?? 0, currentMoveIndex, 'mock'),
    statusMessage: result.reason ? `軽量解析にフォールバック: ${result.reason}` : fallback.statusMessage,
  }
}

export async function analyzePositionFromSfen(
  sfen: string,
  moveCount: number,
  config?: EngineConfig,
): Promise<EngineResult> {
  const provider = getEngineProvider(config)
  const result = await provider.analyzeSfen(sfen, moveCount, config)

  if (result.available && result.bestMoveUsi) {
    const shogi = new Shogi({ preset: 'HIRATE' })
    shogi.initializeFromSFENString(sfen)
    const evaluation = result.evaluation ?? 0
    return {
      source: result.source,
      evaluation,
      bestMove: usiMoveToJapanese(result.bestMoveUsi, shogi),
      bestMoveUsi: result.bestMoveUsi,
      pv: [],
      depth: result.depth ?? 0,
      lines: result.lines?.map((line) => ({
        move: usiMoveToJapanese(line.moveUsi, shogi),
        moveUsi: line.moveUsi,
        evaluation: line.evaluation,
        pv: [],
        depth: line.depth ?? 0,
      })),
      summary: summarizeEvaluation(evaluation, moveCount, result.source),
      statusMessage: result.statusMessage,
    }
  }

  if (provider.id === 'mock' && result.bestMove) {
    return {
      source: 'mock',
      evaluation: result.evaluation ?? 0,
      bestMove: result.bestMove,
      pv: result.pv ?? [],
      depth: result.depth ?? 0,
      summary: '試し指し局面は軽量解析で表示中。',
      statusMessage: result.statusMessage,
    }
  }

  return fallbackResult(result.reason, moveCount)
}
