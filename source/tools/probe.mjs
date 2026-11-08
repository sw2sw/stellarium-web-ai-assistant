/* Probe the running host: does the engine come up, is __vue__/$stel reachable,
 * and which capability paths actually work? Prints a JSON capability report.
 *
 * usage: node tools/probe.mjs [url]
 */
import { chromium } from 'playwright-core'

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/'
const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message))

await page.goto(URL_, { waitUntil: 'load', timeout: 60000 })

// Wait for the engine to be exposed on the Vue root.
const ready = await page.waitForFunction(() => {
  const el = document.getElementById('app') || document.querySelector('.v-application')
  return !!(el && el.__vue__ && el.__vue__.$stel)
}, null, { timeout: 60000 }).then(() => true).catch(() => false)

// The sky catalogues load asynchronously; wait until a DSO resolves.
const dataReady = await page.waitForFunction(() => {
  const el = document.getElementById('app') || document.querySelector('.v-application')
  const stel = el && el.__vue__ && el.__vue__.$stel
  if (!stel) return false
  try { return !!stel.getObj('M 31') } catch (e) { return false }
}, null, { timeout: 60000 }).then(() => true).catch(() => false)

const report = await page.evaluate(([ready, dataReady]) => {
  const out = { engineReady: ready, catalogReady: dataReady }
  if (!ready) return out
  const el = document.getElementById('app') || document.querySelector('.v-application')
  const vm = el.__vue__
  const stel = vm.$stel
  out.rootElementId = el.id || el.className
  out.hasStel = !!stel
  out.hasCore = !!(stel && stel.core)
  out.hasObserver = !!(stel.core && stel.core.observer)
  out.fov = stel.core.fov
  out.utcMjd = stel.core.observer.utc
  out.lat = stel.core.observer.latitude
  out.lng = stel.core.observer.longitude

  const tryGet = (fn) => { try { return fn() } catch (e) { return '__ERR__:' + e.message } }
  out.modules = {}
  for (const name of ['atmosphere', 'constellations', 'lines', 'landscapes', 'milkyway', 'stars', 'dsos']) {
    out.modules[name] = tryGet(() => {
      const m = stel.core[name]
      if (!m) return null
      const v = m.visible
      return typeof v === 'boolean' ? v : 'no-visible'
    })
  }
  out.lines = {}
  for (const g of ['equatorial_jnow', 'azimuthal', 'meridian', 'equatorial', 'ecliptic']) {
    out.lines[g] = tryGet(() => {
      const m = stel.core.lines[g]
      return m ? m.visible : null
    })
  }
  out.constellations = tryGet(() => ({
    lines_visible: stel.core.constellations.lines_visible,
    labels_visible: stel.core.constellations.labels_visible,
    images_visible: stel.core.constellations.images_visible
  }))

  out.selectionBefore = tryGet(() => {
    const s = stel.core.selection
    return s ? s.designations()[0] : null
  })

  // Try to select a well known object and read it back.
  out.selectM31 = tryGet(() => {
    const obj = stel.getObj('M 31')
    if (!obj) return 'not found'
    stel.core.selection = obj
    const sel = stel.core.selection
    const names = sel.designations()
    const radec = sel.getInfo('radec')
    const vmag = sel.getInfo('vmag')
    return { names: names.slice(0, 4), radec, vmag, otype: sel.otype, id: sel.id }
  })

  out.selectByChineseName = tryGet(() => {
    const obj = stel.getObj('仙女座星系')
    return obj ? 'found' : 'not found'
  })

  // alt/az conversion path used by the bridge
  out.altAz = tryGet(() => {
    const sel = stel.core.selection
    const radec = sel.getInfo('radec')
    const p = stel.convertFrame(stel.core.observer, 'ICRF', 'OBSERVED', radec)
    const aa = stel.c2s(p)
    return { az: aa[0] * 180 / Math.PI, alt: aa[1] * 180 / Math.PI }
  })

  out.otypeToStr = tryGet(() => {
    const sel = stel.core.selection
    return stel.otypeToStr(sel.otype)
  })

  out.canvas = !!document.getElementById('stel-canvas')
  out.hasVueStore = !!vm.$store
  return out
}, [ready, dataReady])

report.consoleErrors = consoleErrors.slice(0, 10)

/* ---- 2. object metadata: `otype` is undefined, the code lives in jsonData */
report.objectMeta = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  const out = {}
  const t = (f) => { try { return f() } catch (e) { return '__ERR__:' + e.message } }
  out.m31 = t(() => {
    const o = stel.getObj('M 31')
    return {
      otypeProp: String(o.otype),
      typeCode: o.jsonData && o.jsonData.types && o.jsonData.types[0],
      typeName: stel.otypeToStr(o.jsonData.types[0]),
      distance: o.getInfo('distance'),
      radius: o.getInfo('radius')
    }
  })
  out.betelgeuse = t(() => {
    const o = stel.getObj('* alf Ori')
    return { names: o.designations().slice(0, 3), distance: o.getInfo('distance') }
  })
  out.sun = t(() => {
    const o = stel.getObj('NAME Sun')
    return { distance: o.getInfo('distance') }
  })
  return out
})

/* ---- 3. time: MJD round trip, then a check the round trip cannot fake --- */
await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  stel.core.observer.latitude = 39.9042 * Math.PI / 180
  stel.core.observer.longitude = 116.4074 * Math.PI / 180
  stel.core.observer.elevation = 44
  // Unix epoch is MJD 40587.0. Using 40587.5 here shifts the sky by 12 h and
  // a write/read round trip still passes — hence the sun check below.
  stel.core.observer.utc = Date.parse('2026-10-30T14:30:00.000Z') / 86400000 + 40587.0
})
await page.waitForTimeout(900)
report.time = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  const expect = Date.parse('2026-10-30T14:30:00.000Z') / 86400000 + 40587.0
  const readBack = stel.core.observer.utc
  const sun = stel.getObj('NAME Sun')
  const v = stel.convertFrame(stel.core.observer, 'ICRF', 'OBSERVED', sun.getInfo('radec'))
  return {
    expectMjd: expect,
    readBackMjd: readBack,
    deltaDays: Math.abs(readBack - expect),
    utcIso: new Date((readBack - 40587.0) * 86400000).toISOString(),
    sunAltDeg: stel.c2s(v)[1] * 180 / Math.PI,
    note: 'Beijing 22:30 local must put the sun well below the horizon'
  }
})

/* ---- 4. click-to-select: the host binds no picker ---------------------- */
const nullClears = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  stel.core.selection = stel.getObj('M 31')
  stel.core.selection = null
  const s = stel.core.selection
  return { afterNull: s ? s.designations()[0] : null, cleared: !s }
})
await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  stel.core.selection = stel.getObj('M 31')
})
await page.waitForTimeout(300)
const selBefore = await page.evaluate(() => {
  const s = document.getElementById('app').__vue__.$stel.core.selection
  return s ? s.designations()[0] : null
})
await page.mouse.click(640, 400)
await page.waitForTimeout(500)
const selAfter = await page.evaluate(() => {
  const s = document.getElementById('app').__vue__.$stel.core.selection
  return s ? s.designations()[0] : null
})
report.clickSelect = {
  nullAssignmentClearsSelection: nullClears,
  before: selBefore,
  after: selAfter,
  changed: selBefore !== selAfter,
  conclusion: 'clicking the canvas does not move core.selection; canvas.js binds no picker and core_get_obj_at is not exported'
}

/* ---- 5. catalogue coverage for teaching targets ----------------------- */
report.catalog = await page.evaluate(() => {
  const stel = document.getElementById('app').__vue__.$stel
  const t = (name) => {
    try { const o = stel.getObj(name); return o ? o.designations()[0] : null } catch (e) { return '__ERR__' }
  }
  const probes = [
    // deep sky
    'M 31', 'M 42', 'M 45', 'M 13', 'M 44', 'M 8', 'M 27', 'M 57',
    'M 51', 'M 81', 'M 104', 'M 1', 'M 7',
    // solar system and bright stars
    'NAME Sun', 'NAME Moon', 'NAME Jupiter', 'NAME Saturn', 'NAME Mars',
    'NAME Venus', 'NAME Mercury', 'NAME Uranus', 'NAME Neptune',
    'NAME Polaris', '* alf UMi', '* alf Ori', '* alf CMa', '* alf Lyr', '* alf Boo',
    // constellations
    'CON western Ori', 'CON western UMa', 'CON western Cas', 'CON western Sco',
    // things the engine is known not to resolve
    '仙女座星系', 'Andromeda Galaxy', 'orion nebula', 'm42'
  ]
  const out = { hits: {}, misses: [] }
  for (const n of probes) {
    const r = t(n)
    if (r) out.hits[n] = r
    else out.misses.push(n)
  }
  out.coverage = { probed: probes.length, hit: Object.keys(out.hits).length, miss: out.misses.length }
  out.engineVersion = typeof stel.version === 'undefined' ? 'absent' : String(stel.version)
  return out
})

console.log(JSON.stringify(report, null, 2))
await browser.close()
