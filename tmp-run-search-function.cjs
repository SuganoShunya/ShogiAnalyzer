const fs = require('fs')
const path = require('path')
const cp = require('child_process')

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

function searchShogiWarsGames(id, gtype = '', page = 1) {
  const workdir = process.cwd()
  const homePath = path.join(workdir, '.shogiwars_home.html')
  const searchPath = path.join(workdir, '.shogiwars_search.html')
  const cookiePath = path.join(workdir, '.shogiwars_cookies.txt')

  cp.execFileSync('curl.exe', ['-s', '-A', 'Mozilla/5.0', '-c', cookiePath, `${SHOGI_WARS_BASE}/`], {
    cwd: workdir,
    stdio: ['ignore', fs.openSync(homePath, 'w'), 'ignore'],
  })
  const homeHtml = fs.readFileSync(homePath, 'utf8')
  const tokenMatch = homeHtml.match(/name="_token" value="([^"]+)"/)
  if (!tokenMatch) throw new Error('shogiwars csrf token not found')
  const token = tokenMatch[1]
  const body = `_token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}&gtype=${encodeURIComponent(gtype)}&page=${encodeURIComponent(String(page))}`
  cp.execFileSync(
    'curl.exe',
    ['-s','-L','-A','Mozilla/5.0','-b',cookiePath,'-c',cookiePath,'-X','POST',`${SHOGI_WARS_BASE}/search`,'-H','Content-Type: application/x-www-form-urlencoded','--data',body],
    { cwd: workdir, stdio: ['ignore', fs.openSync(searchPath, 'w'), 'ignore'] },
  )
  const html = fs.readFileSync(searchPath, 'utf8')
  const cardMatches = [...html.matchAll(/<div class="h5">([\s\S]*?)<\/div>[\s\S]*?<div class="small mb-1">対局日:\s*([^<]+)<\/div>[\s\S]*?<a[^>]+href="(\/games\/[^\"]+)"[^>]*>[\s\S]*?棋譜を見る[\s\S]*?<\/a>/g)]
  const games = cardMatches.map((match) => {
    const title = stripHtml(match[1])
    const playedAt = stripHtml(match[2])
    const href = `${SHOGI_WARS_BASE}${match[3]}`
    return { href, label: playedAt ? `${title} (${playedAt})` : title || match[3], title, playedAt }
  })
  const nextPageMatch = html.match(/<form[^>]+id="nextForm"[\s\S]*?<input type="hidden" name="page" value="(\d+)"/)
  const prevPageMatch = html.match(/<form[^>]+id="prevForm"[\s\S]*?<input type="hidden" name="page" value="(\d+)"/)
  return { html: html.slice(0,500), games, found: games.length, page, hasNext: /id="buttonNext"(?![^>]*disabled)/.test(html), hasPrev: /id="buttonPrev"(?![^>]*disabled)/.test(html), nextPage: nextPageMatch ? Number(nextPageMatch[1]) : null, prevPage: prevPageMatch ? Number(prevPageMatch[1]) : null }
}

console.log(JSON.stringify(searchShogiWarsGames(process.argv[2] || 'habu'), null, 2))
