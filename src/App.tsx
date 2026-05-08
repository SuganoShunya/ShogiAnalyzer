import { useEffect, useMemo, useRef, useState } from 'react'
import { Color, Piece, Shogi, colorToString } from 'shogi.js'
import type { Kind } from 'shogi.js'
import { analyzePosition, analyzePositionFromSfen } from './engine'
import type { EngineResult } from './engine'
import { probeUsi } from './usiProbe'
import { canUseServerApis, isHostedWebApp, isNativePlatform } from './platform'
import type { EngineConfig, EngineProviderId, MobileQuality, ParsedMove, Player } from './types'
import './App.css'

type Candidate = {
  rank: number
  move: string
  moveUsi?: string
  evaluation: number
  intent: string
  from?: SelectedSquare
  to?: MoveTarget
  kind?: Kind
  drop?: boolean
  isCheck?: boolean
  captures?: string | null
  risky?: boolean
  hanging?: boolean
  playable?: boolean
  category?: 'attack' | 'defense' | 'shape' | 'drop' | 'waiting'
}

type Insight = {
  label: string
  value: string
  tone?: 'positive' | 'warning' | 'neutral'
}

type PositionAnalysis = EngineResult & {
  currentIndex: number
}

type BoardCell = {
  piece: string | null
  owner?: Player
  boardX: number
  boardY: number
}

type SelectedSquare = {
  x: number
  y: number
}

type MoveTarget = {
  x: number
  y: number
  promote: boolean
  optionalPromotion?: boolean
}

function usiRankToBoardY(rank: string) {
  return 'abcdefghi'.indexOf(rank) + 1
}

function parseUsiMove(moveUsi: string) {
  const dropMatch = moveUsi.match(/^([PLNSGBR])\*([1-9])([a-i])$/)
  if (dropMatch) {
    const dropKindMap: Record<string, Kind> = { P: 'FU', L: 'KY', N: 'KE', S: 'GI', G: 'KI', B: 'KA', R: 'HI' }
    return {
      kind: dropKindMap[dropMatch[1]],
      to: { x: Number(dropMatch[2]), y: usiRankToBoardY(dropMatch[3]), promote: false, optionalPromotion: false },
      drop: true as const,
    }
  }

  const moveMatch = moveUsi.match(/^([1-9])([a-i])([1-9])([a-i])(\+)?$/)
  if (!moveMatch) return null
  return {
    from: { x: Number(moveMatch[1]), y: usiRankToBoardY(moveMatch[2]) },
    to: {
      x: Number(moveMatch[3]),
      y: usiRankToBoardY(moveMatch[4]),
      promote: moveMatch[5] === '+',
      optionalPromotion: false,
    },
    drop: false as const,
  }
}

type SandboxMove = {
  notation: string
  sfen: string
  source?: 'manual' | 'pv'
}

type HandPiece = {
  label: string
  count: number
  kind: Kind
}

type ShogiWarsGame = {
  label: string
  href: string
  title?: string
  playedAt?: string
  playerSide?: 'sente' | 'gote'
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const STORAGE_KEY = 'shogi-analyzer-prototype-state-v2'
const DEFAULT_LAN_URL = 'http://192.168.11.22:5173'
const sampleKifu = `開始局面
▲２六歩 △８四歩 ▲２五歩 △８五歩
▲７八金 △３四歩 ▲２四歩 △同歩
▲同飛 △８六歩 ▲同歩 △同飛
▲３四飛 △３二金 ▲７六歩 △６二銀
▲４八銀 △５四歩 ▲６八玉 △４二玉
▲３六歩`

const numberMap: Record<string, number> = {
  '１': 1,
  '２': 2,
  '３': 3,
  '４': 4,
  '５': 5,
  '６': 6,
  '７': 7,
  '８': 8,
  '９': 9,
}

const fileRankPattern = '[１２３４５６７８９][一二三四五六七八九]'
const pieceLabelMap: Record<string, Kind> = {
  歩: 'FU',
  香: 'KY',
  桂: 'KE',
  銀: 'GI',
  金: 'KI',
  角: 'KA',
  飛: 'HI',
  王: 'OU',
  玉: 'OU',
  と: 'TO',
  杏: 'NY',
  圭: 'NK',
  全: 'NG',
  馬: 'UM',
  龍: 'RY',
  竜: 'RY',
}

const kindKanjiMap: Record<Kind, string> = {
  FU: '歩',
  KY: '香',
  KE: '桂',
  GI: '銀',
  KI: '金',
  KA: '角',
  HI: '飛',
  OU: '王',
  TO: 'と',
  NY: '杏',
  NK: '圭',
  NG: '全',
  UM: '馬',
  RY: '龍',
}

const handKindOrder = ['HI', 'KA', 'KI', 'GI', 'KE', 'KY', 'FU'] as const

function readStoredState() {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as {
      kifuText?: string
      sourceLabel?: string
      currentMoveIndex?: number
      engineConfig?: EngineConfig
      shogiWarsId?: string
      lanUrl?: string
    }
    return {
      kifuText: parsed.kifuText || sampleKifu,
      sourceLabel: parsed.sourceLabel || 'サンプル棋譜',
      currentMoveIndex: parsed.currentMoveIndex ?? parseSimpleKifu(sampleKifu).length,
      engineConfig: parsed.engineConfig ?? { provider: 'wasm', usiPath: '', thinkTimeMs: 1200, mobileQuality: 'auto' },
      shogiWarsId: parsed.shogiWarsId || '',
      lanUrl: parsed.lanUrl || DEFAULT_LAN_URL,
    }
  } catch {
    return null
  }
}

function toPlayer(color: Color): Player {
  return color === Color.Black ? '先手' : '後手'
}

function normalizeNotation(token: string): string {
  return token
    .replace(/[☗▲]/g, '▲')
    .replace(/[☖△]/g, '△')
    .replace(/\r/g, '')
    .trim()
}

function cleanupMoveNotation(notation: string): string {
  return notation
    .replace(/[ 　]/g, '')
    .replace(/[()（）][0-9０-９]+[)）]?/g, '')
    .replace(/不成/g, '')
    .replace(/成銀/g, '全')
    .replace(/成桂/g, '圭')
    .replace(/成香/g, '杏')
    .replace(/王/g, '玉')
    .replace(/竜/g, '龍')
    .trim()
}

function normalizeMoveForCompare(notation: string) {
  return cleanupMoveNotation(notation)
    .replace(/^同/, '同')
    .replace(/玉/g, '王')
}

function displayMoveNotation(notation: string): string {
  return notation
    .replace(/龍/g, '竜')
    .replace(/([歩香桂銀金角飛王玉と杏圭全馬竜龍])(右|左|直|寄|引|上|打|成)+/g, (_, piece, suffix) => `${piece}${suffix}`)
}

function parseSimpleKifu(input: string): ParsedMove[] {
  const tokens = input
    .split(/\s+/)
    .map(normalizeNotation)
    .filter(Boolean)
    .filter((token) => /^[▲△]/.test(token))

  return tokens.map((token, index) => ({
    moveNumber: index + 1,
    player: token.startsWith('▲') ? '先手' : '後手',
    notation: cleanupMoveNotation(token.slice(1)),
  }))
}

function parseKifText(input: string): ParsedMove[] {
  const lines = input.split(/\r?\n/)
  const moves: ParsedMove[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^(開始局面|手数----|先手：|後手：|場所：|持ち時間：|手合割：|戦型：|消費時間：)/.test(trimmed)) {
      continue
    }

    const match = trimmed.match(new RegExp(`^(\d+)\s+((?:同|${fileRankPattern}).+?)(?:\s+\(|$)`))
    if (!match) continue

    const moveNumber = Number(match[1])
    const notation = cleanupMoveNotation(match[2])
    const player = moveNumber % 2 === 1 ? '先手' : '後手'

    if (notation.startsWith('中断')) break

    moves.push({ moveNumber, player, notation })
  }

  return moves
}

function convertCsaMoveToNotation(
  shogi: Shogi,
  player: Player,
  from: string,
  to: string,
  kind: Kind,
  lastDestination: string | null,
) {
  const destination = to === lastDestination ? `同` : toJapaneseSquare(to)
  const piece = kindKanjiMap[kind]

  if (from === '00') {
    return `${destination}${piece}打`
  }

  const fromX = Number(from[0])
  const fromY = Number(from[1])
  const toX = Number(to[0])
  const toY = Number(to[1])
  const color = player === '先手' ? Color.Black : Color.White
  const candidates = shogi.getMovesTo(toX, toY, kind, color).filter((candidate) => candidate.from)
  const samePieceCandidates = candidates.filter(
    (candidate) => candidate.from?.x === fromX && candidate.from?.y === fromY,
  )

  const matchingCandidate = samePieceCandidates[0]
  const otherCandidates = candidates.filter(
    (candidate) => !(candidate.from?.x === fromX && candidate.from?.y === fromY),
  )

  let suffix = ''

  if (otherCandidates.length > 0 && matchingCandidate?.from) {
    const source = matchingCandidate.from

    const hasSameFile = otherCandidates.some((candidate) => candidate.from?.x === source.x)
    if (hasSameFile) {
      suffix += '直'
    } else {
      const rightMost = player === '先手'
        ? Math.max(...candidates.map((candidate) => candidate.from!.x))
        : Math.min(...candidates.map((candidate) => candidate.from!.x))
      const leftMost = player === '先手'
        ? Math.min(...candidates.map((candidate) => candidate.from!.x))
        : Math.max(...candidates.map((candidate) => candidate.from!.x))

      if (source.x === rightMost) suffix += '右'
      else if (source.x === leftMost) suffix += '左'
    }

    const movement = player === '先手' ? source.y - toY : toY - source.y
    if (movement > 0) suffix += '上'
    else if (movement < 0) suffix += '引'
    else suffix += '寄'
  }

  const originalPiece = shogi.get(fromX, fromY)
  const promotedKinds = ['TO', 'NY', 'NK', 'NG', 'UM', 'RY']
  const promote =
    !!originalPiece &&
    originalPiece.kind !== kind &&
    !promotedKinds.includes(originalPiece.kind) &&
    promotedKinds.includes(kind)
  if (promote) suffix += '成'

  return `${destination}${piece}${suffix}`
}

function parseCsaText(input: string): ParsedMove[] {
  const lines = input.split(/\r?\n/)
  const moves: ParsedMove[] = []
  let lastDestination: string | null = null
  const shogi = new Shogi()

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!/^[+-][0-9]{4}[A-Z]{2}$/.test(line)) continue

    const player = line.startsWith('+') ? '先手' : '後手'
    const from = line.slice(1, 3)
    const to = line.slice(3, 5)
    const kind = line.slice(5, 7) as Kind
    try {
      const notation = convertCsaMoveToNotation(shogi, player, from, to, kind, lastDestination)

      moves.push({
        moveNumber: moves.length + 1,
        player,
        notation,
      })

      if (from === '00') {
        const color = player === '先手' ? Color.Black : Color.White
        shogi.drop(Number(to[0]), Number(to[1]), kind, color)
      } else {
        const originalPiece = shogi.get(Number(from[0]), Number(from[1]))
        const promotedKinds = ['TO', 'NY', 'NK', 'NG', 'UM', 'RY']
        const promote =
          !!originalPiece &&
          originalPiece.kind !== kind &&
          !promotedKinds.includes(originalPiece.kind) &&
          promotedKinds.includes(kind)
        shogi.move(Number(from[0]), Number(from[1]), Number(to[0]), Number(to[1]), promote)
      }
    } catch (error) {
      throw new Error(
        `CSA ${moves.length + 1}手目の変換に失敗: ${line} / ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }

    lastDestination = to
  }

  return moves
}

function parseAnyKifu(input: string, filename?: string) {
  const trimmed = input.trim()
  const lowerName = filename?.toLowerCase() ?? ''

  const isCsa = lowerName.endsWith('.csa') || /^([+-]P|PI|N\+|N\-|\$)/m.test(trimmed)
  const isKif = lowerName.endsWith('.kif') || lowerName.endsWith('.ki2') || /手数----|^[0-9]+\s+/.test(trimmed)

  if (isCsa) return parseCsaText(trimmed)
  if (isKif) return parseKifText(trimmed)
  return parseSimpleKifu(trimmed)
}

function toJapaneseSquare(square: string) {
  const file = Number(square[0])
  const rankIndex = Number(square[1]) - 1
  const rankKanji = '一二三四五六七八九'[rankIndex]
  return `${'０１２３４５６７８９'[file]}${rankKanji}`.replace('０', '')
}

function parseMoveNotation(notation: string, lastTo?: { x: number; y: number }) {
  if (notation.startsWith('投了')) {
    return { type: 'resign' as const }
  }

  const destinationMatch = notation.match(/^(同|[１-９][一二三四五六七八九])/)
  if (!destinationMatch) {
    throw new Error(`行き先を解釈できない手です: ${notation}`)
  }

  let destination
  let rest = notation.slice(destinationMatch[0].length)

  if (destinationMatch[0] === '同') {
    if (!lastTo) throw new Error(`"同" の直前局面がありません: ${notation}`)
    destination = lastTo
  } else {
    const x = numberMap[destinationMatch[0][0]]
    const kanjiRank = destinationMatch[0][1]
    const rankMap = '一二三四五六七八九'
    const y = rankMap.indexOf(kanjiRank) + 1
    if (!x || !y) throw new Error(`座標を解釈できません: ${notation}`)
    destination = { x, y }
  }

  const pieceSymbol = Object.keys(pieceLabelMap).find((symbol) => rest.startsWith(symbol))
  if (!pieceSymbol) {
    throw new Error(`駒種を解釈できません: ${notation}`)
  }

  rest = rest.slice(pieceSymbol.length)
  const kind = pieceLabelMap[pieceSymbol]
  const isDrop = rest.includes('打')
  const promote = rest.includes('成')
  const promotedSourceKindMap: Partial<Record<Kind, Kind>> = {
    TO: 'FU',
    NY: 'KY',
    NK: 'KE',
    NG: 'GI',
    UM: 'KA',
    RY: 'HI',
  }
  const searchKind = promote ? promotedSourceKindMap[kind] ?? kind : kind
  const directionHints = {
    right: rest.includes('右'),
    left: rest.includes('左'),
    straight: rest.includes('直'),
    approach: rest.includes('寄'),
    pull: rest.includes('引'),
    advance: rest.includes('上'),
  }

  return {
    type: isDrop ? ('drop' as const) : ('move' as const),
    destination,
    kind,
    searchKind,
    promote,
    directionHints,
  }
}

function chooseCandidate(
  candidates: Array<{ from?: { x: number; y: number }; to: { x: number; y: number } }>,
  player: Player,
  hints: {
    right: boolean
    left: boolean
    straight: boolean
    approach: boolean
    pull: boolean
    advance: boolean
  },
) {
  const withFrom = candidates.filter((candidate) => candidate.from)
  if (withFrom.length <= 1) return withFrom[0]

  let filtered = withFrom

  if (hints.right || hints.left) {
    filtered = [...filtered].sort((a, b) => {
      const ax = a.from!.x
      const bx = b.from!.x
      return player === '先手' ? bx - ax : ax - bx
    })
    if (hints.right) filtered = [filtered[0]]
    if (hints.left) filtered = [filtered[filtered.length - 1]]
  }

  if (hints.straight) {
    const straightCandidates = filtered.filter((candidate) => candidate.from!.x === candidate.to.x)
    if (straightCandidates.length > 0) filtered = straightCandidates
  }

  if (hints.approach || hints.pull || hints.advance) {
    filtered = [...filtered].sort((a, b) => {
      const ay = a.from!.y
      const by = b.from!.y
      if (hints.approach) return player === '先手' ? by - ay : ay - by
      if (hints.pull) return player === '先手' ? ay - by : by - ay
      if (hints.advance) return player === '先手' ? by - ay : ay - by
      return 0
    })
  }

  return filtered[0]
}

function applyMoves(moves: ParsedMove[], moveIndex: number) {
  const shogi = new Shogi()
  let lastTo: { x: number; y: number } | undefined

  for (let i = 0; i < moveIndex; i += 1) {
    const move = moves[i]
    const parsed = parseMoveNotation(move.notation, lastTo)
    const color = move.player === '先手' ? Color.Black : Color.White

    if (parsed.type === 'resign') {
      break
    }

    if (parsed.type === 'drop') {
      shogi.drop(parsed.destination.x, parsed.destination.y, parsed.kind, color)
      lastTo = parsed.destination
      continue
    }

    const candidates = shogi
      .getMovesTo(parsed.destination.x, parsed.destination.y, parsed.searchKind, color)
      .filter((candidate) => candidate.from)

    if (candidates.length === 0) {
      throw new Error(`候補が見つからない手: ${move.player} ${move.notation}`)
    }

    const selected = chooseCandidate(candidates, move.player, parsed.directionHints)
    if (!selected.from) {
      throw new Error(`移動元が不明です: ${move.player} ${move.notation}`)
    }

    shogi.move(
      selected.from.x,
      selected.from.y,
      parsed.destination.x,
      parsed.destination.y,
      parsed.promote,
    )

    lastTo = parsed.destination
  }

  return shogi
}

if (typeof globalThis !== 'undefined') {
  ;(globalThis as { __buildShogiFromParsedMoves__?: typeof applyMoves }).__buildShogiFromParsedMoves__ = applyMoves
  ;(globalThis as { __shogiParseMoveNotation__?: typeof parseMoveNotation }).__shogiParseMoveNotation__ = parseMoveNotation
  ;(globalThis as { __shogiChooseCandidate__?: typeof chooseCandidate }).__shogiChooseCandidate__ = chooseCandidate
}

function boardFromShogi(shogi: Shogi): BoardCell[][] {
  return Array.from({ length: 9 }, (_, rowIndex) => {
    const y = rowIndex + 1
    return Array.from({ length: 9 }, (_, colIndex) => {
      const x = 9 - colIndex
      const piece = shogi.get(x, y)
      if (!piece) return { piece: null, boardX: x, boardY: y }
      return {
        piece: kindKanjiMap[piece.kind],
        owner: toPlayer(piece.color),
        boardX: x,
        boardY: y,
      }
    })
  })
}

function handFromShogi(shogi: Shogi, color: Color): HandPiece[] {
  const summary = shogi.getHandsSummary(color)
  return handKindOrder
    .map((kind) => ({ label: kindKanjiMap[kind], count: summary[kind], kind }))
    .filter((item) => item.count > 0)
}

function canPromoteForMove(kind: Kind, fromY: number, toY: number, player: Player) {
  if (!Piece.canPromote(kind)) return false
  if (player === '先手') return fromY <= 3 || toY <= 3
  return fromY >= 7 || toY >= 7
}

function getCellClasses(
  cell: BoardCell,
  selectedSquare: SelectedSquare | null,
  legalTargets: MoveTarget[],
) {
  const isSelected =
    selectedSquare !== null && selectedSquare.x === cell.boardX && selectedSquare.y === cell.boardY
  const isLegalTarget = legalTargets.some((target) => target.x === cell.boardX && target.y === cell.boardY)

  return ['cell', isSelected ? 'selected' : '', isLegalTarget ? 'legal-target' : '']
    .filter(Boolean)
    .join(' ')
}

function notationFromBoardMove(
  shogi: Shogi,
  from: SelectedSquare,
  to: MoveTarget,
  isDrop = false,
  dropKind?: Kind,
) {
  const sameSquare = from.x === to.x && from.y === to.y
  if (sameSquare) return '同'

  const destination = `${'０１２３４５６７８９'[to.x].replace('０', '')}${'一二三四五六七八九'[to.y - 1]}`
  if (isDrop && dropKind) {
    return `${destination}${kindKanjiMap[dropKind]}打`
  }

  const piece = shogi.get(from.x, from.y)
  if (!piece) return destination
  return `${destination}${kindKanjiMap[to.promote ? Piece.promote(piece.kind) : piece.kind]}${to.promote ? '成' : ''}`
}

function scoreMoveIntent(kind: Kind, move: MoveTarget, turn: Color, evaluation: number) {
  const enemyCamp = turn === Color.Black ? move.y <= 3 : move.y >= 7
  const centerDistance = Math.abs(5 - move.x)
  let score = evaluation

  if (kind === 'OU') score += 12
  if (kind === 'HI' || kind === 'KA') score += enemyCamp ? 40 : 18
  if (kind === 'KI' || kind === 'GI') score += enemyCamp ? 24 : 14
  if (kind === 'FU') score += enemyCamp ? 16 : 8
  if (move.promote) score += 55
  score += Math.max(0, 4 - centerDistance) * 6
  score += enemyCamp ? 18 : 0

  return score
}

function cloneShogiWithMove(
  shogi: Shogi,
  move: { from?: SelectedSquare; to: MoveTarget; kind: Kind; drop?: boolean },
) {
  const next = new Shogi({ preset: 'HIRATE' })
  next.initializeFromSFENString(shogi.toSFENString())

  if (move.drop) {
    next.drop(move.to.x, move.to.y, move.kind, next.turn)
  } else if (move.from) {
    next.move(move.from.x, move.from.y, move.to.x, move.to.y, move.to.promote)
  }

  return next
}

function findKingSquare(shogi: Shogi, color: Color) {
  for (let x = 1; x <= 9; x += 1) {
    for (let y = 1; y <= 9; y += 1) {
      const piece = shogi.get(x, y)
      if (piece?.color === color && piece.kind === 'OU') {
        return { x, y }
      }
    }
  }
  return null
}

function isSquareAttacked(shogi: Shogi, square: SelectedSquare, attacker: Color) {
  for (let x = 1; x <= 9; x += 1) {
    for (let y = 1; y <= 9; y += 1) {
      const piece = shogi.get(x, y)
      if (!piece || piece.color !== attacker) continue
      const moves = shogi.getMovesFrom(x, y)
      if (moves.some((move) => move.to.x === square.x && move.to.y === square.y)) {
        return true
      }
    }
  }
  return false
}

function analyzeCandidateRisk(
  shogi: Shogi,
  move: { from?: SelectedSquare; to: MoveTarget; kind: Kind; drop?: boolean },
) {
  const targetPiece = shogi.get(move.to.x, move.to.y)
  const next = cloneShogiWithMove(shogi, move)
  const mover = shogi.turn
  const opponent = mover === Color.Black ? Color.White : Color.Black
  const enemyKing = findKingSquare(next, opponent)
  const ownKing = findKingSquare(next, mover)
  const movedPiece = next.get(move.to.x, move.to.y)
  const hanging = !!movedPiece && movedPiece.kind !== 'OU' && isSquareAttacked(next, { x: move.to.x, y: move.to.y }, opponent)

  return {
    isCheck: enemyKing ? isSquareAttacked(next, enemyKing, mover) : false,
    captures: targetPiece ? kindKanjiMap[targetPiece.kind] : null,
    risky: ownKing ? isSquareAttacked(next, ownKing, opponent) : false,
    hanging,
  }
}

function candidateIntentLabel(kind: Kind, move: MoveTarget, drop: boolean, turn: Color) {
  const enemyCamp = turn === Color.Black ? move.y <= 3 : move.y >= 7

  if (drop) {
    if (kind === 'FU') return '打って拠点を作る'
    if (kind === 'HI' || kind === 'KA') return '大駒を打って主導権を取る'
    return '持ち駒を使って手をつなぐ'
  }

  if (move.promote) return '成って得を広げる'
  if (kind === 'OU') return '玉を整えて安定させる'
  if (kind === 'KI' || kind === 'GI') return enemyCamp ? '攻防の要を前に出す' : '玉形を締めて厚くする'
  if (kind === 'HI' || kind === 'KA') return enemyCamp ? '大駒で踏み込んで圧をかける' : '大駒の利きを通す'
  if (kind === 'FU') return enemyCamp ? '歩で突いて拠点を作る' : '歩で形を整える'

  return enemyCamp ? '前へ出て圧力をかける' : '形を崩さず含みを残す'
}

function countNearbyFriendlyPieces(shogi: Shogi, x: number, y: number, color: Color) {
  let count = 0
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue
      const nx = x + dx
      const ny = y + dy
      if (nx < 1 || nx > 9 || ny < 1 || ny > 9) continue
      const piece = shogi.get(nx, ny)
      if (piece?.color === color) count += 1
    }
  }
  return count
}

function distanceToKing(square: SelectedSquare, king: SelectedSquare | null) {
  if (!king) return 99
  return Math.abs(square.x - king.x) + Math.abs(square.y - king.y)
}

function categorizeCandidate(
  shogi: Shogi,
  move: { from?: SelectedSquare; to: MoveTarget; kind: Kind; drop?: boolean },
  meta: { isCheck: boolean; captures: string | null; risky: boolean },
) {
  const mover = shogi.turn
  const ownKing = findKingSquare(shogi, mover)
  const enemy = mover === Color.Black ? Color.White : Color.Black
  const enemyKing = findKingSquare(shogi, enemy)
  const toSquare = { x: move.to.x, y: move.to.y }
  const ownKingDistance = distanceToKing(toSquare, ownKing)
  const enemyKingDistance = distanceToKing(toSquare, enemyKing)
  const nearbyFriends = countNearbyFriendlyPieces(shogi, move.to.x, move.to.y, mover)

  if (move.drop) return 'drop'
  if (meta.isCheck || meta.captures || enemyKingDistance <= 2) return 'attack'
  if (move.kind === 'OU' || ownKingDistance <= 2 || nearbyFriends >= 3) return 'defense'
  if (move.kind === 'FU' && !meta.captures && enemyKingDistance >= 4) return 'waiting'
  return 'shape'
}

function categoryWeight(category: Candidate['category']) {
  switch (category) {
    case 'attack':
      return 42
    case 'defense':
      return 28
    case 'drop':
      return 24
    case 'shape':
      return 14
    case 'waiting':
      return -12
    default:
      return 0
  }
}

function shouldKeepDuplicate(existing: Candidate, incoming: Candidate) {
  const existingPriority =
    (existing.isCheck ? 2 : 0) + (existing.captures ? 1 : 0) - (existing.risky ? 2 : 0) - (existing.hanging ? 3 : 0)
  const incomingPriority =
    (incoming.isCheck ? 2 : 0) + (incoming.captures ? 1 : 0) - (incoming.risky ? 2 : 0) - (incoming.hanging ? 3 : 0)
  if (existingPriority !== incomingPriority) return incomingPriority > existingPriority
  return incoming.evaluation > existing.evaluation
}

function selectDiverseCandidates(candidates: Candidate[], bestMove: string, bestMoveUsi?: string) {
  const bestKey = normalizeMoveForCompare(bestMove)
  const deduped = new Map<string, Candidate>()
  const parsedBestAction = bestMoveUsi
    ? candidates.find((candidate) => candidate.moveUsi === bestMoveUsi)
    : candidates.find((candidate) => normalizeMoveForCompare(candidate.move) === bestKey)

  for (const candidate of candidates) {
    const key = `${candidate.kind}-${candidate.to?.x}-${candidate.to?.y}-${candidate.category}`
    const current = deduped.get(key)
    if (!current || shouldKeepDuplicate(current, candidate)) {
      deduped.set(key, candidate)
    }
  }

  const sorted = [...deduped.values()].sort((a, b) => {
    const aBest = normalizeMoveForCompare(a.move) === bestKey ? 1 : 0
    const bBest = normalizeMoveForCompare(b.move) === bestKey ? 1 : 0
    if (aBest !== bBest) return bBest - aBest
    return b.evaluation - a.evaluation
  })

  const picks: Candidate[] = []
  const usedCategories = new Set<Candidate['category']>()
  const matchedBest = bestMoveUsi
    ? sorted.find((candidate) => candidate.moveUsi === bestMoveUsi)
    : sorted.find((candidate) => normalizeMoveForCompare(candidate.move) === bestKey)

  picks.push(
    matchedBest
      ? {
          ...matchedBest,
          move: bestMove,
          moveUsi: bestMoveUsi ?? matchedBest.moveUsi,
          playable: true,
          intent: matchedBest.intent || 'エンジン推奨手',
        }
      : {
          rank: 0,
          move: bestMove,
          moveUsi: bestMoveUsi,
          evaluation: candidates[0]?.evaluation ?? 0,
          intent: parsedBestAction ? 'エンジン推奨手' : 'エンジン推奨手 (盤面反映不可)',
          from: parsedBestAction && !parsedBestAction.drop ? parsedBestAction.from : undefined,
          to: parsedBestAction?.to,
          kind: parsedBestAction?.kind,
          drop: parsedBestAction?.drop,
          playable: !!parsedBestAction,
          category: 'attack',
        },
  )
  if (picks[0].category) usedCategories.add(picks[0].category)

  for (const candidate of sorted) {
    if (picks.some((picked) => normalizeMoveForCompare(picked.move) === normalizeMoveForCompare(candidate.move))) continue
    if (candidate.category && !usedCategories.has(candidate.category)) {
      picks.push(candidate)
      usedCategories.add(candidate.category)
    }
    if (picks.length >= 5) break
  }

  for (const candidate of sorted) {
    if (picks.some((picked) => normalizeMoveForCompare(picked.move) === normalizeMoveForCompare(candidate.move))) continue
    picks.push(candidate)
    if (picks.length >= 5) break
  }

  return picks.slice(0, 5).map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

function candidateFromPosition(shogi: Shogi, bestMove: string, evaluation: number, bestMoveUsi?: string): Candidate[] {
  const turn = shogi.turn
  const moveCandidates: Candidate[] = []
  const parsedBestUsi = bestMoveUsi ? parseUsiMove(bestMoveUsi) : null

  for (let x = 1; x <= 9; x += 1) {
    for (let y = 1; y <= 9; y += 1) {
      const piece = shogi.get(x, y)
      if (!piece || piece.color !== turn) continue

      const moves = shogi.getMovesFrom(x, y)
      for (const move of moves) {
        const baseTarget = { x: move.to.x, y: move.to.y, promote: false, optionalPromotion: false }
        const baseMeta = analyzeCandidateRisk(shogi, { from: { x, y }, to: baseTarget, kind: piece.kind, drop: false })
        const baseCategory = categorizeCandidate(shogi, { from: { x, y }, to: baseTarget, kind: piece.kind, drop: false }, baseMeta)
        moveCandidates.push({
          rank: 0,
          move: notationFromBoardMove(shogi, { x, y }, baseTarget),
          evaluation:
            scoreMoveIntent(piece.kind, baseTarget, turn, evaluation) +
            (baseMeta.isCheck ? 90 : 0) +
            (baseMeta.captures ? 45 : 0) -
            (baseMeta.risky ? 140 : 0) -
            (baseMeta.hanging ? 220 : 0) +
            categoryWeight(baseCategory),
          intent: baseMeta.isCheck
            ? '王手でプレッシャーをかける'
            : baseMeta.captures
              ? `${baseMeta.captures}を取って得する`
              : candidateIntentLabel(piece.kind, baseTarget, false, turn),
          from: { x, y },
          to: baseTarget,
          kind: piece.kind,
          drop: false,
          isCheck: baseMeta.isCheck,
          captures: baseMeta.captures,
          risky: baseMeta.risky,
          hanging: baseMeta.hanging,
          category: baseCategory,
        })

        const optionalPromotion = Piece.canPromote(piece.kind) && canPromoteForMove(piece.kind, y, move.to.y, toPlayer(piece.color))
        if (optionalPromotion) {
          const promoteTarget = { x: move.to.x, y: move.to.y, promote: true, optionalPromotion: true }
          const promoteMeta = analyzeCandidateRisk(shogi, { from: { x, y }, to: promoteTarget, kind: piece.kind, drop: false })
          const promoteCategory = categorizeCandidate(shogi, { from: { x, y }, to: promoteTarget, kind: piece.kind, drop: false }, promoteMeta)
          moveCandidates.push({
            rank: 0,
            move: notationFromBoardMove(shogi, { x, y }, promoteTarget),
            evaluation:
              scoreMoveIntent(piece.kind, promoteTarget, turn, evaluation) +
              (promoteMeta.isCheck ? 90 : 0) +
              (promoteMeta.captures ? 45 : 0) -
              (promoteMeta.risky ? 140 : 0) -
              (promoteMeta.hanging ? 220 : 0) +
              categoryWeight(promoteCategory),
            intent: promoteMeta.isCheck
              ? '成りながら王手で迫る'
              : promoteMeta.captures
                ? `${promoteMeta.captures}を取りつつ成る`
                : '成りを含めて主導権を狙う',
            from: { x, y },
            to: promoteTarget,
            kind: piece.kind,
            drop: false,
            isCheck: promoteMeta.isCheck,
            captures: promoteMeta.captures,
            risky: promoteMeta.risky,
            hanging: promoteMeta.hanging,
            category: promoteCategory,
          })
        }
      }
    }
  }

  const dropCandidates: Candidate[] = shogi.getDropsBy(turn)
    .filter((move) => !!move.kind)
    .map((move) => {
      const target = { x: move.to.x, y: move.to.y, promote: false, optionalPromotion: false }
      const dropKind = move.kind as Kind
      const meta = analyzeCandidateRisk(shogi, { to: target, kind: dropKind, drop: true })
      const category = categorizeCandidate(shogi, { to: target, kind: dropKind, drop: true }, meta)
      return {
        rank: 0,
        move: notationFromBoardMove(shogi, { x: move.to.x, y: move.to.y }, target, true, dropKind),
        evaluation:
          scoreMoveIntent(dropKind, target, turn, evaluation - 8) +
          (meta.isCheck ? 90 : 0) +
          (meta.captures ? 45 : 0) -
          (meta.risky ? 140 : 0) -
          (meta.hanging ? 220 : 0) +
          categoryWeight(category),
        intent: meta.isCheck
          ? '打って王手をかける'
          : meta.captures
            ? `${meta.captures}取りを見せる打ち込み`
            : candidateIntentLabel(dropKind, target, true, turn),
        to: target,
        kind: dropKind,
        drop: true,
        isCheck: meta.isCheck,
        captures: meta.captures,
        risky: meta.risky,
        hanging: meta.hanging,
        category,
      }
    })

  const bestCandidateFromUsi: Candidate[] = []
  if (parsedBestUsi?.drop) {
    bestCandidateFromUsi.push({
      rank: 0,
      move: bestMove,
      moveUsi: bestMoveUsi,
      evaluation,
      intent: 'エンジン推奨手',
      to: parsedBestUsi.to,
      kind: parsedBestUsi.kind,
      drop: true,
      playable: true,
      category: 'attack',
    })
  } else if (parsedBestUsi?.from) {
    const piece = shogi.get(parsedBestUsi.from.x, parsedBestUsi.from.y)
    if (piece && piece.color === turn) {
      bestCandidateFromUsi.push({
        rank: 0,
        move: bestMove,
        moveUsi: bestMoveUsi,
        evaluation,
        intent: 'エンジン推奨手',
        from: parsedBestUsi.from,
        to: parsedBestUsi.to,
        kind: piece.kind,
        drop: false,
        playable: true,
        category: 'attack',
      })
    }
  }

  return selectDiverseCandidates([...bestCandidateFromUsi, ...moveCandidates, ...dropCandidates], bestMove, bestMoveUsi)
}

function App() {
  const initialState = readStoredState()
  const nativePlatform = isNativePlatform()
  const hostedWebApp = isHostedWebApp()
  const serverApisAvailable = canUseServerApis()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [kifuText, setKifuText] = useState(initialState?.kifuText ?? sampleKifu)
  const [sourceLabel, setSourceLabel] = useState(initialState?.sourceLabel ?? 'サンプル棋譜')
  const [analysis, setAnalysis] = useState<PositionAnalysis>({
    source: 'mock',
    evaluation: 0,
    bestMove: '７六歩',
    pv: ['７六歩', '８四歩', '６八銀'],
    depth: 12,
    summary: '初期局面。次の一手で流れが決まる。',
    currentIndex: 0,
  })
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedSquare, setSelectedSquare] = useState<SelectedSquare | null>(null)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installMessage, setInstallMessage] = useState('Androidは Chrome のメニューからホーム画面に追加でかなり実用的。まずPWA運用で十分。')
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false)
  const [pwaUpdateReady, setPwaUpdateReady] = useState(false)
  const [sandboxSfen, setSandboxSfen] = useState<string | null>(null)
  const [sandboxMoveCount, setSandboxMoveCount] = useState(0)
  const [sandboxMoves, setSandboxMoves] = useState<SandboxMove[]>([])
  const [pendingMove, setPendingMove] = useState<{ from: SelectedSquare; to: MoveTarget } | null>(null)
  const [selectedHandKind, setSelectedHandKind] = useState<Kind | null>(null)
  const [pvPreviewIndex, setPvPreviewIndex] = useState<number | null>(null)
  const [shogiWarsId, setShogiWarsId] = useState(initialState?.shogiWarsId ?? '')
  const [shogiWarsRule, setShogiWarsRule] = useState('')
  const [shogiWarsGames, setShogiWarsGames] = useState<ShogiWarsGame[]>([])
  const [shogiWarsPage, setShogiWarsPage] = useState(1)
  const [shogiWarsPageInfo, setShogiWarsPageInfo] = useState<{ hasNext: boolean; hasPrev: boolean; nextPage: number | null; prevPage: number | null }>({
    hasNext: false,
    hasPrev: false,
    nextPage: null,
    prevPage: null,
  })
  const [shogiWarsState, setShogiWarsState] = useState<{ loading: boolean; message: string }>({ loading: false, message: '未取得' })
  const [engineConfig, setEngineConfig] = useState<EngineConfig>(
    initialState?.engineConfig ?? { provider: 'wasm', usiPath: '', thinkTimeMs: 1200, mobileQuality: 'auto' },
  )
  const [probeState, setProbeState] = useState<{ loading: boolean; message: string; ok?: boolean }>({
    loading: false,
    message: '未テスト',
  })
  const [lanUrl, setLanUrl] = useState(initialState?.lanUrl ?? DEFAULT_LAN_URL)
  const analysisRequestIdRef = useRef(0)
  const parsedMoves = useMemo(() => {
    try {
      return parseAnyKifu(kifuText, sourceLabel)
    } catch (error) {
      console.error('parseAnyKifu failed', error)
      return []
    }
  }, [kifuText, sourceLabel])
  const [currentMoveIndex, setCurrentMoveIndex] = useState(
    initialState?.currentMoveIndex ?? parseAnyKifu(initialState?.kifuText ?? sampleKifu).length,
  )

  const safeCurrentMoveIndex = Math.min(currentMoveIndex, parsedMoves.length)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        kifuText,
        sourceLabel,
        currentMoveIndex: safeCurrentMoveIndex,
        engineConfig,
        shogiWarsId,
        lanUrl,
      }),
    )
  }, [currentMoveIndex, engineConfig, kifuText, lanUrl, safeCurrentMoveIndex, shogiWarsId, sourceLabel])

  useEffect(() => {
    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
      setInstallMessage('この端末ではアプリとして追加できます。下のボタンから進めてOK。')
    }

    function onOnline() {
      setIsOffline(false)
    }

    function onOffline() {
      setIsOffline(true)
    }

    function onPwaUpdateReady() {
      setPwaUpdateReady(true)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('pwa-update-ready', onPwaUpdateReady)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('pwa-update-ready', onPwaUpdateReady)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const requestId = ++analysisRequestIdRef.current
    const requestIndex = safeCurrentMoveIndex
    const debounceMs = sandboxSfen ? 80 : 140

    const timer = window.setTimeout(() => {
      async function runAnalysis() {
        setIsAnalyzing(true)
        const result = sandboxSfen
          ? await analyzePositionFromSfen(sandboxSfen, safeCurrentMoveIndex + sandboxMoveCount, engineConfig)
          : await analyzePosition(parsedMoves, safeCurrentMoveIndex, engineConfig)
        if (!disposed && requestId === analysisRequestIdRef.current) {
          setAnalysis({ ...result, currentIndex: requestIndex })
          setIsAnalyzing(false)
        }
      }

      runAnalysis().catch(() => {
        if (!disposed && requestId === analysisRequestIdRef.current) {
          setIsAnalyzing(false)
        }
      })
    }, debounceMs)

    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [engineConfig, parsedMoves, safeCurrentMoveIndex, sandboxMoveCount, sandboxSfen])

  const previewMoveIndex = sandboxSfen ? safeCurrentMoveIndex + sandboxMoveCount : safeCurrentMoveIndex

  const positionState = useMemo(() => {
    try {
      const shogi = sandboxSfen ? new Shogi({ preset: 'HIRATE' }) : applyMoves(parsedMoves, safeCurrentMoveIndex)
      if (sandboxSfen) {
        shogi.initializeFromSFENString(sandboxSfen)
      }
      const currentMove = sandboxSfen
        ? {
            moveNumber: previewMoveIndex,
            player: colorToString(shogi.turn) === 'black' ? '後手' : '先手',
            notation: pvPreviewIndex !== null ? 'PVプレビュー中' : '盤面操作中',
          }
        : parsedMoves[safeCurrentMoveIndex - 1]
      const progress = parsedMoves.length
        ? Math.round((safeCurrentMoveIndex / parsedMoves.length) * 100)
        : 0

      const insights: Insight[] = [
        {
          label: '手番',
          value: colorToString(shogi.turn) === 'black' ? '先手' : '後手',
          tone: 'neutral',
        },
        {
          label: '現在手数',
          value: sandboxSfen
            ? `${safeCurrentMoveIndex + sandboxMoveCount} / ${parsedMoves.length} + 操作中`
            : `${safeCurrentMoveIndex} / ${parsedMoves.length}`,
          tone: 'neutral',
        },
        {
          label: '評価値',
          value: `${analysis.evaluation > 0 ? '+' : ''}${analysis.evaluation}`,
          tone: analysis.evaluation > 120 ? 'positive' : analysis.evaluation < -120 ? 'warning' : 'neutral',
        },
        {
          label: '解析深さ',
          value: `Depth ${analysis.depth}`,
          tone: 'neutral',
        },
        {
          label: '解析モード',
          value:
            analysis.source === 'usi'
              ? 'PCエンジン'
              : analysis.source === 'wasm'
                ? '端末内WASM'
                : '軽量フォールバック',
          tone: analysis.source === 'mock' ? 'warning' : 'positive',
        },
        {
          label: '接続状態',
          value:
            analysis.source === 'usi'
              ? '接続OK'
              : analysis.source === 'wasm'
                ? '端末内解析モード'
                : '未接続 / fallback',
          tone: analysis.source === 'mock' ? 'warning' : 'positive',
        },
        {
          label: '進捗',
          value: `${progress}%`,
          tone: progress > 60 ? 'positive' : 'neutral',
        },
        {
          label: '保存',
          value: 'ローカル保存中',
          tone: 'positive',
        },
      ]

      return {
        shogi,
        board: boardFromShogi(shogi),
        senteHand: handFromShogi(shogi, Color.Black),
        goteHand: handFromShogi(shogi, Color.White),
        insights,
        currentMove,
        error: null,
      }
    } catch (error) {
      return {
        shogi: null,
        board: [],
        senteHand: [],
        goteHand: [],
        insights: [],
        currentMove: undefined,
        error: error instanceof Error ? error.message : '不明なエラー',
      }
    }
  }, [analysis.depth, analysis.evaluation, parsedMoves, previewMoveIndex, pvPreviewIndex, safeCurrentMoveIndex, sandboxMoveCount, sandboxSfen])

  const currentMove = positionState.currentMove
  const candidateMoves = useMemo(
    () => {
      if (!positionState.shogi) return []

      if (analysis.lines && analysis.lines.length > 0) {
        return analysis.lines.map((line, index) => {
          const parsed = parseUsiMove(line.moveUsi)
          if (parsed?.drop) {
            return {
              rank: index + 1,
              move: line.move,
              moveUsi: line.moveUsi,
              evaluation: line.evaluation,
              intent: index === 0 ? 'エンジン推奨手' : 'エンジン候補手',
              to: parsed.to,
              kind: parsed.kind,
              drop: true,
              playable: true,
              category: 'attack' as const,
              isCheck: false,
              captures: null,
              risky: false,
              hanging: false,
            }
          }

          if (parsed?.from) {
            const piece = positionState.shogi.get(parsed.from.x, parsed.from.y)
            return {
              rank: index + 1,
              move: line.move,
              moveUsi: line.moveUsi,
              evaluation: line.evaluation,
              intent: index === 0 ? 'エンジン推奨手' : 'エンジン候補手',
              from: parsed.from,
              to: parsed.to,
              kind: piece?.kind,
              drop: false,
              playable: !!piece,
              category: 'attack' as const,
              isCheck: false,
              captures: null,
              risky: false,
              hanging: false,
            }
          }

          return {
            rank: index + 1,
            move: line.move,
            moveUsi: line.moveUsi,
            evaluation: line.evaluation,
            intent: index === 0 ? 'エンジン推奨手' : 'エンジン候補手',
            playable: false,
            category: 'attack' as const,
          }
        })
      }

      const moves = candidateFromPosition(positionState.shogi, analysis.bestMove, analysis.evaluation, analysis.bestMoveUsi)
      return moves.filter((candidate) => {
        if (candidate.to && candidate.kind && candidate.from) {
          const piece = positionState.shogi.get(candidate.from.x, candidate.from.y)
          return !!piece && piece.color === positionState.shogi.turn
        }
        return true
      })
    },
    [analysis.bestMove, analysis.bestMoveUsi, analysis.evaluation, analysis.lines, positionState.shogi],
  )
  const legalTargets = useMemo(() => {
    if (!positionState.shogi) return []

    if (selectedHandKind) {
      const color = positionState.shogi.turn
      return positionState.shogi
        .getDropsBy(color)
        .filter((move) => move.kind === selectedHandKind)
        .map((move) => ({ x: move.to.x, y: move.to.y, promote: false, optionalPromotion: false }))
    }

    if (!selectedSquare) return []
    const piece = positionState.shogi.get(selectedSquare.x, selectedSquare.y)
    if (!piece) return []

    const player = toPlayer(piece.color)
    const moves = positionState.shogi.getMovesFrom(selectedSquare.x, selectedSquare.y)
    return moves.map((move) => {
      const optionalPromotion = canPromoteForMove(piece.kind, selectedSquare.y, move.to.y, player)
      return {
        x: move.to.x,
        y: move.to.y,
        promote: false,
        optionalPromotion,
      }
    })
  }, [positionState.shogi, selectedHandKind, selectedSquare])

  async function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setKifuText(text)
    setSourceLabel(file.name)
    setCurrentMoveIndex(parseAnyKifu(text, file.name).length)
    event.target.value = ''
  }

  async function handleInstallClick() {
    if (installPrompt) {
      await installPrompt.prompt()
      const choice = await installPrompt.userChoice
      setInstallMessage(
        choice.outcome === 'accepted'
          ? 'ホーム画面追加ありがとう。かなりアプリっぽく使えるはず。'
          : 'あとで追加でもOK。Androidならメニューからでも入れられる。',
      )
      setInstallPrompt(null)
      return
    }

    setInstallMessage('Androidは Chrome の右上メニュー → ホーム画面に追加。入れたらほぼアプリ感で使える。')
  }

  async function handleProbeEngine() {
    if (engineConfig.provider !== 'usi-bridge') {
      setProbeState({
        loading: false,
        ok: engineConfig.provider === 'wasm' ? undefined : true,
        message:
          engineConfig.provider === 'wasm'
            ? 'WASM解析はこれから実装。今は軽量解析へフォールバック中。'
            : '軽量解析は接続テスト不要。',
      })
      return
    }

    setProbeState({ loading: true, message: '接続テスト中...' })
    const result = await probeUsi(engineConfig)
    setProbeState({
      loading: false,
      ok: result.ok,
      message: result.ok ? result.message ?? '接続OK' : result.reason ?? '接続失敗',
    })
  }

  async function handleSearchShogiWars(page = 1) {
    if (!serverApisAvailable) {
      setShogiWarsState({ loading: false, message: 'Native appでは将棋ウォーズ取得は未対応。KIF/CSA読み込みを使って。' })
      return
    }

    setShogiWarsState({ loading: true, message: `棋譜一覧を取得中... (${page}ページ目)` })
    try {
      const response = await fetch('/api/shogiwars-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: shogiWarsId, gtype: shogiWarsRule, page }),
      })
      const result = (await response.json()) as {
        ok?: boolean
        html?: string
        games?: ShogiWarsGame[]
        found?: number
        page?: number
        hasNext?: boolean
        hasPrev?: boolean
        nextPage?: number | null
        prevPage?: number | null
        reason?: string
      }
      if (!response.ok || !result.ok || !result.html) {
        setShogiWarsState({ loading: false, message: result.reason ?? '一覧取得に失敗' })
        return
      }

      const games = result.games ?? []
      setShogiWarsGames(games)
      setShogiWarsPage(result.page ?? page)
      setShogiWarsPageInfo({
        hasNext: Boolean(result.hasNext),
        hasPrev: Boolean(result.hasPrev),
        nextPage: result.nextPage ?? null,
        prevPage: result.prevPage ?? null,
      })
      const pageHint = result.hasNext ? '、続きあり' : ''
      setShogiWarsState({
        loading: false,
        message: games.length > 0 ? `${result.page ?? page}ページ目: ${games.length}件取得${pageHint}` : `対局が見つからない (${result.found ?? 0})`,
      })
    } catch (error) {
      setShogiWarsState({ loading: false, message: error instanceof Error ? error.message : '一覧取得に失敗' })
    }
  }

  async function importShogiWarsGame(url: string, label?: string) {
    if (!serverApisAvailable) {
      setShogiWarsState({ loading: false, message: 'Native appでは将棋ウォーズ取得は未対応。KIF/CSA読み込みを使って。' })
      return
    }

    setShogiWarsState({ loading: true, message: '棋譜を取得中...' })
    try {
      const response = await fetch('/api/shogiwars-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const result = (await response.json()) as { ok?: boolean; csa?: string; kif?: string; reason?: string }
      if (!response.ok || !result.ok) {
        setShogiWarsState({ loading: false, message: result.reason ?? '棋譜取得に失敗' })
        return
      }

      const nextKifu = result.csa || result.kif
      if (!nextKifu) {
        setShogiWarsState({ loading: false, message: '棋譜本文が見つからない' })
        return
      }

      const importName = result.csa ? 'import.csa' : 'import.kif'
      const moveCount = parseAnyKifu(nextKifu, importName).length
      resetBoardInteraction()
      setKifuText(nextKifu)
      setSourceLabel(label ? `将棋ウォーズ: ${label}` : `将棋ウォーズ: ${url}`)
      setCurrentMoveIndex(moveCount)
      setShogiWarsState({ loading: false, message: `棋譜を反映した (${moveCount}手)` })
    } catch (error) {
      setShogiWarsState({ loading: false, message: error instanceof Error ? error.message : '棋譜取得に失敗' })
    }
  }

  function handleResetStorage() {
    localStorage.removeItem(STORAGE_KEY)
    setKifuText(sampleKifu)
    setSourceLabel('サンプル棋譜')
    setCurrentMoveIndex(parseAnyKifu(sampleKifu).length)
    setSandboxSfen(null)
    setSandboxMoveCount(0)
    setSandboxMoves([])
    setSelectedSquare(null)
    setSelectedHandKind(null)
    setPendingMove(null)
    setInstallMessage('保存内容をリセットした。テストのやり直しにどうぞ。')
  }

  function commitSandboxMove(from: SelectedSquare, to: MoveTarget, source: SandboxMove['source'] = 'manual') {
    if (!positionState.shogi) return

    const baseSfen = positionState.shogi.toSFENString(safeCurrentMoveIndex + sandboxMoveCount)
    const nextShogi = new Shogi({ preset: 'HIRATE' })
    nextShogi.initializeFromSFENString(baseSfen)
    const notation = notationFromBoardMove(positionState.shogi, from, to)
    nextShogi.move(from.x, from.y, to.x, to.y, to.promote)
    const nextSfen = nextShogi.toSFENString(safeCurrentMoveIndex + sandboxMoveCount + 1)
    setSandboxSfen(nextSfen)
    setSandboxMoveCount((count) => count + 1)
    setSandboxMoves((moves) => [...moves, { notation, sfen: nextSfen, source }])
    setPvPreviewIndex(source === 'pv' ? (value) => (value === null ? 0 : value + 1) : null)
    setSelectedSquare(null)
    setSelectedHandKind(null)
    setPendingMove(null)
  }

  function commitSandboxDrop(kind: Kind, to: MoveTarget, source: SandboxMove['source'] = 'manual') {
    if (!positionState.shogi) return

    const baseSfen = positionState.shogi.toSFENString(safeCurrentMoveIndex + sandboxMoveCount)
    const nextShogi = new Shogi({ preset: 'HIRATE' })
    nextShogi.initializeFromSFENString(baseSfen)
    const notation = notationFromBoardMove(positionState.shogi, { x: to.x, y: to.y }, to, true, kind)
    nextShogi.drop(to.x, to.y, kind, nextShogi.turn)
    const nextSfen = nextShogi.toSFENString(safeCurrentMoveIndex + sandboxMoveCount + 1)
    setSandboxSfen(nextSfen)
    setSandboxMoveCount((count) => count + 1)
    setSandboxMoves((moves) => [...moves, { notation, sfen: nextSfen, source }])
    setPvPreviewIndex(source === 'pv' ? (value) => (value === null ? 0 : value + 1) : null)
    setSelectedSquare(null)
    setSelectedHandKind(null)
    setPendingMove(null)
  }

  function resetBoardInteraction() {
    setSandboxSfen(null)
    setSandboxMoveCount(0)
    setSandboxMoves([])
    setPvPreviewIndex(null)
    setSelectedSquare(null)
    setSelectedHandKind(null)
    setPendingMove(null)
  }

  function handleUndoSandboxMove() {
    if (sandboxMoves.length === 0) return

    const nextMoves = sandboxMoves.slice(0, -1)
    const lastSfen = nextMoves.length > 0 ? nextMoves[nextMoves.length - 1].sfen : null
    const pvMoves = nextMoves.filter((move) => move.source === 'pv').length
    setSandboxMoves(nextMoves)
    setSandboxSfen(lastSfen)
    setSandboxMoveCount(nextMoves.length)
    setPvPreviewIndex(pvMoves > 0 ? pvMoves - 1 : null)
    setSelectedSquare(null)
    setSelectedHandKind(null)
    setPendingMove(null)
  }

  function parsePvNotationToAction(notation: string, shogi: Shogi) {
    const parsed = parseMoveNotation(notation)
    if (parsed.type === 'resign') return null

    if (parsed.type === 'drop') {
      const canDrop = shogi
        .getDropsBy(shogi.turn)
        .some((move) => move.kind === parsed.kind && move.to.x === parsed.destination.x && move.to.y === parsed.destination.y)
      if (!canDrop) return null
      return { kind: parsed.kind, to: { ...parsed.destination, promote: false, optionalPromotion: false }, drop: true as const }
    }

    const candidates = shogi
      .getMovesTo(parsed.destination.x, parsed.destination.y, parsed.searchKind, shogi.turn)
      .filter((candidate) => candidate.from)
    const selected = chooseCandidate(candidates, colorToString(shogi.turn) === 'black' ? '先手' : '後手', parsed.directionHints)
    if (!selected?.from) return null

    return {
      from: { x: selected.from.x, y: selected.from.y },
      to: { x: parsed.destination.x, y: parsed.destination.y, promote: parsed.promote, optionalPromotion: false },
      kind: shogi.get(selected.from.x, selected.from.y)?.kind,
      drop: false as const,
    }
  }

  async function handlePreviewPvMove(notation: string) {
    if (!positionState.shogi) return
    const action = parsePvNotationToAction(notation, positionState.shogi)
    if (!action) return

    if (action.drop) {
      commitSandboxDrop(action.kind, action.to, 'pv')
      return
    }

    if (!action.from) return
    commitSandboxMove(action.from, action.to, 'pv')
  }

  function handleCandidateClick(candidate: Candidate) {
    if (!positionState.shogi) return

    if (candidate.to && candidate.kind) {
      const target = candidate.to

      if (candidate.drop) {
        const canDrop = positionState.shogi
          .getDropsBy(positionState.shogi.turn)
          .some((move) => move.kind === candidate.kind && move.to.x === target.x && move.to.y === target.y)
        if (!canDrop) return
        commitSandboxDrop(candidate.kind, target)
        return
      }

      if (candidate.from) {
        commitSandboxMove(candidate.from, target)
        return
      }
    }

    if (candidate.moveUsi) {
      const parsedUsi = parseUsiMove(candidate.moveUsi)
      if (parsedUsi?.drop) {
        commitSandboxDrop(parsedUsi.kind, parsedUsi.to)
        return
      }
      if (parsedUsi?.from) {
        const piece = positionState.shogi.get(parsedUsi.from.x, parsedUsi.from.y)
        const legal = piece?.color === positionState.shogi.turn && positionState.shogi
          .getMovesFrom(parsedUsi.from.x, parsedUsi.from.y)
          .some((move) => move.to.x === parsedUsi.to.x && move.to.y === parsedUsi.to.y)
        if (legal) {
          commitSandboxMove(parsedUsi.from, parsedUsi.to)
          return
        }
      }
    }

    const action = parsePvNotationToAction(candidate.move, positionState.shogi)
    if (!action) {
      return
    }

    if (action.drop) {
      commitSandboxDrop(action.kind, action.to)
      return
    }

    if (!action.from) return
    commitSandboxMove(action.from, action.to)
  }

  function handleBoardCellClick(cell: BoardCell) {
    if (!positionState.shogi) return

    const legalTarget = legalTargets.find((target) => target.x === cell.boardX && target.y === cell.boardY)
    if (selectedHandKind && legalTarget) {
      commitSandboxDrop(selectedHandKind, legalTarget)
      return
    }

    if (selectedSquare && legalTarget) {
      if (legalTarget.optionalPromotion) {
        setPendingMove({ from: selectedSquare, to: legalTarget })
      } else {
        commitSandboxMove(selectedSquare, legalTarget)
      }
      return
    }

    if (!cell.piece) {
      setSelectedSquare(null)
      setSelectedHandKind(null)
      return
    }

    const piece = positionState.shogi.get(cell.boardX, cell.boardY)
    if (!piece || piece.color !== positionState.shogi.turn) {
      setSelectedSquare(null)
      return
    }

    setPendingMove(null)
    setSelectedHandKind(null)
    setSelectedSquare((current) =>
      current?.x === cell.boardX && current?.y === cell.boardY
        ? null
        : { x: cell.boardX, y: cell.boardY },
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-card card">
          {isOffline ? <div className="status-banner warn">オフライン中。保存済みの画面とローカル機能を優先して使う。</div> : null}
          {pwaUpdateReady ? <div className="status-banner ok">更新あり。開き直すと新しい版に切り替わる。</div> : null}
          <div>
            <p className="eyebrow">prototype</p>
            <h1>将棋解析アプリ</h1>
          </div>
          <p className="muted">
            KIF/CSAを読めて、局面ごとに擬似解析まで返す試作版。AndroidとiPhoneのホーム画面追加も視野に入れた。
          </p>
          <div className="chip-row">
            <span className="chip active">PWAベース</span>
            <span className="chip">Android向け</span>
            <span className="chip">棋譜再生あり</span>
            <span className="chip">ローカル保存</span>
            <span className="chip">iOS発展可</span>
          </div>
        </div>

        <div className="card control-card">
          <div className="section-title-row">
            <h2>棋譜ソース</h2>
            <button
              className="ghost-button"
              onClick={() => {
                setKifuText(sampleKifu)
                setSourceLabel('サンプル棋譜')
                setCurrentMoveIndex(parseAnyKifu(sampleKifu, 'sample.kif').length)
              }}
            >
              サンプル読込
            </button>
          </div>
          <p className="source-label">現在: {sourceLabel}</p>
          <textarea
            value={kifuText}
            onChange={(event) => {
              const nextText = event.target.value
              setKifuText(nextText)
              setSourceLabel('手入力')
              setCurrentMoveIndex(parseAnyKifu(nextText).length)
            }}
          />
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept=".kif,.ki2,.csa,.txt"
            onChange={handleFileSelect}
          />
          <div className="upload-row">
            <button className="primary-button" onClick={() => fileInputRef.current?.click()}>
              KIF / CSA ファイルを開く
            </button>
            <button className="secondary-button" onClick={() => setCurrentMoveIndex(parsedMoves.length)}>
              最終手へ
            </button>
          </div>
        </div>

        <div className="card install-card">
          <div className="section-title-row">
            <h2>インストール導線</h2>
            <span className="live-pill">PWA推奨</span>
          </div>
          <p className="muted install-message">{installMessage}</p>
          <div className="mini-info">
            <strong>Androidでの使い方</strong>
            <p>Chromeで開いて, 右上メニューからホーム画面に追加。追加後は全画面っぽく起動できる。</p>
            <p>初回表示後は, 電波が弱くてもキャッシュ済み画面で開きやすい。</p>
          </div>
          <div className="upload-row">
            <button className="primary-button" onClick={handleInstallClick} disabled={nativePlatform}>
              {nativePlatform ? 'この端末ではアプリ内実行中' : 'ホーム画面に追加する'}
            </button>
            <button className="secondary-button" onClick={handleResetStorage}>
              保存内容をリセット
            </button>
          </div>
        </div>

        <div className="card control-card">
          <div className="section-title-row">
            <h2>将棋ウォーズ連携</h2>
            <span className="live-pill">BETA</span>
          </div>
          {hostedWebApp ? (
            <div className="status-banner ok">
              公開版では将棋ウォーズ連携をVercel Functions経由で使う。
            </div>
          ) : null}
          <label className="field-label">
            将棋ウォーズID
            <input
              className="text-input"
              type="text"
              placeholder="例: habu"
              value={shogiWarsId}
              onChange={(event) => {
                setShogiWarsId(event.target.value)
                setShogiWarsPage(1)
                setShogiWarsPageInfo({ hasNext: false, hasPrev: false, nextPage: null, prevPage: null })
              }}
            />
          </label>
          <label className="field-label">
            ルール
            <select
              className="text-input"
              value={shogiWarsRule}
              onChange={(event) => {
                setShogiWarsRule(event.target.value)
                setShogiWarsPage(1)
                setShogiWarsPageInfo({ hasNext: false, hasPrev: false, nextPage: null, prevPage: null })
              }}
            >
              <option value="">10分切れ負け</option>
              <option value="sb">3分切れ負け</option>
              <option value="s1">一手10秒</option>
            </select>
          </label>
          <div className="shogiwars-actions">
            <div className="upload-row shogiwars-primary-actions">
              <button className="secondary-button" onClick={() => handleSearchShogiWars(1)} disabled={shogiWarsState.loading || !shogiWarsId.trim() || !serverApisAvailable}>
                一覧取得(BETA)
              </button>
            </div>
            <div className="shogiwars-pagination-row">
              <div className="upload-row shogiwars-pagination-actions">
                <button
                  className="secondary-button"
                  onClick={() => shogiWarsPageInfo.prevPage && handleSearchShogiWars(shogiWarsPageInfo.prevPage)}
                  disabled={shogiWarsState.loading || !shogiWarsId.trim() || !serverApisAvailable || !shogiWarsPageInfo.hasPrev || !shogiWarsPageInfo.prevPage}
                >
                  前ページ
                </button>
                <button
                  className="secondary-button"
                  onClick={() => shogiWarsPageInfo.nextPage && handleSearchShogiWars(shogiWarsPageInfo.nextPage)}
                  disabled={shogiWarsState.loading || !shogiWarsId.trim() || !serverApisAvailable || !shogiWarsPageInfo.hasNext || !shogiWarsPageInfo.nextPage}
                >
                  次ページ
                </button>
              </div>
              <span className="muted shogiwars-page-label">現在 {shogiWarsPage} ページ目</span>
            </div>
          </div>
          <div className="status-banner warn">{shogiWarsState.message}</div>
          <div className="mini-info">
            <strong>候補局</strong>
            <div className="pv-line">
              {shogiWarsGames.length > 0 ? (
                shogiWarsGames.slice(0, 10).map((game, index) => (
                  <button
                    key={`${game.href}-${index}`}
                    type="button"
                    className={`pv-chip shogiwars-game-chip ${game.playerSide ?? ''}`}
                    onClick={() => importShogiWarsGame(game.href, game.label)}
                  >
                    <span className="shogiwars-game-title">{game.title ?? game.label}</span>
                    <span className="shogiwars-game-meta">
                      {game.playerSide === 'sente' ? '先手' : game.playerSide === 'gote' ? '後手' : '対局'}
                      {game.playedAt ? `, ${game.playedAt}` : ''}
                    </span>
                  </button>
                ))
              ) : (
                <p>まだ未取得</p>
              )}
            </div>
          </div>
        </div>

        <div className="card control-card">
          <div className="section-title-row">
            <h2>解析設定</h2>
            <span className="live-pill">ENGINE</span>
          </div>
          <p className="muted install-message">
            目標構成は Android / iPhone でも動く端末内解析。今は provider 分離を先に入れて, 未実装部分は軽量解析へ自動フォールバック。
            {nativePlatform ? ' 今はネイティブアプリ内で動作中。PC向けAPI機能は自動で抑止する。' : ''}
          </p>
          <div className={`status-banner ${analysis.source === 'mock' ? 'warn' : 'ok'}`}>
            {analysis.source === 'usi'
              ? 'PCエンジン接続中。スマホ側はUIとして使えてる。'
              : analysis.source === 'wasm'
                ? '端末内WASM解析モード。将来の本命ルート。'
                : '軽量解析で動作中。WASMまたはPCエンジンが未接続。'}
          </div>
          <div className="mini-info engine-guide">
            <strong>おすすめ構成</strong>
            <p>将来の iPhone / Android 単体対応を見据えて, 端末内の本格エンジンを優先。まず zshogi を使い, 失敗時は軽量実探索へフォールバックする。</p>
            <strong>スマホ接続URL</strong>
            <label className="field-label compact">
              LAN URL
              <input
                className="text-input"
                type="text"
                value={lanUrl}
                onChange={(event) => setLanUrl(event.target.value)}
              />
            </label>
            <p>{nativePlatform ? 'ネイティブアプリ版ではこのLAN URLは不要。' : `PCとスマホが同じWi-Fiなら, まず ${lanUrl} にアクセスして確認。`}</p>
            <strong>今の推奨</strong>
            <p>通常は WASM を選べば zshogi で端末内解析する。うまく動かない環境だけ軽量実探索へ落とし, より強い検討が必要なときだけ PCエンジンの USIブリッジを使う。</p>
          </div>
          <label className="field-label">
            解析方式
            <select
              className="text-input"
              value={engineConfig.provider ?? 'wasm'}
              onChange={(event) =>
                setEngineConfig((current) => ({ ...current, provider: event.target.value as EngineProviderId }))
              }
            >
              <option value="wasm">端末内本格エンジン (zshogi / fallbackあり)</option>
              <option value="mock">軽量解析</option>
              <option value="usi-bridge" disabled={nativePlatform}>PC USIブリッジ</option>
            </select>
          </label>
          <label className="field-label">
            モバイル品質
            <select
              className="text-input"
              value={engineConfig.mobileQuality ?? 'auto'}
              onChange={(event) =>
                setEngineConfig((current) => ({ ...current, mobileQuality: event.target.value as MobileQuality }))
              }
            >
              <option value="auto">自動</option>
              <option value="light">軽量</option>
              <option value="standard">標準</option>
            </select>
          </label>
          <label className="field-label">
            思考時間(ms)
            <input
              className="text-input"
              type="number"
              min={100}
              step={100}
              value={engineConfig.thinkTimeMs ?? 1200}
              onChange={(event) =>
                setEngineConfig((current) => ({
                  ...current,
                  thinkTimeMs: Math.max(100, Number(event.target.value) || 1200),
                }))
              }
            />
          </label>
          {engineConfig.provider === 'usi-bridge' && (
            <label className="field-label">
              エンジンパス
              <input
                className="text-input"
                type="text"
                placeholder="C:\\engine\\your-usi-engine.exe"
                value={engineConfig.usiPath ?? ''}
                onChange={(event) =>
                  setEngineConfig((current) => ({ ...current, usiPath: event.target.value }))
                }
              />
            </label>
          )}
          <div className="upload-row">
            <button className="primary-button" onClick={handleProbeEngine} disabled={probeState.loading}>
              {probeState.loading
                ? '確認中...'
                : engineConfig.provider === 'usi-bridge'
                  ? 'USI接続テスト'
                  : engineConfig.provider === 'wasm'
                    ? '端末内解析の状態を確認'
                    : '軽量解析の状態を確認'}
            </button>
          </div>
          <div className={`status-banner ${probeState.ok === false ? 'warn' : 'ok'}`}>
            状態: {probeState.message}
          </div>
        </div>

        <div className="card">
          <div className="section-title-row">
            <h2>解析サマリー</h2>
            <span className="live-pill">{isAnalyzing ? 'ANALYZING...' : analysis.source.toUpperCase()}</span>
          </div>
          {positionState.error ? (
            <div className="error-box">{positionState.error}</div>
          ) : (
            <>
              <div className="insight-grid">
                {positionState.insights.map((item) => (
                  <div key={item.label} className={`insight ${item.tone ?? 'neutral'}`}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
              <div className="mini-info analysis-box">
                <strong>接続メモ</strong>
                <p>{analysis.statusMessage ?? '状態不明'}</p>
                <strong>読み筋</strong>
                <div className="pv-line">
                  {analysis.pv.length > 0 ? (
                    analysis.pv.map((move, index) => (
                      <button
                        key={`${move}-${index}`}
                        type="button"
                        className={`pv-chip ${pvPreviewIndex === index ? 'current' : ''}`}
                        onClick={() => handlePreviewPvMove(move)}
                      >
                        {index + 1}. {move}
                      </button>
                    ))
                  ) : (
                    <p>読み筋なし</p>
                  )}
                </div>
                <strong>所感</strong>
                <p>{analysis.summary}</p>
                <strong>使い方</strong>
                <p>
                  {nativePlatform
                    ? '単体アプリとして動かす場合は, KIF/CSA読込と盤面操作, 軽量解析を中心に使う構成。'
                    : 'スマホで触るなら, PCでこのアプリを起動して同じWi-Fiから開くのが安定。USI未接続でも候補手や試し指しはそのまま使える。'}
                </p>
              </div>
            </>
          )}
        </div>
      </aside>

      <main className="main-panel">
        <section className="board-area">
          <div className="card board-card">
            <div className="section-title-row">
              <div>
                <p className="eyebrow">対局情報</p>
                <h2>試作再生ボード</h2>
                <p className="muted">
                  {currentMove
                    ? `${currentMove.moveNumber}手目, ${currentMove.player} ${displayMoveNotation(currentMove.notation)}`
                    : '開始局面'}
                  {sandboxSfen ? `（${pvPreviewIndex !== null ? 'PVプレビュー中' : '盤面で試し指し中'}）` : ''}
                </p>
              </div>
              <span className="evaluation-badge">
                {analysis.evaluation > 0 ? '+' : ''}{analysis.evaluation}
              </span>
            </div>

            <div className="topbar-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  if (sandboxMoves.length > 0) {
                    handleUndoSandboxMove()
                    return
                  }
                  setCurrentMoveIndex((value) => Math.max(0, value - 1))
                }}
              >
                ◀ 戻る
              </button>
              <button
                className="primary-button"
                onClick={() => setCurrentMoveIndex((value) => Math.min(parsedMoves.length, value + 1))}
              >
                ▶ 進む
              </button>
              {sandboxSfen ? (
                <button className="secondary-button" onClick={resetBoardInteraction}>
                  PV/試し指しを解除
                </button>
              ) : null}
              <button
                className="secondary-button"
                onClick={() => {
                  resetBoardInteraction()
                  setCurrentMoveIndex(0)
                }}
              >
                初期局面
              </button>
            </div>

            <div className="slider-block">
              <input
                type="range"
                min={0}
                max={parsedMoves.length}
                value={safeCurrentMoveIndex}
                onChange={(event) => {
                  setSandboxSfen(null)
                  setSandboxMoveCount(0)
                  setSelectedSquare(null)
                  setPendingMove(null)
                  setCurrentMoveIndex(Number(event.target.value))
                }}
              />
              <div className="slider-labels">
                <span>0手</span>
                <span>{parsedMoves.length}手</span>
              </div>
            </div>

            {pendingMove ? (
              <div className="promotion-modal">
                <p>この手、成る？</p>
                <div className="promotion-actions">
                  <button
                    className="primary-button"
                    onClick={() => commitSandboxMove(pendingMove.from, { ...pendingMove.to, promote: true })}
                  >
                    成る
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => commitSandboxMove(pendingMove.from, { ...pendingMove.to, promote: false })}
                  >
                    成らない
                  </button>
                </div>
              </div>
            ) : null}

            <div className="board-layout">
              <div className="hand-column">
                <span className="hand-label">後手の持ち駒</span>
                <div className="hand-pieces">
                  {positionState.goteHand.length > 0 ? (
                    positionState.goteHand.map((piece) => (
                      <button
                        key={piece.label}
                        type="button"
                        className={`hand-piece gote ${selectedHandKind === piece.kind ? 'selected-hand' : ''}`}
                        onClick={() => {
                          if (positionState.shogi?.turn !== Color.White) return
                          setSelectedSquare(null)
                          setPendingMove(null)
                          setSelectedHandKind((current) => (current === piece.kind ? null : piece.kind))
                        }}
                      >
                        {piece.label}
                        <small>×{piece.count}</small>
                      </button>
                    ))
                  ) : (
                    <span className="hand-empty">なし</span>
                  )}
                </div>
              </div>

              <div className="board-wrapper">
                <div className="board-coordinates top">
                  {[9, 8, 7, 6, 5, 4, 3, 2, 1].map((file) => (
                    <span key={file}>{file}</span>
                  ))}
                </div>
                <div className="board-grid">
                  {positionState.board.map((row, rowIndex) =>
                    row.map((cell, colIndex) => (
                      <button
                        key={`${rowIndex}-${colIndex}`}
                        type="button"
                        className={getCellClasses(cell, selectedSquare, legalTargets)}
                        onClick={() => handleBoardCellClick(cell)}
                      >
                        {cell.piece ? (
                          <span className={`piece ${cell.owner === '後手' ? 'gote' : 'sente'}`}>
                            {cell.piece}
                          </span>
                        ) : (
                          <span className="empty-dot">・</span>
                        )}
                      </button>
                    )),
                  )}
                </div>
                <div className="board-coordinates side">
                  {['一', '二', '三', '四', '五', '六', '七', '八', '九'].map((rank) => (
                    <span key={rank}>{rank}</span>
                  ))}
                </div>
              </div>

              <div className="hand-column">
                <span className="hand-label">先手の持ち駒</span>
                <div className="hand-pieces sente-hand">
                  {positionState.senteHand.length > 0 ? (
                    positionState.senteHand.map((piece) => (
                      <button
                        key={piece.label}
                        type="button"
                        className={`hand-piece sente ${selectedHandKind === piece.kind ? 'selected-hand' : ''}`}
                        onClick={() => {
                          if (positionState.shogi?.turn !== Color.Black) return
                          setSelectedSquare(null)
                          setPendingMove(null)
                          setSelectedHandKind((current) => (current === piece.kind ? null : piece.kind))
                        }}
                      >
                        {piece.label}
                        <small>×{piece.count}</small>
                      </button>
                    ))
                  ) : (
                    <span className="hand-empty">なし</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="card graph-card">
            <div className="section-title-row">
              <h2>候補手</h2>
              <span className="muted">
                {isAnalyzing
                  ? '計算中...'
                  : `best: ${analysis.bestMove}${analysis.currentIndex !== safeCurrentMoveIndex ? ' (元局面)' : ''}`}
                {analysis.currentIndex !== safeCurrentMoveIndex ? ' (元局面)' : ''}
              </span>
            </div>
            <div className="candidate-list compact">
              {candidateMoves.map((candidate) => (
                <button
                  key={candidate.rank}
                  type="button"
                  className={`candidate-row ${candidate.rank === 1 ? 'best' : ''}`}
                  onClick={() => handleCandidateClick(candidate)}
                  disabled={candidate.playable === false}
                  title={candidate.playable === false ? 'この候補手はまだ盤面反映できません' : undefined}
                >
                  <div className="candidate-rank">#{candidate.rank}</div>
                  <div className="candidate-main">
                    <strong>{candidate.move}</strong>
                    <span>{candidate.intent}</span>
                    <div className="candidate-flags">
                      {candidate.category ? <span className={`candidate-flag category ${candidate.category}`}>{candidate.category === 'attack' ? '攻め' : candidate.category === 'defense' ? '受け' : candidate.category === 'shape' ? '形' : candidate.category === 'drop' ? '打ち' : '保留'}</span> : null}
                      {candidate.isCheck ? <span className="candidate-flag check">王手</span> : null}
                      {candidate.captures ? <span className="candidate-flag capture">{candidate.captures}取り</span> : null}
                      {candidate.risky ? <span className="candidate-flag risk">玉危険</span> : null}
                      {candidate.hanging ? <span className="candidate-flag risk">駒損</span> : null}
                      {candidate.playable === false ? <span className="candidate-flag risk">反映不可</span> : null}
                    </div>
                  </div>
                  <div className="candidate-score">
                    {candidate.evaluation > 0 ? '+' : ''}{candidate.evaluation}
                  </div>
                </button>
              ))}
            </div>
            <div className="mini-info">
              {sandboxMoves.length > 0 ? (
                <>
                  <strong>検討手順</strong>
                  <div className="sandbox-move-list">
                    {sandboxMoves.map((move, index) => (
                      <button
                        key={`${move.notation}-${index}`}
                        type="button"
                        className={`sandbox-move-chip ${index === sandboxMoves.length - 1 ? 'current' : ''}`}
                        onClick={() => {
                          const nextMoves = sandboxMoves.slice(0, index + 1)
                          setSandboxMoves(nextMoves)
                          setSandboxSfen(nextMoves[nextMoves.length - 1]?.sfen ?? null)
                          setSandboxMoveCount(nextMoves.length)
                          setSelectedSquare(null)
                          setSelectedHandKind(null)
                          setPendingMove(null)
                        }}
                      >
                        {move.source === 'pv' ? 'PV ' : ''}{index + 1}. {move.notation}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <strong>モバイル展開</strong>
              <p>
                今の段階でAndroid実機テストしやすい。iPhone側もSafariの共有からホーム画面追加で追従できる。
              </p>
              <strong>盤面操作</strong>
              <p>
                自分の駒をタップすると合法手をハイライト。もう一度タップで解除できる。
              </p>
            </div>
          </div>
        </section>

        <section className="bottom-grid">
          <div className="card move-list-card">
            <div className="section-title-row">
              <h2>棋譜一覧</h2>
              <span className="muted">クリックでその手にジャンプ</span>
            </div>
            <div className="move-grid">
              {parsedMoves.map((move) => (
                <button
                  key={move.moveNumber}
                  className={`move-chip ${move.moveNumber === safeCurrentMoveIndex ? 'current' : ''}`}
                  onClick={() => setCurrentMoveIndex(move.moveNumber)}
                >
                  <span>{move.moveNumber}</span>
                  <strong>
                    {move.player === '先手' ? '▲' : '△'}{displayMoveNotation(move.notation)}
                  </strong>
                </button>
              ))}
            </div>
          </div>

          <div className="card history-card">
            <div className="section-title-row">
              <h2>テスト前メモ</h2>
              <span className="muted">実機投入前</span>
            </div>
            <div className="history-list">
              <article className="history-item current">
                <div className="history-head">
                  <div>
                    <span className="move-number">実装済み</span>
                    <strong>ローカル保存</strong>
                  </div>
                </div>
                <p>棋譜テキスト, ソース名, 現在手数をブラウザに保存。再読込しても状態が戻る。</p>
              </article>
              <article className="history-item">
                <div className="history-head">
                  <div>
                    <span className="move-number">実装済み</span>
                    <strong>インストール導線</strong>
                  </div>
                </div>
                <p>Androidの beforeinstallprompt と、iPhone向け手動案内の両方をカバー。</p>
              </article>
              <article className="history-item">
                <div className="history-head">
                  <div>
                    <span className="move-number">次にやる</span>
                    <strong>合法手ハイライト</strong>
                  </div>
                </div>
                <p>ここまで来たら、次は触って気持ちいい方向の強化に行ける。</p>
              </article>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
