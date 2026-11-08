/* Stellarium Web AI Teaching Assistant - host adapter
 * Copyright (c) 2026 - project contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is the ONLY entry point injected into the Stellarium Web host.
 * It has two jobs:
 *   1. expose a small, versioned bridge to the host engine ($stel);
 *   2. load the assistant bundle described by manifest.json.
 *
 * Design rules (see docs/FEASIBILITY.md):
 *   - never throw into the host: a broken assistant must not blank the sky map;
 *   - never create a second engine instance;
 *   - the assistant is plain JS/CSS, so replacing those files + reloading the
 *     page is enough to update it. No host rebuild, no WASM rebuild.
 *
 * Control contract (review items A4/A5/A6):
 *   - a write is never reported as done just because the call did not throw;
 *     every command reads the engine back and only reports `applied` when the
 *     observed value matches what was asked for;
 *   - animated commands (lock-to-object, zoom) report `applied` only once the
 *     view has settled, otherwise `timeout` — never a silent success;
 *   - `executeCommand` is async for exactly this reason;
 *   - time input must carry an explicit timezone (Z or ±HH:MM).
 */
(function () {
  'use strict'

  var LOADER_VERSION = '0.11.0'
  var PROTOCOL_VERSION = 2
  var GLOBAL_KEY = '__SWE_AI_BRIDGE__'
  var PANEL_ATTR = 'data-swe-assistant'

  if (window[GLOBAL_KEY]) return

  var scriptEl = document.currentScript
  var baseUrl
  try {
    baseUrl = new URL('.', (scriptEl && scriptEl.src) || window.location.href).href
  } catch (e) {
    baseUrl = window.location.href.replace(/[^/]*$/, '')
  }

  /* ---------------------------------------------------------------- utils */

  function safe (fn, fallback) {
    try {
      var r = fn()
      return r === undefined ? fallback : r
    } catch (e) {
      return fallback
    }
  }

  // Unlike safe(), this keeps the error so a caller can report a real failure.
  function attempt (fn) {
    try { return { ok: true, value: fn() } } catch (e) { return { ok: false, error: e } }
  }

  function log (level, msg, err) {
    if (window.console && console[level]) {
      console[level]('[swe-assistant] ' + msg, err || '')
    }
  }

  function isoNow () { return new Date().toISOString() }

  function waitUntil (predicate, timeoutMs) {
    var started = Date.now()
    return new Promise(function (resolve) {
      ;(function tick () {
        var ok = false
        try { ok = !!predicate() } catch (e) { ok = false }
        if (ok) return resolve({ settled: true, waitedMs: Date.now() - started })
        if (Date.now() - started >= timeoutMs) {
          return resolve({ settled: false, waitedMs: Date.now() - started })
        }
        setTimeout(tick, 40)
      })()
    })
  }

  /* ------------------------------------------------------- engine access */

  var cached = { stel: null, core: null, modules: {} }

  function findVueRoot () {
    var els = [
      document.getElementById('app'),
      document.querySelector('.v-application'),
      document.querySelector('#stel')
    ]
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el && el.__vue__) return el.__vue__
    }
    return null
  }

  function getStel () {
    if (cached.stel) return cached.stel
    var vm = findVueRoot()
    if (!vm) return null
    var stel = safe(function () { return vm.$stel }, null)
    if (!stel || !safe(function () { return stel.core }, null)) return null
    cached.stel = stel
    cached.core = stel.core
    return stel
  }

  function mod (name) {
    if (cached.modules[name]) return cached.modules[name]
    var stel = getStel()
    if (!stel) return null
    var m = safe(function () { return stel.core[name] }, null)
    if (m) cached.modules[name] = m
    return m
  }

  function childMod (parentName, childName) {
    var key = parentName + '.' + childName
    if (cached.modules[key]) return cached.modules[key]
    var p = mod(parentName)
    if (!p) return null
    var m = safe(function () { return p[childName] }, null)
    if (m) cached.modules[key] = m
    return m
  }

  function readBool (obj) {
    if (!obj) return null
    var v = safe(function () { return obj.visible }, null)
    return typeof v === 'boolean' ? v : null
  }

  /* ---------------------------------------------------------- geometry */

  var D2R = Math.PI / 180
  var R2D = 180 / Math.PI
  // MJD of the Unix epoch (1970-01-01T00:00:00Z). The host uses the same
  // constant (sw_helpers.js getMJD): t/86400000 + 2440587.5 - 2400000.5.
  var MJD_UNIX_EPOCH = 40587.0

  function altAzOf (stel, radec) {
    if (!radec || radec.length < 3) return null
    return safe(function () {
      var obs = stel.core.observer
      var p = stel.convertFrame(obs, 'ICRF', 'OBSERVED', radec)
      var aa = stel.c2s(p)
      return { az: stel.anp(aa[0]) * R2D, alt: stel.anpm(aa[1]) * R2D }
    }, null)
  }

  function angularDiffDeg (a, b) {
    var d = ((a - b) % 360 + 540) % 360 - 180
    return Math.abs(d)
  }

  /* ------------------------------------------------------ state reading */

  function pickDisplayName (names) {
    var i
    for (i = 0; i < names.length; i++) {
      var n = names[i]
      if (!n) continue
      if (n.indexOf('NAME ') === 0 || n.indexOf('CON ') === 0) continue
      return n
    }
    if (names.length && names[0]) {
      return names[0].replace(/^(NAME|CON) /, '')
    }
    return null
  }

  function describeObject (stel, obj) {
    if (!obj) return null
    var names = safe(function () { return obj.designations() }, []) || []
    // getInfo('radec') returns a 4d cartesian unit vector, not angles.
    var radec = safe(function () { return obj.getInfo('radec') }, null)
    var vmag = safe(function () { return obj.getInfo('vmag') }, null)
    var dist = safe(function () { return obj.getInfo('distance') }, null)
    var radius = safe(function () { return obj.getInfo('radius') }, null)
    // Illuminated fraction, engine-computed (0..1). Real for the Moon and the
    // planets; null for the Sun and absent for deep-sky objects. It is the
    // engine's own number, never a phase the caller may reconstruct.
    var phase = safe(function () { return obj.getInfo('phase') }, null)
    var json = safe(function () { return obj.jsonData }, null)

    // The engine does not expose `otype` as a JS property; the type code lives
    // in the object's JSON data (e.g. ["G","?"] for a galaxy).
    var types = (json && json.types) || []
    var otype = types.length ? types[0] : null
    var otypeName = otype ? safe(function () { return stel.otypeToStr(otype) }, null) : null

    var angles = radec ? safe(function () { return stel.c2s(radec) }, null) : null
    var aa = altAzOf(stel, radec)

    return {
      id: safe(function () { return obj.id }, null),
      designation: names.length ? names[0] : null,
      displayName: pickDisplayName(names),
      names: names.slice(0, 12),
      otype: otype || null,
      otypeName: otypeName || null,
      model: (json && json.model) || null,
      vmag: typeof vmag === 'number' && isFinite(vmag) ? vmag : null,
      ra: angles ? angles[0] : null,
      dec: angles ? angles[1] : null,
      az: aa ? aa.az : null,
      alt: aa ? aa.alt : null,
      distanceAu: typeof dist === 'number' && isFinite(dist) ? dist : null,
      radiusDeg: typeof radius === 'number' && isFinite(radius) ? radius * R2D : null,
      // 0.11.0: engine-computed illuminated fraction (0..1) or null. Unknown
      // stays null; it is never filled in from memory.
      phase: typeof phase === 'number' && isFinite(phase) && phase >= 0 && phase <= 1 ? phase : null,
      // Which fields the engine actually returned; unknown ones stay null.
      source: 'engine'
    }
  }

  function readLayers () {
    var con = mod('constellations')
    return {
      atmosphere: readBool(mod('atmosphere')),
      constellation_lines: con ? safe(function () { return con.lines_visible }, null) : null,
      constellation_labels: con ? safe(function () { return con.labels_visible }, null) : null,
      constellation_images: con ? safe(function () { return con.images_visible }, null) : null,
      landscape: readBool(mod('landscapes')),
      milkyway: readBool(mod('milkyway')),
      stars: readBool(mod('stars')),
      dsos: readBool(mod('dsos')),
      equatorial_grid: readBool(childMod('lines', 'equatorial_jnow')),
      azimuthal_grid: readBool(childMod('lines', 'azimuthal')),
      meridian: readBool(childMod('lines', 'meridian'))
    }
  }

  var revision = 1
  var snapshotCounter = 1
  var viewId = 'view-' + Math.random().toString(36).slice(2, 10)
  var lastSignature = null

  function readState () {
    var stel = getStel()
    if (!stel) return null
    var core = stel.core
    var obs = safe(function () { return core.observer }, null)
    var mjd = obs ? safe(function () { return obs.utc }, null) : null
    var sel = safe(function () { return core.selection }, null)

    var layers = safe(readLayers, {}) || {}

    return {
      protocolVersion: PROTOCOL_VERSION,
      bridgeVersion: LOADER_VERSION,
      host: {
        commit: window.__SWE_HOST_COMMIT__ || 'unknown',
        engineLoaded: true
      },
      viewId: viewId,
      revision: revision,
      snapshotId: snapshotCounter,
      readAt: isoNow(),
      time: mjd === null
        ? null
        : {
            mjd: mjd,
            utc: new Date((mjd - MJD_UNIX_EPOCH) * 86400000).toISOString(),
            // 0 = paused, 1 = real time, N = N times real time. Negative runs
            // backwards. The panel and any other agent need this to know
            // whether the clock is currently moving.
            speed: safe(function () { return core.time_speed }, null),
            running: safe(function () { return core.time_speed !== 0 }, null),
            // How many times the clock was moved discontinuously: the host's
            // own time panel, a keyboard shortcut, another page, or a set_time
            // command - the counter does not say which. Monotonic, so a reader
            // only has to compare two reads, and it knows whether it issued a
            // set_time itself. A running clock is not a jump; see the clock
            // watch below.
            jumps: timeJumpSeq,
            source: 'engine'
          },
      location: obs
        ? {
            lat: safe(function () { return obs.latitude * R2D }, null),
            lng: safe(function () { return obs.longitude * R2D }, null),
            elevation: safe(function () { return obs.elevation }, null),
            source: 'engine'
          }
        : null,
      view: {
        fovDeg: safe(function () { return core.fov * R2D }, null),
        yawDeg: obs ? safe(function () { return obs.yaw * R2D }, null) : null,
        pitchDeg: obs ? safe(function () { return obs.pitch * R2D }, null) : null
      },
      layers: layers,
      selection: describeObject(stel, sel)
    }
  }

  /* -------------------------------------------------- change detection */

  // Everything that changes what a teacher would say about the current sky.
  // Time is quantised to 10 s so a running clock does not bump the revision on
  // every frame, while a real edit (minutes, hours) always does.
  function observableSignature (st) {
    if (!st) return null
    var t = st.time ? Math.round(st.time.mjd * 8640) : null
    return [
      t,
      st.location ? Math.round(st.location.lat * 1e4) : null,
      st.location ? Math.round(st.location.lng * 1e4) : null,
      st.location && st.location.elevation !== null ? Math.round(st.location.elevation) : null,
      st.view.fovDeg === null ? null : Math.round(st.view.fovDeg * 100),
      st.view.yawDeg === null ? null : Math.round(st.view.yawDeg * 10),
      st.view.pitchDeg === null ? null : Math.round(st.view.pitchDeg * 10),
      st.selection ? (st.selection.id || st.selection.designation) : null,
      JSON.stringify(st.layers)
    ].join('|')
  }

  var selectionSubs = []
  var stateSubs = []

  function broadcast () {
    var st = safe(readState, null)
    if (!st) return
    for (var i = 0; i < stateSubs.length; i++) {
      safe(function () { stateSubs[i](st) })
    }
  }

  function broadcastSelection (sel, st) {
    for (var i = 0; i < selectionSubs.length; i++) {
      safe(function () { selectionSubs[i](sel, st) })
    }
  }

  function bump (reason) {
    revision += 1
    snapshotCounter += 1
  }

  // Polls the engine and publishes a new revision whenever anything that
  // affects the teaching snapshot changed — including changes the user made
  // through the host's own UI, and the natural passage of time.
  var watcher = null
  function startWatcher () {
    if (watcher) return
    lastSignature = observableSignature(safe(readState, null))
    watcher = setInterval(function () {
      var st = safe(readState, null)
      if (!st) return
      var sig = observableSignature(st)
      if (sig === lastSignature) return
      lastSignature = sig
      bump('observed-change')
      st = safe(readState, null) || st
      broadcast()
      broadcastSelection(st.selection, st)
    }, 500)
  }

  /* ------------------------------------------- the clock's continuity */

  // A teacher can jump the clock from the host's own time controls while a
  // plan is running, and the panel has to notice before it applies the rest of
  // the plan to a sky nobody asked about. Comparing the time before a command
  // with the time after it cannot do that: at 3600x one second of wall time is
  // an hour of sky, so any allowance wide enough to cover "the command itself
  // changed the rate somewhere in there" is also wide enough to hide a real
  // jump. Watching the clock frame by frame turns the question into "did this
  // single frame move further than its own rate explains", where the allowance
  // is one frame of sky - small enough for a jump to stand out.
  //
  // The counter says the clock was moved, not who moved it: a set_time issued
  // through this bridge counts exactly like the host's own time panel. A
  // reader that issued one knows it did and skips the check for that command;
  // a reader that did not is looking at somebody else's jump. Naming the
  // writer here would have to guess which caller counts as "us", and every
  // guess that got it wrong would hide a real jump - so the only special case
  // is the write this bridge performs itself, which it can see directly
  // (noteClockWrite below).
  var timeJumpSeq = 0
  var clockWatching = false
  var clockLast = null

  // The engine writes observer.utc once per animation frame, so a sample taken
  // anywhere else is up to one frame stale. The floor covers that staleness
  // plus a second; a step has to be bigger than a couple of frames of sky to
  // be called a jump, which at 3600x is about a minute of simulated time.
  var JUMP_FLOOR_SEC = 2
  var JUMP_FRAME_SLACK_SEC = 0.05
  // A frame that took longer than this tells us nothing: the tab was probably
  // in the background, and the engine may have clamped its own step. Drop the
  // sample and start again from the new one.
  var JUMP_MAX_STEP_SEC = 0.25

  function clockNow () {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now()
  }

  function clockSample (stel) {
    var obs = safe(function () { return stel.core.observer }, null)
    var mjd = obs ? safe(function () { return obs.utc }, null) : null
    var speed = safe(function () { return stel.core.time_speed }, null)
    if (typeof mjd !== 'number' || typeof speed !== 'number') return null
    return { mjd: mjd, speed: speed, at: clockNow() }
  }

  // Did the sky move further across one segment of wall time than the rate it
  // ran at can explain?
  function clockJumped (prev, cur) {
    if (!prev) return false
    var dt = (cur.at - prev.at) / 1000
    if (!(dt > 0) || dt > JUMP_MAX_STEP_SEC) return false
    var moved = (cur.mjd - prev.mjd) * 86400
    var lo = Math.min(prev.speed, cur.speed) * dt
    var hi = Math.max(prev.speed, cur.speed) * dt
    var tol = JUMP_FLOOR_SEC + JUMP_FRAME_SLACK_SEC * Math.max(Math.abs(prev.speed), Math.abs(cur.speed))
    return moved < lo - tol || moved > hi + tol
  }

  function countJump (movedSec) {
    timeJumpSeq += 1
    log('info', 'clock jumped by ' + movedSec.toFixed(1) + 's of simulated time')
  }

  function clockTick () {
    if (!clockWatching) return
    requestAnimationFrame(clockTick)
    var stel = getStel()
    if (!stel) { clockLast = null; return }
    var cur = clockSample(stel)
    if (!cur) { clockLast = null; return }
    var prev = clockLast
    clockLast = cur
    if (clockJumped(prev, cur)) countJump((cur.mjd - prev.mjd) * 86400)
  }

  // A set_time through this bridge moves the clock at a single instant, from
  // inside the command. Left to the next frame that write looks like a jump -
  // the segment before it and the sample after it span wall time the clock
  // never ran through - and the frame that reports it runs after the command
  // returned, i.e. after the caller has already re-anchored its context. A
  // batch of "set the date, then animate" would then be stopped by its own
  // first command, at its second one.
  //
  // So the move is counted here, before the command returns, and the frame
  // baseline is rebased onto the value just written. Counting rather than
  // hiding keeps one rule for every writer: whichever command moved the clock
  // owns the jump, and a caller exempts its own command's field by name.
  // Nothing else is rebased, so any other writer's jump still stands.
  function noteClockWrite (stel, beforeMjd, afterMjd) {
    if (!clockWatching) return
    if (typeof beforeMjd === 'number' && typeof afterMjd === 'number') {
      var movedSec = (afterMjd - beforeMjd) * 86400
      if (isFinite(movedSec) && Math.abs(movedSec) > JUMP_FLOOR_SEC) countJump(movedSec)
    }
    clockLast = clockSample(stel)
  }

  function startClockWatch () {
    if (clockWatching) return
    clockWatching = true
    clockLast = null
    requestAnimationFrame(clockTick)
  }

  function stopClockWatch () {
    clockWatching = false
    clockLast = null
  }

  /* ------------------------------------------------------- target names */

  // The engine has no name-resolution layer. `getObj(q)` is `core_search(q)`,
  // which walks every instantiated object and compares `q` with each of its
  // designations using strcasecmp, returning the first exact match. Measured
  // consequences (docs/OBJECT-NAMING.md has the raw evidence):
  //
  //   * letter case is ignored      'm 42', 'NAME jupiter', '* ALF ori' all hit
  //   * spacing is NOT ignored      'M42', 'M  42', 'M 42 ' all miss
  //   * no fuzzy match, no prefix match, no Chinese, no candidate list
  //
  // and each object family uses a different designation shape:
  //
  //   planets     NAME Jupiter      bare 'Jupiter' does not exist
  //   stars       Sirius, * alf Ori 'NAME Sirius' fails
  //   deep sky    M 31, NGC 7000    'M31' fails
  //   constellations  CON western Ori   bare 'Ori' and 'Orion' fail
  //
  // So the bridge maps what a teacher (or a model) actually writes onto the
  // one string the engine accepts. The 88 constellation rows below are the
  // keys shipped in skydata/skycultures/western/index.json; every target in
  // the other tables was resolved against the running engine.

  var CONSTELLATION_ROWS =
    'And=仙女座=Andromeda,Ant=唧筒座=Antlia,Aps=天燕座=Apus,Aqr=宝瓶座=Aquarius,' +
    'Aql=天鹰座=Aquila,Ara=天坛座=Ara,Ari=白羊座=Aries,Aur=御夫座=Auriga,' +
    'Boo=牧夫座=Bootes,Cae=雕具座=Caelum,Cam=鹿豹座=Camelopardalis,Cnc=巨蟹座=Cancer,' +
    'CVn=猎犬座=Canes Venatici,CMa=大犬座=Canis Major,CMi=小犬座=Canis Minor,Cap=摩羯座=Capricornus,' +
    'Car=船底座=Carina,Cas=仙后座=Cassiopeia,Cen=半人马座=Centaurus,Cep=仙王座=Cepheus,' +
    'Cet=鲸鱼座=Cetus,Cha=蝘蜓座=Chamaeleon,Cir=圆规座=Circinus,Col=天鸽座=Columba,' +
    'Com=后发座=Coma Berenices,CrA=南冕座=Corona Australis,CrB=北冕座=Corona Borealis,Crv=乌鸦座=Corvus,' +
    'Crt=巨爵座=Crater,Cru=南十字座=Crux,Cyg=天鹅座=Cygnus,Del=海豚座=Delphinus,' +
    'Dor=剑鱼座=Dorado,Dra=天龙座=Draco,Equ=小马座=Equuleus,Eri=波江座=Eridanus,' +
    'For=天炉座=Fornax,Gem=双子座=Gemini,Gru=天鹤座=Grus,Her=武仙座=Hercules,' +
    'Hor=时钟座=Horologium,Hya=长蛇座=Hydra,Hyi=水蛇座=Hydrus,Ind=印第安座=Indus,' +
    'Lac=蝎虎座=Lacerta,Leo=狮子座=Leo,LMi=小狮座=Leo Minor,Lep=天兔座=Lepus,' +
    'Lib=天秤座=Libra,Lup=豺狼座=Lupus,Lyn=天猫座=Lynx,Lyr=天琴座=Lyra,' +
    'Men=山案座=Mensa,Mic=显微镜座=Microscopium,Mon=麒麟座=Monoceros,Mus=苍蝇座=Musca,' +
    'Nor=矩尺座=Norma,Oct=南极座=Octans,Oph=蛇夫座=Ophiuchus,Ori=猎户座=Orion,' +
    'Pav=孔雀座=Pavo,Peg=飞马座=Pegasus,Per=英仙座=Perseus,Phe=凤凰座=Phoenix,' +
    'Pic=绘架座=Pictor,Psc=双鱼座=Pisces,PsA=南鱼座=Piscis Austrinus,Pup=船尾座=Puppis,' +
    'Pyx=罗盘座=Pyxis,Ret=网罟座=Reticulum,Sge=天箭座=Sagitta,Sgr=人马座=Sagittarius,' +
    'Sco=天蝎座=Scorpius,Scl=玉夫座=Sculptor,Sct=盾牌座=Scutum,Ser=巨蛇座=Serpens,' +
    'Sex=六分仪座=Sextans,Tau=金牛座=Taurus,Tel=望远镜座=Telescopium,Tri=三角座=Triangulum,' +
    'TrA=南三角座=Triangulum Australe,Tuc=杜鹃座=Tucana,UMa=大熊座=Ursa Major,UMi=小熊座=Ursa Minor,' +
    'Vel=船帆座=Vela,Vir=室女座=Virgo,Vol=飞鱼座=Volans,Vul=狐狸座=Vulpecula'

  // Targets are the exact strings passed to getObj().
  var PLANET_ROWS = [
    ['NAME Sun', '太阳', '日', 'sun'],
    ['NAME Moon', '月球', '月亮', '月', '太阴', 'moon'],
    ['NAME Mercury', '水星', 'mercury'],
    ['NAME Venus', '金星', '启明星', '长庚星', '太白', 'venus'],
    ['NAME Mars', '火星', '荧惑', 'mars'],
    ['NAME Jupiter', '木星', '岁星', 'jupiter'],
    ['NAME Saturn', '土星', '镇星', 'saturn'],
    ['NAME Uranus', '天王星', 'uranus'],
    ['NAME Neptune', '海王星', 'neptune'],
    ['NAME Pluto', '冥王星', 'pluto']
  ]

  var STAR_ROWS = [
    ['Sirius', '天狼星', '天狼', 'sirius'],
    ['Vega', '织女星', '织女', '织女一', 'vega'],
    ['Polaris', '北极星', '勾陈一', '紫微星', 'polaris'],
    ['Betelgeuse', '参宿四', 'betelgeuse'],
    ['Rigel', '参宿七', 'rigel'],
    ['Arcturus', '大角星', '大角', 'arcturus'],
    ['Antares', '心宿二', '大火', 'antares'],
    ['Altair', '牛郎星', '牵牛星', '河鼓二', 'altair'],
    ['Deneb', '天津四', 'deneb'],
    ['Aldebaran', '毕宿五', 'aldebaran'],
    ['Capella', '五车二', 'capella'],
    ['Procyon', '南河三', 'procyon'],
    ['Spica', '角宿一', 'spica'],
    ['Regulus', '轩辕十四', 'regulus'],
    ['Fomalhaut', '北落师门', 'fomalhaut'],
    ['Pollux', '北河三', 'pollux'],
    ['Canopus', '老人星', 'canopus']
  ]

  var DSO_ROWS = [
    ['M 1', '蟹状星云', 'crab nebula'],
    ['M 13', '武仙座球状星团', '武仙座大球状星团', 'hercules cluster'],
    ['M 31', '仙女座星系', '仙女星系', '仙女座大星云', '仙女座大星系', 'andromeda galaxy'],
    ['M 42', '猎户座大星云', '猎户星云', '猎户座星云', 'orion nebula'],
    ['M 44', '蜂巢星团', '鬼星团', 'beehive cluster'],
    ['M 45', '昴星团', '昴宿星团', '七姐妹星团', 'pleiades'],
    ['M 51', '涡旋星系', 'whirlpool galaxy'],
    ['M 57', '指环星云', '环状星云', 'ring nebula'],
    ['M 104', '草帽星系', 'sombrero galaxy']
  ]

  // Chinese synonyms that are not the official constellation name.
  var CONSTELLATION_EXTRA = {
    '处女座': 'Vir',
    '射手座': 'Sgr',
    '水瓶座': 'Aqr',
    '山羊座': 'Cap',
    '南十字': 'Cru',
    '北斗七星': 'UMa',
    '北斗': 'UMa',
    '北极星所在星座': 'UMi'
  }

  var TARGET_ALIASES = (function () {
    var map = {}
    function put (alias, target) {
      if (!alias) return
      map[String(alias).replace(/\s+/g, ' ').toLowerCase()] = target
    }
    function addRows (rows) {
      for (var i = 0; i < rows.length; i++) {
        for (var j = 1; j < rows[i].length; j++) put(rows[i][j], rows[i][0])
      }
    }
    var rows = CONSTELLATION_ROWS.split(',')
    for (var i = 0; i < rows.length; i++) {
      var parts = rows[i].split('=')
      var abbr = parts[0]
      put(parts[1], 'CON western ' + abbr)
      put(parts[2], 'CON western ' + abbr)
      put(abbr, 'CON western ' + abbr)
    }
    for (var key in CONSTELLATION_EXTRA) {
      if (Object.prototype.hasOwnProperty.call(CONSTELLATION_EXTRA, key)) {
        put(key, 'CON western ' + CONSTELLATION_EXTRA[key])
      }
    }
    addRows(PLANET_ROWS)
    addRows(STAR_ROWS)
    addRows(DSO_ROWS)
    return map
  })()

  function normalizeTargetName (raw) {
    if (typeof raw !== 'string') return ''
    // \s already covers the ideographic and no-break spaces in ES2015+; do it
    // explicitly anyway so an old engine build cannot slip a full-width space
    // through to the case-sensitive comparison.
    return raw.replace(/[\s\u00a0\u3000]+/g, ' ').replace(/^ | $/g, '')
  }

  // 'M42' -> 'M 42'. The engine needs the space; models drop it constantly.
  function addCatalogueSpace (name) {
    var m = /^(M|C|NGC|IC|HIP|HD)\s*(\d[\w\-]*)$/i.exec(name)
    if (!m) return null
    return m[1].toUpperCase() + ' ' + m[2]
  }

  function resolveTarget (stel, raw) {
    var name = normalizeTargetName(raw)
    var attempt = { given: raw, normalized: name, resolved: null, tried: [] }
    if (!name) return { obj: null, attempt: attempt }
    var seen = {}
    var queue = []
    function push (candidate) {
      if (!candidate) return
      var key = candidate.toLowerCase()
      if (seen[key]) return
      seen[key] = true
      queue.push(candidate)
    }
    push(TARGET_ALIASES[name.toLowerCase()])
    push(name)
    push('NAME ' + name)
    push('CON western ' + name)
    if (/^NAME /i.test(name)) push(name.replace(/^NAME /i, ''))
    if (/^CON \S+ /i.test(name)) push(name.replace(/^CON \S+ /i, ''))
    push(addCatalogueSpace(name))
    for (var i = 0; i < queue.length; i++) {
      attempt.tried.push(queue[i])
      var obj = safe(function () { return stel.getObj(queue[i]) }, null)
      if (obj) {
        attempt.resolved = queue[i]
        return { obj: obj, attempt: attempt }
      }
    }
    return { obj: null, attempt: attempt }
  }

  /* --------------------------------------------------- command handling */

  var LAYER_TARGETS = {
    atmosphere: function () { return mod('atmosphere') },
    landscape: function () { return mod('landscapes') },
    milkyway: function () { return mod('milkyway') },
    stars: function () { return mod('stars') },
    dsos: function () { return mod('dsos') },
    equatorial_grid: function () { return childMod('lines', 'equatorial_jnow') },
    azimuthal_grid: function () { return childMod('lines', 'azimuthal') },
    meridian: function () { return childMod('lines', 'meridian') }
  }

  var COMMAND_SPECS = {
    read_state: { keys: ['type'] },
    set_layer: { keys: ['type', 'layer', 'visible'], required: ['layer', 'visible'] },
    set_layer_flag: { keys: ['type', 'layer', 'visible'], required: ['layer', 'visible'] },
    select_object: { keys: ['type', 'name', 'lock'], required: ['name'] },
    set_time: { keys: ['type', 'utc'], required: ['utc'] },
    set_time_speed: { keys: ['type', 'factor', 'simHours'], required: ['factor'] },
    set_location: { keys: ['type', 'lat', 'lng', 'elevation'], required: ['lat', 'lng'] },
    set_fov: { keys: ['type', 'deg'], required: ['deg'] }
  }

  // Layers that are not a plain `visible` boolean on their own module.
  var CONSTELLATION_FLAGS = {
    constellation_lines: 'lines_visible',
    constellation_labels: 'labels_visible',
    constellation_images: 'images_visible'
  }

  var ALLOWED_LAYERS = Object.keys(LAYER_TARGETS).concat(Object.keys(CONSTELLATION_FLAGS))

  // ISO 8601 with an explicit timezone. A naive local time is rejected: the
  // engine has no timezone concept, so guessing one would silently shift the
  // sky (see docs/API-CAPABILITIES.md).
  var ISO_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

  var SETTLE_TIMEOUT_MS = 4000
  var LOCK_ANIM_MS = 800
  var ZOOM_ANIM_MS = 500

  // Time-flow limits. The engine has none of its own, so these are the actual
  // contract: 86400 means one simulated day per real second, 21600 (6 h/s) is
  // still readable by eye, and anything past a day per second is a jump, not
  // a flow. A classroom rarely needs more than 1000x.
  var TIME_SPEED_MAX = 86400
  var TIME_SPEED_MIN = 0.0001
  // Upper bound on "run for N simulated hours", and on how long the real-time
  // automatic stop may stay armed. 72 h of real time is a hard backstop: a
  // slower speed over a longer span would just look frozen to a class.
  var SIM_HOURS_MAX = 100000
  var REAL_SECONDS_MAX = 72 * 3600
  var AUTO_STOP_TICK_MS = 200

  function fail (code, message, extra) {
    var out = { ok: false, status: 'failed', error: { code: code, message: message } }
    if (extra) {
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k]
    }
    return out
  }

  function validateCommand (cmd) {
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      return fail('invalid_command', '命令必须是一个 JSON 对象')
    }
    var type = cmd.type
    if (typeof type !== 'string' || !COMMAND_SPECS[type]) {
      return fail('unknown_command_type', '不支持的命令类型：' + String(type))
    }
    var spec = COMMAND_SPECS[type]
    var keys = Object.keys(cmd)
    for (var i = 0; i < keys.length; i++) {
      if (spec.keys.indexOf(keys[i]) < 0) {
        return fail('unexpected_field', '命令包含未允许的字段：' + keys[i])
      }
    }
    for (var j = 0; j < (spec.required || []).length; j++) {
      if (cmd[spec.required[j]] === undefined) {
        return fail('missing_field', '命令缺少字段：' + spec.required[j])
      }
    }
    if (type === 'set_layer' || type === 'set_layer_flag') {
      if (ALLOWED_LAYERS.indexOf(cmd.layer) < 0) {
        return fail('unknown_layer', '不支持的图层：' + String(cmd.layer))
      }
      if (typeof cmd.visible !== 'boolean') {
        return fail('invalid_value', 'visible 必须是 true 或 false')
      }
    }
    if (type === 'select_object') {
      if (typeof cmd.name !== 'string' || !cmd.name.trim() || cmd.name.length > 128) {
        return fail('invalid_value', '天体名称必须是非空字符串（不超过 128 字符）')
      }
      if (cmd.lock !== undefined && typeof cmd.lock !== 'boolean') {
        return fail('invalid_value', 'lock 必须是 true 或 false')
      }
    }
    if (type === 'set_time') {
      if (typeof cmd.utc !== 'string') {
        return fail('invalid_value', 'utc 必须是 ISO 8601 字符串')
      }
      if (!ISO_STRICT.test(cmd.utc)) {
        return fail('invalid_value',
          'utc 必须带明确时区（结尾为 Z 或 ±HH:MM），例如 2026-10-30T14:30:00Z')
      }
      var t = Date.parse(cmd.utc)
      if (!isFinite(t)) return fail('invalid_value', 'utc 不是合法的 ISO 8601 时间')
      // 1900-01-01 .. 2100-12-31: keep the engine ephemeris inside its range.
      if (t < -2208988800000 || t > 4133980800000) {
        return fail('out_of_range', '时间超出允许范围（1900-2100）')
      }
    }
    if (type === 'set_time_speed') {
      // The engine exposes time_speed as a bare double with no clamp at all
      // (src/core.h:146, src/core.c:1047), so every limit has to live here.
      // 86400 = one day per second; beyond that the ephemeris jumps so far per
      // frame that positions become meaningless rather than merely fast.
      if (typeof cmd.factor !== 'number' || !isFinite(cmd.factor)) {
        return fail('invalid_value', 'factor 必须是数字')
      }
      if (Math.abs(cmd.factor) > TIME_SPEED_MAX) {
        return fail('out_of_range',
          '时间流速必须在 -' + TIME_SPEED_MAX + ' 到 ' + TIME_SPEED_MAX + ' 之间（86400 = 每秒一天）')
      }
      // Below this the sky is still moving, but not in a way anyone can see:
      // 1e-4 already means 2.8 real hours per simulated second. The limit is
      // the point where "I set a speed and nothing happens" stops being
      // distinguishable from "the panel is broken", not a float underflow -
      // the engine keeps the value as a double (src/core.h:146).
      if (cmd.factor !== 0 && Math.abs(cmd.factor) < TIME_SPEED_MIN) {
        return fail('out_of_range',
          '非零流速不得小于 ' + TIME_SPEED_MIN +
          '（更小的值看不出在动：0.0001 已是 2.8 小时真实时间才走 1 模拟秒）')
      }
      if (cmd.simHours !== undefined) {
        if (typeof cmd.simHours !== 'number' || !isFinite(cmd.simHours) || cmd.simHours <= 0) {
          return fail('invalid_value', 'simHours 必须是正数（模拟小时数）')
        }
        if (cmd.simHours > SIM_HOURS_MAX) {
          return fail('out_of_range', 'simHours 不得超过 ' + SIM_HOURS_MAX)
        }
        if (cmd.factor === 0) {
          return fail('invalid_value', 'factor 为 0 时不要再给 simHours（时间不会走）')
        }
        var realSec = cmd.simHours * 3600 / Math.abs(cmd.factor)
        if (realSec > REAL_SECONDS_MAX) {
          return fail('out_of_range',
            '按这个流速走完 ' + cmd.simHours + ' 模拟小时要 ' + Math.round(realSec) +
            ' 秒真实时间，超过上限 ' + REAL_SECONDS_MAX + ' 秒')
        }
      }
    }
    if (type === 'set_location') {
      if (typeof cmd.lat !== 'number' || !isFinite(cmd.lat) || cmd.lat < -90 || cmd.lat > 90) {
        return fail('out_of_range', '纬度必须在 -90 到 90 之间')
      }
      if (typeof cmd.lng !== 'number' || !isFinite(cmd.lng) || cmd.lng < -180 || cmd.lng > 180) {
        return fail('out_of_range', '经度必须在 -180 到 180 之间')
      }
      if (cmd.elevation !== undefined &&
          (typeof cmd.elevation !== 'number' || !isFinite(cmd.elevation) ||
           cmd.elevation < -500 || cmd.elevation > 10000)) {
        return fail('out_of_range', '海拔必须在 -500 到 10000 米之间')
      }
    }
    if (type === 'set_fov') {
      if (typeof cmd.deg !== 'number' || !isFinite(cmd.deg) || cmd.deg < 0.05 || cmd.deg > 180) {
        return fail('out_of_range', '视场必须在 0.05 到 180 度之间')
      }
    }
    return { ok: true }
  }

  function finish (cmd, status, readback, waitedMs) {
    var st = safe(readState, null)
    return {
      ok: true,
      status: status,
      command: cmd.type,
      waitedMs: waitedMs || 0,
      readback: readback,
      state: st
    }
  }

  /* ---- per-command implementations: write, then verify against the engine */

  function applyLayer (stel, cmd) {
    var flag = CONSTELLATION_FLAGS[cmd.layer]
    var observed
    if (flag) {
      var con = mod('constellations')
      if (!con) return Promise.resolve(fail('engine_unavailable', '星座模块不可用'))
      con[flag] = cmd.visible
      observed = safe(function () { return con[flag] }, null)
    } else {
      var target = LAYER_TARGETS[cmd.layer]()
      if (!target) return Promise.resolve(fail('engine_unavailable', '图层不可用：' + cmd.layer))
      target.visible = !!cmd.visible
      observed = safe(function () { return target.visible }, null)
    }
    if (observed !== cmd.visible) {
      return Promise.resolve(fail('command_failed',
        '图层 ' + cmd.layer + ' 未生效：期望 ' + cmd.visible + '，读回 ' + String(observed),
        { readback: { layer: cmd.layer, visible: observed } }))
    }
    return Promise.resolve(finish(cmd, 'applied', { layer: cmd.layer, visible: observed }, 0))
  }

  function applySelect (stel, cmd) {
    var hit = resolveTarget(stel, cmd.name)
    var obj = hit.obj
    if (!obj) {
      return Promise.resolve(fail('object_not_found', '星图中找不到该名称的天体：' + cmd.name,
        { readback: { given: cmd.name, normalized: hit.attempt.normalized, tried: hit.attempt.tried } }))
    }
    // Kept for the readback: the panel can show what the name was resolved to,
    // so a wrong hit is visible instead of silently accepted.
    var resolvedAs = hit.attempt.resolved
    var wantId = safe(function () { return obj.id }, null)
    stel.core.selection = obj
    var sel = safe(function () { return stel.core.selection }, null)
    var gotId = sel ? safe(function () { return sel.id }, null) : null
    if (!sel || (wantId && gotId && wantId !== gotId)) {
      return Promise.resolve(fail('command_failed', '选中未生效：读回 ' + String(gotId),
        { readback: { selection: gotId } }))
    }

    if (cmd.lock === false) {
      return Promise.resolve(finish(cmd, 'applied',
        { selection: gotId, locked: false, resolvedAs: resolvedAs }, 0))
    }

    var radec = safe(function () { return sel.getInfo('radec') }, null)
    var target = altAzOf(stel, radec)
    stel.pointAndLock(sel, LOCK_ANIM_MS / 1000)

    if (!target) {
      // No geometry to verify against: wait out the animation, then say so
      // honestly instead of claiming the view arrived.
      return waitUntil(function () { return false }, LOCK_ANIM_MS + 200).then(function (w) {
        return finish(cmd, 'timeout', { selection: gotId, locked: 'unverified' }, w.waitedMs)
      })
    }

    return waitUntil(function () {
      var obs = stel.core.observer
      var yaw = stel.anp(obs.yaw) * R2D
      var pitch = stel.anpm(obs.pitch) * R2D
      return angularDiffDeg(yaw, target.az) < 3 && Math.abs(pitch - target.alt) < 3
    }, SETTLE_TIMEOUT_MS).then(function (w) {
      var obs = stel.core.observer
      var readback = {
        selection: gotId,
        locked: w.settled,
        resolvedAs: resolvedAs,
        targetAz: target.az,
        targetAlt: target.alt,
        yawDeg: safe(function () { return stel.anp(obs.yaw) * R2D }, null),
        pitchDeg: safe(function () { return stel.anpm(obs.pitch) * R2D }, null)
      }
      return finish(cmd, w.settled ? 'applied' : 'timeout', readback, w.waitedMs)
    })
  }

  function applyTime (stel, cmd) {
    var obs = stel.core.observer
    var wantMjd = Date.parse(cmd.utc) / 86400000 + MJD_UNIX_EPOCH
    // A pending auto-stop belongs to the previous run: its end point is
    // meaningless once the clock jumps. Drop it, and say so in the readback so
    // a caller that swapped the order of set_time and set_time_speed can see
    // why the run did not stop.
    var hadAutoStop = clearAutoStop()
    var beforeMjd = safe(function () { return obs.utc }, null)
    obs.utc = wantMjd
    var gotMjd = safe(function () { return obs.utc }, null)
    // Counted before this command returns, so the caller that issued it sees
    // the jump inside its own command rather than on top of the next one.
    noteClockWrite(stel, beforeMjd, gotMjd)
    var readback = {
      requestedUtc: cmd.utc,
      requestedMjd: wantMjd,
      engineMjd: gotMjd,
      engineUtc: typeof gotMjd === 'number'
        ? new Date((gotMjd - MJD_UNIX_EPOCH) * 86400000).toISOString()
        : null
    }
    if (hadAutoStop) readback.autoStopCleared = true
    // The host clock keeps running, so allow a small drift between write and
    // read; anything larger means the write did not take.
    if (typeof gotMjd !== 'number' || Math.abs(gotMjd - wantMjd) > 2e-5) {
      return Promise.resolve(fail('command_failed', '时间设置未生效', { readback: readback }))
    }
    return Promise.resolve(finish(cmd, 'applied', readback, 0))
  }

  /* ---- time flow -------------------------------------------------------- */

  // At most one armed auto-stop exists. It watches the *engine* clock, not the
  // wall clock: a backgrounded tab throttles timers, and a paused tab stops
  // rendering altogether, so "86.4 s have passed" is not the same as "one
  // simulated day has passed". Comparing observer.utc against the target is
  // immune to both.
  var autoStop = null

  function clearAutoStop () {
    if (!autoStop) return false
    if (autoStop.timer) clearInterval(autoStop.timer)
    autoStop = null
    return true
  }

  function armAutoStop (stel, stopMjd, dir) {
    var obs = stel.core.observer
    var timer = setInterval(function () {
      var now = safe(function () { return obs.utc }, null)
      if (typeof now !== 'number') return
      var reached = dir > 0 ? now >= stopMjd : now <= stopMjd
      if (!reached) return
      clearAutoStop()
      safe(function () { stel.core.time_speed = 0 })
      bump('time-auto-stop')
    }, AUTO_STOP_TICK_MS)
    autoStop = { timer: timer, stopMjd: stopMjd }
  }

  function applyTimeSpeed (stel, cmd) {
    var core = stel.core
    var factor = cmd.factor
    // Replacing the speed cancels any previous run: two armed auto-stops would
    // fight over the same clock.
    clearAutoStop()

    safe(function () { core.time_speed = factor })
    var got = safe(function () { return core.time_speed }, null)
    var readback = {
      requested: factor,
      factor: got,
      running: typeof got === 'number' ? got !== 0 : null,
      direction: typeof got === 'number' ? (got > 0 ? 'forward' : got < 0 ? 'backward' : 'stopped') : null
    }
    if (typeof got !== 'number' || Math.abs(got - factor) > 1e-6) {
      return Promise.resolve(fail('command_failed', '时间流速设置未生效', { readback: readback }))
    }

    if (cmd.simHours !== undefined) {
      var obs = stel.core.observer
      var startMjd = safe(function () { return obs.utc }, null)
      if (typeof startMjd !== 'number') {
        return Promise.resolve(fail('command_failed', '读不到当前时刻，无法安排停表',
          { readback: readback }))
      }
      var dir = factor > 0 ? 1 : -1
      var stopMjd = startMjd + dir * cmd.simHours / 24
      readback.simHours = cmd.simHours
      readback.realSeconds = Math.round(cmd.simHours * 3600 / Math.abs(factor))
      readback.startedUtc = new Date((startMjd - MJD_UNIX_EPOCH) * 86400000).toISOString()
      readback.stopAtUtc = new Date((stopMjd - MJD_UNIX_EPOCH) * 86400000).toISOString()
      readback.autoStop = true
      armAutoStop(stel, stopMjd, dir)
    }
    return Promise.resolve(finish(cmd, 'applied', readback, 0))
  }

  function applyLocation (stel, cmd) {
    var obs = stel.core.observer
    obs.latitude = cmd.lat * D2R
    obs.longitude = cmd.lng * D2R
    if (cmd.elevation !== undefined) obs.elevation = cmd.elevation
    var lat = safe(function () { return obs.latitude * R2D }, null)
    var lng = safe(function () { return obs.longitude * R2D }, null)
    var readback = { lat: lat, lng: lng, elevation: safe(function () { return obs.elevation }, null) }
    if (lat === null || Math.abs(lat - cmd.lat) > 1e-6 || Math.abs(lng - cmd.lng) > 1e-6) {
      return Promise.resolve(fail('command_failed', '地点设置未生效', { readback: readback }))
    }
    // Altitude is only claimed when it was actually asked for, and then it has
    // to come back: reporting "applied" while the engine kept the old
    // elevation would put a wrong horizon into every later explanation.
    if (cmd.elevation !== undefined &&
        (readback.elevation === null || Math.abs(readback.elevation - cmd.elevation) > 0.01)) {
      return Promise.resolve(fail('command_failed', '海拔设置未生效', { readback: readback }))
    }
    return Promise.resolve(finish(cmd, 'applied', readback, 0))
  }

  function applyFov (stel, cmd) {
    var want = cmd.deg
    stel.zoomTo(want * D2R, ZOOM_ANIM_MS / 1000)
    return waitUntil(function () {
      var fov = safe(function () { return stel.core.fov * R2D }, null)
      return fov !== null && Math.abs(fov - want) <= Math.max(0.01, want * 0.01)
    }, SETTLE_TIMEOUT_MS).then(function (w) {
      var fov = safe(function () { return stel.core.fov * R2D }, null)
      var readback = { requestedDeg: want, fovDeg: fov }
      if (!w.settled) return finish(cmd, 'timeout', readback, w.waitedMs)
      return finish(cmd, 'applied', readback, w.waitedMs)
    })
  }

  function executeCommand (cmd) {
    var v = validateCommand(cmd)
    if (!v.ok) return Promise.resolve(v)
    var stel = getStel()
    if (!stel) return Promise.resolve(fail('engine_unavailable', '星图引擎尚未就绪'))

    if (cmd.type === 'read_state') {
      return Promise.resolve(finish(cmd, 'applied', null, 0))
    }

    var run
    try {
      switch (cmd.type) {
        case 'set_layer':
        case 'set_layer_flag': run = applyLayer(stel, cmd); break
        case 'select_object': run = applySelect(stel, cmd); break
        case 'set_time': run = applyTime(stel, cmd); break
        case 'set_time_speed': run = applyTimeSpeed(stel, cmd); break
        case 'set_location': run = applyLocation(stel, cmd); break
        case 'set_fov': run = applyFov(stel, cmd); break
        default: return Promise.resolve(fail('unknown_command_type', '不支持的命令类型：' + cmd.type))
      }
    } catch (e) {
      // A throwing setter is a failure, not a success. This is the A4 fix.
      log('error', 'command threw: ' + cmd.type, e)
      return Promise.resolve(fail('command_failed',
        '执行命令时出错：' + (e && e.message ? e.message : '未知错误')))
    }

    return Promise.resolve(run).then(function (res) {
      bump(res && res.ok ? 'command' : 'command-failed')
      var st = safe(readState, null)
      if (res) res.state = st
      return res
    }, function (e) {
      log('error', 'command rejected: ' + cmd.type, e)
      return fail('command_failed', '执行命令时出错：' + (e && e.message ? e.message : '未知错误'))
    })
  }

  /* ---------------------------------------------------- subscriptions */

  function subscribeSelection (cb) {
    if (typeof cb !== 'function') return function () {}
    selectionSubs.push(cb)
    var st = safe(readState, null)
    if (st) safe(function () { cb(st.selection, st) })
    return function () {
      var i = selectionSubs.indexOf(cb)
      if (i >= 0) selectionSubs.splice(i, 1)
    }
  }

  function subscribeState (cb) {
    if (typeof cb !== 'function') return function () {}
    stateSubs.push(cb)
    return function () {
      var i = stateSubs.indexOf(cb)
      if (i >= 0) stateSubs.splice(i, 1)
    }
  }

  /* --------------------------------------------------- frozen snapshots */

  // The engine clock never stops, so `snapshotId` churns every few seconds even
  // when nothing a teacher would notice has changed. Deciding staleness from
  // that counter alone marks every answer stale almost immediately. What
  // actually invalidates a snapshot is a material change: a different object,
  // a different site, a different field of view, or the sky moving by a
  // noticeable amount (one minute of simulated time).
  function snapshotSignature (st) {
    if (!st) return null
    return [
      st.selection ? (st.selection.id || st.selection.designation) : null,
      st.time ? Math.round(st.time.mjd * 1440) : null,
      st.location ? Math.round(st.location.lat * 1000) : null,
      st.location ? Math.round(st.location.lng * 1000) : null,
      // Altitude moves the horizon, so it changes what "visible now" means.
      st.location && st.location.elevation !== null ? Math.round(st.location.elevation) : null,
      st.view && st.view.fovDeg !== null ? Math.round(st.view.fovDeg) : null,
      // Where the camera points is part of the picture a teacher describes -
      // but only when nothing is selected. With a selection the engine tracks
      // it every frame, so yaw/pitch change continuously and comparing them
      // would mark every snapshot stale a second after it was taken (the
      // object's own motion is already covered by the time field).
      st.selection ? null : (st.view && st.view.yawDeg !== null ? Math.round(st.view.yawDeg) : null),
      st.selection ? null : (st.view && st.view.pitchDeg !== null ? Math.round(st.view.pitchDeg) : null),
      // Layers change what is on the canvas (grids, labels, the Milky Way).
      st.layers ? JSON.stringify(st.layers) : null
    ].join('|')
  }

  // A snapshot is what an explanation request would send. It carries its own
  // id so a late response can be rejected if the sky moved on (A5).
  function captureSnapshot () {
    var st = safe(readState, null)
    if (!st) return null
    return {
      snapshotId: snapshotCounter,
      signature: snapshotSignature(st),
      revision: st.revision,
      takenAt: isoNow(),
      viewId: viewId,
      time: st.time,
      location: st.location,
      view: st.view,
      layers: st.layers,
      selection: st.selection
    }
  }

  // Raw counter check: true only for the most recent snapshot, regardless of
  // what changed. Kept for callers that want the strict reading.
  function isCurrentSnapshot (snapshotId) {
    return snapshotId === snapshotCounter
  }

  // Material check: true while nothing a viewer would notice has changed.
  function isSnapshotCurrent (snap) {
    if (!snap) return false
    var now = safe(readState, null)
    if (!now) return false
    var sig = snap.signature || snapshotSignature(snap)
    return sig !== null && sig === snapshotSignature(now)
  }

  /* ------------------------------------------------ body query (0.11.0) */

  // The recommendation feature needs altitude/azimuth/magnitude for a FIXED
  // list of designations at the current sim time, without touching the sky.
  // `getObj(q)` is a pure catalogue lookup (see the naming notes above): it
  // walks designations and returns the object; it never selects, never moves
  // the clock or the view, and `describeObject` only reads. That makes this a
  // legitimate read-only batch path - measured on the running engine, a full
  // batch leaves revision, selection, fov and observer.utc byte-identical.
  //
  // Bounded on purpose: string designations only, deduplicated, at most
  // BODY_QUERY_MAX entries per call. A caller that needs more makes more
  // calls; the cap keeps one stray loop from turning into a search scan the
  // size of the catalogue. Nothing here writes, so there is no verification
  // step - there is nothing to verify.
  var BODY_QUERY_MAX = 16

  function queryBodies (list) {
    var stel = getStel()
    if (!stel) return { error: 'engine_unavailable' }
    if (!Array.isArray(list)) return { error: 'bad_request', detail: 'list must be an array of designation strings' }
    if (list.length > BODY_QUERY_MAX) {
      return { error: 'too_many', max: BODY_QUERY_MAX }
    }
    var seen = {}
    var bodies = []
    for (var i = 0; i < list.length; i++) {
      var raw = list[i]
      if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 64) {
        bodies.push({ designation: raw, found: false, error: 'bad_designation' })
        continue
      }
      var key = raw.trim()
      if (seen[key]) continue
      seen[key] = true
      var obj = safe(function () { return stel.getObj(key) }, null)
      if (!obj) {
        bodies.push({ designation: key, found: false })
        continue
      }
      var d = safe(function () { return describeObject(stel, obj) }, null)
      if (!d) {
        bodies.push({ designation: key, found: false, error: 'describe_failed' })
        continue
      }
      d.found = true
      d.query = key
      bodies.push(d)
    }
    return {
      at: isoNow(),
      queried: list.length,
      returned: bodies.length,
      bodies: bodies
    }
  }

  /* ------------------------------------------------------------ bridge */

  var readyResolve
  var bridge = {
    protocolVersion: PROTOCOL_VERSION,
    loaderVersion: LOADER_VERSION,
    ready: new Promise(function (resolve) { readyResolve = resolve }),
    isEngineReady: function () { return !!getStel() },
    getCapabilities: function () {
      return {
        protocolVersion: PROTOCOL_VERSION,
        loaderVersion: LOADER_VERSION,
        commands: Object.keys(COMMAND_SPECS),
        layers: ALLOWED_LAYERS.slice(),
        commandResult: {
          async: true,
          statuses: ['applied', 'timeout', 'failed'],
          verifiedByReadback: true
        },
        features: {
          selectionRead: true,
          selectionSubscribe: true,
          stateSubscribe: true,
          snapshotCapture: true,
          snapshotMaterialCheck: true,
          clickToSelect: false,
          hotSwap: true,
          namingReference: true,
          // 0.7.0: the same validator the executor uses is callable from the
          // panel, so a plan can be rejected for a bad number or an unknown
          // layer before its first command is written, not halfway through.
          commandPrecheck: true,
          // The engine has always had a time rate; 0.6.0 is the first version
          // where the bridge exposes it as a whitelisted command.
          timeSpeed: true,
          // 0.9.0: readState().time.jumps counts clock moves that no command
          // of ours asked for. A panel can stop a plan on that number instead
          // of guessing from how far the clock moved.
          timeJumpSignal: true,
          // 0.11.0: bounded read-only batch lookup (altitude/azimuth/magnitude/
          // phase at the current sim time, no side effects on the sky).
          bodyQuery: true,
          bodyQueryMax: BODY_QUERY_MAX
        }
      }
    },
    readState: readState,
    captureSnapshot: captureSnapshot,
    // 0.11.0: bounded read-only batch query of bodies by exact designation.
    // Returns { at, queried, returned, bodies: [...] } or { error } - never
    // throws, never touches selection, time or view.
    queryBodies: queryBodies,
    // Plain-data copy of the object-naming reference shipped next to the
    // panel, for any other agent that needs to write select_object.name.
    // Null (never a throw) when the reference script did not load, so a
    // caller can fall back to docs/OBJECT-NAMING.md.
    namingReference: function () {
      var ref = window.SWE_NAMING_REFERENCE
      if (!ref) return null
      return safe(function () { return ref.toJSON() }, null)
    },
    isCurrentSnapshot: isCurrentSnapshot,
    isSnapshotCurrent: isSnapshotCurrent,
    // Pure and side-effect free: it reads nothing, writes nothing and is safe
    // to call on every keystroke or on every line of a previewed plan. The
    // executor calls the same function first, so "the preview said OK" and
    // "the bridge will accept it" cannot drift apart.
    validateCommand: validateCommand,
    subscribeSelection: subscribeSelection,
    subscribeState: subscribeState,
    executeCommand: executeCommand,
    dispose: function () {
      selectionSubs.length = 0
      stateSubs.length = 0
      // A hot-swapped bridge must not leave a timer writing into a dead engine
      // reference. clearAutoStop() is idempotent.
      clearAutoStop()
      stopClockWatch()
      if (watcher) { clearInterval(watcher); watcher = null }
      cached.stel = null
      cached.core = null
      cached.modules = {}
    }
  }

  window[GLOBAL_KEY] = bridge

  /* --------------------------------------------- wait for engine ready */

  var attempts = 0
  // Overridable so the "engine never appears" path can be tested quickly.
  var maxAttempts = window.__SWE_AI_ENGINE_TIMEOUT_MS__
    ? Math.ceil(window.__SWE_AI_ENGINE_TIMEOUT_MS__ / 100)
    : 600
  var timer = null

  function poll () {
    attempts += 1
    var stel = getStel()
    if (stel) {
      if (timer) { clearInterval(timer); timer = null }
      safe(function () {
        // The host already uses this hook to mirror engine state into vuex.
        // We add our own listener; it does not replace the host one.
        stel.onValueChanged(function (path) {
          // onValueChanged strips the leading "core." so selection arrives as
          // the bare attribute name.
          if (path === 'selection' || path === 'core.selection') {
            var st = safe(readState, null)
            if (st) broadcastSelection(st.selection, st)
          }
        })
      })
      startWatcher()
      startClockWatch()
      readyResolve(bridge)
      loadAssistant()
      return
    }
    if (attempts >= maxAttempts) {
      if (timer) { clearInterval(timer); timer = null }
      log('warn', 'engine never became available; assistant stays disabled')
      readyResolve(null)
    }
  }

  timer = setInterval(poll, 100)
  poll()

  /* --------------------------------------------------- load assistant */

  var assistantLoaded = false

  function loadAssistant () {
    if (assistantLoaded) return
    assistantLoaded = true
    var manifestUrl = baseUrl + 'manifest.json?t=' + Date.now()
    fetch(manifestUrl, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('manifest HTTP ' + r.status)
        return r.json()
      })
      .then(function (m) {
        if (!m || m.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error('assistant protocol mismatch: got ' + (m && m.protocolVersion) +
                          ', expected ' + PROTOCOL_VERSION)
        }
        // Content hash, not version string: a rebuilt assistant that keeps the
        // same version number still busts caches (A3).
        var v = encodeURIComponent(m.assetQuery || m.version || '0')
        if (m.style) {
          var link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = baseUrl + m.style + '?v=' + v
          link.setAttribute(PANEL_ATTR, 'style')
          document.head.appendChild(link)
        }
        // Assets the entry reads synchronously (the naming reference) are
        // listed in manifest.references and injected first. Dynamically
        // inserted scripts are async by default, which would let the entry
        // run against a missing global, so async is pinned to false and the
        // order below is the execution order.
        var refs = Array.isArray(m.references) ? m.references : []
        for (var i = 0; i < refs.length; i++) {
          if (typeof refs[i] !== 'string' || !refs[i]) continue
          appendScript(baseUrl + refs[i] + '?v=' + v, false)
        }
        appendScript(baseUrl + m.entry + '?v=' + v, true)
        log('info', 'assistant ' + (m.version || '?') + ' requested (' + v + ')')
      })
      .catch(function (e) {
        log('error', 'cannot load assistant manifest', e)
      })
  }

  function appendScript (src, isEntry) {
    var s = document.createElement('script')
    s.src = src
    s.async = false
    s.defer = true
    s.setAttribute(PANEL_ATTR, isEntry ? 'script' : 'reference')
    s.onerror = function () {
      log('error', isEntry ? 'assistant bundle failed to load' : 'assistant reference failed to load: ' + src)
    }
    document.head.appendChild(s)
  }
})()
