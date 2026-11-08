import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// Build the standalone assistant package from the candidate source, mirroring
// packages/assistant/README.md in the frozen delivery. No network, no build
// step; files are copied verbatim, plus licence and package README.

const SRC = path.resolve('source')
const OUT = process.argv[2] || 'pack/assistant'
const MAN = JSON.parse(fs.readFileSync(path.join(SRC, 'packages/assistant-web/manifest.json'), 'utf8'))

const files = [MAN.entry, MAN.style, ...(MAN.references || []), 'manifest.json']
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
for (const f of files) {
  fs.copyFileSync(path.join(SRC, 'packages/assistant-web', f), path.join(OUT, f))
}
fs.copyFileSync(path.join(SRC, 'packages/host-adapter/loader.js'), path.join(OUT, 'loader.js'))
fs.copyFileSync('LICENSE', path.join(OUT, 'LICENSE'))
fs.copyFileSync('NOTICE', path.join(OUT, 'NOTICE'))
fs.writeFileSync(path.join(OUT, 'README.md'), `# Stellarium Web 助手独立包 ${MAN.version}

按仓库根 README「安装到已有星图站点」安装；host 端请配合源码树使用或从 project-source 包获取。\n本包 ${files.length} 个资源文件 + loader.js + 许可/说明，均逐字节复制自候选源码。\n`)
console.log('assistant package built at ' + OUT)
for (const f of [...files, 'loader.js']) console.log(sha(path.join(OUT, f)) + '  ' + f)
