/* Stellarium Web AI Teaching Assistant - sky target reference & rules
 * Copyright (c) 2026 - project contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHAT THIS FILE IS
 *
 *   1. The target-file schema and validator for the external reference
 *      interface (task book §6): a target file is DATA, never script. The
 *      builtin Moon-and-planets provider is the default; an external file
 *      (curated bright stars, clusters, ...) becomes another provider with
 *      the same shape, and a missing or corrupt file must never take the
 *      builtin provider down.
 *
 *   2. The deterministic recommendation rules (task book §5). Given engine
 *      observations (altitude/azimuth/magnitude/phase - all read from the
 *      running engine through the bridge's read-only query) they decide what
 *      is worth looking at NOW for naked-eye and small-telescope viewers.
 *      Pure functions: same input, same output, no engine access, no model.
 *      The AI only explains the program's selection afterwards; it never
 *      invents candidates.
 *
 * SAFETY RULES ENCODED HERE (do not soften without re-reading the task book)
 *   - below the horizon is geometry, not a recommendation;
 *   - the Sun is never a target; Earth is not offered;
 *   - Mercury and Venus are excluded in DAYLIGHT, conservatively, and
 *     Mercury additionally needs a real separation from the Sun at night;
 *   - Uranus/Neptune are never naked-eye picks just because they are up;
 *   - a missing reading stays unknown (null), never 0;
 *   - the advice is for the CURRENT simulated instant and site - the caller
 *      must say so; this file never claims "all night" coverage.
 *
 * READERS
 *   the assistant panel (window.SWE_SKY_TARGETS), Node tests
 *   (require('./sky-targets.js')).
 */
;(function (root, factory) {
  var ref = factory()
  if (typeof module === 'object' && module.exports) module.exports = ref
  if (root) root.SWE_SKY_TARGETS = ref
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  var SCHEMA_VERSION = 1
  var QUERY_MAX = 16

  /* ------------------------------------------------------------ utils */

  function isStr (v, max) {
    return typeof v === 'string' && v.length > 0 && v.length <= max
  }
  function optStr (v, max) {
    return v === undefined || v === null || (typeof v === 'string' && v.length <= max)
  }
  function isNum (v) {
    return typeof v === 'number' && isFinite(v)
  }

  var MODES = ['eye', 'scope']
  var DIFFICULTIES = ['easy', 'moderate', 'challenging']

  /* -------------------------------------------- external file schema */

  /* A target file is plain data: fixed fields, hard length caps, no nested
   * objects beyond the documented ones, no arrays of anything but strings.
   * Anything outside the schema is an error, not a warning - a typo in a
   * curated file must be visible, not silently dropped. */
  // R5 (review round 3): identity-bearing ids the builtin provider owns. An
  // external file using one would let its metadata ride on a builtin safety
  // class (or vice versa); the ids stay separated per provider by design.
  var RESERVED_IDS = ['moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn',
    'uranus', 'neptune', 'sun', 'earth']

  /* `isBuiltin` marks the builtin provider validating its own table: the
   * reserved-id and builtin-conflict rules below are EXTERNAL-provider
   * boundaries (the builtin trivially owns its ids and designations). */
  function validateTargetFile (doc, isBuiltin) {
    var errors = []
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, errors: ['file must be an object'] }
    }
    if (doc.schemaVersion !== SCHEMA_VERSION) {
      errors.push('schemaVersion must be ' + SCHEMA_VERSION)
    }
    if (!doc.source || typeof doc.source !== 'object' ||
        !isStr(doc.source.name, 80)) {
      errors.push('source.name is required (<= 80 chars)')
    } else if (!optStr(doc.source.version, 40) || !optStr(doc.source.reference, 200)) {
      errors.push('source.version / source.reference must be short strings')
    }
    if (!Array.isArray(doc.targets) || doc.targets.length === 0) {
      errors.push('targets must be a non-empty array')
    } else if (doc.targets.length > 200) {
      errors.push('targets: at most 200 entries per file')
    } else {
      var seenId = {}
      var seenDesig = {}
      for (var i = 0; i < doc.targets.length; i++) {
        var t = doc.targets[i]
        var where = 'targets[' + i + ']'
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
          errors.push(where + ' must be an object')
          continue
        }
        if (!isStr(t.id, 64) || !/^[A-Za-z0-9_-]+$/.test(t.id)) {
          errors.push(where + '.id must be [A-Za-z0-9_-]{1,64}')
        } else if (seenId[t.id]) {
          errors.push(where + '.id duplicates ' + t.id)
        } else if (!isBuiltin && RESERVED_IDS.indexOf(String(t.id).toLowerCase()) >= 0) {
          // R5 (review round 3): a provider id is metadata, but the safety
          // rules used to read it as an identity. An external file may not
          // claim the builtin identities at all: id=moon paired with another
          // designation is exactly how a Venus reading was dressed up as the
          // Moon and slipped past the daylight rules.
          errors.push(where + '.id "' + t.id + '" is reserved for the builtin provider; use a provider-namespaced id')
        }
        if (t.id) seenId[t.id] = true
        if (!isStr(t.designation, 64)) {
          errors.push(where + '.designation is required (<= 64 chars)')
        } else if (seenDesig[t.designation]) {
          errors.push(where + '.designation duplicates ' + t.designation)
        } else if (!isBuiltin && BUILTIN_DESIG[String(t.designation).trim().toUpperCase()]) {
          // R5 (review round 3): cross-provider conflict. The builtin
          // provider already covers these designations; a second entry would
          // duplicate the engine query and blur which metadata belongs to
          // the resolved body.
          errors.push(where + '.designation "' + t.designation + '" duplicates builtin target ' +
            BUILTIN_DESIG[String(t.designation).trim().toUpperCase()])
        }
        if (t.designation) seenDesig[t.designation] = true
        if (!isStr(t.nameZh, 40)) errors.push(where + '.nameZh is required (<= 40 chars)')
        if (!isStr(t.nameEn, 60)) errors.push(where + '.nameEn is required (<= 60 chars)')
        if (!isStr(t.type, 32)) errors.push(where + '.type is required (<= 32 chars)')
        if (!Array.isArray(t.modes) || t.modes.length === 0) {
          errors.push(where + '.modes must be a non-empty array')
        } else {
          for (var m = 0; m < t.modes.length; m++) {
            if (MODES.indexOf(t.modes[m]) < 0) {
              errors.push(where + '.modes[' + m + '] must be one of ' + MODES.join('|'))
            }
          }
        }
        if (DIFFICULTIES.indexOf(t.difficulty) < 0) {
          errors.push(where + '.difficulty must be one of ' + DIFFICULTIES.join('|'))
        }
        if (!isStr(t.features, 400)) errors.push(where + '.features is required (<= 400 chars)')
        if (!optStr(t.limits, 400)) errors.push(where + '.limits must be a short string')
        for (var k in t) {
          if (['id', 'designation', 'nameZh', 'nameEn', 'type', 'modes',
            'difficulty', 'features', 'limits'].indexOf(k) < 0) {
            errors.push(where + ' has an unexpected field ' + k)
          }
        }
      }
    }
    if (errors.length) return { ok: false, errors: errors.slice(0, 10) }
    return { ok: true, doc: doc }
  }

  /* ------------------------------------------------- builtin provider */

  /* The eight task-book targets. features/limits are REVIEWED static text:
   * they describe what a small instrument typically shows, not what any
   * particular night will show. Dynamic values (altitude, azimuth, magnitude,
   * phase) always come from the engine, never from this table. */
  var BUILTIN = {
    schemaVersion: SCHEMA_VERSION,
    source: { name: '内置月球与大行星', version: '1', reference: '任务书§5' },
    targets: [
      {
        id: 'moon', designation: 'NAME Moon', nameZh: '月球', nameEn: 'Moon',
        type: '卫星', modes: ['eye', 'scope'], difficulty: 'easy',
        features: '肉眼看明暗面与整体亮度；小望远镜看环形山与明暗界线附近的地形，' +
          '娥眉月与凸月阶段立体感最好，满月过亮且缺乏阴影。',
        limits: '满月时目镜中非常刺眼，建议降低期待或用低倍率。'
      },
      {
        id: 'mercury', designation: 'NAME Mercury', nameZh: '水星', nameEn: 'Mercury',
        type: '行星', modes: ['eye', 'scope'], difficulty: 'challenging',
        features: '肉眼看是一个不高的亮点；小望远镜中是一个小小的相位圆面。',
        limits: '永远离太阳很近，只在日出日落前后的低空有短暂窗口；白天绝不用望远镜在太阳附近寻找。'
      },
      {
        id: 'venus', designation: 'NAME Venus', nameZh: '金星', nameEn: 'Venus',
        type: '行星', modes: ['eye', 'scope'], difficulty: 'easy',
        features: '肉眼看是全天最亮的行星状光点；小望远镜中呈月牙状或半圆的相位。',
        limits: '只能在黄昏或黎明附近见到；目镜中非常亮，注意避免残阳在地平线附近干扰。'
      },
      {
        id: 'mars', designation: 'NAME Mars', nameEn: 'Mars', nameZh: '火星',
        type: '行星', modes: ['eye', 'scope'], difficulty: 'moderate',
        features: '肉眼看是一颗带橙色的亮星；小望远镜中是一个小圆面，冲日前后稍大。',
        limits: '圆面常年很小，不要期待表面细节；亮度随距离变化很大。'
      },
      {
        id: 'jupiter', designation: 'NAME Jupiter', nameZh: '木星', nameEn: 'Jupiter',
        type: '行星', modes: ['eye', 'scope'], difficulty: 'easy',
        features: '肉眼看是稳定的亮星；小望远镜中能看到圆面和四颗伽利略卫星的位置变化。',
        limits: '云带在小型望远镜里通常只是淡淡的条纹，不保证每次清晰。'
      },
      {
        id: 'saturn', designation: 'NAME Saturn', nameZh: '土星', nameEn: 'Saturn',
        type: '行星', modes: ['eye', 'scope'], difficulty: 'easy',
        features: '肉眼看是一颗不闪烁的黄色亮星；小望远镜中能看到明显的光环。',
        limits: '光环倾角随年份变化；目镜中整体仍较小。'
      },
      {
        id: 'uranus', designation: 'NAME Uranus', nameZh: '天王星', nameEn: 'Uranus',
        type: '行星', modes: ['scope'], difficulty: 'challenging',
        features: '小望远镜中是一个带有轻微蓝绿色的暗弱小点，需要星图比对确认。',
        limits: '肉眼基本不可见；不要期待盘面细节。'
      },
      {
        id: 'neptune', designation: 'NAME Neptune', nameZh: '海王星', nameEn: 'Neptune',
        type: '行星', modes: ['scope'], difficulty: 'challenging',
        features: '小望远镜中是一个非常暗弱的小点，需要精确星图比对确认。',
        limits: '肉眼不可见；这是有经验的观测者的目标，不是新手首选项。'
      }
    ]
  }

  // Normalized designations the builtin provider answers for (R5, review
  // round 3): an external file may not duplicate them - the query would run
  // twice and two metadata records would claim the same engine body.
  var BUILTIN_DESIG = {}
  BUILTIN.targets.forEach(function (t) {
    BUILTIN_DESIG[String(t.designation).trim().toUpperCase()] = t.id
  })

  /* --------------------------------------------------- observations */

  /* Merge a provider's metadata with engine readings. The engine is the only
   * source of dynamic values; a designation the engine cannot resolve stays
   * in the result as `found: false` so the caller can say so honestly.
   * Lookup keys are trimmed on both sides (review round 2, C1): a curated
   * file may carry acceptable leading/trailing whitespace, and the caller
   * indexes readings by the trimmed query string it actually sent. */
  function withObservations (targets, obsByDesignation) {
    return (targets || []).map(function (t) {
      var key = String(t.designation || '').trim()
      var obs = (obsByDesignation || {})[key] || null
      return {
        id: t.id,
        designation: t.designation,
        nameZh: t.nameZh,
        nameEn: t.nameEn,
        type: t.type,
        modes: t.modes.slice(),
        difficulty: t.difficulty,
        features: t.features,
        limits: t.limits || '',
        obs: obs && obs.found
          ? {
              alt: isNum(obs.alt) ? obs.alt : null,
              az: isNum(obs.az) ? obs.az : null,
              vmag: isNum(obs.vmag) ? obs.vmag : null,
              phase: isNum(obs.phase) && obs.phase >= 0 && obs.phase <= 1 ? obs.phase : null,
              distanceAu: isNum(obs.distanceAu) ? obs.distanceAu : null
            }
          : null,
        // R5 (review round 3): the engine's OWN resolved identity for the
        // queried body (its designations), kept apart from the provider's
        // metadata id and from the alias string that was asked. Safety
        // classification trusts THIS, never the id a file claimed.
        engineDesignation: obs && obs.found && isStr(obs.designation, 64)
          ? obs.designation
          : null,
        engineNames: obs && obs.found && Array.isArray(obs.names)
          ? obs.names.filter(function (n) { return typeof n === 'string' && n.trim() }).slice(0, 12)
          : []
      }
    })
  }

  function directionName (az, lang) {
    if (!isNum(az)) return null
    var names = lang === 'en'
      ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
      : ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
    var norm = ((az % 360) + 360) % 360
    return names[Math.round(norm / 45) % 8]
  }

  function round (v, digits) {
    if (!isNum(v)) return null
    var f = Math.pow(10, digits)
    return Math.round(v * f) / f
  }

  /* Round to n significant digits. Fixed-decimal rounding turns the Moon's
   * 0.0026 AU into '0.00' (review round 2, R2) - a real engine reading shown
   * as zero. Significant digits keep every magnitude honest. */
  function sig (v, n) {
    if (!isNum(v) || v === 0) return isNum(v) ? 0 : null
    var d = Math.ceil(Math.log10(Math.abs(v)))
    var f = Math.pow(10, n - d)
    return Math.round(v * f) / f
  }

  function sepDeg (a) {
    /* Angular separation between two alt/az pairs (degrees). Topocentric
     * separation is exactly what "keep away from the Sun" means for the
     * viewer, so horizon-frame vectors are the right input here. */
    if (!a || !isNum(a.alt1) || !isNum(a.az1) || !isNum(a.alt2) || !isNum(a.az2)) return null
    var d2r = Math.PI / 180
    var a1 = a.alt1 * d2r; var z1 = a.az1 * d2r
    var a2 = a.alt2 * d2r; var z2 = a.az2 * d2r
    var c = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(z1 - z2)
    if (c > 1) c = 1
    if (c < -1) c = -1
    return Math.acos(c) / d2r
  }

  /* ------------------------------------------------------ recommend */

  /* R5 (review round 3): canonical engine identity. The safety class of a
   * target comes from what the engine RESOLVED for the query (its own
   * designation list for that body), never from the provider's metadata id
   * and never from the alias string alone. A schema-valid file can claim any
   * id it likes; it cannot change what the engine says the body is. */
  var CANON_SUN = ['NAME SUN', 'SUN']
  var CANON_EARTH = ['NAME EARTH', 'EARTH']
  var CANON_MOON = ['NAME MOON', 'MOON', 'LUNA']
  var CANON_MERCURY = ['NAME MERCURY', 'MERCURY']
  var CANON_VENUS = ['NAME VENUS', 'VENUS']

  function canonMatches (e, canon) {
    var vals = []
    if (e.engineDesignation) vals.push(e.engineDesignation)
    if (e.engineNames && e.engineNames.length) vals = vals.concat(e.engineNames)
    // No engine identity available (degenerate or missing reading): fall
    // back to the queried designation string - the previous behaviour.
    if (!vals.length && e.designation) vals.push(e.designation)
    for (var i = 0; i < vals.length; i++) {
      var v = String(vals[i]).trim().toUpperCase()
      for (var j = 0; j < canon.length; j++) {
        if (v === canon[j]) return true
      }
    }
    return false
  }

  /* recommend(entries, sun, opts) -> deterministic grouped advice.
   *
   *   entries  provider targets WITH observations (withObservations output)
   *   sun      { found, alt, az } for the Sun, engine readings
   *   opts     { lang: 'zh'|'en' }
   *
   * The output is plain data; the panel renders it and may hand it to the
   * model for phrasing. Every rejection is recorded with its reason, so the
   * "为什么没有推荐" question has a real answer and the rule tests can pin
   * every branch. */
  function recommend (entries, sun, opts) {
    var lang = (opts && opts.lang) === 'en' ? 'en' : 'zh'
    var T = TEXT[lang]
    var sunAlt = sun && isNum(sun.alt) ? sun.alt : null
    var daylight = sunAlt !== null && sunAlt > 0
    var twilight = sunAlt !== null && sunAlt > -8 && sunAlt <= 0

    var eye = []
    var scope = []
    var excluded = []

    function exclude (e, code) {
      excluded.push({ id: e.id, name: lang === 'en' ? e.nameEn : e.nameZh, reason: code })
    }

    (entries || []).forEach(function (e) {
      // Hard safety exclusion by CANONICAL ENGINE IDENTITY (R5, review round
      // 3): the Sun and the Earth are never targets, whatever id or alias a
      // file came in with. The class is read from the engine's resolved
      // designations; the queried string is only the last-resort fallback.
      if (canonMatches(e, CANON_SUN) || canonMatches(e, CANON_EARTH)) {
        exclude(e, 'sun_or_earth')
        return
      }
      if (!e.obs) { exclude(e, 'not_found'); return }
      var alt = e.obs.alt
      if (alt === null) { exclude(e, 'no_altitude'); return }
      if (alt < 0) { exclude(e, 'below_horizon'); return }
      if (sunAlt === null) { exclude(e, 'no_sun_reading'); return }
      // Identity classes for the rule branches (canonical, not the file's id).
      var isMoon = canonMatches(e, CANON_MOON)
      var isInnerPlanet = canonMatches(e, CANON_MERCURY) || canonMatches(e, CANON_VENUS)
      // Mercury/Venus never belong in a daylight suggestion, whatever their
      // brightness says - and whatever id their file claimed. The Sun is not
      // something a beginner hunts next to.
      if (isInnerPlanet && daylight) { exclude(e, 'daylight_inner_planet'); return }
      if (daylight && !isMoon) { exclude(e, 'daytime'); return }
      var altFloor = (isMoon && daylight) ? 20 : 15
      if (alt < 10) { exclude(e, 'too_low'); return }

      var sunSep = (sun && sun.found) ? sepDeg({ alt1: alt, az1: e.obs.az, alt2: sun.alt, az2: sun.az }) : null
      // R5 (review round 2, priority): a Moon high in the sky can still be
      // right next to the Sun - thin crescent, or a new Moon during eclipse
      // season. Being up is NOT being safe to recommend, least of all to a
      // beginner with a telescope near the Sun. The separation is a hard,
      // non-bypassable precondition for BOTH groups; an unknown separation in
      // daylight is treated as too close (conservative).
      if (isMoon && sunSep !== null && sunSep < 20) { exclude(e, 'moon_near_sun'); return }
      if (isMoon && daylight && sunSep === null) { exclude(e, 'moon_near_sun_unknown'); return }
      var isEyeCandidate = e.modes.indexOf('eye') >= 0
      var isScopeCandidate = e.modes.indexOf('scope') >= 0
      if (!isEyeCandidate && !isScopeCandidate) { exclude(e, 'no_mode'); return }

      var limits = []
      if (e.limits) limits.push(e.limits)
      if (alt < altFloor) { exclude(e, 'too_low_for_mode'); return }
      if (canonMatches(e, CANON_MERCURY)) {
        // Night-only, and only with real separation from the Sun. Twilight
        // Mercury is the classic beginner trap: bright sky, low altitude,
        // and the Sun just below the horizon.
        if (!daylight && !twilight && sunAlt <= -8 && sunSep !== null && sunSep >= 15) {
          limits.push(T.mercuryWindow)
        } else {
          exclude(e, 'mercury_window_closed')
          return
        }
      }
      if (twilight && !isMoon) limits.push(T.twilightSky)
      if (daylight && isMoon) limits.push(T.daylightMoon)
      if (alt < 15) limits.push(T.lowAltitude)
      if (e.obs.vmag === null) limits.push(T.noMagnitude)

      var item = {
        id: e.id,
        designation: e.designation,
        name: lang === 'en' ? e.nameEn : e.nameZh,
        type: e.type,
        difficulty: e.difficulty,
        altitudeDeg: round(alt, 0),
        azimuthDeg: round(e.obs.az, 0),
        direction: directionName(e.obs.az, lang),
        magnitude: round(e.obs.vmag, 1),
        // Illuminated fraction in percent, engine-computed, Moon-style bodies
        // only. It is an engine reading, not a reconstruction.
        illumPercent: e.obs.phase !== null ? round(e.obs.phase * 100, 0) : null,
        // Significant digits, not fixed decimals: the Moon at 0.0026 AU must
        // never display as 0 AU (review round 2, R2).
        distanceAu: sig(e.obs.distanceAu, 3),
        features: e.features,
        limits: limits
      }

      var brightNote = null
      if (isMoon && item.illumPercent !== null) {
        if (item.illumPercent >= 90) brightNote = T.moonFull
        else if (item.illumPercent <= 15) brightNote = T.moonCrescent
      }
      if (brightNote) limits.push(brightNote)

      // R10 (review round 2): the two viewing modes are evaluated
      // INDEPENDENTLY. A naked-eye verdict (too faint) used to return early
      // and silently dropped the same target from the telescope list - a
      // control-flow bug, not a device assessment. Now the eye verdict only
      // removes the eye entry and is recorded on its own.
      var eyeRejected = false
      if (isEyeCandidate && e.obs.vmag !== null && e.obs.vmag > 2) {
        eyeRejected = true
        excluded.push({ id: e.id, name: lang === 'en' ? e.nameEn : e.nameZh, reason: 'too_faint_for_eye' })
      }
      if (isEyeCandidate && !eyeRejected) eye.push(item)
      if (isScopeCandidate) scope.push(item)
    })

    function byBrightness (a, b) {
      var am = a.magnitude === null ? 99 : a.magnitude
      var bm = b.magnitude === null ? 99 : b.magnitude
      return am - bm
    }
    // The Moon first: it is the brightest thing up here and the easiest to
    // point at; after that, brighter first. Uranus/Neptune are scope-only by
    // their provider entry, so the eye list never sees them "just because
    // they are up".
    eye.sort(function (a, b) {
      if (a.id === 'moon') return -1
      if (b.id === 'moon') return 1
      return byBrightness(a, b)
    })
    scope.sort(function (a, b) {
      if (a.id === 'moon') return -1
      if (b.id === 'moon') return 1
      return byBrightness(a, b)
    })

    return {
      schemaVersion: SCHEMA_VERSION,
      timeScope: T.timeScope,
      sunAltitudeDeg: round(sunAlt, 0),
      daytime: daylight,
      twilight: twilight,
      groups: {
        eye: { items: eye, emptyNote: eye.length ? null : T.noEyeTargets },
        scope: { items: scope, emptyNote: scope.length ? null : T.noScopeTargets }
      },
      excluded: excluded
    }
  }

  /* -------------------------------------------- model-facing summary */

  /* A compact, already-rounded digest of a recommendation result for the
   * model to phrase. It carries no internal ids beyond the stable target id
   * and no debug fields; the rules have already decided the selection, so the
   * model explains rather than re-selects. `meta` (R7) binds the digest to
   * the instant and site it was computed for, so a later question can be
   * told apart from a fresh one and the model never guesses the vintage of
   * the numbers. */
  function toModelDigest (rec, lang, meta) {
    var T = TEXT[lang === 'en' ? 'en' : 'zh']
    var out = {
      timeScope: rec.timeScope,
      sunAltitudeDeg: rec.sunAltitudeDeg,
      daytime: rec.daytime,
      eye: rec.groups.eye.items.map(function (i) {
        return {
          name: i.name, altitudeDeg: i.altitudeDeg, direction: i.direction,
          magnitude: i.magnitude, illumPercent: i.illumPercent,
          features: i.features, limits: i.limits
        }
      }),
      scope: rec.groups.scope.items.map(function (i) {
        return {
          name: i.name, altitudeDeg: i.altitudeDeg, direction: i.direction,
          magnitude: i.magnitude, illumPercent: i.illumPercent,
          features: i.features, limits: i.limits
        }
      }),
      emptyNoteEye: rec.groups.eye.emptyNote,
      emptyNoteScope: rec.groups.scope.emptyNote,
      excludedCount: rec.excluded.length,
      instructions: T.digestInstructions
    }
    if (meta) {
      out.computedForUtc = meta.utc || null
      out.computedForSite = meta.site || null
    }
    return out
  }

  /* ------------------------------------------------------------- text */

  var TEXT = {
    zh: {
      timeScope: '以下为当前星图设置时刻与模拟地点的建议，不覆盖整晚时段。',
      noEyeTargets: '当前时刻没有值得肉眼观看的推荐目标。',
      noScopeTargets: '当前时刻没有值得小型望远镜观看的推荐目标。',
      mercuryWindow: '水星窗口很短，需要地平线开阔且日落方向无遮挡。',
      twilightSky: '天空尚未全黑，暗弱目标会被淹没。',
      daylightMoon: '白天的月球对比度低，肉眼寻找需要耐心。',
      lowAltitude: '高度较低，受地面遮挡与大气消光影响，实际观感可能更差。',
      noMagnitude: '亮度读数缺失，按位置推荐。',
      moonFull: '满月前后，目镜中很亮，适合看整体而非地形。',
      moonCrescent: '细月牙，亮度低，明暗界线附近立体感最强。',
      digestInstructions: '这些候选与数值由程序根据引擎读数筛选，你负责向老师解释' +
        '为什么值得看、当前画面能看到什么、下一步怎么看。不要增加新的目标，' +
        '不要编造数值之外的距离、天气或可见性结论；地点是软件模拟地点。'
    },
    en: {
      timeScope: 'These suggestions apply to the CURRENT chart time and simulated site; they do not cover the whole night.',
      noEyeTargets: 'No target is currently worth a naked-eye look.',
      noScopeTargets: 'No target is currently worth a small-telescope look.',
      mercuryWindow: 'The Mercury window is short: an open horizon and a clear sunset direction are required.',
      twilightSky: 'The sky is not dark yet; faint targets will wash out.',
      daylightMoon: 'The daytime Moon has low contrast; finding it by eye takes patience.',
      lowAltitude: 'Low altitude: ground obstruction and atmospheric extinction will make it look worse.',
      noMagnitude: 'Magnitude reading missing; recommended by position only.',
      moonFull: 'Near full Moon: very bright in the eyepiece, best for the whole disk rather than terrain.',
      moonCrescent: 'A thin crescent; terrain near the terminator shows the strongest relief.',
      digestInstructions: 'The candidates and numbers were selected by the program from engine readings. ' +
        'Explain why they are worth seeing, what the current view shows and what to do next. ' +
        'Do not add targets, do not invent distances, weather or visibility beyond the numbers; the site is a simulated one.'
    }
  }

  /* ---------------------------------------------------------- exports */

  return {
    schemaVersion: SCHEMA_VERSION,
    queryMax: QUERY_MAX,
    validateTargetFile: validateTargetFile,
    builtin: BUILTIN,
    withObservations: withObservations,
    directionName: directionName,
    separationDeg: sepDeg,
    recommend: recommend,
    toModelDigest: toModelDigest
  }
})
