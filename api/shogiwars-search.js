const SHOGI_WARS_BASE = 'https://shogiwars.hibinotatsuya.com'

function stripHtml(text) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url, options) {
  const response = await fetch(url, options)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.text()
}

function extractCookie(headers) {
  const raw = headers.get('set-cookie') || ''
  return raw.split(',').map((part) => part.split(';')[0].trim()).filter(Boolean).join('; ')
}

async function searchShogiWarsGames(id, gtype = '', page = 1) {
  const homeResponse = await fetch(`${SHOGI_WARS_BASE}/`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' },
  })
  if (!homeResponse.ok) throw new Error(`home HTTP ${homeResponse.status}`)
  const homeHtml = await homeResponse.text()
  const cookie = extractCookie(homeResponse.headers)
  const tokenMatch = homeHtml.match(/name="_token" value="([^"]+)"/)
  if (!tokenMatch) throw new Error('shogiwars csrf token not found')
  const token = tokenMatch[1]

  const body = new URLSearchParams({ _token: token, id, gtype, page: String(page) })
  const html = await fetchText(`${SHOGI_WARS_BASE}/search`, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html,application/xhtml+xml',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: body.toString(),
  })

  const cardMatches = [...html.matchAll(/<div class="h5">([\s\S]*?)<\/div>[\s\S]*?<div class="small mb-1">対局日:\s*([^<]+)<\/div>[\s\S]*?<a[^>]+href="(\/games\/[^"]+)"[^>]*>[\s\S]*?棋譜を見る[\s\S]*?<\/a>/g)]
  const games = cardMatches.map((match) => {
    const title = stripHtml(match[1])
    const playedAt = stripHtml(match[2])
    const href = `${SHOGI_WARS_BASE}${match[3]}`
    const [leftNameRaw = '', rightNameRaw = ''] = title.split(/\s+vs\s+/i)
    const leftName = leftNameRaw.trim()
    const rightName = rightNameRaw.trim()
    const normalizedId = id.trim().toLowerCase()
    const playerSide = leftName.toLowerCase() === normalizedId ? 'sente' : rightName.toLowerCase() === normalizedId ? 'gote' : undefined
    return {
      href,
      label: playedAt ? `${title} (${playedAt})` : title || match[3],
      title,
      playedAt,
      playerSide,
    }
  })

  const nextPageMatch = html.match(/<form[^>]+id="nextForm"[\s\S]*?<input type="hidden" name="page" value="(\d+)"/)
  const prevPageMatch = html.match(/<form[^>]+id="prevForm"[\s\S]*?<input type="hidden" name="page" value="(\d+)"/)

  return {
    html,
    games,
    found: games.length,
    page,
    hasNext: /id="buttonNext"(?![^>]*disabled)/.test(html),
    hasPrev: /id="buttonPrev"(?![^>]*disabled)/.test(html),
    nextPage: nextPageMatch ? Number(nextPageMatch[1]) : null,
    prevPage: prevPageMatch ? Number(prevPageMatch[1]) : null,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, reason: 'Method not allowed' })
    return
  }

  try {
    const { id, gtype = '', page = 1 } = req.body || {}
    const trimmedId = typeof id === 'string' ? id.trim() : ''
    if (!trimmedId) {
      res.status(400).json({ ok: false, reason: 'id is required' })
      return
    }

    const result = await searchShogiWarsGames(trimmedId, typeof gtype === 'string' ? gtype : '', typeof page === 'number' ? page : 1)
    res.status(200).json({ ok: true, ...result })
  } catch (error) {
    res.status(500).json({ ok: false, reason: error instanceof Error ? error.message : 'shogiwars search failed' })
  }
}
