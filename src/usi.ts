import { Shogi } from 'shogi.js'
import type { EngineConfig, ParsedMove } from './types'
import { canUseServerApis } from './platform'

export type UsiAnalysisResult = {
  available: boolean
  bestMove?: string
  pv?: string[]
  evaluation?: number
  depth?: number
  source?: 'usi'
  reason?: string
}

function buildSfen(moves: ParsedMove[], currentMoveIndex: number) {
  const parser = (globalThis as { __buildShogiFromParsedMoves__?: (moves: ParsedMove[], currentMoveIndex: number) => Shogi }).__buildShogiFromParsedMoves__
  if (!parser) throw new Error('board builder unavailable')
  return parser(moves, currentMoveIndex).toSFENString(currentMoveIndex)
}

export async function analyzeWithUsiSfen(
  sfen: string,
  config?: EngineConfig,
): Promise<UsiAnalysisResult> {
  if (!canUseServerApis()) {
    return {
      available: false,
      reason: 'Native appではPC向けUSIブリッジAPIを使えません',
    }
  }

  try {
    const response = await fetch('/api/usi-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sfen, config }),
    })

    if (!response.ok) {
      return { available: false, reason: `HTTP ${response.status}` }
    }

    return (await response.json()) as UsiAnalysisResult
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'unknown error',
    }
  }
}

export async function analyzeWithUsi(
  moves: ParsedMove[],
  currentMoveIndex: number,
  config?: EngineConfig,
): Promise<UsiAnalysisResult> {
  return analyzeWithUsiSfen(buildSfen(moves, currentMoveIndex), config)
}
