import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const SHOGI_WARS_BASE = 'https://shogiwars.hibinotatsuya.com'

type AnalyzeBody = {
  sfen?: unknown
  config?: { usiPath?: string; thinkTimeMs?: number }
}

type ShogiWarsSearchBody = {
  id?: unknown
  gtype?: unknown
  page?: unknown
}

type ShogiWarsImportBody = {
  url?: unknown
}

function stripHtml(text: string) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function searchShogiWarsGames(id: string, gtype = '', page = 1) {
  const workdir = process.cwd()
  const homePath = path.join(workdir, '.shogiwars_home.html')
  const searchPath = path.join(workdir, '.shogiwars_search.html')
  const cookiePath = path.join(workdir, '.shogiwars_cookies.txt')

  execFileSync('curl.exe', ['-s', '-A', 'Mozilla/5.0', '-c', cookiePath, `${SHOGI_WARS_BASE}/`], {
    cwd: workdir,
    stdio: ['ignore', fs.openSync(homePath, 'w'), 'ignore'],
  })
  const homeHtml = fs.readFileSync(homePath, 'utf8')
  const tokenMatch = homeHtml.match(/name="_token" value="([^"]+)"/)
  if (!tokenMatch) throw new Error('shogiwars csrf token not found')
  const token = tokenMatch[1]
  const body = `_token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}&gtype=${encodeURIComponent(gtype)}&page=${encodeURIComponent(String(page))}`
  execFileSync(
    'curl.exe',
    [
      '-s',
      '-L',
      '-A',
      'Mozilla/5.0',
      '-b',
      cookiePath,
      '-c',
      cookiePath,
      '-X',
      'POST',
      `${SHOGI_WARS_BASE}/search`,
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '--data',
      body,
    ],
    {
      cwd: workdir,
      stdio: ['ignore', fs.openSync(searchPath, 'w'), 'ignore'],
    },
  )
  const html = fs.readFileSync(searchPath, 'utf8')
  const cardMatches = [...html.matchAll(/<div class="h5">([\s\S]*?)<\/div>[\s\S]*?<div class="small mb-1">対局日:\s*([^<]+)<\/div>[\s\S]*?<a[^>]+href="(\/games\/[^\"]+)"[^>]*>[\s\S]*?棋譜を見る[\s\S]*?<\/a>/g)]
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

async function probeUsiEngine(usiPath: string, thinkTimeMs = 600) {
  return new Promise((resolve) => {
    const cwd = path.dirname(usiPath)
    if (!fs.existsSync(usiPath)) {
      resolve({ ok: false, reason: `USI exe not found: ${usiPath}` })
      return
    }
    const proc = spawn(usiPath, [], { stdio: 'pipe', cwd, windowsHide: true })
    let settled = false

    const finish = (result: unknown) => {
      if (settled) return
      settled = true
      proc.kill()
      resolve(result)
    }

    const timer = setTimeout(() => finish({ ok: false, reason: 'USI engine probe timeout' }), thinkTimeMs + 1200)

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        if (line === 'usiok') {
          clearTimeout(timer)
          finish({ ok: true, message: 'USI応答あり。PCエンジンを起動できた。' })
        }
      }
    })

    proc.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, reason: `${error.message} | cwd=${cwd} | exists=${fs.existsSync(usiPath)}` })
    })

    proc.on('exit', () => {
      if (!settled) {
        clearTimeout(timer)
        finish({ ok: false, reason: 'USI engine exited before ready' })
      }
    })

    proc.stdin.write('usi\n')
  })
}

function createUsiProxy() {
  return {
    name: 'usi-analysis-api',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/api/usi-test', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, reason: 'Method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }

        let body: AnalyzeBody
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, reason: 'Invalid JSON body' }))
          return
        }

        const usiPath = body.config?.usiPath || process.env.SHOGI_USI_PATH
        if (!usiPath) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, reason: 'USI path is not configured' }))
          return
        }

        const result = await probeUsiEngine(usiPath)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result))
      })

      server.middlewares.use('/api/shogiwars-search', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, reason: 'Method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }

        let body: ShogiWarsSearchBody
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, reason: 'Invalid JSON body' }))
          return
        }

        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const gtype = typeof body.gtype === 'string' ? body.gtype : ''
        const page = typeof body.page === 'number' ? body.page : 1
        if (!id) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, reason: 'id is required' }))
          return
        }

        try {
          const result = searchShogiWarsGames(id, gtype, page)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, ...result }))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : 'shogiwars search failed' }))
        }
      })

      server.middlewares.use('/api/shogiwars-import', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, reason: 'Method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }

        let body: ShogiWarsImportBody
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, reason: 'Invalid JSON body' }))
          return
        }

        const rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
        if (!rawUrl) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, reason: 'valid game url is required' }))
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
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, reason: 'valid absolute url is required' }))
          return
        }

        if (!normalizedUrl.includes('/games/')) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, reason: 'valid game url is required' }))
          return
        }

        try {
          const response = await fetch(normalizedUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml',
            },
          })

          if (!response.ok) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, reason: `failed to fetch game page: HTTP ${response.status}`, url: normalizedUrl }))
            return
          }

          const html = await response.text()
          const csaMatch = html.match(/<textarea[^>]*id="kifu_csa"[^>]*>([\s\S]*?)<\/textarea>/)
          const kifMatch = html.match(/<script type="text\/kifu">([\s\S]*?)<\/script>/)
          const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
          const csa = csaMatch ? decode(csaMatch[1]) : ''
          const kif = kifMatch ? decode(kifMatch[1]) : ''

          if (!csa && !kif) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, reason: 'kifu payload was not found in fetched page', url: normalizedUrl }))
            return
          }

          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            ok: true,
            csa,
            kif,
            url: normalizedUrl,
          }))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : 'shogiwars import failed' }))
        }
      })

      server.middlewares.use('/api/usi-analyze', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ available: false, reason: 'Method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }

        let body: AnalyzeBody
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ available: false, reason: 'Invalid JSON body' }))
          return
        }

        const usiPath = body.config?.usiPath || process.env.SHOGI_USI_PATH
        if (!usiPath) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ available: false, reason: 'SHOGI_USI_PATH is not configured' }))
          return
        }

        if (typeof body.sfen !== 'string' || !body.sfen.trim()) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ available: false, reason: 'sfen is required' }))
          return
        }

        try {
          const result = await runUsiAnalysis(usiPath, body.sfen, body.config?.thinkTimeMs)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ available: false, reason: error instanceof Error ? error.message : 'USI analysis failed' }))
        }
      })
    },
  }
}

async function runUsiAnalysis(usiPath: string, sfen: string, thinkTimeMs = 1200) {
  return new Promise((resolve) => {
    const cwd = path.dirname(usiPath)
    if (!fs.existsSync(usiPath)) {
      resolve({ available: false, reason: `USI exe not found: ${usiPath}` })
      return
    }
    const proc = spawn(usiPath, [], { stdio: 'pipe', cwd, windowsHide: true })
    let settled = false
    let latestEval: number | undefined
    let latestDepth: number | undefined
    let latestPv: string[] | undefined
    const transcript: string[] = []

    const finish = (result: unknown) => {
      if (settled) return
      settled = true
      proc.kill()
      resolve(result)
    }

    const timer = setTimeout(
      () => finish({ available: false, reason: `USI engine timeout | log=${transcript.slice(-20).join(' || ')}` }),
      thinkTimeMs + 2000,
    )

    let sentReady = false
    let sentGo = false

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        transcript.push(`out:${line}`)
        if (line === 'usiok' && !sentReady) {
          sentReady = true
          transcript.push('in:isready')
          proc.stdin.write('isready\n')
        } else if (line === 'readyok' && !sentGo) {
          sentGo = true
          transcript.push('in:usinewgame')
          proc.stdin.write('usinewgame\n')
          transcript.push(`in:position sfen ${sfen}`)
          proc.stdin.write(`position sfen ${sfen}\n`)
          transcript.push(`in:go movetime ${thinkTimeMs}`)
          proc.stdin.write(`go movetime ${thinkTimeMs}\n`)
        } else if (line.startsWith('info ')) {
          const cpMatch = line.match(/score cp (-?\d+)/)
          const mateMatch = line.match(/score mate (-?\d+)/)
          const depthMatch = line.match(/depth (\d+)/)
          const pvMatch = line.match(/ pv (.+)$/)
          if (cpMatch) latestEval = Number(cpMatch[1])
          if (mateMatch) latestEval = Number(mateMatch[1]) > 0 ? 30000 : -30000
          if (depthMatch) latestDepth = Number(depthMatch[1])
          if (pvMatch) latestPv = pvMatch[1].trim().split(/\s+/)
        } else if (line.startsWith('bestmove ')) {
          clearTimeout(timer)
          const bestMove = line.split(/\s+/)[1]
          finish({
            available: bestMove && bestMove !== 'resign' && bestMove !== 'win',
            source: 'usi',
            bestMove,
            pv: latestPv,
            evaluation: latestEval,
            depth: latestDepth,
            reason: bestMove === 'resign' ? 'engine returned resign' : bestMove === 'win' ? 'engine returned win' : undefined,
            transcript,
          })
        }
      }
    })

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        transcript.push(`err:${line}`)
      }
    })

    proc.on('error', (error) => {
      clearTimeout(timer)
      finish({ available: false, reason: `${error.message} | cwd=${cwd} | exists=${fs.existsSync(usiPath)} | log=${transcript.slice(-20).join(' || ')}` })
    })

    proc.on('exit', (code, signal) => {
      if (!settled) {
        clearTimeout(timer)
        finish({ available: false, reason: `USI engine exited unexpectedly | code=${code} signal=${signal} | log=${transcript.slice(-20).join(' || ')}` })
      }
    })

    transcript.push('in:usi')
    proc.stdin.write('usi\n')
  })
}

export default defineConfig({
  plugins: [react(), createUsiProxy()],
})
