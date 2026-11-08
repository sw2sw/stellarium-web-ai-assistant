#!/usr/bin/env node
/* src-tree fingerprint generator — the ACTUAL algorithm behind the
 * "# src-tree <name> <hash>" header lines in evidence/logs/*.log.
 *
 * Definition (byte-exact, independently reproducible):
 *   input   one or more directories given relative to repo/source
 *           (e.g. packages/assistant-web packages/ai-service)
 *   files   every regular file under the directory, recursively,
 *           dotfiles included, nothing skipped
 *   rel     path of the file relative to the directory, "/" separators
 *   order   rel paths sorted BYTE-WISE (raw UTF-8 octets, not locale
 *           collation)
 *   lines   for each rel, in that order:
 *             <sha256 of file bytes> *<dir-as-given>/<rel>\n
 *           - exactly one space between hash and "*", the "*" is the
 *             sha256sum binary-mode marker, the directory prefix is the
 *             argument AS GIVEN (forward slashes),
 *           - every line ends with LF ("\n"), no CR anywhere,
 *           - no trailing blank line beyond the last line's own LF.
 *   result  sha256 over the concatenation of all lines.
 *
 * The values in the current logs were produced by this byte stream
 * (originally via the equivalent Git Bash pipeline; this script is its
 * committed, portable form):
 *
 *   ( cd packages/assistant-web && find . -type f | sed 's|^\./||' | sort | \
 *       while read -r f; do sha256sum "$f" | sed "s|\*|*packages/assistant-web/|"; done ) \
 *     | sha256sum
 *
 * Verify against the logs:
 *   node tools/src-tree-fingerprint.mjs packages/assistant-web
 *     -> 22a8a6c61b08ba252507ade8feb6f51841aa27c29d2f759a5a3c588cc3240600  (ix-e2e.log, client.log, …)
 *   node tools/src-tree-fingerprint.mjs packages/ai-service
 *     -> 0db6f75ef3c466cf83e31b23c61031857e68e60e5d6ff69369a5e7fe528426f8  (service.log, server-ai.log)
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function fingerprint (dirArg) {
  const dir = path.join(SRC, dirArg)
  const st = fs.statSync(dir)
  if (!st.isDirectory()) throw new Error('not a directory: ' + dirArg)
  const rels = []
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(a, r)
      else if (e.isFile()) rels.push(r)
      // symlinks and other non-regular entries are excluded; the source
      // trees under packages/ contain none (the packaging scripts refuse
      // them outright).
    }
  }
  walk(dir, '')
  rels.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  const stream = rels.map((r) =>
    sha256(fs.readFileSync(path.join(dir, r))) + ' *' + dirArg + '/' + r + '\n'
  ).join('')
  return sha256(Buffer.from(stream, 'utf8'))
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node tools/src-tree-fingerprint.mjs <dir relative to source> [...]')
  process.exit(2)
}
for (const d of args) {
  console.log(d + ' ' + fingerprint(d))
}
