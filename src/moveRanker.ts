import rankerModel from '../models/move-ranker.json'

export type MoveFeatures = {
  isDrop: number
  isBishopDrop: number
  isRookDrop: number
  isEdgeDrop: number
  isCheck: number
  captureValue: number
  promotionGain: number
  hangPenalty: number
  kingDangerDelta: number
  enemyKingPressure: number
  ownKingDefense: number
  centralControl: number
}

type RankerModel = {
  bias: number
  weights: Partial<Record<keyof MoveFeatures, number>>
}

const model = rankerModel as RankerModel

export function scoreMoveFeatures(features: MoveFeatures) {
  let score = model.bias ?? 0
  for (const [key, value] of Object.entries(features) as [keyof MoveFeatures, number][]) {
    score += value * (model.weights[key] ?? 0)
  }
  return score
}
