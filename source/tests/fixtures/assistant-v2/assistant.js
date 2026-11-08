/* Stellarium Web AI Teaching Assistant - panel (stage A)
 * Copyright (c) 2026 - project contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Plain JS on purpose: this file is replaced on every assistant update, so it
 * must not require a bundler or a host rebuild. It only talks to the host
 * through window.__SWE_AI_BRIDGE__ (see loader.js).
 *
 * Stage A scope: manual controls + engine read-back + selection sync.
 * No model calls are made here yet; the explanation area is a placeholder that
 * shows exactly which snapshot would be sent.
 */
(function () {
  'use strict'

  var VERSION = '0.13.0'
  var UI_KEY = '__SWE_ASSISTANT_UI__'
  var STORE_KEY = 'swe-assistant.panel'
  var PANEL_ATTR = 'data-swe-assistant'

  if (window[UI_KEY]) return

  var bridge = window.__SWE_AI_BRIDGE__
  if (!bridge) return

  var el = {}
  var state = null
  var collapsed = false
  var lastExplanationKey = null
  // Snapshot frozen by the user. Kept separate from `state` on purpose: a
  // frozen payload must not be rewritten when the sky moves on (A5).
  var frozen = null

  /* ------------------------------------------------------------- helpers */

  function h (tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k]
        else if (k === 'class') node.className = attrs[k]
        else if (k === 'html') node.innerHTML = attrs[k]
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k])
        else node.setAttribute(k, attrs[k])
      })
    }
    ;(children || []).forEach(function (c) { if (c) node.appendChild(c) })
    return node
  }

  function fmt (v, digits, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '—'
    return v.toFixed(digits === undefined ? 2 : digits) + (unit || '')
  }

  function fmtTime (iso) {
    if (!iso) return '—'
    var d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    var p = function (n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function loadPrefs () {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch (e) { return {} }
  }

  function savePrefs () {
    try {
      var rect = el.panel.getBoundingClientRect()
      localStorage.setItem(STORE_KEY, JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        collapsed: collapsed
      }))
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- view */

  function section (title, children) {
    return h('section', { class: 'swe-sec' }, [h('h3', { text: title })].concat(children))
  }

  function row (label, valueEl) {
    return h('div', { class: 'swe-row' }, [
      h('span', { class: 'swe-k', text: label }),
      valueEl
    ])
  }

  function value (text, cls) {
    return h('span', { class: 'swe-v ' + (cls || ''), text: text })
  }

  function toggle (label, key) {
    var btn = h('button', {
      class: 'swe-toggle',
      type: 'button',
      'aria-pressed': 'false',
      text: label,
      onclick: function () {
        var cur = state && state.layers ? state.layers[key] : null
        var next = !cur
        runCommand({ type: 'set_layer', layer: key, visible: next })
      }
    })
    btn.dataset.layer = key
    return btn
  }

  function runCommand (cmd) {
    // The bridge only reports `applied` after reading the engine back and, for
    // animated commands, after the view has settled. Until that resolves the
    // command is neither shown as done nor silently dropped.
    var pending = bridge.executeCommand(cmd)
    if (!pending || typeof pending.then !== 'function') {
      // Defensive: an older bridge. Treat a plain result as final.
      return handleResult(pending)
    }
    return pending.then(handleResult, function (e) {
      flash('命令执行失败：' + (e && e.message ? e.message : '未知错误'))
      return null
    })
  }

  function handleResult (res) {
    if (!res) return null
    if (!res.ok) {
      flash(res.error ? res.error.message : '命令执行失败')
      return res
    }
    if (res.status === 'timeout') {
      flash('命令已发出，但星图在 ' + Math.round((res.waitedMs || 0) / 1000) + ' 秒内未到达目标位置')
    }
    if (res.state) applyState(res.state)
    return res
  }

  var flashTimer = null
  function flash (msg) {
    if (!el.status) return
    el.status.textContent = msg
    el.status.classList.add('swe-err')
    clearTimeout(flashTimer)
    flashTimer = setTimeout(function () {
      el.status.classList.remove('swe-err')
      renderStatus()
    }, 4000)
  }

  /* ------------------------------------------------------------- render */

  function renderStatus () {
    if (!el.status) return
    if (!state) {
      el.status.textContent = '星图引擎未就绪'
      el.status.classList.add('swe-warn')
      return
    }
    el.status.classList.remove('swe-warn', 'swe-err')
    el.status.textContent = '已连接 · 桥接 v' + bridge.loaderVersion +
      ' · 协议 ' + bridge.protocolVersion +
      ' · 视图 ' + state.viewId.slice(-4) + ' · rev ' + state.revision
  }

  function renderSelection () {
    if (!el.selBox) return
    el.selBox.textContent = ''
    var s = state && state.selection
    if (!s) {
      el.selBox.appendChild(h('p', { class: 'swe-empty', text: '未选中天体。在上方搜索框选择，或让助手按名称定位。' }))
      return
    }
    el.selBox.appendChild(h('div', { class: 'swe-obj-name', text: s.displayName || s.designation || s.id || '未知天体' }))
    el.selBox.appendChild(h('div', { class: 'swe-obj-type', text: s.otypeName || s.otype || '类型未知' }))
    var grid = h('div', { class: 'swe-grid' }, [
      row('星等', value(fmt(s.vmag, 2))),
      row('方位角', value(fmt(s.az, 1, '°'))),
      row('高度角', value(fmt(s.alt, 1, '°'))),
      row('赤经', value(s.ra === null ? '—' : fmt(s.ra * 12 / Math.PI, 3, 'h'))),
      row('赤纬', value(s.dec === null ? '—' : fmt(s.dec * 180 / Math.PI, 2, '°')))
    ])
    el.selBox.appendChild(grid)
    el.selBox.appendChild(h('p', { class: 'swe-note', text: '以上为星图引擎读回的真实数值。' }))
  }

  function renderLayers () {
    if (!el.layersBox) return
    var L = (state && state.layers) || {}
    Array.prototype.forEach.call(el.layersBox.querySelectorAll('button[data-layer]'), function (btn) {
      var v = L[btn.dataset.layer]
      var on = v === true
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
      btn.classList.toggle('on', on)
      btn.classList.toggle('unknown', v === null || v === undefined)
    })
  }

  function renderTime () {
    if (!el.timeInput || !state || !state.time) return
    if (document.activeElement === el.timeInput) return
    var d = new Date(state.time.utc)
    var p = function (n) { return (n < 10 ? '0' : '') + n }
    el.timeInput.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes())
    el.timeText.textContent = fmtTime(state.time.utc) + '（设备本地时区）'
  }

  function renderView () {
    if (!el.viewText || !state) return
    el.viewText.textContent = '视场 ' + fmt(state.view.fovDeg, 1, '°') +
      ' · 地点 ' + fmt(state.location && state.location.lat, 2, '°') + ' / ' +
      fmt(state.location && state.location.lng, 2, '°')
  }

  // The preview must not keep showing a snapshot that no longer matches the
  // sky. `snapshotId` is bumped by the bridge whenever anything that affects
  // the snapshot changes — including edits made through the host's own UI and
  // the natural passage of time (A5).
  function renderExplanation () {
    if (!el.explainBox || !state) return
    var key = (state.selection ? state.selection.id : 'none') + '|' + state.snapshotId
    if (key === lastExplanationKey) return
    lastExplanationKey = key
    el.explainBox.textContent = ''

    if (!state.selection) {
      el.explainBox.appendChild(h('p', {
        class: 'swe-empty',
        text: '先选中一个天体，再点击「讲解」。点选本身不会产生模型请求。'
      }))
      return
    }
    el.explainBox.appendChild(h('p', {
      class: 'swe-placeholder',
      text: '阶段 A 尚未接入模型。下面是将要发送给模型的观测快照（不含精确地点，除非你允许）。'
    }))
    el.explainBox.appendChild(h('pre', {
      class: 'swe-pre',
      text: JSON.stringify(snapshotForModel(state, state.snapshotId), null, 2)
    }))
    el.explainBox.appendChild(h('div', { class: 'swe-row-btns' }, [
      h('button', {
        class: 'swe-btn',
        type: 'button',
        text: '冻结此快照',
        'data-swe-action': 'freeze',
        onclick: freezeSnapshot
      })
    ]))
    if (frozen) el.explainBox.appendChild(renderFrozen())
  }

  function freezeSnapshot () {
    var snap = bridge.captureSnapshot()
    if (!snap) { flash('引擎未就绪，无法冻结快照'); return }
    frozen = snap
    // Show the frozen payload immediately; later state changes must not
    // rewrite it, only mark it stale.
    lastExplanationKey = null
    renderExplanation()
    renderFrozenState()
  }

  function renderFrozen () {
    var stale = !bridge.isCurrentSnapshot(frozen.snapshotId)
    return h('div', { class: 'swe-frozen', 'data-swe-frozen': 'true' }, [
      h('p', {
        class: stale ? 'swe-placeholder swe-stale' : 'swe-note',
        'data-swe-frozen-stale': stale ? 'true' : 'false',
        text: '已冻结 snapshotId=' + frozen.snapshotId +
          (stale ? '（天空已变化，此快照已过期，不会用于新的请求）' : '（与当前天空一致）')
      }),
      h('pre', {
        class: 'swe-pre',
        'data-swe-frozen-body': 'true',
        text: JSON.stringify(snapshotForModel(frozen, frozen.snapshotId), null, 2)
      })
    ])
  }

  function renderFrozenState () {
    if (!el.explainBox || !frozen) return
    var old = el.explainBox.querySelector('[data-swe-frozen]')
    if (old) old.remove()
    el.explainBox.appendChild(renderFrozen())
  }

  function snapshotForModel (st, snapshotId) {
    return {
      snapshotId: snapshotId,
      object: {
        designation: st.selection.displayName || st.selection.designation,
        type: st.selection.otypeName,
        magnitude: st.selection.vmag
      },
      observing: {
        utc: st.time ? st.time.utc : null,
        locationSent: false,
        altitudeDeg: st.selection.alt === null ? null : Math.round(st.selection.alt),
        azimuthDeg: st.selection.az === null ? null : Math.round(st.selection.az),
        fovDeg: st.view.fovDeg === null ? null : Math.round(st.view.fovDeg)
      },
      revision: st.revision,
      viewId: st.viewId
    }
  }

  function applyState (st) {
    state = st
    renderStatus()
    renderSelection()
    renderLayers()
    renderTime()
    renderView()
    renderExplanation()
  }

  /* --------------------------------------------------------------- build */

  function buildPanel () {
    var prefs = loadPrefs()
    collapsed = !!prefs.collapsed

    el.status = h('div', { class: 'swe-status', text: '正在连接星图引擎…' })

    el.selBox = h('div', { class: 'swe-sel' })

    el.layersBox = h('div', { class: 'swe-toggles' }, [
      toggle('大气', 'atmosphere'),
      toggle('星座线', 'constellation_lines'),
      toggle('星座名', 'constellation_labels'),
      toggle('地景', 'landscape'),
      toggle('银河', 'milkyway'),
      toggle('赤道网格', 'equatorial_grid'),
      toggle('地平网格', 'azimuthal_grid')
    ])

    el.timeInput = h('input', { type: 'datetime-local', class: 'swe-input', step: '60' })
    el.timeText = h('div', { class: 'swe-note' })
    var applyTime = function () {
      if (!el.timeInput.value) return
      var d = new Date(el.timeInput.value)
      if (isNaN(d.getTime())) { flash('时间格式不正确'); return }
      runCommand({ type: 'set_time', utc: d.toISOString() })
    }
    var nowBtn = h('button', { class: 'swe-btn', type: 'button', text: '现在', onclick: function () {
      runCommand({ type: 'set_time', utc: new Date().toISOString() })
    } })

    el.viewText = h('div', { class: 'swe-note' })

    var fovRow = h('div', { class: 'swe-row-btns' }, [30, 20, 10, 5].map(function (d) {
      return h('button', {
        class: 'swe-btn',
        type: 'button',
        text: d + '°',
        onclick: function () { runCommand({ type: 'set_fov', deg: d }) }
      })
    }))

    el.explainBox = h('div', { class: 'swe-explain' })

    el.locateInput = h('input', { type: 'text', class: 'swe-input', placeholder: '如 M 31 / * alf Ori / NAME Sun' })
    var locateBtn = h('button', { class: 'swe-btn', type: 'button', text: '定位', onclick: function () {
      var name = (el.locateInput.value || '').trim()
      if (!name) { flash('请输入天体名称'); return }
      Promise.resolve(runCommand({ type: 'select_object', name: name })).then(function (res) {
        if (res && res.ok) el.locateInput.value = ''
      })
    } })

    var body = h('div', { class: 'swe-body' }, [
      el.status,
      section('当前天体', [el.selBox]),
      section('按名称定位', [el.locateInput, h('div', { class: 'swe-row-btns' }, [locateBtn])]),
      section('图层', [el.layersBox]),
      section('观测时间', [el.timeInput, h('div', { class: 'swe-row-btns' }, [
        h('button', { class: 'swe-btn', type: 'button', text: '应用', onclick: applyTime }),
        nowBtn
      ]), el.timeText, h('div', {
        class: 'swe-note',
        text: '输入按本机设备时区解释，发送给引擎前会换算成带 Z 的 UTC；引擎本身没有时区概念。'
      })]),
      section('视场', [fovRow, el.viewText]),
      section('讲解', [el.explainBox])
    ])

    var collapseBtn = h('button', {
      class: 'swe-icon-btn',
      type: 'button',
      title: '折叠 / 展开',
      text: '–',
      onclick: function (e) {
        e.stopPropagation()
        collapsed = !collapsed
        el.panel.classList.toggle('swe-collapsed', collapsed)
        collapseBtn.textContent = collapsed ? '+' : '–'
        savePrefs()
      }
    })

    var header = h('header', { class: 'swe-head' }, [
      h('span', { class: 'swe-title', text: '教学助手 ' }),
      h('span', { class: 'swe-ver', text: 'v' + VERSION }),
      h('span', { class: 'swe-spacer' }),
      collapseBtn
    ])

    el.panel = h('aside', {
      class: 'swe-panel' + (collapsed ? ' swe-collapsed' : ''),
      role: 'complementary',
      'aria-label': 'Stellarium 教学助手',
      'data-swe-assistant': 'panel',
      // Hot-swap fixture marker: proves the panel on screen came from this
      // package and not from the previously installed one.
      'data-swe-fixture': 'hotswap-0.13.0'
    }, [header, body])

    if (typeof prefs.left === 'number' && typeof prefs.top === 'number') {
      el.panel.style.left = prefs.left + 'px'
      el.panel.style.top = prefs.top + 'px'
      el.panel.style.right = 'auto'
      el.panel.style.bottom = 'auto'
    }
    if (typeof prefs.width === 'number') {
      el.panel.style.width = Math.max(260, Math.min(560, prefs.width)) + 'px'
    }

    // Keep keyboard focus inside the panel from leaking to the sky map, and
    // let Esc collapse the panel. The map's own handlers are on the canvas, so
    // this never blocks map dragging / wheel zoom.
    el.panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        collapsed = true
        el.panel.classList.add('swe-collapsed')
        collapseBtn.textContent = '+'
        savePrefs()
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
        return
      }
      e.stopPropagation()
    })
    el.panel.addEventListener('keyup', function (e) { e.stopPropagation() })

    makeDraggable(el.panel, header)
    document.body.appendChild(el.panel)
  }

  function makeDraggable (panel, handle) {
    var drag = null
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return
      var rect = panel.getBoundingClientRect()
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
      e.preventDefault()
    })
    window.addEventListener('mousemove', function (e) {
      if (!drag) return
      var left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx))
      var top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy))
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
      panel.style.right = 'auto'
      panel.style.bottom = 'auto'
    })
    window.addEventListener('mouseup', function () {
      if (drag) { drag = null; savePrefs() }
    })
  }

  function buildUnavailable (msg) {
    el.panel = h('aside', { class: 'swe-panel swe-collapsed', 'data-swe-assistant': 'panel' }, [
      h('header', { class: 'swe-head' }, [h('span', { class: 'swe-title', text: '教学助手不可用' })]),
      h('div', { class: 'swe-body' }, [h('p', { class: 'swe-empty', text: msg })])
    ])
    document.body.appendChild(el.panel)
  }

  /* ---------------------------------------------------------------- init */

  function init (b) {
    window[UI_KEY] = true
    if (!b) {
      buildUnavailable('星图引擎未在预期时间内就绪，助手已自动停用，星图本身不受影响。')
      return
    }
    buildPanel()
    applyState(b.readState())
    b.subscribeState(function (st) { applyState(st) })
    setInterval(function () {
      var st = b.readState()
      if (st) applyState(st)
    }, 2000)
  }

  try {
    bridge.ready.then(init, function () { init(null) })
  } catch (e) {
    buildUnavailable('助手初始化失败：' + (e && e.message ? e.message : '未知错误'))
  }
})()
