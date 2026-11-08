/* Durable quota storage.
 *
 * Why this file exists: the earlier build counted requests in a Map keyed by
 * the session cookie. Clearing the cookie, opening a private window or
 * restarting the container reset the budget, so "daily limit" was a promise the
 * code could not keep (task book P0-2).
 *
 * Two backends, one contract:
 *   - node:sqlite   Node >= 22.5, real transactions, a single file.
 *   - json journal  any Node, one document, atomic replace + fsync.
 *
 * The fallback is not decoration. The deployment target's Node version was
 * checked before choosing (see docs/SERVER-AI.md "Node and storage"); if the
 * runtime turns out to lack node:sqlite the service still enforces a durable
 * quota instead of silently degrading to memory.
 *
 * Failure direction (R2). A ledger that cannot be read is NOT an empty ledger.
 * Starting over from zero would hand every class a fresh budget on the day the
 * disk filled up, so an unreadable, corrupt or unknown-schema ledger makes
 * openStore() throw: the caller keeps the site up and refuses to generate, and
 * the original file stays exactly where it is for the operator to inspect.
 * For the same reason the backend is never switched silently: a data directory
 * that already holds a quota.db is not quietly re-opened as a fresh quota.json.
 *
 * Counting model, per calendar day and per subject:
 *
 *   reserved   a paid call has been authorised and is (or was) in flight
 *   completed  the upstream answered and the client was served
 *   unknown    we cannot say whether the upstream billed it (timeout, abort,
 *              5xx). Never refunded, never retried.
 *   refunded   the upstream definitely did not generate (401/403/404/4xx/429)
 *
 * "Used" = reserved + completed + unknown. A refund moves reserved -> refunded,
 * which is the only path that gives budget back, and it is only taken when the
 * outcome is known to have produced nothing.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const STATES = ['reserved', 'completed', 'unknown', 'refunded']

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const SUBJECT_RE = /^[A-Za-z0-9_-]{1,64}$/

/* A ledger problem the operator has to resolve. The service turns this into
 * "AI closed, site up, here is why", never into a fresh empty budget. */
export class StoreError extends Error {
  constructor (code, detail) {
    super(detail || code)
    this.code = code
    this.detail = detail || code
  }
}

/* ------------------------------------------------------------- helpers --- */

function ensurePrivateDir (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    const st = fs.statSync(dir)
    // Not fatal on a platform without POSIX modes, but worth saying out loud:
    // the directory holds the upstream key and the quota ledger.
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700)
    }
  } catch { /* best effort */ }
}

/* fsync, but only swallow the errors that mean "this platform cannot". A full
 * disk or an I/O error must not be reported as a successful commit: the caller
 * would then tell a teacher "allowed" for a reservation that is not on disk. */
function fsyncStrict (fd) {
  try {
    fs.fsyncSync(fd)
  } catch (e) {
    if (e.code === 'EINVAL' || e.code === 'ENOTSUP' || e.code === 'EISDIR' || e.code === 'EBADF') return
    throw e
  }
}

/* The half of the atomic write that used to be swallowed wholesale (review
 * round 2): fsyncing the directory so the rename itself survives a power cut.
 *
 * Two very different things used to land in the same silent catch. "This
 * platform cannot fsync a directory at all" is a property of the deployment
 * and is accepted: Windows opens the directory fd but answers EPERM to the
 * fsync, some filesystems answer EINVAL/ENOTSUP. A real I/O error - EIO,
 * ENOSPC, a directory that vanished - is a persistence fault: reporting
 * "saved" for a rename whose directory entry may not exist after a crash is
 * exactly the lie R2 forbids. Those throw. */
function syncDirectory (dir) {
  const platformCannot = (code) =>
    code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EBADF' ||
    (process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EACCES' || code === 'EISDIR' || code === 'EBUSY'))
  let dfd
  try {
    dfd = fs.openSync(dir, 'r')
  } catch (e) {
    if (platformCannot(e.code)) return 'unsupported'
    throw new StoreError('dir_sync_failed',
      'data directory cannot be opened for fsync (' + (e.code || e.message) + '): ' + dir)
  }
  try {
    fsyncStrict(dfd)
    return 'ok'
  } catch (e) {
    if (platformCannot(e.code)) return 'unsupported'
    throw new StoreError('dir_sync_failed',
      'directory fsync failed (' + (e.code || e.message) + '): ' + dir)
  } finally {
    try { fs.closeSync(dfd) } catch { /* ignore */ }
  }
}

/* Write tmp + fsync + rename, then fsync the directory entry. The error that
 * can happen after the rename carries `published: true`: the caller cannot
 * roll that back, so it must not pretend the old state is still in effect. */
function writeFileAtomic (file, data) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + crypto.randomBytes(6).toString('hex') + '.tmp')
  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(fd, data)
    fsyncStrict(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    throw e
  }
  try {
    syncDirectory(dir)
  } catch (e) {
    // Reached only after the rename: the new content IS the file's content
    // now. Callers use the flag to pick "published but not proven durable"
    // over "nothing was written".
    if (e instanceof StoreError) e.published = true
    throw e
  }
}

/* --------------------------------------------------------- json backend --- */

/* A ledger the service refuses to interpret is a fault; one it misreads is a
 * reset. This is the second half of the R2 posture: `days` must be a plain
 * object with real date keys and real counts, because a document like
 * `{"schema":1,"days":[]}` used to pass the old "is it an object?" check and
 * then quietly lose every count on the next save - string keys on an array do
 * not survive JSON.stringify, so a restart handed every class a fresh budget. */
function validateLedgerDoc (parsed, file) {
  const bad = (why) => new StoreError('ledger_schema', 'quota ledger ' + why + ': ' + file)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('is not an object')
  if (parsed.schema !== 1) throw bad('has an unknown schema')
  const days = parsed.days
  if (!days || typeof days !== 'object' || Array.isArray(days)) throw bad('days is not an object')
  const count = (v, where) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 1e9) {
      throw bad('has an unusable count at ' + where)
    }
  }
  const cellOf = (owner, cell) => {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) throw bad(owner + ' is not an object')
    for (const state of Object.keys(cell)) {
      if (!STATES.includes(state)) throw bad('has an unknown state ' + JSON.stringify(state) + ' at ' + owner)
      count(cell[state], owner + '/' + state)
    }
  }
  for (const day of Object.keys(days)) {
    if (!DAY_RE.test(day)) throw bad('has a malformed day key ' + JSON.stringify(day))
    // Shape alone is not enough: 2026-13-99 matches the pattern but is not a
    // day, and a day key that will never be pruned or aggregated is corruption
    // wearing a valid-looking coat.
    let canonical = null
    try { canonical = new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) } catch { /* invalid */ }
    if (canonical !== day) {
      throw bad('has an impossible day key ' + JSON.stringify(day))
    }
    const b = days[day]
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('day ' + day + ' is not an object')
    for (const k of Object.keys(b)) {
      if (k !== 'global' && k !== 'subjects') throw bad('day ' + day + ' has an unexpected field ' + JSON.stringify(k))
    }
    cellOf(day + '/global', b.global || {})
    const subjects = b.subjects || {}
    if (!subjects || typeof subjects !== 'object' || Array.isArray(subjects)) {
      throw bad('day ' + day + ' subjects is not an object')
    }
    for (const subject of Object.keys(subjects)) {
      if (!SUBJECT_RE.test(subject)) throw bad('has a malformed subject key ' + JSON.stringify(subject))
      cellOf(day + '/' + subject, subjects[subject])
    }
  }
}

function createJsonBackend (file, log, write) {
  // `write` is a test seam: it has the same contract as writeFileAtomic, so a
  // unit can inject "the rename published, then the directory fsync failed"
  // without needing a disk that lies on cue. Production always passes the real
  // one (the default below).
  const publish = write || writeFileAtomic
  // `view` is the document every read and write goes through. Inside a
  // transaction it points at a private draft; it is swapped back only after the
  // draft has been persisted, so a failed write leaves memory and disk agreeing
  // on the previous state (R2 supplement: no partial commits).
  let view = { schema: 1, days: {} }
  let depth = 0
  // Latched while the last publish ended after the rename but before a clean
  // directory fsync (ledger_sync_failed). The counts are live and on disk, but
  // a crash right now could take the directory entry with it, and the operator
  // gets to see that instead of a clean bill of health. Cleared by the next
  // publish that fsyncs (or is told the platform cannot).
  let syncFault = null

  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw new StoreError('ledger_unreadable', 'quota ledger cannot be read (' + e.code + '): ' + file)
    }
    raw = null
  }
  if (raw !== null) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new StoreError('ledger_corrupt', 'quota ledger is not valid JSON: ' + file)
    }
    validateLedgerDoc(parsed, file)
    view = parsed
    if (log) log.info('quota ledger loaded', { file, days: Object.keys(view.days).length })
  }

  function bucket (day) {
    if (!view.days[day]) view.days[day] = { global: {}, subjects: {} }
    return view.days[day]
  }
  function cell (day, subject) {
    const b = bucket(day)
    if (subject === 'global') {
      if (!b.global) b.global = {}
      return b.global
    }
    if (!b.subjects) b.subjects = {}
    if (!b.subjects[subject]) b.subjects[subject] = {}
    return b.subjects[subject]
  }

  return {
    kind: 'json',
    get (day, subject, state) {
      const c = cell(day, subject)
      const n = c[state]
      return Number.isFinite(n) ? n : 0
    },
    add (day, subject, state, delta) {
      const c = cell(day, subject)
      c[state] = Math.max(0, (Number.isFinite(c[state]) ? c[state] : 0) + delta)
    },
    tx (fn) {
      // Single writer, synchronous: the atomic replace below is the commit.
      if (depth > 0) return fn() // nested calls join the outer transaction
      const draft = structuredClone(view)
      const prev = view
      view = draft
      depth = 1
      let out
      try {
        out = fn()
      } catch (e) {
        view = prev
        depth = 0
        throw e
      }
      try {
        publish(file, JSON.stringify(draft))
        syncFault = null
      } catch (e) {
        if (e && e.code === 'dir_sync_failed' && e.published) {
          // The rename DID publish the draft: rolling the view back now would
          // make memory disagree with the disk that already holds the new
          // counts, and the next transaction would silently overwrite them.
          // The conservative direction is the opposite one - keep what was
          // published, say out loud that its durability is not proven, and let
          // the next clean write clear the latch.
          syncFault = e.detail || e.message
          depth = 0
          throw new StoreError('ledger_sync_failed', 'quota ledger was published but its directory entry is not proven durable (' + (e.detail || e.message) + ')')
        }
        // The transaction did not happen. Roll the in-memory view back so the
        // next request sees the same numbers the disk still holds.
        view = prev
        depth = 0
        throw new StoreError('ledger_write_failed', 'quota ledger could not be written (' + (e.code || e.message) + ')')
      }
      depth = 0
      return out
    },
    days () { return Object.keys(view.days) },
    dropDay (day) { delete view.days[day] },
    flush () { publish(file, JSON.stringify(view)); syncFault = null },
    syncState () { return { degraded: !!syncFault, lastError: syncFault } },
    close () {}
  }
}

/* ------------------------------------------------------- sqlite backend --- */

async function createSqliteBackend (file, log) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec(`CREATE TABLE IF NOT EXISTS quota (
    day     TEXT NOT NULL,
    subject TEXT NOT NULL,
    state   TEXT NOT NULL,
    n       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, subject, state)
  )`)

  const sel = db.prepare('SELECT n FROM quota WHERE day = ? AND subject = ? AND state = ?')
  const upsert = db.prepare(`INSERT INTO quota (day, subject, state, n) VALUES (?, ?, ?, ?)
    ON CONFLICT(day, subject, state) DO UPDATE SET n = excluded.n`)
  const days = db.prepare('SELECT DISTINCT day FROM quota')
  const delDay = db.prepare('DELETE FROM quota WHERE day = ?')

  let depth = 0
  return {
    kind: 'sqlite',
    get (day, subject, state) {
      const r = sel.get(day, subject, state)
      return r && Number.isFinite(r.n) ? r.n : 0
    },
    add (day, subject, state, delta) {
      const cur = this.get(day, subject, state)
      upsert.run(day, subject, state, Math.max(0, cur + delta))
    },
    tx (fn) {
      if (depth > 0) return fn() // nested calls join the outer transaction
      // BEGIN first: if it throws (lock contention, I/O), the nesting counter
      // must still read 0, otherwise every later transaction takes the
      // "nested" branch and silently runs outside a transaction.
      db.exec('BEGIN IMMEDIATE')
      depth = 1
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* ignore */ }
        throw e
      } finally {
        depth = 0
      }
    },
    days () { return days.all().map((r) => r.day) },
    dropDay (day) { delDay.run(day) },
    flush () {},
    close () { try { db.close() } catch { /* ignore */ } }
  }
}

/* ------------------------------------------------------------- factory --- */

function isModuleMissing (e) {
  const code = e && e.code
  if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' || code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return true
  return /no such built-?in module|Cannot find module 'node:sqlite'/i.test(String(e && e.message))
}

export async function openStore (opts) {
  const dir = opts.dir
  const log = opts.log
  const backendPref = opts.backend || 'auto'
  // Test seam: the function used to publish the JSON ledger. Same contract as
  // writeFileAtomic, so a unit can inject a fault that happens after the
  // rename without owning a disk that lies on cue.
  const write = opts.write || null
  ensurePrivateDir(dir)

  const dbPath = path.join(dir, 'quota.db')
  const jsonPath = path.join(dir, 'quota.json')
  let backend = null

  if (backendPref === 'sqlite') {
    backend = await createSqliteBackend(dbPath, log)
  } else if (backendPref === 'json') {
    backend = createJsonBackend(jsonPath, log, write)
  } else {
    // auto. The rules, in order, because each one has burned someone:
    //   1. two ledgers in one directory is a configuration nobody can reason
    //      about - refuse instead of picking one and losing the other's counts;
    //   2. an existing JSON ledger keeps the JSON backend, even on a Node that
    //      has sqlite: switching would start a second, empty account;
    //   3. an existing quota.db needs sqlite. If the module is gone, that is a
    //      broken deployment, not an invitation to start over from zero;
    //   4. only a data directory with no ledger at all picks a backend, and
    //      only falls back when node:sqlite is genuinely absent.
    const hasDb = fs.existsSync(dbPath)
    const hasJson = fs.existsSync(jsonPath)
    if (hasDb && hasJson) {
      throw new StoreError('ledger_ambiguous', 'both quota.db and quota.json exist in ' + dir)
    }
    if (hasJson) {
      backend = createJsonBackend(jsonPath, log)
    } else {
      try {
        backend = await createSqliteBackend(dbPath, log)
      } catch (e) {
        if (!isModuleMissing(e)) {
          throw new StoreError('sqlite_failed', 'quota.db could not be opened: ' + (e.code || e.message))
        }
        if (hasDb) {
          throw new StoreError('ledger_backend_missing',
            'quota.db exists but node:sqlite is unavailable; refusing to start a second, empty ledger')
        }
        if (log) log.warn('node:sqlite unavailable, using the json ledger for this fresh data directory')
        backend = createJsonBackend(jsonPath, log)
      }
    }
  }

  const keepDays = opts.keepDays || 40

  function dayKey (now, tz) {
    // The quota day is a calendar day in the operator's timezone, not UTC:
    // a class that runs 20:00-22:00 Beijing time must not straddle two days.
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(now || Date.now()))
    } catch {
      return new Date(now || Date.now()).toISOString().slice(0, 10)
    }
  }

  function used (day, subject) {
    return backend.get(day, subject, 'reserved') +
      backend.get(day, subject, 'completed') +
      backend.get(day, subject, 'unknown')
  }

  function prune () {
    const today = dayKey(Date.now(), 'UTC')
    const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - keepDays * 86400000)
      .toISOString().slice(0, 10)
    backend.tx(() => {
      for (const d of backend.days()) if (d < cutoff) backend.dropDay(d)
    })
  }

  let lastPrune = 0

  return {
    dir,
    backend: backend.kind,

    /* Durability of the last publish. `degraded` is latched between a rename
     * whose directory fsync failed and the next clean write; a deployment
     * without directory fsync support reports the same shape as a healthy one
     * (its platform accepted the write the only way it can). */
    syncHealth () {
      return backend.syncState
        ? backend.syncState()
        : { degraded: false, lastError: null }
    },

    dayKey,

    /* Authorise one paid call. Both ceilings are checked and both counters are
     * incremented inside one transaction, so two concurrent requests cannot
     * both see the last free slot. */
    reserve (args) {
      const day = args.day
      const subject = args.subject
      if (!DAY_RE.test(day)) throw new Error('bad day key: ' + day)
      if (!SUBJECT_RE.test(subject)) throw new Error('bad subject: ' + subject)

      const out = backend.tx(() => {
        const globalUsed = used(day, 'global')
        const subjectUsed = used(day, subject)
        if (args.dailyGlobal > 0 && globalUsed >= args.dailyGlobal) {
          return { ok: false, reason: 'global_quota', globalUsed, subjectUsed }
        }
        if (args.dailyPerSubject > 0 && subjectUsed >= args.dailyPerSubject) {
          return { ok: false, reason: 'subject_quota', globalUsed, subjectUsed }
        }
        backend.add(day, 'global', 'reserved', 1)
        backend.add(day, subject, 'reserved', 1)
        return { ok: true, globalUsed: globalUsed + 1, subjectUsed: subjectUsed + 1 }
      })

      if (Date.now() - lastPrune > 3600_000) {
        lastPrune = Date.now()
        try { prune() } catch { /* housekeeping must never fail a request */ }
      }
      return out
    },

    /* Move a reservation to its final state. `refunded` is the only outcome
     * that returns budget, and the caller only passes it when the upstream
     * provably generated nothing. */
    settle (args) {
      const day = args.day
      const subject = args.subject
      const outcome = args.outcome
      if (!DAY_RE.test(day)) throw new Error('bad day key: ' + day)
      if (!SUBJECT_RE.test(subject)) throw new Error('bad subject: ' + subject)
      if (outcome !== 'completed' && outcome !== 'unknown' && outcome !== 'refunded') {
        throw new Error('bad outcome: ' + outcome)
      }
      backend.tx(() => {
        backend.add(day, 'global', 'reserved', -1)
        backend.add(day, subject, 'reserved', -1)
        backend.add(day, 'global', outcome, 1)
        backend.add(day, subject, outcome, 1)
      })
    },

    usage (day) {
      const b = backend
      const row = (subject) => ({
        reserved: b.get(day, subject, 'reserved'),
        completed: b.get(day, subject, 'completed'),
        unknown: b.get(day, subject, 'unknown'),
        refunded: b.get(day, subject, 'refunded'),
        used: used(day, subject)
      })
      return { day, global: row('global'), subject: row('__none__') }
    },

    usageFor (day, subject) {
      const b = backend
      return {
        reserved: b.get(day, subject, 'reserved'),
        completed: b.get(day, subject, 'completed'),
        unknown: b.get(day, subject, 'unknown'),
        refunded: b.get(day, subject, 'refunded'),
        used: used(day, subject)
      }
    },

    flush () { backend.flush() },
    close () { backend.close() }
  }
}

export { ensurePrivateDir, writeFileAtomic, syncDirectory }
