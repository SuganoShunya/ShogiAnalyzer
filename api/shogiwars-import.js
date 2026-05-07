const SHOGI_WARS_BASE = 'https://shogiwars.hibinotatsuya.com'

function decode(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, reason: 'Method not allowed' })
    return
  }

  try {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
    if (!rawUrl) {
      res.status(400).json({ ok: false, reason: 'valid game url is required' })
      return
    }

    let normalizedUrl = rawUrl
    try {
      const parsed = new URL(rawUrl)
      const gamePathMatch = parsed.pathname.match(/\/games\/[^/?#]+/)
      if (gamePathMatch) {
        normalizedUrl = `${parsed.origin}${gamePathMatch[0]}`
      }
    } catch {
      res.status(400).json({ ok: false, reason: 'valid absolute url is required' })
      return
    }

    if (!normalizedUrl.startsWith(SHOGI_WARS_BASE) || !normalizedUrl.includes('/games/')) {
      res.status(400).json({ ok: false, reason: 'valid game url is required' })
      return
    }

    const response = await fetch(normalizedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    })

    if (!response.ok) {
      res.status(502).json({ ok: false, reason: `failed to fetch game page: HTTP ${response.status}`, url: normalizedUrl })
      return
    }

    const html = await response.text()
    const csaMatch = html.match(/<textarea[^>]*id="kifu_csa"[^>]*>([\s\S]*?)<\/textarea>/)
    const kifMatch = html.match(/<script type="text\/kifu">([\s\S]*?)<\/script>/)
    const csa = csaMatch ? decode(csaMatch[1]) : ''
    const kif = kifMatch ? decode(kifMatch[1]) : ''

    if (!csa && !kif) {
      res.status(502).json({ ok: false, reason: 'kifu payload was not found in fetched page', url: normalizedUrl })
      return
    }

    res.status(200).json({ ok: true, csa, kif, url: normalizedUrl })
  } catch (error) {
    res.status(500).json({ ok: false, reason: error instanceof Error ? error.message : 'shogiwars import failed' })
  }
}
