import fs from 'node:fs'
import path from 'node:path'
import { Shogi, Color, Piece } from 'shogi.js'
import { extractMoveFeatures } from '../src/featureExtractor.ts'

const FILES = '123456789'
const RANKS = 'abcdefghi'

type InputPosition = {
  sfen: string
  bestMove: string
  candidateMoves?: string[]
}

type DatasetRow = {
  sfen: string
  move: string
  label: 0 | 1
  features: ReturnType<typeof extractMoveFeatures>
}

function loadJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as InputPosition[]
}

function moveToUsi(fromX: number, fromY: number, toX: number, toY: number, promote = false) {
  return `${FILES[fromX - 1]}${RANKS[fromY - 1]}${FILES[toX - 1]}${RANKS[toY - 1]}${promote ? '+' : ''}`
}

function dropToUsi(kind: string, toX: number, toY: number) {
  return `${kind}*${FILES[toX - 1]}${RANKS[toY - 1]}`
}

function canPromoteMove(kind: string, fromY: number, toY: number, color: Color) {
  if (!Piece.canPromote(kind as never)) return false
  if (color === Color.Black) return fromY <= 3 || toY <= 3
  return fromY >= 7 || toY >= 7
}

function mandatoryPromotion(kind: string, toY: number, color: Color) {
  if (color === Color.Black) return (kind === 'FU' || kind === 'KY') ? toY === 1 : kind === 'KE' ? toY <= 2 : false
  return (kind === 'FU' || kind === 'KY') ? toY === 9 : kind === 'KE' ? toY >= 8 : false
}

function legalUsiMoves(shogi: Shogi) {
  const color = shogi.turn
  const moves: string[] = []

  for (let x = 1; x <= 9; x += 1) {
    for (let y = 1; y <= 9; y += 1) {
      const piece = shogi.get(x, y)
      if (!piece || piece.color !== color) continue

      for (const move of shogi.getMovesFrom(x, y)) {
        const mustPromote = mandatoryPromotion(piece.kind, move.to.y, color)
        const canPromote = canPromoteMove(piece.kind, y, move.to.y, color)
        if (mustPromote) {
          moves.push(moveToUsi(x, y, move.to.x, move.to.y, true))
          continue
        }
        moves.push(moveToUsi(x, y, move.to.x, move.to.y, false))
        if (canPromote) moves.push(moveToUsi(x, y, move.to.x, move.to.y, true))
      }
    }
  }

  for (const drop of shogi.getDropsBy(color)) {
    if (!drop.kind) continue
    const dropMap: Record<string, string> = { FU: 'P', KY: 'L', KE: 'N', GI: 'S', KI: 'G', KA: 'B', HI: 'R' }
    const symbol = dropMap[drop.kind]
    if (symbol) moves.push(dropToUsi(symbol, drop.to.x, drop.to.y))
  }

  return [...new Set(moves)]
}

function buildRows(position: InputPosition): DatasetRow[] {
  const shogi = new Shogi({ preset: 'HIRATE' })
  shogi.initializeFromSFENString(position.sfen)
  const candidates = position.candidateMoves?.length ? position.candidateMoves : legalUsiMoves(shogi)

  return candidates.map((move) => ({
    sfen: position.sfen,
    move,
    label: move === position.bestMove ? 1 : 0,
    features: extractMoveFeatures(shogi, move),
  }))
}

function main() {
  const inputPath = process.argv[2] || path.join(process.cwd(), 'training', 'sample-data', 'positions.json')
  const outputPath = process.argv[3] || path.join(process.cwd(), 'training', 'dataset.jsonl')
  const positions = loadJson(inputPath)
  const rows = positions.flatMap(buildRows)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, rows.map((row) => JSON.stringify(row)).join('\n'))
  console.log(`wrote ${rows.length} rows to ${outputPath}`)
}

main()
