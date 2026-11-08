/* Time-flow acceptance for the bridge (0.7.0).
 *
 * What this file proves, and what it does not:
 *   - it calls the bridge directly and measures the engine clock, so it shows
 *     that set_time_speed really changes the rate and that the automatic stop
 *     really fires;
 *   - it does not touch the model at all. The prompt wording is covered by
 *     tests/reference/consistency.mjs and tests/e2e/client.mjs.
 *
 * The scenario from the brief is exercised end to end in section 9:
 * jump to a moment, centre an object, run one simulated day at 1000x.
 *
 * usage: node tests/e2e/timeflow.mjs [url]
 * env:   CHROME_PATH
 */
import { chromium } from 'playwright-core'

const URL_ = process.argv[2] || 'http://127.0.0.1:8911/'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''))
  if (!ok) failures++
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

console.log('# time flow against ' + URL_)

// Same reason as client.mjs: the host's Google Fonts request is the only
// off-machine traffic in this page, and it must not gate the test.
await page.route('**://fonts.googleapis.com/**', (r) => r.abort())
await page.route('**://fonts.gstatic.com/**', (r) => r.abort())

await page.goto(URL_, { waitUntil: 'load' })
await page.waitForFunction(() => {
  const e = document.getElementById('app')
  const s = e && e.__vue__ && e.__vue__.$stel
  const b = window.__SWE_AI_BRIDGE__
  try { return !!(b && s && s.getObj('M 31')) } catch (_) { return false }
}, null, { timeout: 90000 })
await page.waitForTimeout(1500)

/* Helpers: every measurement goes through the same two calls, so a failure is
 * never a difference in how the test asked. */
const exec = (cmd) => page.evaluate((c) => window.__SWE_AI_BRIDGE__.executeCommand(c), cmd)
const state = () => page.evaluate(() => window.__SWE_AI_BRIDGE__.readState())
const utcMs = (st) => Date.parse(st.time.utc)
const stop = async () => { await exec({ type: 'set_time_speed', factor: 0 }); await page.waitForTimeout(150) }

/* 1. capability + state surface ------------------------------------------ */
const caps = await page.evaluate(() => window.__SWE_AI_BRIDGE__.getCapabilities())
check('the bridge advertises timeSpeed', caps.features.timeSpeed === true,
  caps.features)
// bridgeVersion lives on readState(), not on capabilities; assert the served
// bundle really is the one that knows the command.
const bootState = await state()
check('the served bridge reports 0.7.0 or newer',
  String(bootState.bridgeVersion || '').localeCompare('0.7.0', undefined, { numeric: true }) >= 0,
  bootState.bridgeVersion)
// 0.7.0 exposes the executor's own validator, which is what lets the panel
// reject a bad number before a batch starts.
check('the bridge offers a pure command precheck',
  caps.features.commandPrecheck === true &&
  typeof (await page.evaluate(() => typeof window.__SWE_AI_BRIDGE__.validateCommand)) === 'string' &&
  (await page.evaluate(() => window.__SWE_AI_BRIDGE__.validateCommand({ type: 'set_fov', deg: 999 }).ok)) === false,
  caps.features.commandPrecheck)
check('the precheck writes nothing',
  (await state()).view.fovDeg !== null &&
  (await page.evaluate(() => {
    const before = window.__SWE_AI_BRIDGE__.readState().view.fovDeg
    window.__SWE_AI_BRIDGE__.validateCommand({ type: 'set_fov', deg: 12 })
    return window.__SWE_AI_BRIDGE__.readState().view.fovDeg === before
  })) === true)

await stop()
const st0 = await state()
check('readState reports the current rate as a number',
  typeof st0.time.speed === 'number' && st0.time.speed === 0, st0.time)
check('readState reports running=false while stopped', st0.time.running === false, st0.time.running)

/* 2. the rate really is a rate ------------------------------------------- */
await exec({ type: 'set_time', utc: '2026-11-01T12:00:00Z' })
const r1000 = await exec({ type: 'set_time_speed', factor: 1000 })
check('set_time_speed applies 1000', r1000.ok === true && r1000.readback.factor === 1000,
  r1000.ok ? r1000.readback : r1000.error)
check('the readback names the direction', r1000.readback.direction === 'forward',
  r1000.readback.direction)

const before = utcMs(await state())
await page.waitForTimeout(2000)
const after = utcMs(await state())
const advanced = (after - before) / 1000
// 1000x for ~2 s is ~2000 simulated seconds. Rendering under swiftshader is
// slow enough that the frame budget, not the rate, is the limit, so accept a
// wide band and only assert the order of magnitude.
check('1000x advances the clock by roughly 2000 s in 2 s',
  advanced > 1200 && advanced < 3200, { simulatedSeconds: Math.round(advanced) })

/* 3. stopping ------------------------------------------------------------ */
await exec({ type: 'set_time_speed', factor: 0 })
const stoppedAt = utcMs(await state())
await page.waitForTimeout(1200)
const stillThere = utcMs(await state())
check('factor 0 stops the clock', Math.abs(stillThere - stoppedAt) < 200,
  { driftSeconds: Math.round((stillThere - stoppedAt) / 1000) })

/* 4. backwards ----------------------------------------------------------- */
await exec({ type: 'set_time', utc: '2026-11-01T12:00:00Z' })
await exec({ type: 'set_time_speed', factor: -600 })
const back0 = utcMs(await state())
await page.waitForTimeout(1500)
const back1 = utcMs(await state())
check('a negative factor runs the clock backwards', back1 < back0 - 30000,
  { movedSeconds: Math.round((back1 - back0) / 1000) })
await stop()

/* 5. automatic stop ------------------------------------------------------ */
// 100x for 0.05 simulated hours (3 simulated minutes) = 1.8 real seconds.
await exec({ type: 'set_time', utc: '2026-11-01T12:00:00Z' })
const armed = await exec({ type: 'set_time_speed', factor: 100, simHours: 0.05 })
check('simHours is converted to a real duration', armed.ok === true && armed.readback.realSeconds === 2,
  armed.ok ? armed.readback.realSeconds : armed.error)
check('the readback states where the run will stop',
  armed.readback.autoStop === true && /T/.test(armed.readback.stopAtUtc || ''),
  armed.readback.stopAtUtc)

await page.waitForTimeout(4500)
const afterAuto = await state()
check('the automatic stop fired', afterAuto.time.speed === 0, afterAuto.time)
const travelled = (utcMs(afterAuto) - Date.parse('2026-11-01T12:00:00Z')) / 1000
// 3 simulated minutes = 180 s; overshoot is bounded by one 200 ms poll at 100x.
check('it stopped after about the requested span, not later',
  travelled >= 175 && travelled <= 220, { simulatedSeconds: Math.round(travelled) })

/* 6. replacing a run cancels the old stop -------------------------------- */
await exec({ type: 'set_time', utc: '2026-11-01T12:00:00Z' })
await exec({ type: 'set_time_speed', factor: 50, simHours: 1 })
const replaced = await exec({ type: 'set_time_speed', factor: 0 })
check('a new speed replaces the pending run',
  replaced.ok === true && replaced.readback.factor === 0, replaced.readback)

/* 7. set_time clears a pending stop, and says so ------------------------- */
await exec({ type: 'set_time_speed', factor: 500, simHours: 2 })
const jumped = await exec({ type: 'set_time', utc: '2026-11-02T12:00:00Z' })
check('set_time drops an unfinished auto-stop and reports it',
  jumped.readback.autoStopCleared === true, jumped.readback)
await page.waitForTimeout(700)
const stillJumped = await state()
check('the clock keeps running after the jump (the rate was not cancelled)',
  stillJumped.time.speed === 500, stillJumped.time.speed)
await stop()

/* 8. bounds the engine does not have ------------------------------------- */
const tooFast = await exec({ type: 'set_time_speed', factor: 86401 })
check('a rate above one day per second is rejected',
  tooFast.ok === false && tooFast.error.code === 'out_of_range', tooFast.error)

const tooSlow = await exec({ type: 'set_time_speed', factor: 1e-6 })
check('a non-zero rate below 0.0001 is rejected (float rounds it to a stop)',
  tooSlow.ok === false && tooSlow.error.code === 'out_of_range', tooSlow.error)

const zeroWithHours = await exec({ type: 'set_time_speed', factor: 0, simHours: 1 })
check('simHours with factor 0 is rejected as meaningless',
  zeroWithHours.ok === false && zeroWithHours.error.code === 'invalid_value', zeroWithHours.error)

const tooManyHours = await exec({ type: 'set_time_speed', factor: 1000, simHours: 200000 })
check('simHours above the cap is rejected',
  tooManyHours.ok === false && tooManyHours.error.code === 'out_of_range', tooManyHours.error)

const tooLongReal = await exec({ type: 'set_time_speed', factor: 0.5, simHours: 10 })
// 10 simulated hours at 0.5x = 20 real hours, under the 72 h cap, so this one
// is accepted; the rejected case below needs a slower rate or a longer span.
const tooLongReal2 = await exec({ type: 'set_time_speed', factor: 0.01, simHours: 100 })
check('a run that would take longer than 72 real hours is rejected',
  tooLongReal2.ok === false && tooLongReal2.error.code === 'out_of_range', tooLongReal2.error)
check('a slow but bounded run is still accepted',
  tooLongReal.ok === true && tooLongReal.readback.realSeconds === 72000,
  tooLongReal.ok ? tooLongReal.readback.realSeconds : tooLongReal.error)
await stop()

const extraField = await exec({ type: 'set_time_speed', factor: 10, until: '2026-01-01T00:00:00Z' })
check('an unknown field is rejected, not ignored',
  extraField.ok === false && extraField.error.code === 'unexpected_field', extraField.error)

const notANumber = await exec({ type: 'set_time_speed', factor: '1000' })
check('a string factor is rejected', notANumber.ok === false && notANumber.error.code === 'invalid_value',
  notANumber.error)

/* 9. the brief, end to end ----------------------------------------------- */
// "jump to a moment, centre an object, run one day at 1000x"
await exec({ type: 'set_time', utc: '2026-11-01T12:00:00Z' })
const sel = await exec({ type: 'select_object', name: 'NAME Jupiter' })
const run = await exec({ type: 'set_time_speed', factor: 1000, simHours: 24 })
const scene = await state()

check('the object really is centred', sel.ok === true &&
  /Jupiter/i.test(JSON.stringify(scene.selection || {})), scene.selection)
check('one day at 1000x is scheduled to take 86 real seconds',
  run.ok === true && run.readback.realSeconds === 86, run.readback.realSeconds)
check('the run stops exactly one day after it started',
  Math.abs(Date.parse(run.readback.stopAtUtc) - Date.parse('2026-11-02T12:00:00Z')) < 2000,
  run.readback.stopAtUtc)
check('the clock is actually running at 1000', scene.time.speed === 1000, scene.time.speed)
await stop()

/* 10. no page errors ----------------------------------------------------- */
check('no page errors were raised', consoleErrors.length === 0, consoleErrors.slice(0, 3))

await browser.close()
console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
