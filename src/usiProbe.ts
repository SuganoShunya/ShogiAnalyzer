import type { EngineConfig } from './types'
import { canUseServerApis } from './platform'

export type UsiProbeResult = {
  ok: boolean
  message?: string
  reason?: string
}

export async function probeUsi(config?: EngineConfig): Promise<UsiProbeResult> {
  if (!canUseServerApis()) {
    return {
      ok: false,
      reason: 'Native appではPC向けUSI接続テストは使えません',
    }
  }

  try {
    const response = await fetch('/api/usi-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    })

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` }
    }

    return (await response.json()) as UsiProbeResult
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'unknown error',
    }
  }
}
