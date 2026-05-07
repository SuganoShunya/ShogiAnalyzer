import { Shogi } from 'shogi.js'
import type { EngineConfig, ParsedMove } from './types'
import type { EngineProviderResult } from './engineProviders'

const worker = typeof Worker !== 'undefined'
  ? new Worker(new URL('./analysisWorker.ts', import.meta.url), { type: 'module' })
  : null

let requestId = 0
const pending = new Map<number, { resolve: (value: EngineProviderResult) => void; reject: (reason?: unknown) => void }>()

if (worker) {
  worker.onmessage = (event: MessageEvent<
    | { id: number; ok: true; result: EngineProviderResult }
    | { id: number; ok: false; error: string }
  >) => {
    const message = event.data
    const current = pending.get(message.id)
    if (!current) return
    pending.delete(message.id)
    if (message.ok) current.resolve(message.result)
    else current.reject(new Error(message.error))
  }
}

function buildSfen(moves: ParsedMove[], currentMoveIndex: number) {
  const parser = (globalThis as { __buildShogiFromParsedMoves__?: (moves: ParsedMove[], currentMoveIndex: number) => Shogi }).__buildShogiFromParsedMoves__
  if (!parser) throw new Error('board builder unavailable')
  return parser(moves, currentMoveIndex).toSFENString(currentMoveIndex)
}

export function canUseAnalysisWorker() {
  return !!worker
}

export function analyzeWithWorker(moves: ParsedMove[], currentMoveIndex: number, config?: EngineConfig) {
  return analyzeSfenWithWorker(buildSfen(moves, currentMoveIndex), currentMoveIndex, config)
}

export function analyzeSfenWithWorker(sfen: string, moveCount: number, config?: EngineConfig): Promise<EngineProviderResult> {
  if (!worker) {
    return Promise.reject(new Error('analysis worker unavailable'))
  }

  const id = ++requestId
  return new Promise<EngineProviderResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, sfen, moveCount, config })
  })
}
