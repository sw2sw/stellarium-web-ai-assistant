/* Concurrency control and body reading.
 *
 * In-flight limits bound *simultaneous* calls: memory, upstream connection
 * pool, and the operator's rate limit. They are deliberately in-memory, because
 * they describe the present, not the past: a restart legitimately clears them.
 *
 * The daily quota is a different thing and lives in store.mjs, on disk, keyed by
 * access identity. Keeping the two apart is what stops "restart the container"
 * from being a way to reset the budget.
 *
 * A rejected request is rejected here, before any upstream connection opens.
 */

export function createLimiter (getLimits) {
  let globalInflight = 0
  const perIdentity = new Map() // identity -> in-flight count

  return {
    /* Returns {ok:true} and takes the slot, or {ok:false, code}. The caller must
     * call release(identity) in a finally block. */
    acquire (identity) {
      const limits = getLimits()
      if ((perIdentity.get(identity) || 0) >= limits.perIdentityInflight) {
        return { ok: false, code: 'identity_inflight' }
      }
      if (globalInflight >= limits.globalInflight) {
        return { ok: false, code: 'global_inflight' }
      }
      globalInflight += 1
      perIdentity.set(identity, (perIdentity.get(identity) || 0) + 1)
      return { ok: true }
    },

    release (identity) {
      globalInflight = Math.max(0, globalInflight - 1)
      const n = (perIdentity.get(identity) || 0) - 1
      if (n <= 0) perIdentity.delete(identity)
      else perIdentity.set(identity, n)
    },

    stats () {
      return { globalInflight, identities: perIdentity.size }
    }
  }
}

/* Body size guard. Reads at most maxBytes+1 so an oversized upload is detected
 * without buffering the whole thing. */
export function readBody (req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({ tooLarge: true })
      return
    }
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }

    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > maxBytes) {
        finish({ tooLarge: true })
        // Do not destroy the socket: the caller still needs to write 413.
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ tooLarge: false, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', (e) => { if (!done) { done = true; reject(e) } })
  })
}
