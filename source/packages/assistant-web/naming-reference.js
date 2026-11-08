/* Stellarium Web AI Teaching Assistant - control reference
 * Copyright (c) 2026 - project contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHAT THIS FILE IS
 *   The single reference for "what a command may contain". Two halves:
 *
 *   1. object names - Stellarium Web resolves a name by comparing it against
 *      every designation of every object with an exact, case-insensitive
 *      comparison. There is no fuzzy match, no prefix match, no Chinese table
 *      and no tolerance for a missing space, so a model that guesses gets
 *      object_not_found.
 *
 *   2. time flow - the engine has a rate factor (core.time_speed) with no
 *      clamp of its own; 0 stops, 1 is real time, 1000 runs a day in 86 s.
 *      The bridge is the only thing that bounds it, and this file is where
 *      those bounds are written down.
 *
 *   Every claim below was measured against the running engine; the method is
 *   in docs/OBJECT-NAMING.md and docs/TIME-CONTROL.md, and the automated
 *   version is tests/reference/consistency.mjs.
 *
 * WHO READS IT
 *   1. the assistant panel, via toPrompt(lang) - the text is sent as part of
 *      the system prompt so the model writes the right shape the first time;
 *   2. any other agent, via window.SWE_NAMING_REFERENCE (in the page),
 *      window.__SWE_AI_BRIDGE__.namingReference() (bridge, plain data),
 *      require('./naming-reference.js') under Node, or toMarkdown(lang) for a
 *      human/agent-readable document.
 *
 * KEEPING IT TRUE
 *   constellations / planets / stars / deepSky mirror the alias tables in
 *   packages/host-adapter/loader.js. tests/reference/consistency.mjs fails if
 *   the two drift apart, so edit both or neither.
 */
;(function (root, factory) {
  var ref = factory()
  if (typeof module === 'object' && module.exports) module.exports = ref
  if (root) root.SWE_NAMING_REFERENCE = ref
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  var VERSION = '1.1.0'
  // Bump when a measured fact changes, and re-run consistency.mjs.
  var MEASURED = '2026-10-30'

  /* --------------------------------------------------------- the engine */

  // One sentence a model cannot misread. Repeated, in short form, in the
  // prompt: models that only skim the table still need to know that a near
  // miss is a hard failure rather than something the bridge will fix.
  var ENGINE = {
    zh: '引擎按 designation 做全等比较：大小写无所谓，空格一个都不能少，没有模糊匹配，不认中文。',
    en: 'The engine compares a name against each object\'s designations exactly: case-insensitive, whitespace-sensitive, no fuzzy match, no Chinese names.'
  }

  /* ---------------------------------------------------------- the shapes */

  // Four shapes, because the data itself differs: a planet's designation is
  // literally "NAME Jupiter", a star's is the bare "Sirius", a constellation's
  // is "CON western Ori". The same prefix that is required on one is fatal on
  // the next, which is exactly what models get wrong.
  var SHAPES = [
    {
      kind: 'planet',
      engineForm: 'NAME <English name>',
      zh: '行星、太阳、月球要带 NAME 前缀：NAME Jupiter、NAME Moon、NAME Sun。裸写 Jupiter 或写中文都查不到。',
      en: 'planets, the Sun and the Moon REQUIRE the NAME prefix: NAME Jupiter, NAME Moon, NAME Sun. Bare Jupiter fails.',
      ok: ['NAME Jupiter', 'NAME Moon', 'NAME Sun', 'NAME Saturn'],
      bad: ['Jupiter', 'Moon', '太阳', '木星']
    },
    {
      kind: 'star',
      engineForm: '<proper name>  or  * <bayer> <genitive>',
      zh: '恒星写专名或拜耳编号，前面不要加 NAME：Sirius、Vega、* alf Ori。NAME Sirius 查不到。',
      en: 'stars use the proper name or the Bayer code, with NO NAME prefix: Sirius, Vega, * alf Ori. NAME Sirius fails.',
      ok: ['Sirius', 'Vega', 'Polaris', '* alf Ori', '* bet Ori'],
      bad: ['NAME Sirius', 'Alpha Ori', 'HIP 32349', '天狼星']
    },
    {
      kind: 'deepsky',
      engineForm: '<catalogue> <number>',
      zh: '深空天体写目录号，字母和数字之间恰好一个空格：M 31、M 42、NGC 7000。M31、M  31、NGC7000 都查不到。',
      en: 'deep-sky objects use the catalogue number with EXACTLY one space: M 31, M 42, NGC 7000. M31 and NGC7000 fail.',
      ok: ['M 31', 'M 42', 'M 45', 'NGC 7000', 'IC 405'],
      bad: ['M31', 'NGC7000', 'M 31 ', '仙女座星系']
    },
    {
      kind: 'constellation',
      engineForm: 'CON western <3-letter IAU abbreviation>',
      zh: '星座写 CON western 加三字母 IAU 缩写：CON western Ori。只写 Ori、Orion 或"猎户座"都查不到。',
      en: 'constellations use CON western plus the 3-letter IAU abbreviation: CON western Ori. Bare Ori, Orion or the Chinese name fail.',
      ok: ['CON western Ori', 'CON western UMa', 'CON western Sco', 'CON western Cru'],
      bad: ['Ori', 'Orion', '猎户座', 'CON western Orion']
    }
  ]

  // The same four shapes as a machine-checkable statement. A short regex costs
  // a model far fewer tokens than a paragraph of prose, survives translation
  // into any provider's prompt, and can be tested here (see
  // tests/reference/consistency.mjs), which prose cannot.
  var GRAMMAR = {
    planet: '^NAME [A-Za-z]+$',
    star: '^(\\* [a-z]{3} [A-Z][A-Za-z]{2}|[A-Z][A-Za-z]+)$',
    deepsky: '^(M|C|NGC|IC|HIP|HD) [0-9]+$',
    constellation: '^CON western [A-Z][A-Za-z]{2}$'
  }

  /* -------------------------------------------------- the lookup tables */

  // 88 IAU constellations, exactly the ids in
  // skydata/skycultures/western/index.json. [abbr, Chinese, English]
  var CONSTELLATIONS = [
    ['And', '仙女座', 'Andromeda'], ['Ant', '唧筒座', 'Antlia'], ['Aps', '天燕座', 'Apus'],
    ['Aqr', '宝瓶座', 'Aquarius'], ['Aql', '天鹰座', 'Aquila'], ['Ara', '天坛座', 'Ara'],
    ['Ari', '白羊座', 'Aries'], ['Aur', '御夫座', 'Auriga'], ['Boo', '牧夫座', 'Bootes'],
    ['Cae', '雕具座', 'Caelum'], ['Cam', '鹿豹座', 'Camelopardalis'], ['Cnc', '巨蟹座', 'Cancer'],
    ['CVn', '猎犬座', 'Canes Venatici'], ['CMa', '大犬座', 'Canis Major'], ['CMi', '小犬座', 'Canis Minor'],
    ['Cap', '摩羯座', 'Capricornus'], ['Car', '船底座', 'Carina'], ['Cas', '仙后座', 'Cassiopeia'],
    ['Cen', '半人马座', 'Centaurus'], ['Cep', '仙王座', 'Cepheus'], ['Cet', '鲸鱼座', 'Cetus'],
    ['Cha', '蝘蜓座', 'Chamaeleon'], ['Cir', '圆规座', 'Circinus'], ['Col', '天鸽座', 'Columba'],
    ['Com', '后发座', 'Coma Berenices'], ['CrA', '南冕座', 'Corona Australis'], ['CrB', '北冕座', 'Corona Borealis'],
    ['Crv', '乌鸦座', 'Corvus'], ['Crt', '巨爵座', 'Crater'], ['Cru', '南十字座', 'Crux'],
    ['Cyg', '天鹅座', 'Cygnus'], ['Del', '海豚座', 'Delphinus'], ['Dor', '剑鱼座', 'Dorado'],
    ['Dra', '天龙座', 'Draco'], ['Equ', '小马座', 'Equuleus'], ['Eri', '波江座', 'Eridanus'],
    ['For', '天炉座', 'Fornax'], ['Gem', '双子座', 'Gemini'], ['Gru', '天鹤座', 'Grus'],
    ['Her', '武仙座', 'Hercules'], ['Hor', '时钟座', 'Horologium'], ['Hya', '长蛇座', 'Hydra'],
    ['Hyi', '水蛇座', 'Hydrus'], ['Ind', '印第安座', 'Indus'], ['Lac', '蝎虎座', 'Lacerta'],
    ['Leo', '狮子座', 'Leo'], ['LMi', '小狮座', 'Leo Minor'], ['Lep', '天兔座', 'Lepus'],
    ['Lib', '天秤座', 'Libra'], ['Lup', '豺狼座', 'Lupus'], ['Lyn', '天猫座', 'Lynx'],
    ['Lyr', '天琴座', 'Lyra'], ['Men', '山案座', 'Mensa'], ['Mic', '显微镜座', 'Microscopium'],
    ['Mon', '麒麟座', 'Monoceros'], ['Mus', '苍蝇座', 'Musca'], ['Nor', '矩尺座', 'Norma'],
    ['Oct', '南极座', 'Octans'], ['Oph', '蛇夫座', 'Ophiuchus'], ['Ori', '猎户座', 'Orion'],
    ['Pav', '孔雀座', 'Pavo'], ['Peg', '飞马座', 'Pegasus'], ['Per', '英仙座', 'Perseus'],
    ['Phe', '凤凰座', 'Phoenix'], ['Pic', '绘架座', 'Pictor'], ['Psc', '双鱼座', 'Pisces'],
    ['PsA', '南鱼座', 'Piscis Austrinus'], ['Pup', '船尾座', 'Puppis'], ['Pyx', '罗盘座', 'Pyxis'],
    ['Ret', '网罟座', 'Reticulum'], ['Sge', '天箭座', 'Sagitta'], ['Sgr', '人马座', 'Sagittarius'],
    ['Sco', '天蝎座', 'Scorpius'], ['Scl', '玉夫座', 'Sculptor'], ['Sct', '盾牌座', 'Scutum'],
    ['Ser', '巨蛇座', 'Serpens'], ['Sex', '六分仪座', 'Sextans'], ['Tau', '金牛座', 'Taurus'],
    ['Tel', '望远镜座', 'Telescopium'], ['Tri', '三角座', 'Triangulum'], ['TrA', '南三角座', 'Triangulum Australe'],
    ['Tuc', '杜鹃座', 'Tucana'], ['UMa', '大熊座', 'Ursa Major'], ['UMi', '小熊座', 'Ursa Minor'],
    ['Vel', '船帆座', 'Vela'], ['Vir', '室女座', 'Virgo'], ['Vol', '飞鱼座', 'Volans'],
    ['Vul', '狐狸座', 'Vulpecula']
  ]

  // [engine string, Chinese, English]. Kept short on purpose: the prompt does
  // not need every synonym the bridge already knows.
  var PLANETS = [
    ['NAME Sun', '太阳', 'Sun'], ['NAME Moon', '月球', 'Moon'], ['NAME Mercury', '水星', 'Mercury'],
    ['NAME Venus', '金星', 'Venus'], ['NAME Mars', '火星', 'Mars'], ['NAME Jupiter', '木星', 'Jupiter'],
    ['NAME Saturn', '土星', 'Saturn'], ['NAME Uranus', '天王星', 'Uranus'], ['NAME Neptune', '海王星', 'Neptune'],
    ['NAME Pluto', '冥王星', 'Pluto']
  ]

  var STARS = [
    ['Sirius', '天狼星', 'Sirius'], ['Vega', '织女星', 'Vega'], ['Polaris', '北极星', 'Polaris'],
    ['Betelgeuse', '参宿四', 'Betelgeuse'], ['Rigel', '参宿七', 'Rigel'], ['Arcturus', '大角星', 'Arcturus'],
    ['Antares', '心宿二', 'Antares'], ['Altair', '牛郎星', 'Altair'], ['Deneb', '天津四', 'Deneb'],
    ['Aldebaran', '毕宿五', 'Aldebaran'], ['Capella', '五车二', 'Capella'], ['Procyon', '南河三', 'Procyon'],
    ['Spica', '角宿一', 'Spica'], ['Regulus', '轩辕十四', 'Regulus'], ['Fomalhaut', '北落师门', 'Fomalhaut'],
    ['Pollux', '北河三', 'Pollux'], ['Canopus', '老人星', 'Canopus']
  ]

  var DEEP_SKY = [
    ['M 1', '蟹状星云', 'Crab Nebula'], ['M 13', '武仙座球状星团', 'Hercules Cluster'],
    ['M 31', '仙女座星系', 'Andromeda Galaxy'], ['M 42', '猎户座大星云', 'Orion Nebula'],
    ['M 44', '蜂巢星团', 'Beehive Cluster'], ['M 45', '昴星团', 'Pleiades'],
    ['M 51', '涡旋星系', 'Whirlpool Galaxy'], ['M 57', '指环星云', 'Ring Nebula'],
    ['M 104', '草帽星系', 'Sombrero Galaxy']
  ]

  // The mistakes models actually make, in one line each. Cheaper to read than
  // a rule, and it is the part they copy most reliably.
  var CORRECTIONS = [
    ['Jupiter', 'NAME Jupiter'],
    ['Moon', 'NAME Moon'],
    ['M42', 'M 42'],
    ['NGC7000', 'NGC 7000'],
    ['Orion', 'CON western Ori'],
    ['猎户座', 'CON western Ori'],
    ['NAME Sirius', 'Sirius'],
    ['Alp Ori', '* alf Ori'],
    ['仙女座星系', 'M 31']
  ]

  // Few-shot pairs. Same five requests in both languages so a language switch
  // cannot silently change the taught grammar. Stored as data, not as JSON
  // text, so rendering cannot produce an unbalanced quote.
  var EXAMPLES = [
    {
      ask: { zh: '看看木星', en: 'show me Jupiter' },
      commands: [{ type: 'select_object', name: 'NAME Jupiter' }],
      say: { zh: '已定位木星', en: 'Centred on Jupiter' }
    },
    {
      ask: { zh: '看看天狼星', en: 'show me Sirius' },
      commands: [{ type: 'select_object', name: 'Sirius' }],
      say: { zh: '已定位天狼星', en: 'Centred on Sirius' }
    },
    {
      ask: { zh: '把猎户座转到视野中央', en: 'centre Orion' },
      commands: [{ type: 'select_object', name: 'CON western Ori' }],
      say: { zh: '已定位猎户座', en: 'Centred on Orion' }
    },
    {
      ask: { zh: '看一下仙女座星系，视场缩到5度', en: 'show the Andromeda galaxy, narrow the field to 5 degrees' },
      commands: [{ type: 'select_object', name: 'M 31' }, { type: 'set_fov', deg: 5 }],
      say: { zh: '已定位仙女座星系，视场 5 度', en: 'Centred on M 31, field 5 degrees' }
    },
    {
      // The worked example the whole feature exists for: jump, centre, run at
      // a rate, and stop by itself after one simulated day. Three commands,
      // because the day length is expressed in simulated hours - the model
      // never has to divide 86400 by 1000.
      ask: {
        zh: '跳到 11 月 1 日晚上 8 点，把木星放到视场中央，再用 1000 倍速度走完一天',
        en: 'jump to 1 Nov at 8 pm, centre Jupiter, then run one day at 1000x'
      },
      commands: [
        { type: 'set_time', utc: '2026-11-01T12:00:00Z' },
        { type: 'select_object', name: 'NAME Jupiter' },
        { type: 'set_time_speed', factor: 1000, simHours: 24 }
      ],
      say: {
        zh: '已跳到 20:00，木星居中，1000 倍速开跑，走完一天自动停',
        en: 'Jumped to 20:00, Jupiter centred, running at 1000x until a day has passed'
      }
    },
    {
      ask: { zh: '时间先停一下', en: 'pause the clock' },
      commands: [{ type: 'set_time_speed', factor: 0 }],
      say: { zh: '时间已暂停', en: 'Clock paused' }
    },
    {
      ask: { zh: '打开星座线，然后看天蝎座', en: 'turn on constellation lines and show Scorpius' },
      commands: [
        { type: 'set_layer_flag', layer: 'constellation_lines', visible: true },
        { type: 'select_object', name: 'CON western Sco' }
      ],
      say: { zh: '星座线已打开，已定位天蝎座', en: 'Lines on, centred on Scorpius' }
    },
    {
      ask: { zh: '今晚十点在天上看月亮', en: 'look at the Moon tonight at ten' },
      commands: [
        { type: 'set_time', utc: '2026-10-30T14:00:00Z' },
        { type: 'select_object', name: 'NAME Moon' }
      ],
      say: { zh: '时间已设为今晚十点，已定位月球', en: 'Time set, centred on the Moon' }
    }
  ]

  /* ------------------------------------------------------- time flow */

  // Why this is a table and not a single sentence: the rate is a bare double
  // in the engine (src/core.h:146) with no clamp anywhere in the C code, so
  // "how fast is too fast" is purely a bridge decision. A model that invents
  // 1e9 does not get a fast sky, it gets a rejected command.
  var TIME = {
    zh: [
      'set_time_speed 的 factor 是倍率：0 = 停，1 = 实时，1000 = 每 1 秒真实时间走 1000 秒模拟时间，86400 = 每秒一天；负数往回走。',
      '可选 simHours：从当前时刻按该倍率走这么多模拟小时后自动停表。真实要等多久由桥接算，你不用写真实秒数；1000 倍配 simHours 24 就是走完一天，约 86 秒。',
      '顺序固定：先 set_time 跳到起点，再 set_time_speed 开跑。set_time 会丢掉上一轮没走完的自动停表（readback 里 autoStopCleared=true）。',
      '上限：|factor| ≤ 86400；非零时 ≥ 0.0001（更小的值在引擎里等于停）；simHours ≤ 100000；按倍率折算的真实耗时 ≤ 72 小时，否则整条命令被拒。',
      '要停就写 set_time_speed 且 factor 0。不要用 set_time 当刹车的替代品——那只是跳时刻，速度还在跑。'
    ],
    en: [
      'set_time_speed: factor is the rate. 0 = stopped, 1 = real time, 1000 = 1000 simulated seconds per real second, 86400 = one day per second; negative runs backwards.',
      'Optional simHours: run for that many *simulated* hours, then stop automatically. Do not compute the real duration yourself; 1000 with simHours 24 runs exactly one day in about 86 real seconds.',
      'Order matters: set_time to the start, then set_time_speed to run. set_time drops any unfinished auto-stop (readback reports autoStopCleared=true).',
      'Bounds: |factor| <= 86400, and >= 0.0001 when non-zero (smaller rounds to a stop in the engine); simHours <= 100000; the implied real duration <= 72 hours, otherwise the whole command is rejected.',
      'To stop, send set_time_speed with factor 0. Do not use set_time as a brake - that only jumps the clock, the rate keeps running.'
    ]
  }

  // One-paragraph form for the default (paid-on-every-request) block. The full
  // list above is only sent when a caller asks for level:'full'.
  var TIME_COMPACT = {
    zh: '时间（set_time_speed）：factor 是倍率——0 停、1 实时、1000 每真实秒走 1000 模拟秒、86400 每秒一天，负数倒放；' +
        '再给 simHours 就走到那么多模拟小时后自动停，真实秒数不用你算（1000 配 24 = 走完一天，约 86 秒）。' +
        '顺序：先 set_time 再 set_time_speed；|factor| ≤ 86400，simHours ≤ 100000。停表用 factor 0。',
    en: 'Time (set_time_speed): factor is the rate - 0 stops, 1 is real time, 1000 means 1000 simulated seconds per real second, 86400 is one day per second, negative runs backwards. ' +
        'Add simHours to stop automatically after that many simulated hours; do not compute real seconds (1000 with 24 = one day in about 86 s). ' +
        'Order: set_time first, then set_time_speed. Bounds: |factor| <= 86400, simHours <= 100000. To stop, send factor 0.'
  }

  var TIME_LIMITS = {
    maxFactor: 86400,
    minNonZeroFactor: 0.0001,
    maxSimHours: 100000,
    maxRealSeconds: 72 * 3600
  }

  var LIMITS = {
    zh: [
      '没有模糊匹配：写错一个字母就是 object not found，不要指望引擎猜。',
      '不认中文：中文名能生效是本地面板的别名表兜底，不是引擎能力。',
      '查不到的天体不要编：宁可返回空 commands 并说明，也不要造一个编号。',
      '一次最多 4 条命令。'
    ],
    en: [
      'No fuzzy match: one wrong letter means object not found. Do not rely on the engine guessing.',
      'No Chinese names: they work only because the panel rewrites them locally, not because the engine knows them.',
      'Do not invent a catalogue number for an object that is not listed. Return an empty command list and say so.',
      'At most 4 commands per reply.'
    ]
  }

  /* -------------------------------------------------------- rendering */

  function pick (obj, lang) {
    return (obj && obj[lang === 'en' ? 'en' : 'zh']) || ''
  }

  function constellationLines (lang) {
    var rows = []
    for (var i = 0; i < CONSTELLATIONS.length; i++) {
      var c = CONSTELLATIONS[i]
      rows.push(lang === 'en' ? c[0] + ' ' + c[2] : c[0] + ' ' + c[1] + ' ' + c[2])
    }
    // Six per line: the prompt stays readable for a human debugging it, and
    // tokenisation is the same as one long line.
    var out = []
    for (var j = 0; j < rows.length; j += 6) out.push(rows.slice(j, j + 6).join('; '))
    return out.join('\n')
  }

  function tableLines (rows, lang) {
    var out = []
    for (var i = 0; i < rows.length; i++) {
      out.push(rows[i][0] + ' = ' + (lang === 'en' ? rows[i][2] : rows[i][1]))
    }
    return out.join('; ')
  }

  // The block that gets appended to the system prompt. Deliberately plain
  // text: no markdown tables, because a model copying a table can copy a
  // stray pipe into the JSON.
  //
  // Two levels, because a prompt is paid for on every request and the reader
  // may be any provider's model:
  //   compact (default) - the grammar as regexes, one example and one classic
  //                       mistake per kind, four few-shot pairs. Covers
  //                       everything the bridge can also repair.
  //   full              - adds the 88-row constellation table and the
  //                       planet/star/deep-sky name tables, so a model can
  //                       write an engine-exact name for anything listed
  //                       without relying on the local rewrite at all.
  // Both are rendered from the same tables, so they cannot disagree.
  function compactPrompt (lang) {
    var en = lang === 'en'
    var lines = []
    lines.push(en
      ? 'name (case-insensitive, space-sensitive; a line that does not match is object_not_found):'
      : 'name 必须整体匹配下列任一行（大小写无关、空格敏感，不匹配就是 object_not_found）：')
    lines.push('planet        ' + GRAMMAR.planet + (en
      ? '   e.g. NAME Jupiter, NAME Moon; fails: Jupiter'
      : '   例 NAME Jupiter、NAME Moon；错 Jupiter'))
    lines.push('star          ' + GRAMMAR.star + (en
      ? '   e.g. Sirius, * alf Ori; fails: NAME Sirius'
      : '   例 Sirius、* alf Ori；错 NAME Sirius'))
    lines.push('deepsky       ' + GRAMMAR.deepsky + (en
      ? '   e.g. M 31, NGC 7000; fails: M31'
      : '   例 M 31、NGC 7000；错 M31'))
    lines.push('constellation ' + GRAMMAR.constellation + (en
      ? '   e.g. CON western Ori; fails: Ori, Orion'
      : '   例 CON western Ori；错 Ori、Orion、猎户座'))
    lines.push(en
      ? 'Chinese names are rewritten locally (Jupiter, Orion, Sirius, Andromeda all resolve), but prefer the forms above. Check every name once before replying.'
      : '中文名本地也会转换（木星、猎户座、天狼星、仙女座星系都能命中），但能写上面的形态就直接写；回复前把每个 name 核对一遍。')
    lines.push('')
    lines.push(TIME_COMPACT[en ? 'en' : 'zh'])
    lines.push('')
    lines.push(en ? 'Examples:' : '示例：')
    // Five, not four: the four name shapes plus the time-flow example. Dropping
    // the time one would leave the feature undocumented in the default block.
    lines.push(toExamples(lang, { limit: 5 }))
    return lines.join('\n')
  }

  function fullPrompt (lang) {
    var en = lang === 'en'
    var head = en
      ? ['Object names (this is a measured spec, not style advice; a wrong shape returns object_not_found):',
         ENGINE.en]
      : ['天体名称（以下为实测规则，不是措辞建议；写错形态会返回 object_not_found）：',
         ENGINE.zh]
    var body = []
    for (var i = 0; i < SHAPES.length; i++) {
      body.push('- ' + pick(SHAPES[i], lang))
    }
    var lines = head.concat(body)
    lines.push('')
    lines.push(en
      ? 'Constellations (abbreviation English name; write them as "CON western <abbreviation>"):'
      : '星座表（缩写 中文名 英文名；使用时写成 "CON western 缩写"）：')
    lines.push(constellationLines(lang))
    lines.push('')
    lines.push(en
      ? 'Planets, Sun and Moon (exact string = the Chinese name):'
      : '行星与日月（引擎写法 = 中文名）：')
    lines.push(tableLines(PLANETS, lang))
    lines.push(en ? 'Bright stars (exact string = the Chinese name):' : '亮星（引擎写法 = 中文名）：')
    lines.push(tableLines(STARS, lang))
    lines.push(en ? 'Deep sky (exact string = the Chinese name):' : '深空天体（引擎写法 = 中文名）：')
    lines.push(tableLines(DEEP_SKY, lang))
    lines.push('')
    lines.push(en ? 'Fix these before sending: ' + CORRECTIONS.map(function (c) { return c[0] + ' -> ' + c[1] }).join('; ')
                  : '这些写法要改：' + CORRECTIONS.map(function (c) { return c[0] + ' -> ' + c[1] }).join('；'))
    lines.push('')
    var lim = LIMITS[lang === 'en' ? 'en' : 'zh']
    for (var k = 0; k < lim.length; k++) lines.push('- ' + lim[k])
    lines.push('')
    lines.push(en ? 'Time flow (set_time_speed):' : '时间流速（set_time_speed）：')
    var tl = TIME[lang === 'en' ? 'en' : 'zh']
    for (var m = 0; m < tl.length; m++) lines.push('- ' + tl[m])
    lines.push('')
    lines.push(en ? 'Examples:' : '示例：')
    lines.push(toExamples(lang))
    return lines.join('\n')
  }

  function toPrompt (lang, opts) {
    return (opts && opts.level === 'full') ? fullPrompt(lang) : compactPrompt(lang)
  }

  function toExamples (lang, opts) {
    var take = EXAMPLES.length
    if (opts && typeof opts.limit === 'number' && opts.limit > 0) take = Math.min(take, opts.limit)
    var out = []
    for (var i = 0; i < take; i++) {
      var e = EXAMPLES[i]
      out.push((lang === 'en' ? 'request: ' : '请求：') + pick(e.ask, lang))
      out.push(JSON.stringify({ commands: e.commands, say: pick(e.say, lang) }))
    }
    return out.join('\n')
  }

  function toMarkdown (lang) {
    var en = lang === 'en'
    var out = []
    out.push(en ? '# Object naming reference' : '# 天体名称参考')
    out.push('')
    out.push('`' + VERSION + '` / measured ' + MEASURED + ' / ' +
             (en ? 'use with `select_object.name`' : '用于 `select_object.name`'))
    out.push('')
    out.push('## ' + (en ? 'How the engine matches' : '引擎怎么匹配'))
    out.push('')
    out.push(ENGINE[en ? 'en' : 'zh'])
    out.push('')
    out.push('## ' + (en ? 'Four shapes' : '四类形态'))
    out.push('')
    out.push(en ? '| kind | write | examples | fails |' : '| 类别 | 写法 | 正例 | 反例 |')
    out.push('|---|---|---|---|')
    for (var i = 0; i < SHAPES.length; i++) {
      var s = SHAPES[i]
      out.push('| ' + s.kind + ' | `' + s.engineForm + '` | ' +
        s.ok.slice(0, 3).map(function (x) { return '`' + x + '`' }).join(' ') + ' | ' +
        s.bad.slice(0, 3).map(function (x) { return '`' + x + '`' }).join(' ') + ' |')
    }
    out.push('')
    out.push('## ' + (en ? 'Constellations' : '星座表'))
    out.push('')
    out.push(en ? '| abbr | name | write as |' : '| 缩写 | 名称 | 写成 |')
    out.push('|---|---|---|')
    for (var c = 0; c < CONSTELLATIONS.length; c++) {
      var k = CONSTELLATIONS[c]
      out.push('| ' + k[0] + ' | ' + (en ? k[2] : k[1]) + ' | `CON western ' + k[0] + '` |')
    }
    out.push('')
    out.push('## ' + (en ? 'Common objects' : '常用天体'))
    out.push('')
    var group = [['planet', PLANETS], ['star', STARS], ['deepsky', DEEP_SKY]]
    for (var g = 0; g < group.length; g++) {
      out.push('**' + group[g][0] + '**')
      out.push('')
      for (var r = 0; r < group[g][1].length; r++) {
        out.push('- `' + group[g][1][r][0] + '` — ' + (en ? group[g][1][r][2] : group[g][1][r][1]))
      }
      out.push('')
    }
    out.push('## ' + (en ? 'Common mistakes' : '常见错写'))
    out.push('')
    for (var m = 0; m < CORRECTIONS.length; m++) {
      out.push('- `' + CORRECTIONS[m][0] + '` -> `' + CORRECTIONS[m][1] + '`')
    }
    out.push('')
    out.push('## ' + (en ? 'Few-shot' : '示例'))
    out.push('')
    out.push('```')
    out.push(toExamples(lang))
    out.push('```')
    out.push('')
    out.push('## ' + (en ? 'Limits' : '边界'))
    out.push('')
    var lim = LIMITS[en ? 'en' : 'zh']
    for (var l = 0; l < lim.length; l++) out.push('- ' + lim[l])
    out.push('')
    out.push('## ' + (en ? 'Time flow' : '时间流速'))
    out.push('')
    out.push(en ? 'Command: `set_time_speed {factor, simHours?}`'
                : '命令：`set_time_speed {factor, simHours?}`')
    out.push('')
    var tline = TIME[en ? 'en' : 'zh']
    for (var t = 0; t < tline.length; t++) out.push('- ' + tline[t])
    out.push('')
    out.push(en ? 'Worked example: 1 Nov 20:00, Jupiter centred, 1000x for one day:'
                : '完整示例：11 月 1 日 20:00，木星居中，1000 倍走完一天：')
    out.push('')
    out.push('```json')
    out.push(JSON.stringify({
      commands: [
        { type: 'set_time', utc: '2026-11-01T12:00:00Z' },
        { type: 'select_object', name: 'NAME Jupiter' },
        { type: 'set_time_speed', factor: 1000, simHours: 24 }
      ]
    }, null, 2))
    out.push('```')
    return out.join('\n')
  }

  // Plain data only: the bridge hands this to other agents through
  // postMessage-free synchronous calls, so no functions leak through.
  function toJSON () {
    return {
      id: 'swe-object-naming',
      // The id is kept for compatibility with 0.6.0 callers; the scopes field
      // is what a new consumer should look at.
      scopes: ['naming', 'time'],
      version: VERSION,
      measured: MEASURED,
      engine: { zh: ENGINE.zh, en: ENGINE.en },
      shapes: SHAPES.map(function (s) {
        return { kind: s.kind, engineForm: s.engineForm, zh: s.zh, en: s.en, ok: s.ok.slice(), bad: s.bad.slice() }
      }),
      constellations: CONSTELLATIONS.map(function (c) { return c.slice() }),
      planets: PLANETS.map(function (c) { return c.slice() }),
      stars: STARS.map(function (c) { return c.slice() }),
      deepSky: DEEP_SKY.map(function (c) { return c.slice() }),
      corrections: CORRECTIONS.map(function (c) { return c.slice() }),
      examples: EXAMPLES.map(function (e) {
        return {
          ask: { zh: e.ask.zh, en: e.ask.en },
          commands: JSON.parse(JSON.stringify(e.commands)),
          say: { zh: e.say.zh, en: e.say.en }
        }
      }),
      grammar: {
        planet: GRAMMAR.planet, star: GRAMMAR.star,
        deepsky: GRAMMAR.deepsky, constellation: GRAMMAR.constellation
      },
      limits: { zh: LIMITS.zh.slice(), en: LIMITS.en.slice() },
      time: {
        rules: { zh: TIME.zh.slice(), en: TIME.en.slice() },
        compact: { zh: TIME_COMPACT.zh, en: TIME_COMPACT.en },
        command: 'set_time_speed',
        fields: ['factor', 'simHours'],
        bounds: TIME_LIMITS
      },
      // The default block is the compact one: it is what every request pays
      // for. promptFull is here for callers that want the tables as well.
      prompt: { zh: compactPrompt('zh'), en: compactPrompt('en') },
      promptFull: { zh: fullPrompt('zh'), en: fullPrompt('en') },
      markdown: { zh: toMarkdown('zh'), en: toMarkdown('en') }
    }
  }

  return {
    id: 'swe-object-naming',
    version: VERSION,
    measured: MEASURED,
    engine: ENGINE,
    shapes: SHAPES,
    grammar: GRAMMAR,
    constellations: CONSTELLATIONS,
    planets: PLANETS,
    stars: STARS,
    deepSky: DEEP_SKY,
    corrections: CORRECTIONS,
    examples: EXAMPLES,
    limits: LIMITS,
    time: {
      rules: TIME,
      compact: TIME_COMPACT,
      command: 'set_time_speed',
      fields: ['factor', 'simHours'],
      bounds: TIME_LIMITS
    },
    toPrompt: toPrompt,
    toExamples: toExamples,
    toMarkdown: toMarkdown,
    toJSON: toJSON
  }
})
