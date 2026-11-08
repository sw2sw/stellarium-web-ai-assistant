/* Interaction tests: no browser, no engine, no model.
 *
 * Everything here is a PURE function over fixture data, so the deterministic
 * recommendation rules and the external-target-file schema are pinned branch
 * by branch (task book §7.4) without a running engine:
 *
 *   recommend()        day/night, twilight, below horizon, low altitude,
 *                      missing readings, no-suitable-target honesty,
 *                      southern hemisphere directions, viewing modes,
 *                      Mercury's real solar-separation window,
 *                      Uranus/Neptune never naked-eye
 *   validateTargetFile schema violations, duplicate ids, script-ish fields,
 *                      oversized strings, valid fixtures
 *   withObservations   missing engine readings stay unknown (never 0)
 *   separationDeg      geometric sanity of the solar-separation helper
 *
 * Run: node tests/interaction/run.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const failures = []

function check (name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS ' + name); return }
  fail += 1
  failures.push(name)
  console.log('FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)))
}

function section (title) {
  console.log('\n# ' + title)
}

// sky-targets.js is a classic script that publishes a bare global (the same
// shape the browser loads it with), so the test loads it exactly that way -
// a sandbox, the file text, and whatever lands on the global.
const skyRef = (() => {
  const file = path.join(HERE, '../../packages/assistant-web/sky-targets.js')
  const sandbox = { console, setTimeout, clearTimeout }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'sky-targets.js' })
  return sandbox.SWE_SKY_TARGETS
})()

/* ------------------------------------------------------------ fixtures --- */

// Entries in the shape withObservations() produces: provider metadata + an
// `obs` block that is either engine readings or null (designation the engine
// could not resolve).
function entry (id, obs) {
  const base = skyRef.builtin.targets.find((t) => t.id === id)
  return {
    id: base.id,
    designation: base.designation,
    nameZh: base.nameZh,
    nameEn: base.nameEn,
    type: base.type,
    modes: base.modes.slice(),
    difficulty: base.difficulty,
    features: base.features,
    limits: base.limits || '',
    obs: obs
  }
}

function obs (alt, az, vmag, phase) {
  return { alt, az, vmag: vmag === undefined ? null : vmag, phase: phase === undefined ? null : phase, distanceAu: null }
}

function run (entries, sunAlt, sunAz) {
  return skyRef.recommend(
    entries,
    { found: sunAlt !== null, alt: sunAlt, az: sunAz === undefined ? 180 : sunAz },
    { lang: 'zh' }
  )
}

function names (group) {
  return group.items.map((i) => i.name)
}

/* ------------------------------------------------------- recommend rules --- */

section('recommend: night, the ordinary classroom case')

{
  // 21:00 Beijing, mid-November-ish: the Moon and Jupiter well up, Saturn
  // marginal, Uranus/Neptune up (telescope-only), Mercury low near the Sun.
  const rec = run([
    entry('moon', obs(45, 130, -11, 0.42)),
    entry('jupiter', obs(55, 200, -2.1)),
    entry('saturn', obs(12, 210, 0.6)),
    entry('mars', obs(35, 150, 1.2)),
    entry('venus', obs(5, 250, -4)),
    entry('mercury', obs(8, 250, 2)),
    entry('uranus', obs(40, 180, 5.7)),
    entry('neptune', obs(38, 190, 7.8))
  ], -35)

  check('night: the Moon leads the naked-eye list',
    rec.groups.eye.items.length > 0 && rec.groups.eye.items[0].id === 'moon', names(rec.groups.eye))
  check('night: bright planets are naked-eye candidates', names(rec.groups.eye).includes('木星'), names(rec.groups.eye))
  check('night: low objects (12°) are excluded, not padded in',
    rec.excluded.some((e) => e.id === 'saturn' && e.reason === 'too_low_for_mode'), rec.excluded)
  check('night: below-horizon or near-horizon inner planets are not recommended',
    !names(rec.groups.eye).includes('金星') && !names(rec.groups.eye).includes('水星'), rec.excluded)
  check('night: Uranus is never a naked-eye pick', !names(rec.groups.eye).includes('天王星'), names(rec.groups.eye))
  check('night: Uranus/Neptune are telescope picks with honest difficulty',
    rec.groups.scope.items.some((i) => i.id === 'uranus' && i.difficulty === 'challenging'), names(rec.groups.scope))
  check('night: Saturn survives for the telescope (12° stays out of both lists by rule)',
    rec.groups.scope.items.every((i) => i.id !== 'saturn'), names(rec.groups.scope))
  check('recommend: the scope list includes the Moon too',
    rec.groups.scope.items.some((i) => i.id === 'moon'), names(rec.groups.scope))
  check('recommend: the time scope is stated, never "all night"',
    /当前/.test(rec.timeScope), rec.timeScope)
  check('recommend: sun altitude is carried for the physical cross-check',
    rec.sunAltitudeDeg === -35, rec.sunAltitudeDeg)
}

section('recommend: Mercury needs a real window, not just a clear sky')

{
  // Geometry note: with the Sun below -8° and Mercury at 15°+ altitude the
  // separation is always >= 23°, so the 15° elongation rule is belt and
  // braces; what really closes the window is twilight and daylight. These
  // cases pin the rule at its real boundaries.
  const sameAz = entry('mercury', obs(18, 250, 2))
  const open = run([sameAz], -20, 250)
  check('night Mercury over the sunset azimuth is offered with a warning',
    open.groups.eye.items.some((i) => i.id === 'mercury') &&
    open.groups.eye.items[0].limits.join('').includes('水星'), open.groups.eye)
  const twilight = run([sameAz], -5, 250)
  check('twilight Mercury is refused even with a large separation',
    twilight.excluded.some((e) => e.id === 'mercury' && e.reason === 'mercury_window_closed'), twilight.excluded)
  const nightEdge = run([entry('mercury', obs(15, 250, 2))], -8.5, 250)
  check('the darkest edge of night keeps the window open at minimal altitude',
    nightEdge.groups.eye.items.some((i) => i.id === 'mercury'), nightEdge.groups.eye)
}

section('recommend: daylight is conservative')

{
  // The Moon is placed far from the Sun (350° vs 180°, sep > 100°); a
  // near-sun daylight Moon has its own block below (R5).
  const rec = run([
    entry('moon', obs(40, 350, -10, 0.6)),
    entry('venus', obs(30, 120, -4.2)),
    entry('mercury', obs(25, 100, 0)),
    entry('jupiter', obs(60, 200, -2)),
    entry('saturn', obs(45, 210, 0.6))
  ], 40, 180)
  check('daylight: Venus and Mercury are refused outright (inner planets)',
    rec.excluded.filter((e) => e.reason === 'daylight_inner_planet').map((e) => e.id).sort().join(',') === 'mercury,venus',
    rec.excluded)
  check('daylight: other planets are refused too, conservatively',
    rec.excluded.filter((e) => e.reason === 'daytime').map((e) => e.id).sort().join(',') === 'jupiter,saturn',
    rec.excluded)
  check('daylight: the Moon stays, with its own limitation',
    rec.groups.eye.items.length === 1 && rec.groups.eye.items[0].id === 'moon' &&
    rec.groups.eye.items[0].limits.join('').includes('白天'), rec.groups.eye)
  check('daylight: nothing is fabricated when the Moon is low',
    run([entry('moon', obs(12, 180, -10, 0.6))], 40).groups.eye.items.length === 0,
    'moon 12° in daylight must not be recommended')
  const empty = run([entry('mars', obs(50, 200, 1.5))], 30)
  check('daylight with nothing suitable: the empty note is honest',
    empty.groups.eye.items.length === 0 && /没有/.test(empty.groups.eye.emptyNote), empty.groups.eye.emptyNote)

  // R5 (priority): a daylight Moon NEAR the Sun is a hard exclusion for BOTH
  // groups - being high is not being safe (thin crescent, eclipse season).
  const nearSun = run([
    entry('moon', obs(40, 200, -10, 0.05))
  ], 40, 180)
  check('daylight Moon within 20° of the Sun is refused for both groups',
    nearSun.excluded.some((e) => e.id === 'moon' && e.reason === 'moon_near_sun') &&
    nearSun.groups.eye.items.length === 0 && nearSun.groups.scope.items.length === 0,
    { excluded: nearSun.excluded, eye: nearSun.groups.eye.items })
  const sepUnknown = run([
    entry('moon', obs(40, null, -10, 0.05))
  ], 40, 180)
  check('daylight Moon with an UNKNOWN solar separation is refused (conservative)',
    sepUnknown.excluded.some((e) => e.id === 'moon' && e.reason === 'moon_near_sun_unknown'),
    sepUnknown.excluded)
  // R5 supplement: a schema-valid external file claiming id=moon with
  // designation NAME SUN must never become a Sun recommendation.
  const impostor = [{
    id: 'moon', designation: 'NAME Sun', nameZh: '月球', nameEn: 'Moon',
    type: '行星', modes: ['eye', 'scope'], difficulty: 'easy',
    features: 'x', limits: '',
    obs: { alt: 60, az: 90, vmag: -26, phase: null, distanceAu: null }
  }]
  const hijack = run(impostor, -30, 250)
  check('a NAME Sun designation claiming the Moon id is hard-excluded',
    hijack.excluded.some((e) => e.reason === 'sun_or_earth') &&
    hijack.groups.eye.items.length === 0 && hijack.groups.scope.items.length === 0,
    hijack.excluded)
}

section('recommend: horizon, altitude and geometry')

{
  const rec = run([
    entry('moon', obs(-15, 120, -11, 0.5)),
    entry('jupiter', obs(9, 200, -2.1)),
    entry('mars', obs(18, 200, 1.2))
  ], -30)
  check('below the horizon is geometry, not a recommendation',
    rec.excluded.some((e) => e.id === 'moon' && e.reason === 'below_horizon'), rec.excluded)
  check('below 10° is refused outright',
    rec.excluded.some((e) => e.id === 'jupiter' && e.reason === 'too_low'), rec.excluded)
  check('a healthy altitude is recommended',
    rec.groups.eye.items.map((i) => i.id).join(',') === 'mars', rec.groups.eye)
}

section('recommend: missing readings stay unknown, never 0')

{
  const rec = run([
    entry('mars', obs(30, 200, null)),
    entry('jupiter', obs(30, 210, -2)),
    entry('saturn', obs(28, 190, 0.6))
  ], -25)
  const marsEye = rec.groups.eye.items.find((i) => i.id === 'mars')
  check('a missing magnitude keeps the item with an explicit note',
    !!marsEye && marsEye.magnitude === null && marsEye.limits.join('').includes('亮度读数缺失'), marsEye)
  const noObs = [entry('moon', null), entry('jupiter', obs(30, 210, -2))]
  const rec2 = run(noObs, -25)
  check('a designation the engine cannot resolve is reported, not invented',
    rec2.excluded.some((e) => e.id === 'moon' && e.reason === 'not_found') &&
    rec2.groups.eye.items.every((i) => i.id !== 'moon'), rec2.excluded)
  const noSun = run([entry('jupiter', obs(30, 210, -2))], null)
  check('a missing Sun reading stops recommendations instead of guessing day/night',
    noSun.excluded.some((e) => e.reason === 'no_sun_reading'), noSun.excluded)
}

section('recommend: viewing modes and hemisphere neutrality')

{
  const rec = run([entry('uranus', obs(50, 180, 5.7)), entry('neptune', obs(48, 190, 7.8))], -25)
  check('Uranus/Neptune up does not make a naked-eye list',
    rec.groups.eye.items.length === 0 && /没有/.test(rec.groups.eye.emptyNote), rec.groups.eye)
  check('the telescope list still offers them',
    rec.groups.scope.items.length === 2, names(rec.groups.scope))

  const south = run([entry('jupiter', obs(45, 10, -2.1))], -25)
  check('azimuth direction names work on either hemisphere (10° = 北/N)',
    south.groups.eye.items[0].direction === '北', south.groups.eye.items[0])
  const en = skyRef.recommend(
    [entry('jupiter', obs(45, 10, -2.1))],
    { found: true, alt: -25, az: 180 }, { lang: 'en' })
  check('the English facet renders English names and directions',
    en.groups.eye.items[0].name === 'Jupiter' && en.groups.eye.items[0].direction === 'N', en.groups.eye.items[0])
}

section('recommend: determinism')

{
  const input = [entry('moon', obs(40, 130, -11, 0.42)), entry('jupiter', obs(55, 200, -2.1))]
  const a = skyRef.recommend(input, { found: true, alt: -35, az: 250 }, { lang: 'zh' })
  const b = skyRef.recommend(input, { found: true, alt: -35, az: 250 }, { lang: 'zh' })
  check('same input, same output (byte-identical JSON)',
    JSON.stringify(a) === JSON.stringify(b))
}

/* ------------------------------------------------------- R2/R10/C1 --- */

section('R2: distances keep significant digits, never collapse to zero')

{
  const rec = run([
    entry('moon', { alt: 45, az: 130, vmag: -11, phase: 0.42, distanceAu: 0.00257 }),
    entry('neptune', { alt: 38, az: 190, vmag: 7.8, phase: null, distanceAu: 29.146 })
  ], -35)
  const moon = rec.groups.eye.items[0]
  check('the Moon at 0.0026 AU keeps three significant digits (not 0)',
    moon.distanceAu === 0.00264 || (moon.distanceAu > 0.0025 && moon.distanceAu < 0.0028),
    moon.distanceAu)
  check('the Moon distance is NOT rounded to zero',
    moon.distanceAu !== 0 && moon.distanceAu !== null, moon.distanceAu)
  const far = rec.groups.scope.items.find((i) => i.id === 'neptune')
  check('a far planet keeps meaningful precision too',
    far && far.distanceAu !== null && far.distanceAu >= 29 && far.distanceAu < 30, far && far.distanceAu)
  const noDist = run([entry('moon', obs(45, 130, -11, 0.42))], -35)
  void noDist
  check('a missing distance stays null',
    skyRef.withObservations(skyRef.builtin.targets, {
      'NAME Moon': { found: true, alt: 45, az: 130, vmag: -11, phase: 0.42, distanceAu: null }
    })[0].obs.distanceAu === null)
}

section('R10: the two viewing modes are evaluated independently')

{
  // A dual-mode target too faint for the naked eye (vmag 5.5, Uranus-like)
  // must still reach the telescope list.
  const faint = {
    id: 'dual', designation: 'NAME Uranus', nameZh: '天王星', nameEn: 'Uranus',
    type: '行星', modes: ['eye', 'scope'], difficulty: 'challenging',
    features: 'x', limits: '',
    obs: { alt: 50, az: 180, vmag: 5.5, phase: null, distanceAu: null }
  }
  const rec = skyRef.recommend([faint], { found: true, alt: -25, az: 250 }, { lang: 'zh' })
  check('naked-eye too faint: the eye list skips it',
    rec.groups.eye.items.length === 0, rec.groups.eye)
  check('naked-eye too faint: the scope list still evaluates it',
    rec.groups.scope.items.length === 1 && rec.groups.scope.items[0].id === 'dual', rec.groups.scope)
  check('the eye rejection is recorded as its own decision',
    rec.excluded.some((e) => e.id === 'dual' && e.reason === 'too_faint_for_eye'), rec.excluded)
}

section('C1: whitespace designations resolve through trimmed lookup')

{
  const targets = [{
    id: 'saturn-ws', designation: '  NAME Saturn  ', nameZh: '土星（带空白）',
    nameEn: 'Saturn', type: '行星', modes: ['eye', 'scope'], difficulty: 'easy',
    features: 'x', limits: ''
  }]
  // The caller indexes readings by the TRIMMED query string it actually sent.
  const merged = skyRef.withObservations(targets, {
    'NAME Saturn': { found: true, alt: 30, az: 200, vmag: 0.6, phase: null, distanceAu: 8.6 }
  })
  check('a file designation with acceptable whitespace still finds its reading',
    merged[0].obs !== null && merged[0].obs.alt === 30, merged[0])
  const rec = skyRef.recommend(merged, { found: true, alt: -25, az: 250 }, { lang: 'zh' })
  check('the whitespace designation is recommended as Saturn, not lost as not_found',
    rec.groups.eye.items.length === 1 && rec.groups.eye.items[0].name === '土星（带空白）',
    { eye: rec.groups.eye.items, excluded: rec.excluded })
  // And the engine-identity normalization still applies to it: renaming the
  // Sun through whitespace does not sneak past the hard exclusion.
  const sunFile = [{
    id: 'x', designation: '  name sun  ', nameZh: '假月球', nameEn: 'fake',
    type: '行星', modes: ['eye', 'scope'], difficulty: 'easy',
    features: 'x', limits: '',
    obs: { alt: 60, az: 90, vmag: -26, phase: null, distanceAu: null }
  }]
  const hijack = skyRef.recommend(sunFile, { found: true, alt: -30, az: 250 }, { lang: 'zh' })
  check('whitespace around "name sun" does not bypass the hard exclusion',
    hijack.excluded.some((e) => e.reason === 'sun_or_earth'), hijack.excluded)
}

section('R5: reserved ids and canonical engine identity')

{
  // A provider id is metadata, never an identity. An external file claiming
  // a builtin id is refused at load, whatever designation it pairs with.
  const fakeMoon = {
    schemaVersion: 1, source: { name: 'x' },
    targets: [{
      id: 'moon', designation: 'NAME Venus', nameZh: '假月球', nameEn: 'Fake Moon',
      type: '行星', modes: ['eye', 'scope'], difficulty: 'easy', features: 'x'
    }]
  }
  const v = skyRef.validateTargetFile(fakeMoon)
  check('an external file claiming a reserved id is refused (Venus dressed as moon)',
    v.ok === false && /reserved/.test(v.errors.join('')), v.errors)
  const sameDesig = skyRef.validateTargetFile({
    schemaVersion: 1, source: { name: 'x' },
    targets: [Object.assign({}, fakeMoon.targets[0], { designation: 'NAME Moon' })]
  })
  check('a reserved id is refused even when the designation matches the id',
    sameDesig.ok === false && /reserved/.test(sameDesig.errors.join('')), sameDesig.errors)
  const dupBuiltin = skyRef.validateTargetFile({
    schemaVersion: 1, source: { name: 'x' },
    targets: [{
      id: 'deep-moon', designation: '  name moon  ', nameZh: '月球（外部）', nameEn: 'Moon (ext)',
      type: '卫星', modes: ['eye'], difficulty: 'easy', features: 'x'
    }]
  })
  check('a designation duplicating a builtin target is refused across providers',
    dupBuiltin.ok === false && /duplicates builtin/.test(dupBuiltin.errors.join('')), dupBuiltin.errors)
}

{
  // Runtime belt (R5): whatever a file claimed, the safety class follows the
  // engine's resolved identity. A "moon" that resolved to Venus IS Venus.
  const fakeMoonEntry = {
    id: 'moon', designation: 'NAME Venus', nameZh: '假月球', nameEn: 'Fake Moon',
    type: '行星', modes: ['eye', 'scope'], difficulty: 'easy',
    features: 'x', limits: '',
    engineDesignation: 'NAME Venus', engineNames: ['NAME Venus', 'Venus'],
    obs: { alt: 45, az: 120, vmag: -4.2, phase: 0.7, distanceAu: 0.5 }
  }
  const day = skyRef.recommend([fakeMoonEntry], { found: true, alt: 30, az: 100 }, { lang: 'zh' })
  check('a fake moon that resolves to Venus is excluded from BOTH groups in daylight',
    day.groups.eye.items.length === 0 && day.groups.scope.items.length === 0 &&
    day.excluded.some((e) => e.id === 'moon' && e.reason === 'daylight_inner_planet'),
    { eye: day.groups.eye.items, scope: day.groups.scope.items, excluded: day.excluded })

  // The same trick cannot open the Mercury window: canonical Mercury obeys
  // the Mercury rules - in twilight the window is closed, period.
  const fakeMercury = {
    id: 'moon', designation: 'NAME Mercury', nameZh: '假月球', nameEn: 'Fake Moon',
    type: '行星', modes: ['eye', 'scope'], difficulty: 'easy',
    features: 'x', limits: '',
    engineDesignation: 'NAME Mercury', engineNames: ['NAME Mercury', 'Mercury'],
    obs: { alt: 25, az: 260, vmag: 0.1, phase: null, distanceAu: 0.9 }
  }
  const twilight = skyRef.recommend([fakeMercury], { found: true, alt: -5, az: 250 }, { lang: 'zh' })
  check('a fake moon that resolves to Mercury still obeys the Mercury window',
    twilight.groups.eye.items.length === 0 && twilight.groups.scope.items.length === 0 &&
    twilight.excluded.some((e) => e.reason === 'mercury_window_closed'),
    { excluded: twilight.excluded, eye: twilight.groups.eye.items })

  // And the real Moon through an alias keeps its own protections: the class
  // comes from the engine identity, not from the queried string.
  const luna = {
    id: 'ext-luna', designation: 'Luna', nameZh: '月球（别名）', nameEn: 'Moon (alias)',
    type: '卫星', modes: ['eye', 'scope'], difficulty: 'easy',
    features: 'x', limits: '',
    engineDesignation: 'NAME Moon', engineNames: ['NAME Moon', 'Moon', 'Luna'],
    obs: { alt: 40, az: 90, vmag: -10, phase: 0.2, distanceAu: 0.0026 }
  }
  const dayLuna = skyRef.recommend([luna], { found: true, alt: 30, az: 90 }, { lang: 'zh' })
  check('the Moon through an alias still gets the near-Sun exclusion in daylight',
    dayLuna.groups.eye.items.length === 0 &&
    dayLuna.excluded.some((e) => e.id === 'ext-luna' && e.reason === 'moon_near_sun'),
    { excluded: dayLuna.excluded })
}

/* --------------------------------------------------- separation helper --- */

section('separationDeg: geometry sanity')

{
  check('same point is 0° apart', skyRef.separationDeg({ alt1: 30, az1: 100, alt2: 30, az2: 100 }) < 1e-9)
  check('a point 30° up versus the zenith is 60° apart',
    Math.abs(skyRef.separationDeg({ alt1: 30, az1: 0, alt2: 90, az2: 0 }) - 60) < 1e-6)
  check('two 30°-high points on opposite azimuths are 120° apart',
    Math.abs(skyRef.separationDeg({ alt1: 30, az1: 0, alt2: 30, az2: 180 }) - 120) < 1e-6)
  check('opposite horizon points are 180° apart', Math.abs(skyRef.separationDeg({ alt1: 0, az1: 0, alt2: 0, az2: 180 }) - 180) < 1e-6)
  check('null inputs give null, not 0',
    skyRef.separationDeg({ alt1: 30, az1: 100, alt2: null, az2: 100 }) === null)
}

/* ------------------------------------------------ external file schema --- */

section('validateTargetFile: the builtin provider passes its own schema')

{
  const v = skyRef.validateTargetFile(skyRef.builtin, true)
  check('builtin Moon-and-planets provider validates', v.ok === true, v.errors)
}

section('validateTargetFile: a valid external file loads')

{
  const doc = {
    schemaVersion: 1,
    source: { name: '测试精选（夹具）', version: '0', reference: 'tests/fixtures' },
    targets: [
      {
        id: 'm45', designation: 'M 45', nameZh: '昴星团', nameEn: 'Pleiades',
        type: '疏散星团', modes: ['eye', 'scope'], difficulty: 'easy',
        features: '肉眼看是一小团蓝白色星；小望远镜里成员星更多。',
        limits: ''
      }
    ]
  }
  const v = skyRef.validateTargetFile(doc)
  check('a minimal curated file is accepted', v.ok === true, v.errors)
  const bad = skyRef.validateTargetFile(Object.assign({}, doc, { schemaVersion: 2 }))
  check('a wrong schemaVersion is refused', bad.ok === false && /schemaVersion/.test(bad.errors.join('')), bad.errors)
}

section('validateTargetFile: data-only, strictly')

{
  const base = {
    schemaVersion: 1,
    source: { name: 'x' },
    targets: [{
      id: 'a1', designation: 'M 1', nameZh: '甲', nameEn: 'A', type: '星云',
      modes: ['eye'], difficulty: 'easy', features: 'x'
    }]
  }
  const dup = skyRef.validateTargetFile({
    schemaVersion: 1, source: { name: 'x' },
    targets: [base.targets[0], Object.assign({}, base.targets[0])]
  })
  check('duplicate ids are refused', dup.ok === false && dup.errors.join('').includes('id duplicates'), dup.errors)
  const dupDesig = skyRef.validateTargetFile({
    schemaVersion: 1, source: { name: 'x' },
    targets: [base.targets[0], Object.assign({}, base.targets[0], { id: 'a2' })]
  })
  check('duplicate designations are refused', dupDesig.ok === false && dupDesig.errors.join('').includes('designation duplicates'), dupDesig.errors)
  const scripty = skyRef.validateTargetFile({
    schemaVersion: 1, source: { name: 'x' },
    targets: [Object.assign({ onload: 'alert(1)' }, base.targets[0])]
  })
  check('unexpected fields (a smuggled script) are refused',
    scripty.ok === false && scripty.errors.join('').includes('onload'), scripty.errors)
  const badMode = skyRef.validateTargetFile({
    schemaVersion: 1, source: { name: 'x' },
    targets: [Object.assign({}, base.targets[0], { modes: ['camera'] })]
  })
  check('modes outside eye|scope are refused', badMode.ok === false, badMode.errors)
  const long = skyRef.validateTargetFile({
    schemaVersion: 1, source: { name: 'x' },
    targets: [Object.assign({}, base.targets[0], { features: 'x'.repeat(401) })]
  })
  check('oversized text fields are refused', long.ok === false && /features/.test(long.errors.join('')), long.errors)
  const empty = skyRef.validateTargetFile({ schemaVersion: 1, source: { name: 'x' }, targets: [] })
  check('an empty targets array is refused', empty.ok === false, empty.errors)
  check('an array or null is refused, not parsed',
    skyRef.validateTargetFile([]).ok === false && skyRef.validateTargetFile(null).ok === false)
}

/* -------------------------------------------------- withObservations --- */

section('withObservations: provider metadata meets engine readings')

{
  const targets = [skyRef.builtin.targets[0], skyRef.builtin.targets[4]] // moon, jupiter
  const merged = skyRef.withObservations(targets, {
    'NAME Moon': { found: true, alt: 40, az: 130, vmag: -11, phase: 0.42 },
    'NAME Jupiter': { found: false }
  })
  check('resolved designations carry readings', merged[0].obs && merged[0].obs.alt === 40 && merged[0].obs.phase === 0.42, merged[0])
  check('phase outside [0,1] is treated as unknown', skyRef.withObservations(targets, {
    'NAME Moon': { found: true, alt: 40, az: 130, vmag: -11, phase: 3 }
  })[0].obs.phase === null)
  check('an unresolved designation stays in the list with obs: null', merged[1].obs === null, merged[1])
}

/* -------------------------------------------------------------- report --- */

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
if (fail) {
  console.log('failed:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
