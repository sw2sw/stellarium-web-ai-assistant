/* Configuration: two layers, on purpose.
 *
 *   boot config    environment only, read once, decides *where the process
 *                  listens and where its private directory lives*. An operator
 *                  edits this in the unit file / compose file.
 *
 *   runtime config everything a teacher-facing administrator may change while
 *                  the service runs: upstream base URL, model, key, on/off,
 *                  output cap, concurrency, daily quota. Persisted as a single
 *                  JSON document with a monotonic revision, so a change is
 *                  atomic: readers either see the whole old snapshot or the
 *                  whole new one.
 *
 * Nothing here trusts a request. In particular the upstream URL, the model id
 * and the credential are never taken from a browser: they live in the private
 * data directory and are edited only through /api/admin/*.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { ensurePrivateDir, writeFileAtomic } from './store.mjs'

export const CONFIG_SCHEMA = 1
/* Pre-R5 data directories keep their key here. It is read (so an upgrade does
 * not log everyone out of the model) but never written again: new keys go into
 * keys/rev-<n>.key and config.json points at them by name. */
export const KEY_FILE = 'upstream.key'
export const KEYS_DIR = 'keys'
export const CONFIG_FILE = 'config.json'

/* Addresses that must never be reachable through the admin-configured base URL,
 * even if someone lists them in the allowlist. These are cloud metadata
 * endpoints: they hand out instance credentials to anything that can GET them. */
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata'
])

const DEFAULTS = {
  enabled: false,
  baseUrl: '',
  model: '',
  authMode: 'auto', // auto = send Bearer only when a key is stored
  note: '',
  maxOutputTokens: 800,
  timeoutMs: 180000,
  idleTimeoutMs: 60000,
  connectTimeoutMs: 10000,
  globalInflight: 4,
  perIdentityInflight: 1,
  dailyGlobal: 400,
  dailyPerIdentity: 60,
  dayTz: 'Asia/Shanghai'
}

export class ValidationError extends Error {
  constructor (code, detail) {
    super(detail || code)
    this.code = code
    this.detail = detail || code
  }
}

/* A data directory the service refuses to interpret: unreadable, malformed or
 * inconsistent. Startup turns this into "AI closed, site up, reason logged"
 * rather than into a fresh empty state. */
export class ConfigError extends Error {
  constructor (code, detail) {
    super(detail || code)
    this.code = code
    this.detail = detail || code
  }
}

function int (name, raw, min, max) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(name + ' must be an integer in [' + min + ', ' + max + ']')
  }
  return n
}

/* ------------------------------------------------------------- boot --- */

export function loadBootConfig (env = process.env) {
  const list = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)

  const dataDir = path.resolve(env.SWE_DATA_DIR || path.join(process.cwd(), 'ai-service-data'))
  const requireAuth = !['0', 'false', 'no', 'off'].includes(
    String(env.SWE_REQUIRE_AUTH === undefined ? '1' : env.SWE_REQUIRE_AUTH).toLowerCase())

  const boot = {
    host: env.SWE_BIND || '127.0.0.1',
    port: Number(env.SWE_PORT || 8080),
    staticDir: path.resolve(env.SWE_STATIC_DIR || path.join(process.cwd(), '../packages/integrated-web/dist')),
    dataDir,
    logLevel: (env.SWE_LOG_LEVEL || 'info').trim(),
    publicOrigin: (env.SWE_PUBLIC_ORIGIN || '').trim().replace(/\/+$/, ''),
    // Reverse-proxy headers are only believed when the socket peer is one of
    // these addresses. Without it, X-Forwarded-Host is attacker-controlled.
    trustedProxies: list(env.SWE_TRUSTED_PROXY),
    // Hosts the admin may point the upstream at. Empty means "nothing may be
    // configured": fail closed rather than let an admin paste any URL.
    allowHosts: list(env.SWE_AI_ALLOWED_HOSTS).map((s) => s.toLowerCase()),
    requireAuth,
    auth: {
      classroom: list(env.SWE_ACCESS_TOKENS),
      classroomFile: (env.SWE_ACCESS_TOKENS_FILE || '').trim(),
      admin: list(env.SWE_ADMIN_TOKENS),
      adminFile: (env.SWE_ADMIN_TOKENS_FILE || '').trim()
    },
    // Tests only: forces a storage backend so both paths are exercised.
    storeBackend: (env.SWE_STORE_BACKEND || 'auto').trim()
  }

  if (!Number.isInteger(boot.port) || boot.port < 1 || boot.port > 65535) {
    throw new Error('SWE_PORT must be an integer in [1, 65535]')
  }
  if (boot.publicOrigin) {
    let u
    try { u = new URL(boot.publicOrigin) } catch { throw new Error('SWE_PUBLIC_ORIGIN is not a valid URL') }
    if (u.pathname !== '/' && u.pathname !== '') throw new Error('SWE_PUBLIC_ORIGIN must be an origin, not a path')
    boot.publicOrigin = u.origin
  }
  return boot
}

/* ------------------------------------------------- upstream allowlist --- */

/* Exact host, host:port, or a single leading "*." wildcard. Deliberately not a
 * regex: a mistyped pattern in an SSRF allowlist is a hole, not a typo. */
export function hostAllowed (allowHosts, url) {
  const host = url.host.toLowerCase()
  const hostname = url.hostname.toLowerCase()
  if (METADATA_HOSTS.has(host) || METADATA_HOSTS.has(hostname)) return false
  for (const entry of allowHosts) {
    if (entry === host || entry === hostname) return true
    if (entry.startsWith('*.') && hostname.endsWith(entry.slice(1)) && hostname !== entry.slice(2)) return true
  }
  return false
}

/* Validates and normalises an admin-supplied base URL.
 *
 * The result is a base with no trailing slash; the client appends a fixed
 * /chat/completions. Anything the URL parser would happily accept but an
 * operator would not recognise - embedded credentials, a query, a fragment,
 * a javascript: scheme - is refused here rather than discovered later. */
export function parseUpstream (raw, allowHosts) {
  const text = String(raw || '').trim()
  if (!text) throw new ValidationError('base_url_required')
  let u
  try { u = new URL(text) } catch { throw new ValidationError('base_url_invalid') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ValidationError('base_url_scheme')
  if (u.username || u.password) throw new ValidationError('base_url_credentials')
  if (u.search) throw new ValidationError('base_url_query')
  if (u.hash) throw new ValidationError('base_url_fragment')
  if (u.pathname !== '/' && !/^\/[A-Za-z0-9._~\-/]*$/.test(u.pathname)) {
    throw new ValidationError('base_url_path')
  }
  if (!allowHosts || allowHosts.length === 0) throw new ValidationError('allowlist_not_configured')
  if (!hostAllowed(allowHosts, u)) throw new ValidationError('host_not_allowed')
  const base = (u.origin + u.pathname).replace(/\/+$/, '')
  return { base, origin: u.origin, protocol: u.protocol, host: u.host }
}

/* -------------------------------------------------------- runtime cfg --- */

function normaliseLimits (raw) {
  const src = raw || {}
  return {
    maxOutputTokens: int('maxOutputTokens', src.maxOutputTokens === undefined ? DEFAULTS.maxOutputTokens : src.maxOutputTokens, 16, 8192),
    timeoutMs: int('timeoutMs', src.timeoutMs === undefined ? DEFAULTS.timeoutMs : src.timeoutMs, 5000, 300000),
    idleTimeoutMs: int('idleTimeoutMs', src.idleTimeoutMs === undefined ? DEFAULTS.idleTimeoutMs : src.idleTimeoutMs, 2000, 120000),
    connectTimeoutMs: int('connectTimeoutMs', src.connectTimeoutMs === undefined ? DEFAULTS.connectTimeoutMs : src.connectTimeoutMs, 1000, 30000),
    globalInflight: int('globalInflight', src.globalInflight === undefined ? DEFAULTS.globalInflight : src.globalInflight, 1, 64),
    perIdentityInflight: int('perIdentityInflight', src.perIdentityInflight === undefined ? DEFAULTS.perIdentityInflight : src.perIdentityInflight, 1, 16),
    dailyGlobal: int('dailyGlobal', src.dailyGlobal === undefined ? DEFAULTS.dailyGlobal : src.dailyGlobal, 0, 100000),
    dailyPerIdentity: int('dailyPerIdentity', src.dailyPerIdentity === undefined ? DEFAULTS.dailyPerIdentity : src.dailyPerIdentity, 0, 10000),
    dayTz: String(src.dayTz === undefined ? DEFAULTS.dayTz : src.dayTz)
  }
}

function validTimeZone (tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    return true
  } catch { return false }
}

export function createConfigStore (boot, opts = {}) {
  const log = opts.log
  /* Test seam (C1 evidence): the function used to publish config.json and the
   * per-revision key files. Same contract as writeFileAtomic, so a unit can
   * inject "the rename published, then the directory fsync failed" without a
   * disk that lies on cue. Production always uses the real one. */
  const write = opts.write || writeFileAtomic
  const dir = boot.dataDir
  ensurePrivateDir(dir)
  const configPath = path.join(dir, CONFIG_FILE)
  const legacyKeyPath = path.join(dir, KEY_FILE)
  const keysDir = path.join(dir, KEYS_DIR)

  let current = {
    schema: CONFIG_SCHEMA,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    enabled: DEFAULTS.enabled,
    note: DEFAULTS.note,
    upstream: { baseUrl: '', model: '', authMode: DEFAULTS.authMode, keyRef: '', hasKey: false },
    limits: normaliseLimits({})
  }
  const keyCache = { path: '', value: '', mtimeMs: -1 }

  function ensureKeysDir () {
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 })
    return keysDir
  }

  function keyPathFor (ref) {
    if (!/^rev-\d+$/.test(String(ref || ''))) return ''
    return path.join(keysDir, ref + '.key')
  }

  function readKeyFile (file) {
    if (!file) return ''
    let st
    try { st = fs.statSync(file) } catch { return '' }
    if (file === keyCache.path && st.mtimeMs === keyCache.mtimeMs) return keyCache.value
    try {
      const v = fs.readFileSync(file, 'utf8').trim()
      keyCache.path = file
      keyCache.value = v
      keyCache.mtimeMs = st.mtimeMs
      return v
    } catch (e) {
      // Unreadable key file: treat as "no key" (the paid route closes) but say
      // so, because it looks exactly like "nobody configured one".
      if (log) log.warn('stored key unreadable', { code: e.code })
      return ''
    }
  }

  /* The credential in effect is whatever the current configuration points at.
   *
   * A legacy upstream.key is honoured only while the configuration on disk
   * predates key references (a pre-R5 document has no upstream.keyRef field at
   * all). Once a document carries keyRef - even an empty one - the legacy file
   * is dead bytes, not a fallback: the round-2 review caught clearKey() leaving
   * an undeletable legacy file that the empty keyRef then re-adopted on the
   * next enable, resurrecting a credential the operator had explicitly cleared.
   * "明确已清除" and "旧版迁移待处理" are different states and both are
   * reported as such (keySource below). */
  let legacyFallback = true

  function legacyKeyPresent () {
    try { return fs.statSync(legacyKeyPath).isFile() } catch { return false }
  }

  function readKey () {
    if (current.upstream.keyRef) return readKeyFile(keyPathFor(current.upstream.keyRef))
    if (legacyFallback) return readKeyFile(legacyKeyPath)
    return ''
  }

  /* Which source the effective credential comes from, and whether an old
   * upstream.key is still sitting in the directory waiting to be retired.
   * Exposed so the operator can tell "the key in effect is the legacy one -
   * saving a new key (or clearing) finishes the migration" apart from "the
   * legacy file is gone". */
  function keySource () {
    if (current.upstream.keyRef) return 'revision'
    return legacyFallback && legacyKeyPresent() ? 'legacy' : 'none'
  }

  function writeKeyForRevision (revision, value) {
    ensureKeysDir()
    const file = path.join(keysDir, 'rev-' + revision + '.key')
    try {
      write(file, value)
    } catch (e) {
      /* C1 policy for the key file itself: a fault after its rename leaves the
       * content on disk with only the directory entry unproven. The config
       * publish below is the atomic gate - if it succeeds the pair is in
       * effect, and if a crash later loses the key file's entry the config
       * references a missing key and readKey() fails closed. If the config
       * publish fails BEFORE its rename instead, the key file stays an
       * unreferenced orphan (the case the R5 fault-window test pins). */
      if (!e || !e.published) throw e
      if (log) log.warn('key file published but its directory entry is not proven durable',
        { detail: e.detail || e.message })
    }
    try { fs.chmodSync(file, 0o600) } catch { /* windows */ }
    return file
  }

  /* Only the key the current config points at survives a save.
   *
   * Keeping a few old revisions around was friendlier for a rollback, but a key
   * that has been rotated is usually rotated because it leaked, and a copy left
   * on disk is still a working credential: "we replaced it" has to mean the
   * bytes are gone. A rollback to an older config.json therefore needs the key
   * typed in again, which is the honest cost of rotating. Best effort - a
   * leftover file is reported by clearKey rather than being fatal.
   *
   * The legacy upstream.key is part of the same rule (review round 2, R5): the
   * rotation that produces the first versioned key is exactly the moment the
   * legacy bytes stop being an upgrade convenience and become a second live
   * credential, so prune deletes it too. A file that cannot be unlinked is
   * reported (legacyPending stays visible in the snapshot); it is never read
   * again, because the document now carries a keyRef. */
  function pruneKeys (keepRef) {
    let names
    try { names = fs.readdirSync(keysDir) } catch { return }
    for (const n of names) {
      const m = /^(rev-\d+)\.key$/.exec(n)
      if (!m || m[1] === keepRef) continue
      try { fs.unlinkSync(path.join(keysDir, n)) } catch { /* ignore */ }
    }
    if (/^rev-\d+$/.test(String(keepRef))) {
      try { fs.unlinkSync(legacyKeyPath) } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('legacy key file could not be removed', { code: e.code })
      }
    }
  }

  function loadFromDisk () {
    let raw
    try { raw = fs.readFileSync(configPath, 'utf8') } catch (e) {
      if (e.code === 'ENOENT') return
      // Unreadable for another reason (permissions, I/O): stay closed and keep
      // the file. Rewriting it would destroy what the operator needs to see.
      if (log) log.warn('config unreadable; staying closed', { code: e.code })
      return
    }
    let doc
    try { doc = JSON.parse(raw) } catch {
      if (log) log.warn('config is not valid JSON; staying closed, file left in place')
      return
    }
    if (!doc || doc.schema !== CONFIG_SCHEMA) {
      if (log) log.warn('config schema mismatch; staying closed', { schema: doc && doc.schema })
      return
    }
    try {
      const up = doc.upstream || {}
      // A document without any keyRef field predates the versioned-key store:
      // its credential lives in the legacy file and stays honoured until the
      // operator saves (which writes a keyRef and retires the legacy copy).
      // Anything written by this generation carries keyRef, so the legacy file
      // is no longer a fallback there - including after a clearKey.
      legacyFallback = !(doc.upstream && Object.prototype.hasOwnProperty.call(doc.upstream, 'keyRef'))
      current = {
        schema: CONFIG_SCHEMA,
        revision: Number.isInteger(doc.revision) ? doc.revision : 0,
        updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
        updatedBy: typeof doc.updatedBy === 'string' ? doc.updatedBy : null,
        enabled: doc.enabled === true,
        note: typeof doc.note === 'string' ? doc.note : '',
        upstream: {
          baseUrl: typeof up.baseUrl === 'string' ? up.baseUrl : '',
          model: typeof up.model === 'string' ? up.model : '',
          authMode: ['auto', 'none'].includes(up.authMode) ? up.authMode : 'auto',
          keyRef: /^rev-\d+$/.test(String(up.keyRef || '')) ? up.keyRef : '',
          hasKey: false
        },
        limits: normaliseLimits(doc.limits)
      }
      current.upstream.hasKey = !!readKey()
    } catch (e) {
      if (log) log.warn('config rejected on load', { detail: e.detail || e.message })
    }
  }

  function persist (next) {
    const doc = {
      schema: CONFIG_SCHEMA,
      revision: next.revision,
      updatedAt: next.updatedAt,
      updatedBy: next.updatedBy,
      enabled: next.enabled,
      note: next.note,
      upstream: {
        baseUrl: next.upstream.baseUrl,
        model: next.upstream.model,
        authMode: next.upstream.authMode,
        // The pointer, not the credential: one atomic rename publishes the new
        // configuration together with the key it refers to (R5).
        keyRef: next.upstream.keyRef || ''
      },
      limits: next.limits
    }
    write(configPath, JSON.stringify(doc, null, 2) + '\n')
    try { fs.chmodSync(configPath, 0o600) } catch { /* windows */ }
  }

  /* The durability question a directory fsync answers. Null while the last
   * publish is either proven or pre-rename-failed; set when a publish renamed
   * but could not prove the directory entry. While it is set the paid route is
   * closed: the configuration that decides where money goes must not keep
   * serving when a crash could silently revert it to the previous revision
   * (review round 3, C1). Cleared by the next publish that proves itself, or
   * by a restart that reads whatever the disk actually kept. */
  let syncUnverified = null

  /* Publish `next` and adopt it in memory.
   *
   * Two very different failures. A failure BEFORE the rename leaves the old
   * document on disk: rethrow, and the caller keeps the old snapshot - the
   * reported failure is the truth. A failure AFTER the rename (the directory
   * fsync) leaves the NEW document on disk; keeping the OLD snapshot in memory
   * here is what C1 was: the process would keep generating under a
   * configuration the next restart would not see, and later saves could reuse
   * a revision number and key file name the disk already used. So the
   * published snapshot is adopted - memory matches the disk the next restart
   * will read - the fault is latched, and the error still travels to the
   * caller, because "saved but durability unverified, route closed" is not a
   * clean success. */
  function publish (next) {
    try {
      persist(next)
    } catch (e) {
      if (!e || !e.published) throw e
      adopt(next, e.detail || e.message)
      throw new ConfigError('config_sync_unverified',
        'configuration was published but not proven durable (' + (e.detail || e.message) + '); ' +
        'the paid route stays closed until a verified save or a restart')
    }
    adopt(next, null)
  }

  function adopt (next, fault) {
    current = next
    // The published document always carries a keyRef field: the legacy file is
    // dead bytes from here on, exactly as a clean save would have decided.
    legacyFallback = false
    syncUnverified = fault
    // The adopted document is the one the next restart will read, so the keys
    // it superseded are unreferenced bytes exactly as after a clean save - the
    // same prune runs on both paths. Skipping it here (round-4 review) left
    // the previous revision's key file on disk whenever an adopted publish
    // still reported a fault, and a later clearKey only swept the key that was
    // current at the clear. Best effort either way: a file that cannot be
    // unlinked now is swept by the next explicit clear.
    if (next.upstream.keyRef) pruneKeys(next.upstream.keyRef)
    if (fault && log) {
      log.error('configuration published but durability unverified; paid route closed',
        { revision: next.revision, detail: fault })
    }
  }

  loadFromDisk()

  /* Is the saved target still permitted by the allowlist in force right now?
   * Checked on every live() call so that removing a host from
   * SWE_AI_ALLOWED_HOSTS closes an already-configured deployment, including
   * after a restart (R8). */
  function upstreamAllowed () {
    const base = current.upstream.baseUrl
    if (!base) return false
    let u
    try { u = new URL(base) } catch { return false }
    return hostAllowed(boot.allowHosts, u)
  }

  function snapshot () {
    return {
      schema: current.schema,
      revision: current.revision,
      updatedAt: current.updatedAt,
      updatedBy: current.updatedBy,
      enabled: current.enabled,
      note: current.note,
      upstream: Object.assign({}, current.upstream, {
        hasKey: !!readKey(),
        keySource: keySource(),
        // Old bytes still sitting in the directory. With a keyRef in effect
        // they are a leftover to retire, not a key in use; with a legacy
        // document they are the migration itself (R5).
        legacyPending: legacyKeyPresent(),
        allowed: upstreamAllowed()
      }),
      limits: Object.assign({}, current.limits)
    }
  }

  /* live = switched on AND target AND model AND the target still allowed AND
   * (a key, or auth explicitly off) AND the last publish is proven durable.
   * The last condition is C1: after a publish that renamed but could not fsync
   * the directory, the disk claims a configuration whose survival across a
   * crash is unknown, so the honest state is closed until the operator
   * re-verifies with a clean save (or a restart reads what the disk kept). */
  function live () {
    if (syncUnverified) return false
    if (!current.enabled) return false
    if (!current.upstream.model) return false
    if (!upstreamAllowed()) return false
    const authOk = current.upstream.authMode === 'none' || !!readKey()
    return !!authOk
  }

  /* Same shape as the ledger's syncHealth: the operator sees "the last config
   * publish is on disk but its durability is unproven, and the paid route is
   * closed until that is resolved" instead of inferring it from a 503. */
  function syncHealth () {
    return { degraded: !!syncUnverified, lastError: syncUnverified }
  }

  function missing () {
    const out = []
    if (!current.upstream.baseUrl) out.push('baseUrl')
    if (!current.upstream.model) out.push('model')
    if (current.upstream.baseUrl && !upstreamAllowed()) out.push('allowlist')
    if (current.upstream.authMode !== 'none' && !readKey()) out.push('key')
    return out
  }

  function assertRevision (expected) {
    if (expected === undefined || expected === null) return
    if (!Number.isInteger(expected)) throw new ValidationError('revision_required')
    if (expected !== current.revision) {
      throw new ValidationError('revision_conflict',
        'configuration is at revision ' + current.revision + ', not ' + expected)
    }
  }

  /* Every write is compare-and-set, including the ones made through the
   * standalone key endpoint (R9 supplement): a missing or null expectedRevision
   * here used to be waved through, so a direct API call could write or clear a
   * credential outside the versioning the admin page obeys. Only the emergency
   * stop is exempt, on purpose. */
  function assertRevisionRequired (expected) {
    if (expected === undefined || expected === null) {
      throw new ValidationError('revision_required',
        'this operation is compare-and-set; send the revision you read (current: ' + current.revision + ')')
    }
    assertRevision(expected)
  }

  return {
    dir,
    get: snapshot,
    live,
    missing,
    key: readKey,
    syncHealth,

    /* Applies a validated patch. Either every field is accepted or nothing
     * changes: a half-applied configuration is worse than a rejected one,
     * because the operator believes it took effect.
     *
     * The key, when present in the patch, is committed as part of the same save
     * and the same revision. Two revisions for one click would make "rev 5" in
     * an audit line ambiguous about what was actually in effect.
     *
     * Ordering matters (R5). The key is written first, to a file named after
     * the revision that is about to become current, and the configuration -
     * which names that file - is published afterwards with one atomic rename.
     * A crash or a failed write between the two leaves the OLD revision and the
     * OLD key in effect, plus an unreferenced key file nobody uses. The reverse
     * order would let a new credential be sent to the old endpoint. */
    apply (patch, actor, expectedRevision) {
      assertRevisionRequired(expectedRevision)
      const next = snapshot()
      const p = patch || {}

      // Format-checked here, written at commit time below. An empty value means
      // "leave the stored key alone", which is what an untouched password box
      // sends.
      const newKey = p.key === undefined ? '' : String(p.key)
      if (newKey) {
        if (newKey.length > 512) throw new ValidationError('key_too_long')
        if (/\s/.test(newKey)) throw new ValidationError('key_whitespace')
      }

      if (p.baseUrl !== undefined) {
        const up = parseUpstream(p.baseUrl, boot.allowHosts)
        next.upstream.baseUrl = up.base
      }
      if (p.model !== undefined) {
        const m = String(p.model || '').trim()
        if (!m) throw new ValidationError('model_required')
        if (m.length > 200) throw new ValidationError('model_too_long')
        if (!/^[A-Za-z0-9._:\-/@+ ]+$/.test(m)) throw new ValidationError('model_charset')
        next.upstream.model = m
      }
      if (p.authMode !== undefined) {
        if (!['auto', 'none'].includes(p.authMode)) throw new ValidationError('auth_mode')
        next.upstream.authMode = p.authMode
      }
      if (p.note !== undefined) {
        const n = String(p.note || '')
        if (n.length > 500) throw new ValidationError('note_too_long')
        next.note = n
      }
      if (p.enabled !== undefined) next.enabled = p.enabled === true
      if (p.limits !== undefined) {
        next.limits = normaliseLimits(Object.assign({}, next.limits, p.limits))
        if (!validTimeZone(next.limits.dayTz)) throw new ValidationError('day_tz')
        if (next.limits.perIdentityInflight > next.limits.globalInflight) {
          throw new ValidationError('per_identity_above_global')
        }
      }

      // A target the allowlist no longer permits cannot be switched on.
      if (next.enabled && next.upstream.baseUrl) {
        let u
        try { u = new URL(next.upstream.baseUrl) } catch { u = null }
        if (!u || !hostAllowed(boot.allowHosts, u)) throw new ValidationError('host_not_allowed')
      }

      // Turning the feature on without a usable target would advertise an
      // option that answers 503 to every request.
      if (next.enabled) {
        if (!next.upstream.baseUrl) throw new ValidationError('enable_without_base_url')
        if (!next.upstream.model) throw new ValidationError('enable_without_model')
        if (next.upstream.authMode !== 'none' && !newKey && !readKey()) {
          throw new ValidationError('enable_without_key')
        }
      }

      next.revision = current.revision + 1
      next.updatedAt = new Date().toISOString()
      next.updatedBy = actor || 'unknown'

      if (newKey) {
        writeKeyForRevision(next.revision, newKey)
        next.upstream.keyRef = 'rev-' + next.revision
        next.upstream.hasKey = true
      } else if (legacyFallback && !next.upstream.keyRef && readKey()) {
        // First save on a legacy deployment: the credential that was in effect
        // moves into the versioned store as part of THIS revision. Not doing
        // this would make the first save - with the key box untouched - drop
        // the working key, because the document being written carries a keyRef
        // and the legacy fallback ends here.
        writeKeyForRevision(next.revision, readKey())
        next.upstream.keyRef = 'rev-' + next.revision
        next.upstream.hasKey = true
      }
      // Publish, then adopt. A pre-rename failure leaves the old document on
      // disk and the old snapshot in memory - and the old key file in place,
      // because nothing was adopted (the reported failure is the truth). A
      // post-rename durability fault is adopted and latched inside publish(),
      // which also prunes the keys the adopted document superseded, so the
      // process never keeps generating under a configuration the next restart
      // would not see (C1) and no superseded credential survives it (round 4).
      publish(next)
      return { revision: next.revision, live: live() }
    },

    /* Empty input never clears the key. Clearing is its own explicit call, so a
     * "save" with the key box left blank cannot silently break the deployment. */
    setKey (value, actor, expectedRevision) {
      assertRevisionRequired(expectedRevision)
      const v = String(value === undefined || value === null ? '' : value)
      if (!v) return { changed: false, revision: current.revision }
      if (v.length > 512) throw new ValidationError('key_too_long')
      if (/\s/.test(v)) throw new ValidationError('key_whitespace')

      const next = snapshot()
      next.revision = current.revision + 1
      next.updatedAt = new Date().toISOString()
      next.updatedBy = actor || 'unknown'
      writeKeyForRevision(next.revision, v)
      next.upstream.keyRef = 'rev-' + next.revision
      next.upstream.hasKey = true
      // Adoption inside publish() prunes the superseded key files on both the
      // clean and the adopted-fault path.
      publish(next)
      return { changed: true, revision: next.revision }
    },

    clearKey (actor, expectedRevision) {
      assertRevisionRequired(expectedRevision)
      const had = !!readKey()
      const next = snapshot()
      next.upstream.keyRef = ''
      next.upstream.hasKey = false
      // Clearing the key while the feature is on would leave a live route with
      // no credential; the honest result is to switch the feature off.
      if (next.enabled && next.upstream.authMode !== 'none') next.enabled = false
      next.revision = current.revision + 1
      next.updatedAt = new Date().toISOString()
      next.updatedBy = actor || 'unknown'
      // Publish the pointer first: after this line the credential is out of
      // effect even if the unlink below fails. A durability fault AFTER the
      // rename is adopted (memory follows the published, keyless document)
      // and latched - but the cleanup below still runs, because the bytes it
      // removes are unreferenced either way (C1).
      let syncFault = null
      try {
        persist(next)
        adopt(next, null)
      } catch (e) {
        if (!e || !e.published) throw e
        syncFault = e.detail || e.message
        adopt(next, syncFault)
      }
      // The published document carries a keyRef (an empty one): a leftover
      // legacy file is dead bytes from here on, in this process and after a
      // restart. This is what keeps "明确已清除" from quietly becoming "旧版
      // 迁移待处理" again.
      legacyFallback = false

      // After a clear NOTHING is referenced any more, so the sweep covers
      // EVERY version file plus the legacy one - not just the key that was
      // current at the clear. Older revision files can be sitting here from
      // earlier saves or from an adopted faulted publish (round-4 review):
      // each of them is a live credential until its bytes are gone, and
      // "换掉了必须意味着字节没了" applies to all of them.
      let leftover = null
      const files = [legacyKeyPath]
      try {
        for (const n of fs.readdirSync(keysDir)) {
          if (/^rev-\d+\.key$/.test(n)) files.push(path.join(keysDir, n))
        }
      } catch { /* no keys directory */ }
      for (const f of files) {
        if (!f) continue
        try { fs.unlinkSync(f) } catch (e) { if (e.code !== 'ENOENT') leftover = e.code }
      }
      keyCache.path = ''
      keyCache.value = ''
      keyCache.mtimeMs = -1
      if (leftover && log) log.warn('key file could not be removed', { code: leftover })
      if (syncFault) {
        throw new ConfigError('config_sync_unverified',
          'the cleared configuration was published but not proven durable (' + syncFault + '); ' +
          'the paid route stays closed until a verified save or a restart')
      }
      return { changed: had, revision: next.revision, live: live(), leftover }
    },

    /* Emergency stop: takes effect for the next request, not the next restart.
     * In-flight calls are not aborted (that would be a different promise); the
     * admin UI says so. It deliberately does not take an expected revision: a
     * stop must never be blocked by a stale form, and the revision it bumps is
     * exactly what makes every older form stale (R9). A published durability
     * fault here is adopted like any other publish: the stop IS in effect on
     * disk and in memory, and the latch adds nothing worse than what the stop
     * already did - but the caller still hears that durability is unproven. */
    emergencyStop (actor) {
      const next = snapshot()
      next.enabled = false
      next.revision = current.revision + 1
      next.updatedAt = new Date().toISOString()
      next.updatedBy = actor || 'unknown'
      publish(next)
      return { revision: next.revision }
    }
  }
}

/* The identity secret makes the quota ledger keyed by something that cannot be
 * read back out of the database: sha256(token) would let anyone holding the
 * ledger brute-force a weak passphrase offline. Generated once, 0600.
 *
 * It is generated ONLY when the file does not exist AND the directory around it
 * is genuinely fresh. A file that is present but unreadable or malformed is a
 * data-directory fault, and so is a MISSING file in a directory that already
 * holds a ledger, a configuration or a versioned key (review round 2, B3):
 * generating a new secret there would silently re-key every passphrase, so
 * today's ledger would stop matching the people it belongs to and every class
 * would look like it had spent nothing - the exact scenario "restore a backup
 * and forget identity.key" produces. The caller turns both faults into "AI
 * closed, site up, fix the data directory". */
export function loadIdentitySecret (dataDir) {
  ensurePrivateDir(dataDir)
  const file = path.join(dataDir, 'identity.key')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw new ConfigError('identity_unreadable', 'identity.key cannot be read (' + e.code + ')')
    }
    raw = null
  }
  if (raw === null) {
    const marks = initializedMarks(dataDir)
    if (marks.length) {
      throw new ConfigError('identity_missing',
        'identity.key is missing but the data directory is already initialized (' +
        marks.join(', ') + '); restore identity.key from backup or start from an empty directory')
    }
    const secret = crypto.randomBytes(32)
    writeFileAtomic(file, secret.toString('hex'))
    try { fs.chmodSync(file, 0o600) } catch { /* windows */ }
    return secret
  }
  const hex = raw.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ConfigError('identity_invalid', 'identity.key is not 32 hex-encoded bytes')
  }
  return Buffer.from(hex, 'hex')
}

/* What marks a data directory as "this is not the first run". A ledger (either
 * backend), a saved configuration or a versioned key file each mean a previous
 * service ran here; a bare keys/ directory without any key file does not, and
 * neither does an empty directory. */
function initializedMarks (dir) {
  const marks = []
  for (const name of [CONFIG_FILE, 'quota.json', 'quota.db']) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) marks.push(name)
    } catch { /* not there */ }
  }
  try {
    if (fs.readdirSync(path.join(dir, KEYS_DIR)).some((n) => /^rev-\d+\.key$/.test(n))) {
      marks.push(KEYS_DIR + '/')
    }
  } catch { /* no keys directory */ }
  return marks
}
