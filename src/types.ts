export type Player = '先手' | '後手'

export type ParsedMove = {
  moveNumber: number
  player: Player
  notation: string
}

export type EngineProviderId = 'mock' | 'usi-bridge' | 'wasm'
export type MobileQuality = 'auto' | 'light' | 'standard'

export type EngineConfig = {
  provider?: EngineProviderId
  usiPath?: string
  thinkTimeMs?: number
  mobileQuality?: MobileQuality
}

export type EngineLine = {
  moveUsi: string
  evaluation: number
  pv: string[]
  depth?: number
}

export type BoardBuilder = (moves: ParsedMove[], moveIndex: number) => import('shogi.js').Shogi
