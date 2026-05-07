const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const SHOGI_WARS_BASE = 'https://shogiwars.hibinotatsuya.com'
const id = process.argv[2] || 'habu'
const gtype = process.argv[3] || ''
const page = Number(process.argv[4] || '1')
const workdir = process.cwd()
const homePath = path.join(workdir, '.tmp_shogiwars_home.html')
const searchPath = path.join(workdir, '.tmp_shogiwars_search.html')
const cookiePath = path.join(workdir, '.tmp_shogiwars_cookies.txt')

cp.execFileSync('curl.exe', ['-s', '-c', cookiePath, `${SHOGI_WARS_BASE}/`], {
  cwd: workdir,
  stdio: ['ignore', fs.openSync(homePath, 'w'), 'ignore'],
})
const homeHtml = fs.readFileSync(homePath, 'utf8')
const tokenMatch = homeHtml.match(/name="_token" value="([^"]+)"/)
if (!tokenMatch) {
  console.error('TOKEN_NOT_FOUND')
  process.exit(2)
}
const token = tokenMatch[1]
const body = `_token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}&gtype=${encodeURIComponent(gtype)}&page=${encodeURIComponent(String(page))}`
cp.execFileSync(
  'curl.exe',
  ['-s', '-L', '-b', cookiePath, '-c', cookiePath, '-X', 'POST', `${SHOGI_WARS_BASE}/search`, '-H', 'Content-Type: application/x-www-form-urlencoded', '--data', body],
  {
    cwd: workdir,
    stdio: ['ignore', fs.openSync(searchPath, 'w'), 'ignore'],
  },
)
const html = fs.readFileSync(searchPath, 'utf8')
console.log(html.slice(0, 6000))
