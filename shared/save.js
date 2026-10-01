// 저장: 튜토리얼 완료, 채보별 기록(플레이 횟수·클리어·최고 점수·등급·보더), 해금.
// 브라우저 저장소(localStorage)에 목업별로 따로 둔다. 서버로 열든 파일로 열든 같은 브라우저면 이어진다
// (단, http://localhost 와 file:// 은 브라우저가 서로 다른 저장소로 본다).
//
// 보더(메달): 0 없음(게임오버) · 1 클리어 · 2 풀콤보(굿·미스 없음) · 3 올퍼펙트(전부 퍼펙트)
// 되돌리기를 한 번이라도 쓴 판은 클리어까지만 인정한다(되감아 지운 실수로 풀콤보가 되살아나지 않게, 09-29 결정).
// 그래서 풀콤보·올퍼펙트는 늘 되돌리기 없이 얻은 것이고, medalNR은 "되돌리기 없이 클리어했는가"를 가른다.
(function (root) {
  "use strict";

  // 보더. FAIL(-1)은 저장하는 보더 값이 아니라 표시용이다: 클리어한 적 없이 게임오버만 난 채보(기록의 fails)에 붙는다.
  // 저장값(medal·medalNR)은 예전 그대로 0~3이라 이전 기록과 호환된다.
  var MEDAL = { FAIL: -1, NONE: 0, CLEAR: 1, FC: 2, AP: 3 };
  var MEDAL_LABEL = { "-1": "FAIL", 0: "", 1: "CLEAR", 2: "FULL COMBO", 3: "ALL PERFECT" };
  var MEDAL_SHORT = { "-1": "FAIL", 0: "", 1: "CLEAR", 2: "FC", 3: "AP" }; // 배지 글자: AP·FC는 줄임, CLEAR·FAIL은 그대로
  // 점수 등급(100만 점 만점). 클리어한 판에만 붙는다.
  var RANKS = [
    { min: 980000, label: "S+" }, { min: 950000, label: "S" }, { min: 900000, label: "A" },
    { min: 800000, label: "B" }, { min: 700000, label: "C" }, { min: 0, label: "D" }
  ];

  function rankOf(score) {
    for (var i = 0; i < RANKS.length; i++) if (score >= RANKS[i].min) return RANKS[i].label;
    return "D";
  }
  function rankIndex(label) {
    for (var i = 0; i < RANKS.length; i++) if (RANKS[i].label === label) return i;
    return RANKS.length;
  }

  // result: { cleared, score, counts:{perfect,great,good,miss}, maxCombo, total, rewindsUsed }
  function medalOf(result) {
    if (!result.cleared) return MEDAL.FAIL;
    if (result.rewindsUsed > 0) return MEDAL.CLEAR;
    var c = result.counts;
    if (c.miss === 0 && c.good === 0 && c.great === 0) return MEDAL.AP;
    if (c.miss === 0 && c.good === 0) return MEDAL.FC;
    return MEDAL.CLEAR;
  }

  // 곡 선택·기록에 보일 보더: 얻은 보더가 있으면 그것, 없고 게임오버만 났으면 FAIL, 둘 다 없으면 NONE
  function borderOf(rec) {
    if (!rec) return MEDAL.NONE;
    if (rec.medal > 0) return rec.medal;
    return rec.fails > 0 ? MEDAL.FAIL : MEDAL.NONE;
  }
  // 곡 선택 · 랭킹 칸에 보일 최고 기록: 클리어가 있으면 클리어 최고 점수 · 등급, 게임오버만 났으면 그 최고 점수 · 점수로 매긴 등급(FAIL), 없으면 null(10-01)
  function bestOf(rec) {
    if (!rec) return null;
    if (rec.clears > 0) return { score: rec.bestScore, rank: rec.bestRank, fail: false };
    if (rec.bestFail !== null && rec.bestFail !== undefined) return { score: rec.bestFail, rank: rankOf(rec.bestFail), fail: true };
    return null;
  }

  // bestFail: 게임오버 판의 최고 점수(10-01, 없으면 null). 클리어 최고 기록(bestScore)과 따로 둔다.
  function emptyRecord() {
    return { plays: 0, clears: 0, fails: 0, bestScore: 0, bestRank: null, bestRewinds: null, bestFail: null, medal: 0, medalNR: 0, bestCombo: 0, lastScore: null, lastCleared: null, lastPlayed: null };
  }
  // owner: 이 데이터가 어느 계정 것인가(계정 id, 계정 연결 전 데이터는 null). shared/account.js bindProgress가 정한다.
  function freshData() {
    return { ver: 1, tutorial: { done: false, lessons: {} }, firstRunDone: false, records: {}, seen: {}, notices: {}, unlockAll: false, owner: null }; // notices: 본 안내(예: rivet 리벳 겹침, 09-30)
  }
  // 저장해 둔 글(또는 서버에서 받은 값)을 지금 모양으로. 모르는 버전이면 새 데이터.
  function normalize(raw) {
    var base = freshData();
    if (raw && raw.ver === 1) for (var k in base) if (raw[k] !== undefined && raw[k] !== null) base[k] = raw[k];
    return base;
  }

  // 두 저장 데이터를 합친다(계정에 처음 연결할 때 · 서버에 못 올린 변경이 남았을 때). 같은 데이터를 여러 번 합쳐도 결과가 같다.
  // 튜토리얼 단계 · 본 채보 · 완료 표시는 어느 쪽이든 남기고, 채보 기록은 횟수는 큰 쪽, 최고 기록은 더 좋은 쪽, 마지막 판은 더 최근 쪽.
  // owner는 합치지 않는다(null). 부르는 쪽이 정한다.
  function merge(a, b) {
    a = normalize(a);
    b = normalize(b);
    var out = freshData();
    out.tutorial.done = !!(a.tutorial.done || b.tutorial.done);
    out.firstRunDone = !!(a.firstRunDone || b.firstRunDone);
    out.unlockAll = !!(a.unlockAll || b.unlockAll);
    [a, b].forEach(function (d) {
      var lessons = d.tutorial.lessons || {};
      Object.keys(lessons).forEach(function (k) { out.tutorial.lessons[k] = !!lessons[k] || !!out.tutorial.lessons[k]; });
      Object.keys(d.seen || {}).forEach(function (id) { if (d.seen[id]) out.seen[id] = true; });
      Object.keys(d.notices || {}).forEach(function (k) { if (d.notices[k]) out.notices[k] = true; });
    });
    var ids = {};
    Object.keys(a.records).concat(Object.keys(b.records)).forEach(function (id) { ids[id] = true; });
    Object.keys(ids).forEach(function (id) { out.records[id] = mergeRecord(a.records[id], b.records[id]); });
    return out;
  }
  function mergeRecord(x, y) {
    x = Object.assign(emptyRecord(), x || {});
    y = Object.assign(emptyRecord(), y || {});
    var r = emptyRecord();
    r.plays = Math.max(x.plays, y.plays);
    r.clears = Math.max(x.clears, y.clears);
    r.fails = Math.max(x.fails || 0, y.fails || 0);
    r.medal = Math.max(x.medal, y.medal);
    r.medalNR = Math.max(x.medalNR, y.medalNR);
    r.bestCombo = Math.max(x.bestCombo, y.bestCombo);
    // 최고 기록: 클리어한 쪽 중 점수가 높은 쪽, 같으면 되돌리기를 덜 쓴 쪽
    var best = [x, y].filter(function (v) { return v.bestRank !== null; }).sort(function (p, q) {
      return (q.bestScore - p.bestScore) || ((p.bestRewinds === null ? Infinity : p.bestRewinds) - (q.bestRewinds === null ? Infinity : q.bestRewinds));
    })[0];
    if (best) { r.bestScore = best.bestScore; r.bestRank = best.bestRank; r.bestRewinds = best.bestRewinds; }
    var fails = [x.bestFail, y.bestFail].filter(function (v) { return v !== null && v !== undefined; });
    r.bestFail = fails.length ? Math.max.apply(null, fails) : null;
    var last = (x.lastPlayed || 0) >= (y.lastPlayed || 0) ? x : y;
    r.lastScore = last.lastScore;
    r.lastCleared = last.lastCleared;
    r.lastPlayed = last.lastPlayed;
    return r;
  }

  function create(mode, storage) {
    var KEY = "td-save-" + mode + "-v1";
    var store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    var data = freshData();
    try {
      data = normalize(store && JSON.parse(store.getItem(KEY) || "null"));
    } catch (e) { /* 저장소를 못 쓰면 이번 실행 동안만 기억 */ }

    // 바뀔 때마다 브라우저 저장소에 쓰고, onChange가 있으면 알린다(계정에 올리기, shared/account.js bindProgress)
    function save() {
      try { if (store) store.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 무시 */ }
      if (inst.onChange) inst.onChange(data);
    }

    function getRecord(id) { return data.records[id] || emptyRecord(); }

    // 해금은 난이도 규칙(chart-format.js unlockRule)으로 정한다. 같은 곡의 보통을 찾으려고 지금 곡 목록을 들고 있는다(setCharts).
    var chartList = [];
    function unlockOf(chart) {
      var C = chartFormat();
      return C ? C.unlockRule(chart, chartList) : chart.unlock || { type: "none" };
    }
    function isUnlocked(chart) {
      if (data.unlockAll) return true;
      var u = unlockOf(chart);
      if (u.type === "tutorial") return !!data.tutorial.done;
      if (u.type === "clear") return getRecord(u.chart).clears > 0;
      return true;
    }

    // 해금 조건을 사람이 읽는 문장으로. charts: 제목을 찾을 채보 목록
    function unlockText(chart, charts) {
      var u = unlockOf(chart);
      if (u.type === "tutorial") return "튜토리얼을 마치면 열립니다";
      if (u.type === "clear") {
        var src = (charts || []).filter(function (c) { return c.id === u.chart; })[0];
        var name = src ? src.title + " [" + difficultyLabel(src.difficulty) + "]" : u.chart;
        return name + " 클리어 시 열립니다";
      }
      return "";
    }
    function chartFormat() {
      return root.TDChart || (typeof require === "function" ? require("./chart-format.js") : null); // node 테스트에서는 require
    }
    function difficultyLabel(key) {
      var C = chartFormat();
      return C ? C.difficultyLabel(key) : key;
    }

    // 한 판이 끝났을 때. 돌려주는 값에 새 최고 기록·새 보더·새로 열린 채보를 담는다.
    function record(chartId, result, charts) {
      if (charts) chartList = charts;
      charts = charts || [];
      var before = charts.filter(function (c) { return !isUnlocked(c); }).map(function (c) { return c.id; });
      var r = data.records[chartId] || emptyRecord();
      var prevBest = r.bestScore;
      var prevMedal = r.medal;
      var prevMedalNR = r.medalNR;
      var medal = medalOf(result);
      var rank = result.cleared ? rankOf(result.score) : null;
      r.plays++;
      r.lastScore = result.score;
      r.lastCleared = !!result.cleared;
      r.lastPlayed = Date.now();
      var newBest = false;
      if (result.cleared) {
        r.clears++;
        if (r.bestRank === null || result.score > r.bestScore) {
          newBest = true;
          r.bestScore = result.score;
          r.bestRank = rank;
          r.bestRewinds = result.rewindsUsed;
        } else if (result.score === r.bestScore && result.rewindsUsed < r.bestRewinds) {
          r.bestRewinds = result.rewindsUsed; // 같은 점수면 되돌리기를 덜 쓴 판을 남긴다
        }
        if (medal > r.medal) r.medal = medal;
        if (result.rewindsUsed === 0 && medal > r.medalNR) r.medalNR = medal;
        if (result.maxCombo > r.bestCombo) r.bestCombo = result.maxCombo;
      }
      if (!result.cleared) {
        r.fails = (r.fails || 0) + 1; // 게임오버(중간에 나간 판은 기록하지 않는다)
        if (r.bestFail === null || r.bestFail === undefined || result.score > r.bestFail) r.bestFail = result.score;
      }
      data.records[chartId] = r;
      save();
      var unlocked = before.filter(function (id) {
        var c = charts.filter(function (x) { return x.id === id; })[0];
        return c && isUnlocked(c);
      });
      return {
        record: r, rank: rank, medal: medal, newBest: newBest, prevBest: prevBest,
        newMedal: medal > prevMedal, newMedalNR: result.rewindsUsed === 0 && medal > prevMedalNR,
        unlocked: unlocked
      };
    }

    var inst = {
      get data() { return data; },
      onChange: null,
      // 데이터를 통째로 바꾼다(계정에서 받아 합친 것)
      adopt: function (next) { data = normalize(JSON.parse(JSON.stringify(next))); save(); },
      save: save,
      getRecord: getRecord,
      setCharts: function (charts) { chartList = charts || []; }, // 해금 규칙에 쓸 곡 목록(게임이 곡 목록을 바꿀 때마다)
      isUnlocked: isUnlocked,
      unlockText: unlockText,
      record: record,
      tutorialDone: function () { return !!data.tutorial.done; },
      setTutorialLesson: function (key, passed) { data.tutorial.lessons[key] = !!passed || !!data.tutorial.lessons[key]; save(); },
      setTutorialDone: function () { data.tutorial.done = true; save(); },
      firstRunDone: function () { return !!data.firstRunDone; },
      setFirstRunDone: function () { data.firstRunDone = true; save(); },
      isNew: function (chart) { return isUnlocked(chart) && !data.seen[chart.id]; },
      markSeen: function (id) { if (!data.seen[id]) { data.seen[id] = true; save(); } },
      setUnlockAll: function (on) { data.unlockAll = !!on; save(); },
      noticeSeen: function (key) { return !!(data.notices && data.notices[key]); },
      markNotice: function (key) { if (!data.notices) data.notices = {}; if (!data.notices[key]) { data.notices[key] = true; save(); } },
      reset: function () { var owner = data.owner; data = freshData(); data.owner = owner; save(); } // 기록 초기화(시험용). 계정 표시는 남긴다
    };
    return inst;
  }

  var api = { create: create, fresh: freshData, merge: merge, MEDAL: MEDAL, MEDAL_LABEL: MEDAL_LABEL, MEDAL_SHORT: MEDAL_SHORT, RANKS: RANKS, rankOf: rankOf, rankIndex: rankIndex, medalOf: medalOf, borderOf: borderOf, bestOf: bestOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TDSave = api;
})(this);
