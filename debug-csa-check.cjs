const fs = require('fs')
const { Shogi, Color } = require('shogi.js')

const input = fs.readFileSync('debug-csa.txt', 'utf8')
const lines = input.split(/\r?\n/)
const kindKanjiMap = {
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
const promotedKinds = ['TO', 'NY', 'NK', 'NG', 'UM', 'RY']

function toJapaneseSquare(square) {
  const file = Number(square[0])
  const rankIndex = Number(square[1]) - 1
  const rankKanji = '一二三四五六七八九'[rankIndex]
  return `${'０１２３４５６７８９'[file]}${rankKanji}`.replace('０', '')
}

function convert(shogi, player, from, to, kind, lastDestination) {
  const destination = to === lastDestination ? '同' : toJapaneseSquare(to)
  const piece = kindKanjiMap[kind]
  if (from === '00') return `${destination}${piece}打`

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
      const rightMost =
        player === '先手'
          ? Math.max(...candidates.map((candidate) => candidate.from.x))
          : Math.min(...candidates.map((candidate) => candidate.from.x))
      const leftMost =
        player === '先手'
          ? Math.min(...candidates.map((candidate) => candidate.from.x))
          : Math.max(...candidates.map((candidate) => candidate.from.x))
      if (source.x === rightMost) suffix += '右'
      else if (source.x === leftMost) suffix += '左'
    }

    const movement = player === '先手' ? source.y - toY : toY - source.y
    if (movement > 0) suffix += '上'
    else if (movement < 0) suffix += '引'
    else suffix += '寄'
  }

  const originalPiece = shogi.get(fromX, fromY)
  const promote =
    !!originalPiece &&
    originalPiece.kind !== kind &&
    !promotedKinds.includes(originalPiece.kind) &&
    promotedKinds.includes(kind)
  if (promote) suffix += '成'

  return `${destination}${piece}${suffix}`
}

const shogi = new Shogi()
let lastDestination = null
let moveNo = 0
for (const rawLine of lines) {
  const line = rawLine.trim()
  if (!/^[+-][0-9]{4}[A-Z]{2}$/.test(line)) continue
  moveNo += 1
  const player = line.startsWith('+') ? '先手' : '後手'
  const from = line.slice(1, 3)
  const to = line.slice(3, 5)
  const kind = line.slice(5, 7)
  const notation = convert(shogi, player, from, to, kind, lastDestination)
  console.log(moveNo, line, notation)

  try {
    if (from === '00') {
      const color = player === '先手' ? Color.Black : Color.White
      shogi.drop(Number(to[0]), Number(to[1]), kind, color)
    } else {
      const originalPiece = shogi.get(Number(from[0]), Number(from[1]))
      const promote =
        !!originalPiece &&
        originalPiece.kind !== kind &&
        !promotedKinds.includes(originalPiece.kind) &&
        promotedKinds.includes(kind)
      shogi.move(Number(from[0]), Number(from[1]), Number(to[0]), Number(to[1]), promote)
    }
  } catch (error) {
    console.error('FAIL APPLY', moveNo, line, notation, error.message)
    break
  }

  lastDestination = to
}
