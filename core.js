/*
 * PLAYCUT LOGGER — core (DOM 非依存)
 *
 * ここには「画面がなくても正しさを確かめられる」純粋関数だけを置く。
 * ブラウザからは <script src="core.js"> で classic script として読み、
 * Node からは require("./core.js") で読む。追加パッケージは使わない。
 *
 * JSON スキーマは T0016 PLAYCUT (app/page.tsx) の
 *   type MatchProject / type MatchEvent
 * に厳密に一致させること。ここを変えると Mac 版が読めなくなる。
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.PlaycutCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ---------- 基本ユーティリティ ---------- */

  function uid() {
    if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }

  /*
   * 端末ローカルの年月日（YYYY-MM-DD）。
   * ISO(UTC) だと JST 早朝（09:00 前）に「新規」した試合の date が前日になる。
   * ジュニアスポーツは午前試合が普通なので、ここは必ずローカル基準にする。
   * createdAt / finishedAt は ISO(UTC) のままでよい（Mac 版 T0016 も ISO 文字列を想定）。
   */
  function todayStr(nowMs) {
    var d = typeof nowMs === "number" ? new Date(nowMs) : new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  var SPORTS = ["soccer", "basketball"];
  var SIDES = ["home", "away"];

  function sportDefaults(sport) {
    return sport === "basketball"
      ? {
          competition: "REGULAR SEASON / GAME 01",
          periodLengthMinutes: 10,
          preRollSec: 7,
          postRollSec: 8,
          homeColor: "#ff4d24",
          awayColor: "#2c72ff",
        }
      : {
          competition: "2026 SEASON / MATCHDAY 01",
          periodLengthMinutes: 45,
          preRollSec: 14,
          postRollSec: 18,
          homeColor: "#d8ff3e",
          awayColor: "#7d8cff",
        };
  }

  /* ---------- MatchProject ---------- */

  function newProject(sport, nowMs) {
    var s = SPORTS.indexOf(sport) >= 0 ? sport : "soccer";
    var d = sportDefaults(s);
    var ms = typeof nowMs === "number" ? nowMs : Date.now();
    return {
      version: 1,
      sport: s,
      competition: d.competition,
      date: todayStr(ms),
      venue: "メインアリーナ",
      home: { name: "TOKYO UNITED", short: "TKY", color: d.homeColor },
      away: { name: "OSAKA CITY", short: "OSK", color: d.awayColor },
      periodLengthMinutes: d.periodLengthMinutes,
      period: 1,
      clockMs: 0,
      sessionEpochMs: null,
      syncOffsetSec: 0,
      syncConfigured: false,
      preRollSec: d.preRollSec,
      postRollSec: d.postRollSec,
      events: [],
      createdAt: new Date(ms).toISOString(),
      finishedAt: null,
    };
  }

  /* 競技を切り替える。T0016 の switchSport と同じく記録はリセットされる。 */
  function switchSport(project, sport) {
    if (SPORTS.indexOf(sport) < 0 || sport === project.sport) return project;
    var d = sportDefaults(sport);
    return Object.assign({}, project, {
      sport: sport,
      periodLengthMinutes: d.periodLengthMinutes,
      period: 1,
      clockMs: 0,
      sessionEpochMs: null,
      syncOffsetSec: 0,
      syncConfigured: false,
      preRollSec: d.preRollSec,
      postRollSec: d.postRollSec,
      events: [],
      finishedAt: null,
    });
  }

  /* ---------- クロック ---------- */

  /* 実際に画面へ出す経過ms。runningSince が null なら止まっている。 */
  function displayClockMs(project, runningSince, nowMs) {
    var base = project.clockMs || 0;
    var add = runningSince ? nowMs - runningSince : 0;
    return Math.max(0, base + add);
  }

  /* T0016 formatClock と同一。バスケはピリオド長からのカウントダウン。 */
  function formatClock(ms, sport, periodLengthMinutes) {
    var safe = Math.max(0, sport === "basketball" ? periodLengthMinutes * 60000 - ms : ms);
    var total = Math.floor(safe / 1000);
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return pad2(minutes) + ":" + pad2(seconds);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function periodLabel(sport, period) {
    if (sport === "soccer") return period === 1 ? "1st" : period === 2 ? "2nd" : "ET" + (period - 2);
    return period <= 4 ? "Q" + period : "OT" + (period - 4);
  }

  /* 微調整。負にはしない。バスケでもここは「経過ms」を足し引きする。 */
  function nudgeClock(clockMs, deltaMs) {
    return Math.max(0, clockMs + deltaMs);
  }

  /* ---------- イベント ---------- */

  var HIGHLIGHT_TYPES = ["goal", "chance", "point3", "point2"];

  function isHighlightType(type) {
    return HIGHLIGHT_TYPES.indexOf(type) >= 0;
  }

  /*
   * MatchEvent を1件作る。
   * spec: { type, label, team?, delta?, highlight?, system? }
   * ctx : { project, runningSince, nowMs, clockMs?, period?, clockRunning?, id? }
   */
  function makeEvent(spec, ctx) {
    var project = ctx.project;
    var instant = ctx.nowMs;
    var epoch = project.sessionEpochMs == null ? instant : project.sessionEpochMs;
    var event = {
      id: ctx.id || uid(),
      type: spec.type,
      label: spec.label,
      period: ctx.period == null ? project.period : ctx.period,
      clockMs: ctx.clockMs == null ? displayClockMs(project, ctx.runningSince, instant) : ctx.clockMs,
      wallMs: Math.max(0, instant - epoch),
      clockRunning: ctx.clockRunning == null ? Boolean(ctx.runningSince) : ctx.clockRunning,
      highlight: spec.highlight == null ? isHighlightType(spec.type) : Boolean(spec.highlight),
      createdAt: new Date(instant).toISOString(),
    };
    /* team / delta / system は MatchEvent で optional。無い時はキー自体を出さない。 */
    if (spec.team) event.team = spec.team;
    if (typeof spec.delta === "number") event.delta = spec.delta;
    if (spec.system) event.system = true;
    return event;
  }

  /*
   * 最初のイベントが打たれた瞬間を wallMs の原点にする。
   * すでに決まっていればそのまま返す。
   */
  function ensureSession(project, nowMs) {
    if (project.sessionEpochMs != null) return project;
    return Object.assign({}, project, { sessionEpochMs: nowMs });
  }

  /* イベントを追記した新しい project を返す（元は書き換えない）。 */
  function appendEvent(project, event, epochMs) {
    var epoch = project.sessionEpochMs != null
      ? project.sessionEpochMs
      : (typeof epochMs === "number" ? epochMs : null);
    return Object.assign({}, project, {
      sessionEpochMs: epoch,
      events: project.events.concat([event]),
    });
  }

  /* ---------- スコア ---------- */

  function deriveScore(events, wallMs) {
    var limit = typeof wallMs === "number" ? wallMs : Infinity;
    var score = { home: 0, away: 0 };
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.wallMs <= limit && e.delta && e.team && (e.team === "home" || e.team === "away")) {
        score[e.team] += e.delta;
      }
    }
    return score;
  }

  /* ---------- 取り消し / 削除 ---------- */

  /* 直近の「人が記録したイベント」の index。無ければ -1。system は飛ばす。 */
  function lastUserEventIndex(events) {
    for (var i = events.length - 1; i >= 0; i--) {
      if (!events[i].system) return i;
    }
    return -1;
  }

  function removeEventAt(events, index) {
    if (index < 0 || index >= events.length) return events.slice();
    return events.slice(0, index).concat(events.slice(index + 1));
  }

  function removeEventById(events, id) {
    return events.filter(function (e) {
      return e.id !== id;
    });
  }

  /* ---------- 書き出し ---------- */

  function exportFilename(project) {
    return "PLAYCUT_" + project.date + "_" + project.home.short + "-" + project.away.short + ".json";
  }

  /* MatchProject に無いキー（内部の保存用ラッパ等）を落として整形する。 */
  var PROJECT_KEYS = [
    "version", "sport", "competition", "date", "venue", "home", "away",
    "periodLengthMinutes", "period", "clockMs", "sessionEpochMs",
    "syncOffsetSec", "syncConfigured", "preRollSec", "postRollSec",
    "events", "createdAt", "finishedAt",
  ];
  var EVENT_KEYS = [
    "id", "type", "label", "team", "delta", "period", "clockMs",
    "wallMs", "clockRunning", "highlight", "system", "createdAt",
  ];

  function pick(obj, keys) {
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(obj, keys[i]) && obj[keys[i]] !== undefined) {
        out[keys[i]] = obj[keys[i]];
      }
    }
    return out;
  }

  function toMatchProject(project, clockMsOverride) {
    var base = pick(project, PROJECT_KEYS);
    base.home = { name: project.home.name, short: project.home.short, color: project.home.color };
    base.away = { name: project.away.name, short: project.away.short, color: project.away.color };
    base.events = project.events.map(function (e) {
      return pick(e, EVENT_KEYS);
    });
    if (typeof clockMsOverride === "number") base.clockMs = Math.max(0, clockMsOverride);
    return base;
  }

  function serializeProject(project, clockMsOverride) {
    return JSON.stringify(toMatchProject(project, clockMsOverride), null, 2);
  }

  /* ---------- 取り込み / 検証 ---------- */

  function isStr(v) { return typeof v === "string"; }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function isBool(v) { return typeof v === "boolean"; }

  function validateTeam(t, path, errors) {
    if (!t || typeof t !== "object") { errors.push(path + " がオブジェクトではない"); return; }
    if (!isStr(t.name)) errors.push(path + ".name が文字列ではない");
    if (!isStr(t.short)) errors.push(path + ".short が文字列ではない");
    if (!isStr(t.color)) errors.push(path + ".color が文字列ではない");
  }

  function validateEvent(e, path, errors) {
    if (!e || typeof e !== "object") { errors.push(path + " がオブジェクトではない"); return; }
    if (!isStr(e.id)) errors.push(path + ".id が文字列ではない");
    if (!isStr(e.type)) errors.push(path + ".type が文字列ではない");
    if (!isStr(e.label)) errors.push(path + ".label が文字列ではない");
    if (e.team !== undefined && SIDES.indexOf(e.team) < 0) errors.push(path + ".team が home/away ではない");
    if (e.delta !== undefined && !isNum(e.delta)) errors.push(path + ".delta が数値ではない");
    if (!isNum(e.period)) errors.push(path + ".period が数値ではない");
    if (!isNum(e.clockMs)) errors.push(path + ".clockMs が数値ではない");
    if (!isNum(e.wallMs)) errors.push(path + ".wallMs が数値ではない");
    if (!isBool(e.clockRunning)) errors.push(path + ".clockRunning が真偽値ではない");
    if (!isBool(e.highlight)) errors.push(path + ".highlight が真偽値ではない");
    if (e.system !== undefined && !isBool(e.system)) errors.push(path + ".system が真偽値ではない");
    if (!isStr(e.createdAt)) errors.push(path + ".createdAt が文字列ではない");
    var extra = Object.keys(e).filter(function (k) { return EVENT_KEYS.indexOf(k) < 0; });
    if (extra.length) errors.push(path + " に MatchEvent 外のキー: " + extra.join(","));
  }

  /* Mac 版 PLAYCUT がそのまま読めるかを機械的に確かめる。 */
  function validateProject(p) {
    var errors = [];
    if (!p || typeof p !== "object") return { ok: false, errors: ["オブジェクトではない"] };
    if (p.version !== 1) errors.push("version が 1 ではない");
    if (SPORTS.indexOf(p.sport) < 0) errors.push("sport が soccer/basketball ではない");
    if (!isStr(p.competition)) errors.push("competition が文字列ではない");
    if (!isStr(p.date)) errors.push("date が文字列ではない");
    if (!isStr(p.venue)) errors.push("venue が文字列ではない");
    validateTeam(p.home, "home", errors);
    validateTeam(p.away, "away", errors);
    if (!isNum(p.periodLengthMinutes)) errors.push("periodLengthMinutes が数値ではない");
    if (!isNum(p.period)) errors.push("period が数値ではない");
    if (!isNum(p.clockMs)) errors.push("clockMs が数値ではない");
    if (p.sessionEpochMs !== null && !isNum(p.sessionEpochMs)) errors.push("sessionEpochMs が数値でも null でもない");
    if (!isNum(p.syncOffsetSec)) errors.push("syncOffsetSec が数値ではない");
    if (p.syncConfigured !== undefined && !isBool(p.syncConfigured)) errors.push("syncConfigured が真偽値ではない");
    if (!isNum(p.preRollSec)) errors.push("preRollSec が数値ではない");
    if (!isNum(p.postRollSec)) errors.push("postRollSec が数値ではない");
    if (!Array.isArray(p.events)) errors.push("events が配列ではない");
    else p.events.forEach(function (e, i) { validateEvent(e, "events[" + i + "]", errors); });
    if (!isStr(p.createdAt)) errors.push("createdAt が文字列ではない");
    if (p.finishedAt !== undefined && p.finishedAt !== null && !isStr(p.finishedAt)) errors.push("finishedAt が文字列でも null でもない");
    var extra = Object.keys(p).filter(function (k) { return PROJECT_KEYS.indexOf(k) < 0; });
    if (extra.length) errors.push("MatchProject 外のキー: " + extra.join(","));
    return { ok: errors.length === 0, errors: errors };
  }

  /* 取り込み。T0016 の importProject と同じく sessionEpochMs は捨てる。 */
  function parseProject(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, errors: ["JSON として読めない: " + err.message], project: null };
    }
    var result = validateProject(parsed);
    if (!result.ok) return { ok: false, errors: result.errors, project: null };
    var project = toMatchProject(parsed);
    project.sessionEpochMs = null;
    return { ok: true, errors: [], project: project };
  }

  /* ---------- 既定のイベントボタン ---------- */

  function quickActions(sport) {
    if (sport === "basketball") {
      return [
        { type: "point2", label: "2ポイント", delta: 2, primary: true },
        { type: "point1", label: "1ポイント", delta: 1 },
        { type: "point3", label: "3ポイント", delta: 3 },
        { type: "chance", label: "チャンス" },
        { type: "foul", label: "ファウル" },
        { type: "substitution", label: "交代" },
      ];
    }
    return [
      { type: "goal", label: "ゴール", delta: 1, primary: true },
      { type: "chance", label: "チャンス" },
      { type: "card_yellow", label: "イエロー" },
      { type: "card_red", label: "レッド" },
      { type: "substitution", label: "交代" },
    ];
  }

  return {
    SPORTS: SPORTS,
    SIDES: SIDES,
    PROJECT_KEYS: PROJECT_KEYS,
    EVENT_KEYS: EVENT_KEYS,
    uid: uid,
    todayStr: todayStr,
    sportDefaults: sportDefaults,
    newProject: newProject,
    switchSport: switchSport,
    ensureSession: ensureSession,
    displayClockMs: displayClockMs,
    formatClock: formatClock,
    periodLabel: periodLabel,
    nudgeClock: nudgeClock,
    isHighlightType: isHighlightType,
    makeEvent: makeEvent,
    appendEvent: appendEvent,
    deriveScore: deriveScore,
    lastUserEventIndex: lastUserEventIndex,
    removeEventAt: removeEventAt,
    removeEventById: removeEventById,
    exportFilename: exportFilename,
    toMatchProject: toMatchProject,
    serializeProject: serializeProject,
    validateProject: validateProject,
    parseProject: parseProject,
    quickActions: quickActions,
  };
});
