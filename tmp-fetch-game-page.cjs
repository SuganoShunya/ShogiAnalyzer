const fs = require('fs')
const cp = require('child_process')
const url = process.argv[2]
if (!url) throw new Error('url required')
cp.execFileSync('curl.exe', ['-s', '-L', '-A', 'Mozilla/5.0', url], { stdio: ['ignore', fs.openSync('.tmp_shogiwars_game.html', 'w'), 'ignore'] })
console.log(fs.readFileSync('.tmp_shogiwars_game.html', 'utf8').slice(0, 8000))
