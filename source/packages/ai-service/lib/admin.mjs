/* Administrator surface.
 *
 * Three deliberate separations, because getting them wrong is how a "settings
 * page" becomes a way to spend money:
 *
 *   save          validates and persists. It never contacts the model. A typo in
 *                 a base URL must not cost a generation to discover.
 *   check         GET {base}/models. Non-generating, no quota consumed.
 *   generate test one real call, explicitly labelled, consumes one quota slot.
 *
 * Every response is masked: the key is reported as a boolean and never as a
 * value, and config.json on disk does not contain it either.
 */

import { json, readJson } from './http.mjs'
import { ValidationError, ConfigError } from './config.mjs'
import { refundableOutcome } from './upstream.mjs'

function masked (cfg) {
  return {
    revision: cfg.revision,
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
    enabled: cfg.enabled,
    note: cfg.note,
    upstream: {
      baseUrl: cfg.upstream.baseUrl,
      model: cfg.upstream.model,
      authMode: cfg.upstream.authMode,
      hasKey: cfg.upstream.hasKey,
      // Where the effective credential comes from ('revision' | 'legacy' |
      // 'none') and whether old upstream.key bytes are still on disk (R5
      // supplement): "explicitly cleared" and "legacy migration pending" are
      // different states and the operator sees which one they are in.
      keySource: cfg.upstream.keySource,
      legacyPending: cfg.upstream.legacyPending,
      // The saved target may no longer be on the allowlist. Saying so here is
      // what turns "the option is greyed out" into "this host is no longer
      // permitted", which is a different repair (R8).
      allowed: cfg.upstream.allowed
    },
    limits: cfg.limits
  }
}

export function createAdmin (deps) {
  const config = deps.config
  const upstream = deps.upstream
  const store = deps.store
  const log = deps.log
  const limiter = deps.limiter
  const startupFault = deps.startupFault || null

  function today () {
    return store.dayKey(Date.now(), config.get().limits.dayTz)
  }

  function usageReport () {
    if (!store) return { day: null, timezone: config.get().limits.dayTz, global: null, perIdentityLimit: config.get().limits.dailyPerIdentity }
    const cfg = config.get()
    const day = today()
    const global = store.usageFor(day, 'global')
    return {
      day,
      timezone: cfg.limits.dayTz,
      global: Object.assign({}, global, {
        limit: cfg.limits.dailyGlobal,
        remaining: cfg.limits.dailyGlobal > 0 ? Math.max(0, cfg.limits.dailyGlobal - global.used) : null
      }),
      perIdentityLimit: cfg.limits.dailyPerIdentity
    }
  }

  function fail (res, e) {
    if (e instanceof ValidationError) {
      // A revision conflict is not a bad request: the caller's data was valid,
      // it was just written from a snapshot that no longer exists. 409 lets the
      // admin page tell "someone else saved" apart from "your input is wrong".
      if (e.code === 'revision_conflict') {
        return json(res, 409, { error: e.code, detail: e.detail, revision: config.get().revision })
      }
      return json(res, 400, { error: e.code, detail: e.detail })
    }
    if (e instanceof ConfigError) {
      // A publish that cannot prove durability is a service fault, not a bad
      // request (C1): the save IS on disk and adopted in memory, the paid route
      // is closed until a verified save or a restart, and the caller is told
      // which revision is now in effect instead of a bare "internal".
      return json(res, 503, { error: e.code, detail: e.detail, revision: config.get().revision })
    }
    throw e
  }

  return async function handleAdmin (req, res, urlPath, actor) {
    if (req.method === 'GET' && urlPath === '/api/admin/config') {
      const cfg = config.get()
      return json(res, 200, {
        ok: true,
        config: masked(cfg),
        live: config.live() && !startupFault,
        missing: config.missing(),
        usage: usageReport(),
        store: store ? store.backend : 'unavailable',
        // Degraded while the last config publish is on disk but its durability
        // is unproven (C1); the paid route stays closed until it is resolved.
        configSync: config.syncHealth(),
        fault: startupFault
      })
    }

    if (req.method === 'PUT' && urlPath === '/api/admin/config') {
      const body = await readJson(req, 64 * 1024)
      if (body.error) return json(res, body.status, { error: body.error })
      const p = body.value
      // An unknown field is a client bug or a probe; either way, refuse it
      // rather than guess what it meant.
      const allowed = ['baseUrl', 'model', 'authMode', 'enabled', 'note', 'limits', 'key', 'expectedRevision']
      const extra = Object.keys(p).filter((k) => !allowed.includes(k))
      if (extra.length) return json(res, 400, { error: 'unexpected_fields', fields: extra.slice(0, 5) })
      if (p.key !== undefined) {
        if (typeof p.key !== 'string') return json(res, 400, { error: 'key_shape' })
      }
      // Compare-and-set is mandatory here (R9). Without it, a settings page left
      // open in another tab writes back the `enabled: true` it was rendered with
      // and silently undoes an emergency stop, or re-points the upstream at a
      // host the operator has just removed from the allowlist.
      if (!Number.isInteger(p.expectedRevision)) {
        return json(res, 400, { error: 'revision_required', revision: config.get().revision })
      }
      try {
        // One save, one revision. The key travels inside the same patch so a
        // rejected field cannot leave a new credential behind, and a request
        // may set a key and enable the feature in a single step.
        const out = config.apply(p, actor, p.expectedRevision)
        log.info('admin config applied', {
          actor, revision: out.revision, live: out.live, enabled: p.enabled === true
        })
        return json(res, 200, {
          ok: true,
          revision: out.revision,
          live: out.live,
          config: masked(config.get()),
          missing: config.missing()
        })
      } catch (e) { return fail(res, e) }
    }

    if (req.method === 'POST' && urlPath === '/api/admin/config/key') {
      const body = await readJson(req, 8 * 1024)
      if (body.error) return json(res, body.status, { error: body.error })
      const p = body.value
      // The standalone key endpoint is compare-and-set like every other write
      // (R9 supplement). The config layer refuses a missing revision too, but
      // the HTTP surface says so here, with the current revision attached, so
      // a direct API caller gets the same contract the admin page obeys
      // instead of a 500.
      if (!Number.isInteger(p.expectedRevision)) {
        return json(res, 400, { error: 'revision_required', revision: config.get().revision })
      }
      const expected = p.expectedRevision
      try {
        if (p.clear === true) {
          const out = config.clearKey(actor, expected)
          log.info('admin key cleared', { actor, changed: out.changed, live: out.live, leftover: out.leftover })
          return json(res, 200, {
            ok: true,
            changed: out.changed,
            revision: out.revision,
            live: out.live,
            // The pointer is gone, so the credential is out of effect; if the
            // file itself could not be unlinked the operator is told rather than
            // left believing the bytes were destroyed.
            leftover: out.leftover || null
          })
        }
        if (typeof p.key !== 'string') return json(res, 400, { error: 'key_required' })
        // An empty string is not "clear": the admin UI sends an empty box when
        // the operator simply did not retype the key, and that must not wipe it.
        const out = config.setKey(p.key, actor, expected)
        log.info('admin key set', { actor, changed: out.changed, revision: out.revision })
        return json(res, 200, { ok: true, changed: out.changed, revision: out.revision })
      } catch (e) { return fail(res, e) }
    }

    if (req.method === 'POST' && urlPath === '/api/admin/emergency-stop') {
      let out
      try {
        out = config.emergencyStop(actor)
      } catch (e) { return fail(res, e) }
      log.warn('emergency stop', { actor, revision: out.revision })
      return json(res, 200, { ok: true, revision: out.revision, live: false })
    }

    if (req.method === 'POST' && urlPath === '/api/admin/test-connection') {
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      const out = await upstream.probe(ac.signal)
      log.info('admin connection probe', { actor, ok: out.ok, code: out.code, models: out.models })
      if (!out.ok) return json(res, 200, { ok: false, code: out.code, generated: false })
      return json(res, 200, {
        ok: true,
        reachable: true,
        models: out.models,
        note: out.note || null,
        generated: false,
        // Said out loud because it is the most common misreading of this button.
        detail: 'reachable_only'
      })
    }

    if (req.method === 'POST' && urlPath === '/api/admin/test-generate') {
      if (startupFault || !store) {
        return json(res, 503, {
          error: 'storage_unavailable',
          area: startupFault ? startupFault.area : 'ledger'
        })
      }
      if (!config.live()) return json(res, 503, { error: 'server_ai_unavailable', missing: config.missing() })
      const cfg = config.get()
      const day = today()
      const subject = 'admin-test'
      // The same gate as a classroom request (R6). A "test" that ignores the
      // concurrency limit is a way to put load on a shared GPU while the class
      // is using it, and the in-flight limit is the only thing protecting the
      // upstream from that.
      const gate = limiter.acquire(subject)
      if (!gate.ok) return json(res, 429, { error: gate.code }, { 'Retry-After': '2' })

      let reserved = false
      let outcome = null
      const settleOnce = (o) => {
        if (outcome) return
        outcome = o
        try { store.settle({ day, subject, outcome: o }) }
        catch (e) { log.error('quota settle failed', { code: e.code || e.message, outcome: o }) }
      }

      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      const t0 = Date.now()
      let out
      try {
        const slot = store.reserve({
          day,
          subject,
          dailyGlobal: cfg.limits.dailyGlobal,
          dailyPerSubject: cfg.limits.dailyPerIdentity
        })
        if (!slot.ok) return json(res, 429, { error: slot.reason, day })
        reserved = true
        out = await upstream.chat([
          { role: 'system', content: 'Reply with exactly: OK' },
          { role: 'user', content: 'Connection test. Answer with OK.' }
        ], ac.signal)
        settleOnce(out.ok ? 'completed' : (refundableOutcome(out) ? 'refunded' : 'unknown'))
      } finally {
        limiter.release(subject)
        if (reserved && !outcome) settleOnce('unknown')
      }
      const ms = Date.now() - t0
      log.info('admin generate test', { actor, ok: out.ok, code: out.code, ms })
      if (!out.ok) {
        return json(res, 200, {
          ok: false,
          code: out.code,
          generated: true,
          refunded: refundableOutcome(out),
          ms
        })
      }
      return json(res, 200, {
        ok: true,
        generated: true,
        chars: out.content.length,
        // The content itself is not echoed: an admin test does not need it, and
        // a model that echoes its prompt would leak the system prompt into the
        // audit trail.
        preview: out.content.slice(0, 40).replace(/\s+/g, ' '),
        ms,
        usage: usageReport()
      })
    }

    if (req.method === 'GET' && urlPath === '/api/admin/quota') {
      if (!store) {
        return json(res, 503, {
          error: 'storage_unavailable',
          area: startupFault ? startupFault.area : 'ledger'
        })
      }
      return json(res, 200, { ok: true, usage: usageReport() })
    }

    return json(res, 404, { error: 'not_found' })
  }
}
