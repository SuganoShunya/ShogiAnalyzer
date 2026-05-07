import { analyzePositionFromSfenWithBrowserEngine } from './wasmEngine'
import type { EngineConfig } from './types'

type AnalyzeRequest = {
  id: number
  sfen: string
  moveCount: number
  config?: EngineConfig
}

type AnalyzeResponse = {
  id: number
  ok: true
  result: Awaited<ReturnType<typeof analyzePositionFromSfenWithBrowserEngine>>
} | {
  id: number
  ok: false
  error: string
}

self.onmessage = async (event: MessageEvent<AnalyzeRequest>) => {
  const { id, sfen, moveCount, config } = event.data

  try {
    const result = await analyzePositionFromSfenWithBrowserEngine(sfen, moveCount, config)
    const response: AnalyzeResponse = { id, ok: true, result }
    self.postMessage(response)
  } catch (error) {
    const response: AnalyzeResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'worker analysis failed',
    }
    self.postMessage(response)
  }
}

export {}
