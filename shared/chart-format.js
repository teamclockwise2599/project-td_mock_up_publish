// 채보 파일 형식(td-chart 1)과 변환 규칙. 게임 두 종·에디터·서버·node 도구가 같이 쓴다.
//
// 채보 파일은 JSON 하나 = 난이도 하나. 위치: Mockups/<목업>/charts/<id>.json
// 시간은 박자(b) 단위로 저장하고, 게임에 넘길 때 초(t)로 바꾼다. 초 = offset + 박자 × (60 / bpm)
//
// {
//   "format": 1,
//   "mode": "core" | "lanes",           어느 목업의 채보인지(노트 종류·규칙이 다르다)
//   "id": "enchanted-love_normal",       파일 이름(확장자 뺀 것). 영문 소문자·숫자·-·_ 만
//   "songId": "enchanted-love",          같은 곡의 난이도끼리 묶는 이름
//   "title": "enchanted love", "artist": "",
//   "song": "linear ring - Enchanted love.mp3", songs/ 안의 음원 파일 이름
//   "bpm": 190, "offset": 0,             offset = 음원에서 0박이 울리는 시각(초)
//   "degPerBeat": 90,                    만든 사람이 기준으로 삼은 회전 속도(참고용. 게임은 설정값을 쓴다). 없으면 에임형 90 · 건반형 30
//   "difficulty": "normal", "level": 8,   난이도 easy · normal · hard(쉬움 · 보통 · 어려움). level: 쉬움 1~6 · 보통 4~9 · 어려움 7~13, 화면에는 시계 숫자 I~XII, 13은 OVER
//   "unlock": { "type": "tutorial" }     해금 조건. 게임은 이 칸 대신 난이도 규칙(unlockRule)을 쓰고, 에디터가 저장할 때 규칙대로 채운다
//                                         ({ "type": "none" } 처음부터 / "tutorial" 튜토리얼 완료 / { "type": "clear", "chart": "<id>" } 그 채보 클리어)
//   "order": 0,                          곡 목록 정렬(작을수록 위)
//   "deploy": false,                     배포본(GitHub Pages)에 넣을 커스텀 채보인가. 에디터 「배포에 포함」으로 고른다(기본 꺼짐).
//                                         공식 채보는 서버에서 받으므로 넣지 않는다. 배포 사본은 tools/deploy.js가 이 칸이 켜진 채보만으로 만든다
//   "notes": [
//     { "type": 0, "b": 4, "lane": 2 },                                   탭
//     { "type": 1, "b": 8, "eb": 10, "lane": 1 },                         롱
//     { "type": 2, "b": 12, "eb": 16, "lane": 0,                          체이스(에임형 전용)
//       "path": [{ "b": 12, "lane": 0 }, { "b": 13, "lane": 0 }, { "b": 14, "lane": 2 }, { "b": 16, "lane": 2 }] },
//     { "type": 3, "b": 20, "eb": 24, "lane": 3, "taps": [21, 22.5, 23] }  홀드앤탭(에임형 전용). taps = 리벳(안쪽 탭) 박자
//   ]
// }
//
// 홀드앤탭 taps: 시작과 끝 사이(양 끝 제외)의 리벳 박자, 오름차순. 비어 있어도 된다(09-30).
//   예전 형식 "iv"(간격 하나로 고르게 채움)는 읽을 때 taps로 펼친다. 쓸 때는 taps만 쓴다.
//
// 체이스 path: 시간 순 꼭짓점. 첫 점 = 시작(b, lane), 마지막 점 = 끝(eb). 없으면 lane 한 줄을 그대로 간다.
//   꼭짓점 사이에서 고리 반지름이 시간에 비례해 옮겨 간다(표식이 비스듬히 건너감). 건반형에는 체이스가 없다(탭·롱만).
(function (root) {
  "use strict";

  var TYPE = { TAP: 0, LONG: 1, CHASE: 2, HOLDTAP: 3 };
  var LANES = 4;
  var DIFFICULTIES = [
    { key: "easy", label: "쉬움", short: "EZ" },
    { key: "normal", label: "보통", short: "NM" },
    { key: "hard", label: "어려움", short: "HD" }
  ];
  // 목업별로 쓸 수 있는 노트 종류(에디터 1·2·3·4 키 순서). 건반형은 탭·롱만(체이스·홀드앤탭 없음)
  var MODE_TYPES = {
    core: [TYPE.TAP, TYPE.LONG, TYPE.CHASE, TYPE.HOLDTAP],
    lanes: [TYPE.TAP, TYPE.LONG]
  };
  var TYPE_NAMES = ["탭", "롱", "체이스", "홀드앤탭"];

  function round4(v) { return Math.round(v * 10000) / 10000; }
  function num(v, d) { v = typeof v === "string" ? parseFloat(v) : v; return typeof v === "number" && isFinite(v) ? v : d; }
  function clampLane(l) { l = Math.round(num(l, 0)); return l < 0 ? 0 : l > LANES - 1 ? LANES - 1 : l; }

  // 파일 이름·묶음 이름으로 쓸 수 있게 영문 소문자·숫자·-·_ 만 남긴다.
  function slug(text) {
    var s = String(text || "").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return s || "song";
  }
  function isValidId(id) { return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id); }
  function chartIdOf(songId, difficulty) { return slug(songId) + "_" + difficulty; }
  // 해금 규칙(09-30): 난이도로 정한다. 쉬움 · 보통(과 그 아래)은 튜토리얼 완료, 어려움 이상은 같은 곡(songId)의 보통 클리어.
  // 같은 곡에 보통 채보가 없으면 튜토리얼 완료. charts: 같은 목업의 채보 목록. 채보 파일의 unlock 칸은 에디터가 이 규칙으로 채운다.
  function unlockRule(chart, charts) {
    if (difficultyIndex(chart.difficulty) >= difficultyIndex("hard")) {
      var normal = (charts || []).filter(function (c) { return c.songId === chart.songId && c.difficulty === "normal" && c.id !== chart.id; })[0];
      if (normal) return { type: "clear", chart: normal.id };
    }
    return { type: "tutorial" };
  }
  function difficultyIndex(key) {
    for (var i = 0; i < DIFFICULTIES.length; i++) if (DIFFICULTIES[i].key === key) return i;
    return -1;
  }
  // 레벨: 1~12는 시계 숫자(로마 숫자), 13은 OVER(보스곡 반열 하나로 묶음). 저장값은 숫자.
  var LEVEL_MAX = 13; // 13 = OVER(보스곡 반열)
  // 난이도별로 고를 수 있는 레벨(09-30): 쉬움 I~VI, 보통 IV~IX, 어려움 VII~OVER
  var LEVEL_RANGE = { easy: [1, 6], normal: [4, 9], hard: [7, 13] };
  function levelRange(difficulty) { return LEVEL_RANGE[difficulty] || LEVEL_RANGE.normal; }
  var ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
  function levelLabel(n) {
    n = Math.round(n);
    return n >= LEVEL_MAX ? "OVER" : ROMAN[Math.max(1, n)];
  }
  // 화면 표시용: 레벨이라는 걸 분명히 "LV. VII" · "LV. OVER"
  function levelText(n) { return "LV. " + levelLabel(n); }
  function difficultyLabel(key) {
    var i = difficultyIndex(key);
    return i >= 0 ? DIFFICULTIES[i].label : key;
  }

  // 체이스 꼭짓점 정리: 시간 순, 같은 박자는 뒤의 것, 첫 점·끝 점을 노트 시작·끝에 맞춘다.
  function normalizePath(path, b, eb, lane) {
    var pts = (Array.isArray(path) ? path : []).map(function (p) { return { b: round4(num(p.b, b)), lane: clampLane(p.lane) }; })
      .filter(function (p) { return p.b >= b - 1e-6 && p.b <= eb + 1e-6; });
    pts.sort(function (x, y) { return x.b - y.b; });
    var out = [];
    pts.forEach(function (p) {
      if (out.length && Math.abs(out[out.length - 1].b - p.b) < 1e-6) out[out.length - 1] = p;
      else out.push(p);
    });
    if (!out.length || out[0].b > b + 1e-6) out.unshift({ b: b, lane: lane });
    out[0] = { b: b, lane: lane };
    if (out[out.length - 1].b < eb - 1e-6) out.push({ b: eb, lane: out[out.length - 1].lane });
    out[out.length - 1] = { b: eb, lane: out[out.length - 1].lane };
    // 같은 라인이 셋 이상 이어지면 가운데 점은 필요 없다(에임형 기울기도 변하지 않음)
    var slim = [out[0]];
    for (var i = 1; i < out.length; i++) {
      var prev = slim[slim.length - 1];
      var next = out[i + 1];
      if (next && prev.lane === out[i].lane && next.lane === out[i].lane) continue;
      slim.push(out[i]);
    }
    return slim;
  }
  function pathHasTurns(path) {
    for (var i = 1; i < path.length; i++) if (path[i].lane !== path[0].lane) return true;
    return false;
  }

  // 홀드앤탭 리벳 박자: 시작·끝 사이(양 끝 제외)만, 오름차순, 겹치면 하나로. taps가 없고 예전 iv가 있으면 그 간격으로 채운다.
  function normalizeTaps(src, b, eb) {
    var raw = [];
    if (Array.isArray(src.taps)) raw = src.taps.map(function (t) { return num(t, NaN); });
    else if (src.iv !== undefined) {
      var iv = Math.max(0.125, num(src.iv, 1));
      for (var t = b + iv; t < eb - 1e-4; t += iv) raw.push(t);
    }
    var out = [];
    raw.map(round4).sort(function (p, q) { return p - q; }).forEach(function (t) {
      if (!isFinite(t) || t <= b + 1e-4 || t >= eb - 1e-4) return;
      if (out.length && Math.abs(out[out.length - 1] - t) < 1e-4) return;
      out.push(t);
    });
    return out;
  }

  function normalizeNote(src) {
    var type = Math.round(num(src.type, 0));
    if (type < 0 || type > 3) type = 0;
    var b = round4(Math.max(0, num(src.b, 0)));
    var lane = clampLane(src.lane);
    var n = { type: type, b: b, lane: lane };
    if (type !== TYPE.TAP) {
      var eb = round4(num(src.eb, b + 1));
      if (eb <= b + 1e-4) eb = round4(b + 0.25);
      n.eb = eb;
    }
    if (type === TYPE.HOLDTAP) n.taps = normalizeTaps(src, b, n.eb);
    if (type === TYPE.CHASE) {
      var path = normalizePath(src.path, n.b, n.eb, lane);
      if (pathHasTurns(path)) n.path = path;
    }
    return n;
  }

  function compareNotes(a, b) { return a.b - b.b || a.lane - b.lane || a.type - b.type; }

  function normalizeUnlock(u) {
    if (!u || typeof u !== "object") return { type: "none" };
    if (u.type === "tutorial") return { type: "tutorial" };
    if (u.type === "clear" && typeof u.chart === "string" && u.chart) return { type: "clear", chart: u.chart };
    return { type: "none" };
  }

  // 파일에서 읽은 값을 빈칸·잘못된 값 없이 정리한다(원본은 건드리지 않음).
  function normalizeChart(raw, idHint) {
    raw = raw || {};
    var title = String(raw.title || "제목 없음");
    var songId = raw.songId ? slug(raw.songId) : slug(title);
    var difficulty = difficultyIndex(raw.difficulty) >= 0 ? raw.difficulty : "normal";
    var id = isValidId(raw.id) ? raw.id : isValidId(idHint) ? idHint : chartIdOf(songId, difficulty);
    var notes = (Array.isArray(raw.notes) ? raw.notes : []).map(normalizeNote).sort(compareNotes);
    return {
      format: 1,
      mode: raw.mode === "lanes" ? "lanes" : "core",
      id: id,
      songId: songId,
      title: title,
      artist: String(raw.artist || ""),
      song: String(raw.song || ""),
      bpm: Math.max(1, num(raw.bpm, 120)),
      offset: num(raw.offset, 0),
      degPerBeat: num(raw.degPerBeat, raw.mode === "lanes" ? 30 : 90), // 비어 있으면 목업 기본 회전 속도(에임형 90° · 건반형 30°)
      difficulty: difficulty,
      level: Math.max(1, Math.min(LEVEL_MAX, Math.round(num(raw.level, 1)))),
      unlock: normalizeUnlock(raw.unlock),
      order: num(raw.order, 0),
      deploy: raw.deploy === true,
      notes: notes
    };
  }

  // 게임 엔진이 읽는 모양(초 단위)으로 바꾼다.
  function toEngineChart(chart) {
    var spb = 60 / chart.bpm;
    function sec(b) { return round4(chart.offset + b * spb); }
    var notes = chart.notes.slice().sort(compareNotes).map(function (n, i) {
      var e = { id: i + 1, type: n.type, t: sec(n.b), end: sec(n.type === TYPE.TAP ? n.b : n.eb), lane: n.lane };
      if (n.type === TYPE.HOLDTAP) e.taps = (n.taps || []).map(sec);
      if (n.type === TYPE.CHASE && n.path) e.path = n.path.map(function (p) { return { t: sec(p.b), lane: p.lane }; });
      return e;
    });
    return { id: chart.id, title: chart.title, bpm: chart.bpm, offset: chart.offset, degPerBeat: chart.degPerBeat, notes: notes };
  }

  // 예전 초 단위 채보(chart-data.js)를 박자 단위로 옮길 때. 1/48박 격자에 맞춘다.
  function secToBeat(t, bpm, offset) {
    return Math.round(((t - (offset || 0)) / (60 / bpm)) * 48) / 48;
  }
  function fromEngineNotes(notes, bpm, offset) {
    return notes.map(function (n) {
      var o = { type: n.type, b: round4(secToBeat(n.t, bpm, offset)), lane: n.lane };
      if (n.type !== TYPE.TAP) o.eb = round4(secToBeat(n.end, bpm, offset));
      if (n.type === TYPE.HOLDTAP) {
        if (n.taps) o.taps = n.taps.map(function (t) { return round4(secToBeat(t, bpm, offset)); });
        else o.iv = n.interval || 1;
      }
      if (n.type === TYPE.CHASE && n.path) o.path = n.path.map(function (p) { return { b: round4(secToBeat(p.t, bpm, offset)), lane: p.lane }; });
      return o;
    });
  }

  // 체이스의 박자 b 시점 라인(건반형 기준: 꼭짓점 시각에 바뀜).
  function laneAtBeat(note, b) {
    if (!note.path) return note.lane;
    var lane = note.path[0].lane;
    for (var i = 0; i < note.path.length; i++) if (note.path[i].b <= b + 1e-6) lane = note.path[i].lane;
    return lane;
  }

  // 목업별 규칙으로 칠 수 없는 배치를 찾는다. 저장은 막지 않고 알려만 준다.
  // 돌려주는 값: [{ level: "error"|"warn", index: 노트 번호(notes 배열 기준), msg }]
  function validateChart(chart) {
    var out = [];
    var notes = chart.notes;
    var allowed = MODE_TYPES[chart.mode] || MODE_TYPES.core;
    var EPS = 1e-4;
    notes.forEach(function (n, i) {
      if (allowed.indexOf(n.type) < 0) out.push({ level: "error", index: i, msg: TYPE_NAMES[n.type] + "은(는) 이 목업에서 쓸 수 없는 노트입니다" });
      if (n.type !== TYPE.TAP && !(n.eb > n.b)) out.push({ level: "error", index: i, msg: "끝이 시작보다 빠릅니다" });
    });
    function activeLaneAt(h, b) { return h.type === TYPE.CHASE ? laneAtBeat(h, b) : h.lane; }
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var same = 0;
      for (var j = 0; j < notes.length; j++) {
        if (j === i) continue;
        var m = notes[j];
        if (Math.abs(m.b - n.b) < EPS) {
          same++;
          if (m.lane === n.lane && j < i) out.push({ level: "error", index: i, msg: "같은 자리에 노트가 겹칩니다" });
        }
        // 누르고 있는 노트(m) 도중에 시작하는 노트(n)
        if (m.type !== TYPE.TAP && n.b > m.b + EPS && n.b < m.eb + EPS) {
          if (chart.mode === "core") {
            // 홀드앤탭 리벳과 같은 순간의 탭은 의도한 패턴(잡은 키 + 리벳 키 + 커서로 탭). 일반 경고와 구분해 알린다(09-30).
            var onRivet = m.type === TYPE.HOLDTAP && n.type === TYPE.TAP && (m.taps || []).some(function (tb) { return Math.abs(tb - n.b) < EPS; });
            out.push({ level: "warn", index: i, msg: onRivet ? "홀드앤탭 리벳과 같은 순간입니다(잡은 키 + 리벳 키 + 커서로 탭, 입력 3개)" : "누르는 노트 도중에 시작합니다(커서가 하나라 치기 어렵습니다)" });
          } else if (activeLaneAt(m, n.b) === n.lane) {
            out.push({ level: "warn", index: i, msg: "누르고 있는 라인에 노트가 있습니다" });
          }
        }
      }
      if (chart.mode === "core" && same > 0) out.push({ level: "warn", index: i, msg: "같은 순간에 노트가 둘 이상입니다(커서가 하나라 동시치기 불가)" });
      if (chart.mode === "lanes" && same > 1) out.push({ level: "warn", index: i, msg: "동시치기가 셋 이상입니다" });
    }
    // 같은 노트에 같은 문구가 여러 번 붙지 않게 정리
    var seen = {};
    return out.filter(function (w) {
      var k = w.index + "|" + w.msg;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  // 파일로 쓸 때: 머리 항목은 한 줄에 하나, 노트도 한 줄에 하나(변경 내역을 보기 쉽게).
  function stringifyChart(chart) {
    var lines = [];
    Object.keys(chart).forEach(function (k) {
      if (k === "notes") return;
      lines.push("  " + JSON.stringify(k) + ": " + JSON.stringify(chart[k]));
    });
    var notes = (chart.notes || []).map(function (n) { return "    " + JSON.stringify(n); });
    lines.push('  "notes": [' + (notes.length ? "\n" + notes.join(",\n") + "\n  ]" : "]"));
    return "{\n" + lines.join(",\n") + "\n}\n";
  }

  var api = {
    TYPE: TYPE, LANES: LANES, stringifyChart: stringifyChart, DIFFICULTIES: DIFFICULTIES, MODE_TYPES: MODE_TYPES, TYPE_NAMES: TYPE_NAMES,
    slug: slug, isValidId: isValidId, chartIdOf: chartIdOf, difficultyIndex: difficultyIndex, difficultyLabel: difficultyLabel, levelLabel: levelLabel, levelText: levelText, LEVEL_MAX: LEVEL_MAX, LEVEL_RANGE: LEVEL_RANGE, levelRange: levelRange,
    normalizeChart: normalizeChart, normalizeNote: normalizeNote, normalizePath: normalizePath, compareNotes: compareNotes,
    toEngineChart: toEngineChart, fromEngineNotes: fromEngineNotes, secToBeat: secToBeat, laneAtBeat: laneAtBeat,
    validateChart: validateChart,
    unlockRule: unlockRule
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TDChart = api;
})(this);
