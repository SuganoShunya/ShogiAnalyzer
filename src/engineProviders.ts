import type { EngineConfig, ParsedMove } from './types'
import { analyzeWithUsi, analyzeWithUsiSfen } from './usi'
import { analyzeSfenWithWorker, analyzeWithWorker, canUseAnalysisWorker } from './workerEngine'
import { analyzePositionFromSfenWithBrowserEngine, analyzeWithBrowserEngine } from './wasmEngine'

export type EngineSource = 'mock' | 'usi' | 'wasm'

export type EngineProviderResult = {
  source: EngineSource
  available: boolean
  evaluation?: number
  bestMove?: string
  bestMoveUsi?: string
  pv?: string[]
  depth?: number
  reason?: string
  statusMessage?: string
}

export interface EngineProvider {
  id: EngineConfig['provider']
  label: string
  analyzePosition(moves: ParsedMove[], currentMoveIndex: number, config?: EngineConfig): Promise<EngineProviderResult>
  analyzeSfen(sfen: string, moveCount: number, config?: EngineConfig): Promise<EngineProviderResult>
}

const openingBook = [
  { move: '７六歩', eval: 35, pv: ['７六歩', '８四歩', '６八銀'] },
  { move: '２六歩', eval: 28, pv: ['２六歩', '８四歩', '２五歩'] },
  { move: '５八金右', eval: 18, pv: ['５八金右', '３四歩', '６八玉'] },
  { move: '４八銀', eval: 12, pv: ['４八銀', '８四歩', '７六歩'] },
]

function hashMoves(moves: ParsedMove[]) {
  return moves.reduce((acc, move, index) => {
    const seed = [...move.notation].reduce((sum, char) => sum + char.charCodeAt(0), 0)
    return acc + seed * (index + 3)
  }, 0)
}

function mockSummary(evaluation: number, currentMoveIndex: number) {
  const phase = currentMoveIndex < 12 ? '序盤' : currentMoveIndex < 40 ? '中盤' : '終盤'
  if (evaluation > 180) return `${phase}で先手が指しやすい。少し差が出てる。`
  if (evaluation < -180) return `${phase}で後手が手得気味。受け損なうと苦しい。`
  return `${phase}で大きな差はまだない。次の一手の質で傾く。`
}

function mockAnalyze(moves: ParsedMove[], currentMoveIndex: number): EngineProviderResult {
  const played = moves.slice(0, currentMoveIndex)
  const hash = hashMoves(played)
  const sign = currentMoveIndex % 2 === 0 ? 1 : -1
  const evaluation = sign * ((hash % 480) - 120)
  const best = openingBook[hash % openingBook.length]

  return {
    source: 'mock',
    available: true,
    evaluation,
    bestMove: best.move,
    pv: best.pv,
    depth: 12 + (hash % 8),
    statusMessage: '軽量解析で表示中',
  }
}

const mockProvider: EngineProvider = {
  id: 'mock',
  label: '軽量解析',
  async analyzePosition(moves, currentMoveIndex) {
    return mockAnalyze(moves, currentMoveIndex)
  },
  async analyzeSfen(_sfen, moveCount) {
    return {
      source: 'mock',
      available: true,
      evaluation: 0,
      bestMove: '候補なし',
      pv: [],
      depth: 0,
      statusMessage: '試し指し局面は軽量解析で表示中',
      reason: mockSummary(0, moveCount),
    }
  },
}

const usiBridgeProvider: EngineProvider = {
  id: 'usi-bridge',
  label: 'PC USIブリッジ',
  async analyzePosition(moves, currentMoveIndex, config) {
    const usi = await analyzeWithUsi(moves, currentMoveIndex, config)
    return {
      source: 'usi',
      available: usi.available,
      evaluation: usi.evaluation,
      bestMoveUsi: usi.bestMove,
      pv: usi.pv,
      depth: usi.depth,
      reason: usi.reason,
      statusMessage: usi.available ? 'PC側USIエンジンに接続して解析中' : undefined,
    }
  },
  async analyzeSfen(sfen, _moveCount, config) {
    const usi = await analyzeWithUsiSfen(sfen, config)
    return {
      source: 'usi',
      available: usi.available,
      evaluation: usi.evaluation,
      bestMoveUsi: usi.bestMove,
      pv: usi.pv,
      depth: usi.depth,
      reason: usi.reason,
      statusMessage: usi.available ? 'PC側USIエンジンに接続して解析中' : undefined,
    }
  },
}

const wasmProvider: EngineProvider = {
  id: 'wasm',
  label: '端末内WASM',
  async analyzePosition(moves, currentMoveIndex, config) {
    try {
      const { analyzeWithZshogi } = await import('./zshogiEngine')
      const result = await analyzeWithZshogi(moves, currentMoveIndex, config)
      if (result.available) {
        return {
          ...result,
          statusMessage: `${result.statusMessage ?? 'zshogi による端末内解析'}${canUseAnalysisWorker() ? ' (本格エンジン)' : ''}`,
        }
      }
    } catch {
      // fall through
    }

    if (canUseAnalysisWorker()) {
      try {
        const result = await analyzeWithWorker(moves, currentMoveIndex, config)
        return {
          ...result,
          statusMessage: result.statusMessage ? `${result.statusMessage} (Worker実行)` : '端末内探索エンジンをWorkerで実行中',
        }
      } catch {
        // fall through
      }
    }
    return analyzeWithBrowserEngine(moves, currentMoveIndex, config)
  },
  async analyzeSfen(sfen, moveCount, config) {
    if (canUseAnalysisWorker()) {
      try {
        const result = await analyzeSfenWithWorker(sfen, moveCount, config)
        return {
          ...result,
          statusMessage: result.statusMessage ? `${result.statusMessage} (Worker実行)` : '端末内探索エンジンをWorkerで実行中',
        }
      } catch {
        // fall through
      }
    }
    return analyzePositionFromSfenWithBrowserEngine(sfen, moveCount, config)
  },
}

export const engineProviders: Record<NonNullable<EngineConfig['provider']>, EngineProvider> = {
  mock: mockProvider,
  'usi-bridge': usiBridgeProvider,
  wasm: wasmProvider,
}

export function getEngineProvider(config?: EngineConfig) {
  const providerId = config?.provider ?? 'wasm'
  return engineProviders[providerId] ?? engineProviders.wasm
}

export function summarizeEvaluation(evaluation: number, currentMoveIndex: number, source: EngineSource) {
  const phase = currentMoveIndex < 12 ? '序盤' : currentMoveIndex < 40 ? '中盤' : '終盤'
  if (evaluation > 180) return `${phase}で先手が指しやすい。${source === 'usi' || source === 'wasm' ? '読み筋でも' : ''}少し差が出てる。`
  if (evaluation < -180) return `${phase}で後手が手得気味。${source === 'usi' || source === 'wasm' ? '評価的にも' : ''}受け損なうと苦しい。`
  return `${phase}で大きな差はまだない。次の一手の質で傾く。`
}
