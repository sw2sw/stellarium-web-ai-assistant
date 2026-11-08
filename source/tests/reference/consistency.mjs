/* Static acceptance for the bundled object-naming reference.
 *
 * The reference (packages/assistant-web/naming-reference.js) is what the model
 * is told and what any other agent is invited to read, so it has to be right
 * on its own terms. This file checks that without a browser:
 *
 *   1. it loads the way a <script> would (a bare global, no bundler);
 *   2. its 88 constellations and its common-object tables are the same rows the
 *      bridge resolves names with - if the two drift, the model is taught one
 *      spelling and the fallback rewrites another;
 *   3. every example it teaches actually matches the shape it claims;
 *   4. the prompt it produces is complete, and carries no table markup a model
 *      could copy into JSON.
 *
 * usage: node tests/reference/consistency.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../..')
const REF_FILE = path.join(SRC, 'packages/assistant-web/naming-reference.js')
const LOADER_FILE = path.join(SRC, 'packages/host-adapter/loader.js')
const MANIFEST_FILE = path.join(SRC, 'packages/assistant-web/manifest.json')

let failures = 0
let passes = 0
const check = (name, ok, detail) => {
  if (ok) passes++
  else failures++
  console.log((ok ? 'PASS ' : 'FAIL ') + name +
    (!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''))
}

/* ------------------------------------------------- 1. load like a script */

// No require/import: the file must work as a plain <script> in the page.
// In a browser globalThis === window; in this sandbox the same code lands on
// the context's global object, which is why both are checked.
const sandbox = { window: {}, console }
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(REF_FILE, 'utf8'), sandbox, { filename: 'naming-reference.js' })

const ref = sandbox.SWE_NAMING_REFERENCE || sandbox.window.SWE_NAMING_REFERENCE
check('the reference exposes itself as a bare global, like a <script> would', !!ref)
if (!ref) {
  console.log('\n1 CHECK(S) FAILED')
  process.exit(1)
}
check('it declares an id, a version and a measurement date',
  ref.id === 'swe-object-naming' && /^\d+\.\d+\.\d+$/.test(ref.version) && /^\d{4}-\d{2}-\d{2}$/.test(ref.measured),
  { id: ref.id, version: ref.version, measured: ref.measured })
check('it works under Node too (globalThis, no window)',
  (() => {
    const g = {}
    vm.runInNewContext(fs.readFileSync(REF_FILE, 'utf8'), g)
    return !!g.SWE_NAMING_REFERENCE
  })())

/* --------------------------------------- 2. same rows as the bridge tables */

// The loader keeps its alias tables as escaped source; read the literals back
// rather than copying them, so this test cannot agree with a stale copy.
const loaderSrc = fs.readFileSync(LOADER_FILE, 'utf8')
function literalAfter (marker, endMarker) {
  const start = loaderSrc.indexOf(marker)
  if (start < 0) throw new Error('loader.js: marker not found: ' + marker)
  const end = endMarker ? loaderSrc.indexOf(endMarker, start) : -1
  const body = loaderSrc.slice(start + marker.length, end > 0 ? end : undefined)
  // The assignment ends at the first newline followed by two spaces + a letter
  // that starts a new statement; the tables are all one statement.
  const expr = body.slice(0, body.indexOf('\n\n'))
  return new Function('return ' + expr.trim())()
}

const bridgeConstellations = literalAfter('var CONSTELLATION_ROWS =', '// Targets are the exact strings')
  .split(',').map((row) => row.split('='))
const bridgePlanets = literalAfter('var PLANET_ROWS =')
const bridgeStars = literalAfter('var STAR_ROWS =')
const bridgeDsos = literalAfter('var DSO_ROWS =')

check('the bridge ships 88 constellation rows, the reference ships 88',
  bridgeConstellations.length === 88 && ref.constellations.length === 88,
  { bridge: bridgeConstellations.length, reference: ref.constellations.length })

const refConst = new Map(ref.constellations.map((r) => [r[0], r]))
const bridgeConstMap = new Map(bridgeConstellations.map((r) => [r[0], r]))
const missing = bridgeConstellations.map((r) => r[0]).filter((a) => !refConst.has(a))
const extra = ref.constellations.map((r) => r[0]).filter((a) => !bridgeConstMap.has(a))
check('every constellation abbreviation the bridge knows is in the reference',
  missing.length === 0, missing)
check('the reference invents no constellation the bridge cannot resolve',
  extra.length === 0, extra)

const nameDrift = ref.constellations.filter((r) => {
  const b = bridgeConstMap.get(r[0])
  return !b || b[1] !== r[1] || b[2] !== r[2]
}).map((r) => r[0])
check('Chinese and English constellation names match the bridge row for row',
  nameDrift.length === 0, nameDrift)

const noDupes = new Set(ref.constellations.map((r) => r[0])).size === ref.constellations.length
check('no duplicated constellation abbreviation', noDupes)

// Same first column = same engine string, which is the only column that
// matters for a lookup miss.
function sameFirstColumn (label, refRows, bridgeRows) {
  const a = refRows.map((r) => r[0]).sort()
  const b = bridgeRows.map((r) => r[0]).sort()
  const diff = a.filter((x) => !b.includes(x)).concat(b.filter((x) => !a.includes(x)))
  check(label + ' use the same engine strings as the bridge', diff.length === 0, diff)
}
sameFirstColumn('planet', ref.planets, bridgePlanets)
sameFirstColumn('star', ref.stars, bridgeStars)
sameFirstColumn('deep-sky', ref.deepSky, bridgeDsos)

/* ------------------------------------------- 3. the shapes teach the truth */

const shapeOf = (name) => {
  if (/^NAME \S+$/.test(name)) return 'planet'
  if (/^CON western [A-Z][A-Za-z]{2}$/.test(name)) return 'constellation'
  if (/^(M|C|NGC|IC|HIP|HD) \d+[A-Za-z]?$/.test(name)) return 'deepsky'
  return 'star'
}

const kinds = ref.shapes.map((s) => s.kind)
check('one shape per object kind, no duplicates',
  kinds.length === 4 && new Set(kinds).size === 4, kinds)

const badOk = []
for (const s of ref.shapes) {
  for (const name of s.ok) {
    if (shapeOf(name) !== s.kind) badOk.push({ kind: s.kind, name, looks: shapeOf(name) })
  }
}
check('every taught example matches the shape it is filed under', badOk.length === 0, badOk)

// A counter-example must not read like a valid member of another shape either:
// 'Jupiter' is filed under planet and is a bare star-shaped name, which is the
// point - it is the error, not a second way to write it.
const badBad = []
for (const s of ref.shapes) {
  for (const name of s.bad) {
    if (!name) badBad.push({ kind: s.kind, empty: true })
  }
}
check('every counter-example is a non-empty string', badBad.length === 0, badBad)

// Planet examples must be exactly the strings the bridge table carries, or the
// model is taught something that only the fallback saves.
const planetTargets = new Set(ref.planets.map((r) => r[0]))
const strayPlanet = ref.shapes.find((s) => s.kind === 'planet').ok.filter((n) => !planetTargets.has(n))
check('the planet examples are all real rows of the planet table', strayPlanet.length === 0, strayPlanet)

// Constellation examples must name an abbreviation that exists.
const abbrs = new Set(ref.constellations.map((r) => r[0]))
const strayCon = ref.shapes.find((s) => s.kind === 'constellation').ok
  .map((n) => n.replace(/^CON western /, '')).filter((a) => !abbrs.has(a))
check('the constellation examples use real IAU abbreviations', strayCon.length === 0, strayCon)

// Corrections must land on a shape that exists.
const badFix = ref.corrections.filter(([, to]) => !['planet', 'star', 'constellation', 'deepsky'].includes(shapeOf(to)))
  .map(([from, to]) => from + ' -> ' + to)
check('every "fix this" entry points at a valid shape', badFix.length === 0, badFix)

/* ------------------------------------------------- 4. the produced prompt */

const zh = ref.toPrompt('zh')
const zhFull = ref.toPrompt('zh', { level: 'full' })
const en = ref.toPrompt('en')
const enFull = ref.toPrompt('en', { level: 'full' })

// The default block rides with every request, so its size is a product
// decision, not an accident: compact enough for a small context window, and
// big enough to carry a regex and an example for each of the four shapes.
check('the Chinese default block is small enough to send on every request',
  zh.length > 600 && zh.length < 1500 && Buffer.byteLength(zh) < 2000,
  { chars: zh.length, bytes: Buffer.byteLength(zh) })
// English needs more characters than Chinese for the same content (~0.5k
// tokens), so its ceiling is higher; the point is that it stays a fraction of
// the full block, not that it matches the Chinese count.
check('the English default block is small enough to send on every request',
  en.length > 600 && en.length < 2100 && Buffer.byteLength(en) < 2300,
  { chars: en.length, bytes: Buffer.byteLength(en) })
check('the full block is opt-in and costs several times more',
  zhFull.length > 2500 && zhFull.length > zh.length * 2 &&
  enFull.length > 2000 && enFull.length > en.length * 2,
  { compact: zh.length, full: zhFull.length })

const mustHave = {
  zh: ['NAME Jupiter', 'CON western Ori', 'M 31', '* alf Ori', 'object_not_found'],
  en: ['NAME Jupiter', 'CON western Ori', 'M 31', '* alf Ori', 'object_not_found']
}
for (const [lang, wanted] of Object.entries(mustHave)) {
  for (const [level, text] of [[lang + '/compact', lang === 'zh' ? zh : en],
                               [lang + '/full', lang === 'zh' ? zhFull : enFull]]) {
    const gone = wanted.filter((w) => !text.includes(w))
    check('the ' + level + ' block keeps every measured example', gone.length === 0, gone)
  }
}

// Every taught positive example must satisfy the regex published next to it,
// otherwise the block contradicts itself and a model following the regex will
// reject a name the block itself recommends.
const grammarMiss = []
for (const shape of ref.shapes) {
  const re = new RegExp(ref.grammar[shape.kind])
  for (const name of shape.ok) {
    if (!re.test(name)) grammarMiss.push({ kind: shape.kind, name, re: ref.grammar[shape.kind] })
  }
}
check('every taught example matches the regex published for its kind',
  grammarMiss.length === 0, grammarMiss)

// And the classic mistakes must NOT match, or the block would teach that the
// wrong form is acceptable.
const grammarLet = []
for (const shape of ref.shapes) {
  const re = new RegExp(ref.grammar[shape.kind])
  for (const name of shape.bad) {
    if (re.test(name)) grammarLet.push({ kind: shape.kind, name })
  }
}
check('no taught mistake passes the published regex', grammarLet.length === 0, grammarLet)

const absentAbbr = ref.constellations.map((r) => r[0])
  .filter((a) => !new RegExp('(^|[;\\s])' + a + ' ').test(zhFull))
check('the full block carries all 88 abbreviations', absentAbbr.length === 0, absentAbbr)

// The compact block is allowed to drop the table on purpose: a Chinese or
// English constellation name is rewritten by the bridge, so the table is an
// optimisation, not a requirement.
const compactAbbr = ref.constellations.map((r) => r[0])
  .filter((a) => new RegExp('(^|[;\\s])' + a + ' ').test(zh)).length
check('the compact block leaves the 88-row table out on purpose',
  compactAbbr < 10, compactAbbr)

// A pipe inside a regex alternation is fine; a pipe in column position is a
// table, and a fence invites a model to wrap the JSON in it.
const hasTable = (t) => t.split('\n').some((l) => /^\s*\|/.test(l)) || t.includes('```')
check('no block carries a markdown table or fence a model could copy',
  !hasTable(zh) && !hasTable(en) && !hasTable(zhFull) && !hasTable(enFull))

const exZh = ref.toExamples('zh')
const exFull = ref.toExamples('zh')
const validReplies = (block, want) => {
  const lines = block.split('\n').filter((l) => l.startsWith('{'))
  if (lines.length !== want) return false
  return lines.every((l) => {
    const o = JSON.parse(l)
    return Array.isArray(o.commands) && typeof o.say === 'string' &&
      o.commands.every((c) => typeof c.type === 'string')
  })
}
check('the full few-shot block is valid JSON on every reply line',
  validReplies(ref.toExamples('zh'), ref.examples.length), ref.examples.length)
check('the compact few-shot block is valid JSON and shorter',
  validReplies(ref.toExamples('zh', { limit: 4 }), 4) &&
  ref.toExamples('zh', { limit: 4 }).length < exZh.length)
check('the compact few-shot covers all four shapes',
  (() => {
    const names = ref.toExamples('zh', { limit: 4 }).split('\n')
      .filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).commands)
      .flat().filter((c) => c.name).map((c) => c.name)
    const kinds = new Set(names.map((n) => /^NAME /.test(n) ? 'planet'
      : /^CON western /.test(n) ? 'constellation'
      : /^(M|C|NGC|IC|HIP|HD) \d/.test(n) ? 'deepsky' : 'star'))
    return kinds.size === 4
  })())
check('the English few-shot block has the same replies',
  ref.toExamples('en').split('\n').filter((l) => l.startsWith('{')).length ===
  exFull.split('\n').filter((l) => l.startsWith('{')).length)

/* ------------------------------------------- 5. what other agents receive */

const json = JSON.parse(JSON.stringify(ref.toJSON()))
check('toJSON() is plain data (survives structured clone)', (() => {
  try { structuredClone(json); return true } catch (e) { return false }
})())
check('toJSON() carries the default block, the full block and both documents',
  json.prompt.zh.length > 600 && json.prompt.en.length > 600 &&
  json.promptFull.zh.length > json.prompt.zh.length * 2 &&
  json.markdown.zh.length > 4000 && json.markdown.en.length > 4000,
  { zhCompact: json.prompt.zh.length, zhFull: json.promptFull.zh.length })
check('toJSON() carries the regexes, so a caller can validate without parsing prose',
  json.grammar && Object.keys(json.grammar).length === 4 &&
  new RegExp(json.grammar.constellation).test('CON western Ori'),
  json.grammar)
check('toJSON() carries the tables another agent needs',
  json.constellations.length === 88 && json.planets.length === 10 &&
  json.stars.length === 17 && json.deepSky.length === 9 && json.corrections.length === 9)
check('the markdown document has a row per constellation',
  ref.toMarkdown('zh').split('\n').filter((l) => /^\| [A-Za-z]{2,3} \| .+ \| `CON western [A-Za-z]{3}` \|$/.test(l)).length === 88)

/* ------------------------------------ 6. the panel is wired to this file */

const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
check('manifest.json lists the reference so the loader injects it first',
  Array.isArray(manifest.references) && manifest.references.includes('naming-reference.js'),
  manifest.references)

const assistantSrc = fs.readFileSync(path.join(SRC, 'packages/assistant-web/assistant.js'), 'utf8')
check('the panel reads the reference instead of its own copy',
  assistantSrc.includes('SWE_NAMING_REFERENCE') && assistantSrc.includes('toPrompt'))
check('the panel keeps a fallback for a failed reference load',
  assistantSrc.includes('NAMING_FALLBACK'))
check('the loader can hand the reference to other agents',
  loaderSrc.includes('namingReference:') && loaderSrc.includes('features') &&
  /namingReference: true/.test(loaderSrc))

console.log('\n' + passes + ' passed, ' + failures + ' failed')
process.exit(failures === 0 ? 0 : 1)
