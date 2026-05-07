const fs = require('fs')
const html = fs.readFileSync('.tmp_shogiwars_search.html', 'utf8')

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

const oldMatches = [...html.matchAll(/<div class="h5">([\s\S]*?)<\/div>[\s\S]*?<a[^>]+href="(\/games\/[^\"]+)"[^>]*>[\s\S]*?棋譜を見る[\s\S]*?<\/a>/g)]
console.log('oldMatches', oldMatches.length)
console.log(oldMatches.slice(0, 5).map((m) => ({ label: stripHtml(m[1]), href: m[2] })))

const rowBlocks = [...html.matchAll(/<div class="row(?: mb-4)?">([\s\S]*?)<\/div>\s*<\/div>?/g)]
console.log('rowBlocks', rowBlocks.length)
