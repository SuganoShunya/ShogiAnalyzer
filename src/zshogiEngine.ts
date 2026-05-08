import { analyzeWithBrowserEngine } from './wasmEngine'
import type { EngineProviderResult } from './engineProviders'
import type { EngineConfig, EngineLine, ParsedMove } from './types'

const DANGER_EVAL_THRESHOLD = -2500

let enginePromise: Promise<{ run: (command: string) => string }> | null = null

async function getEngine() {
  if (!enginePromise) {
    enginePromise = import('zshogi').then(async ({ Engine }) => Engine.init())
  }
  return enginePromise
}

function toUsiCommand(moves: ParsedMove[], currentMoveIndex: number) {
  const parser = (globalThis as { __buildShogiFromParsedMoves__?: unknown; __shogiParseMoveNotation__?: unknown; __shogiChooseCandidate__?: unknown }).__buildShogiFromParsedMoves__
  if (!parser) throw new Error('board builder unavailable')

  const build = parser as (moves: ParsedMove[], moveIndex: number) => import('shogi.js').Shogi
  const parseMoveNotation = (globalThis as { __shogiParseMoveNotation__?: (notation: string, lastTo?: { x: number; y: number }) => any }).__shogiParseMoveNotation__
  const chooseCandidate = (globalThis as { __shogiChooseCandidate__?: (candidates: Array<{ from?: { x: number; y: number }; to: { x: number; y: number } }>, player: '先手' | '後手', hints: any) => { from?: { x: number; y: number } } | undefined }).__shogiChooseCandidate__
  if (!parseMoveNotation || !chooseCandidate) throw new Error('move helpers unavailable')

  const shogi = build([], 0)
  let lastTo: { x: number; y: number } | undefined
  const usiMoves: string[] = []
  const files = '123456789'
  const ranks = 'abcdefghi'
  const dropMap: Record<string, string> = { FU: 'P', KY: 'L', KE: 'N', GI: 'S', KI: 'G', KA: 'B', HI: 'R' }

  for (let i = 0; i < currentMoveIndex; i += 1) {
    const move = moves[i]
    const parsed = parseMoveNotation(move.notation, lastTo)
    const color = move.player === '先手' ? 0 : 1

    if (parsed.type === 'resign') break

    if (parsed.type === 'drop') {
      const usi = `${dropMap[parsed.kind]}*${files[parsed.destination.x - 1]}${ranks[parsed.destination.y - 1]}`
      usiMoves.push(usi)
      ;(shogi as any).drop(parsed.destination.x, parsed.destination.y, parsed.kind, color)
      lastTo = parsed.destination
      continue
    }

    const candidates = (shogi as any)
      .getMovesTo(parsed.destination.x, parsed.destination.y, parsed.searchKind, color)
      .filter((candidate: any) => candidate.from)

    const selected = chooseCandidate(candidates, move.player, parsed.directionHints)
    if (!selected?.from) throw new Error(`could not resolve move: ${move.notation}`)

    const promote = parsed.promote
    const usi = `${files[selected.from.x - 1]}${ranks[selected.from.y - 1]}${files[parsed.destination.x - 1]}${ranks[parsed.destination.y - 1]}${promote ? '+' : ''}`
    usiMoves.push(usi)
    ;(shogi as any).move(selected.from.x, selected.from.y, parsed.destination.x, parsed.destination.y, promote)
    lastTo = parsed.destination
  }

  return `position startpos${usiMoves.length ? ` moves ${usiMoves.join(' ')}` : ''}`
}

function parseGoResult(output: string): EngineProviderResult {
  const rawLines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const bestmoveLine = [...rawLines].reverse().find((line) => line.startsWith('bestmove '))
  const infoLine = [...rawLines].reverse().find((line) => line.startsWith('info '))

  const bestMoveUsi = bestmoveLine?.split(/\s+/)[1]
  const depthMatch = infoLine?.match(/depth\s+(\d+)/)
  const cpMatch = infoLine?.match(/score cp\s+(-?\d+)/)
  const pvMatch = infoLine?.match(/ pv (.+)$/)

  const parsedLines: EngineLine[] = rawLines
    .filter((line) => line.startsWith('info ') && line.includes(' pv '))
    .map((line) => {
      const cp = line.match(/score cp\s+(-?\d+)/)
      const depth = line.match(/depth\s+(\d+)/)
      const pv = line.match(/ pv (.+)$/)
      const pvMoves = pv ? pv[1].trim().split(/\s+/) : []
      return {
        moveUsi: pvMoves[0] ?? '',
        evaluation: cp ? Number(cp[1]) : 0,
        pv: pvMoves,
        depth: depth ? Number(depth[1]) : 0,
      }
    })
    .filter((line) => line.moveUsi)
    .slice(0, 5)

  return {
    source: 'wasm',
    available: !!bestMoveUsi,
    bestMoveUsi,
    evaluation: cpMatch ? Number(cpMatch[1]) : 0,
    depth: depthMatch ? Number(depthMatch[1]) : 0,
    pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : [],
    lines: parsedLines.length > 0 ? parsedLines : undefined,
    statusMessage: 'zshogi による端末内解析',
  }
}

function depthLimit(config?: EngineConfig) {
  if (config?.mobileQuality === 'light') return 3
  if (config?.mobileQuality === 'standard') return 5
  if ((config?.thinkTimeMs ?? 1200) >= 2500) return 6
  if ((config?.thinkTimeMs ?? 1200) >= 1500) return 5
  if ((config?.thinkTimeMs ?? 1200) >= 800) return 4
  return 3
}

function mergeAndSortLines(primary: EngineLine[], supplemental: EngineLine[], bestMoveUsi?: string, fallbackPv: string[] = [], fallbackEvaluation = 0, fallbackDepth = 0) {
  const merged = new Map<string, EngineLine>()

  for (const line of [...primary, ...supplemental]) {
    if (!line.moveUsi) continue
    const existing = merged.get(line.moveUsi)
    if (!existing || line.evaluation > existing.evaluation) merged.set(line.moveUsi, line)
  }

  if (bestMoveUsi) {
    const existing = merged.get(bestMoveUsi)
    merged.set(bestMoveUsi, {
      moveUsi: bestMoveUsi,
      evaluation: existing?.evaluation ?? fallbackEvaluation,
      pv: existing?.pv?.length ? existing.pv : fallbackPv,
      depth: Math.max(existing?.depth ?? 0, fallbackDepth),
    })
  }

  const sorted = [...merged.values()].sort((a, b) => b.evaluation - a.evaluation)
  if (bestMoveUsi) {
    const bestLine = merged.get(bestMoveUsi)
    return [bestLine, ...sorted.filter((line) => line.moveUsi !== bestMoveUsi)].filter(Boolean).slice(0, 5) as EngineLine[]
  }
  return sorted.slice(0, 5)
}

export async function analyzeWithZshogi(moves: ParsedMove[], currentMoveIndex: number, config?: EngineConfig): Promise<EngineProviderResult> {
  const engine = await getEngine()
  engine.run('usi')
  engine.run(`setoption name DepthLimit value ${depthLimit(config)}`)
  engine.run('isready')
  engine.run('usinewgame')
  engine.run(toUsiCommand(moves, currentMoveIndex))
  const result = parseGoResult(engine.run('go'))
  const browserResult = await analyzeWithBrowserEngine(moves, currentMoveIndex, config)
  const supplemental = browserResult.lines ?? []
  const primary = result.lines ?? []

  const mergedLines = mergeAndSortLines(
    primary,
    supplemental,
    result.bestMoveUsi,
    result.pv,
    result.evaluation ?? (supplemental[0]?.evaluation ?? 0),
    result.depth ?? 0,
  )

  const bestSupplemental = supplemental[0]
  const zshogiLine = result.bestMoveUsi ? mergedLines.find((line) => line.moveUsi === result.bestMoveUsi) : undefined
  const shouldOverrideBest = !!bestSupplemental
    && !!zshogiLine
    && zshogiLine.evaluation <= DANGER_EVAL_THRESHOLD
    && bestSupplemental.evaluation > zshogiLine.evaluation + 1200

  if (shouldOverrideBest) {
    return {
      source: 'wasm',
      available: true,
      bestMoveUsi: bestSupplemental.moveUsi,
      evaluation: bestSupplemental.evaluation,
      depth: Math.max(result.depth ?? 0, browserResult.depth ?? 0),
      pv: bestSupplemental.pv,
      lines: mergeAndSortLines(primary, supplemental, bestSupplemental.moveUsi, bestSupplemental.pv, bestSupplemental.evaluation, bestSupplemental.depth ?? 0),
      statusMessage: 'zshogi を安全補正して端末内解析',
    }
  }

  return {
    ...result,
    lines: mergedLines,
    pv: result.pv?.length ? result.pv : (zshogiLine?.pv ?? browserResult.pv),
    evaluation: zshogiLine?.evaluation ?? result.evaluation,
    statusMessage: (result.lines?.length ?? 0) <= 1
      ? 'zshogi による端末内解析 (候補手は補助探索で補完)'
      : 'zshogi による端末内解析',
  }
}
