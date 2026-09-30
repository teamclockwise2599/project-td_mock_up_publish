// 판정·점수·라이프·되돌리기 규칙만 담은 순수 로직입니다.
// 화면·소리·입력 장치와 무관하므로 브라우저와 node 테스트에서 똑같이 돌아갑니다.
//
// 좌표 규칙: 시계 판의 반지름을 1로 둔 정규화 좌표. 12시 방향이 0도이고 시계 방향으로 각도가 커집니다.
// 화면과 같게 y는 아래쪽이 +입니다.
(function (root) {
  "use strict";

  var TYPE = { TAP: 0, LONG: 1, CHASE: 2, HOLDTAP: 3 };
  var RANKS = ["perfect", "great", "good", "miss"];

  var DEFAULTS = {
    windows: { perfect: 50, great: 100, good: 150 }, // 판정 범위(ms, 앞뒤 대칭)
    // 누르는 노트(롱·체이스·홀드앤탭)의 끝에서 떼는 판정 범위. 누를 때보다 후하게(09-29).
    // 이보다 일찍 떼면 미스, 끝을 이만큼 지나서도 누르고 있으면 끝 판정 미스.
    releaseWindows: { perfect: 100, great: 150, good: 200 }, // ms
    weights: { perfect: 1, great: 0.7, good: 0.5, miss: 0 }, // 판정별 점수 배율
    maxScore: 1000000,
    lifeMax: 200,
    lifePerMiss: 10,
    laneRadii: [0.30, 0.49, 0.68, 0.87], // 안쪽부터 0~3번 레인
    spiralPerTurn: 0.06, // 누르는 노트가 한 바퀴 돌 때 바깥으로 벌어지는 거리
    aimRadius: 0.14, // 화면에 그리는 에임 원의 반지름(판정에는 쓰지 않는다)
    hitRadius: 0.19, // 커서가 노트 중심에서 이만큼 안에 있어야 친 것으로 본다. 에임 원(0.14)보다 넓어 태엽이 원에 절반쯤 걸쳐도 친다. 레인 간격(0.19)과 같게(09-29, 예전 0.14)
    sweetRadius: 0.0372, // 탭 태엽의 가운데 빈 곳(태엽 반지름 0.093의 0.4). 퍼펙트로 칠 때 커서가 이 안이면 퍼펙트+
    plusBonus: 1, // 퍼펙트+ 1개당 더하는 점수(이론치 = maxScore + 탭 노트 수)
    followRadius: 0.208, // 체이스 표식을 따라갈 때 허용 거리(처음 0.16에서 30% 늘림)
    degPerBeat: null, // 한 박자에 판정선이 도는 각도. 비우면 채보 값(90)을 쓴다
    posFn: null, // 위치 계산을 통째로 바꿔 끼울 때(튜토리얼의 직선 트랙). posFn(t, lane, fromT) → {x, y}
    followGrace: 156, // 체이스 표식에서 잠깐 벗어나도 봐주는 시간(ms, 처음 120에서 30% 늘림)
    rewindSeconds: 3, // 되돌리기: 실수 몇 초 전으로 돌아갈지
    rewindLimit: -1, // 되돌리기 횟수. -1은 무제한
    rewindPenalty: 10000, // 되돌리기 1회당 감점
    rewindLookback: 10, // 이 시간(초) 안의 실수만 "방금 한 실수"로 본다
    preRoll: 1.2 // 되감은 뒤 노트가 다시 나오기 전까지 들려줄 음악 길이(초)
  };

  function merge(base, extra) {
    var out = {};
    for (var k in base) out[k] = base[k];
    if (extra) for (var j in extra) if (extra[j] !== undefined) out[j] = extra[j];
    return out;
  }

  function dist(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function createEngine(chart, options) {
    var cfg = merge(DEFAULTS, options);
    var spb = 60 / chart.bpm; // 한 박자의 길이(초)
    // 판정 기준은 ms로 받아(cfg), 초 단위인 곡 시간과 견주려고 여기서 한 번 초로 바꾼다
    function msToSec(w) { return { perfect: w.perfect / 1000, great: w.great / 1000, good: w.good / 1000 }; }
    var W = msToSec(cfg.windows);
    var RW = msToSec(cfg.releaseWindows);
    var GRACE = cfg.followGrace / 1000;
    var notes = chart.notes.map(buildNote).sort(function (a, b) { return a.t - b.t; });
    var total = notes.reduce(function (s, n) { return s + n.slots.length; }, 0) || 1; // 노트 없는 채보도 점수 계산이 깨지지 않게
    var tapCount = notes.filter(function (n) { return n.type === TYPE.TAP; }).length; // 퍼펙트+를 받을 수 있는 노트 수
    var st = null;

    // ---------- 기하 ----------
    function degPerBeat() {
      return cfg.degPerBeat || chart.degPerBeat;
    }
    function angleAt(t) {
      return ((t - chart.offset) / spb) * degPerBeat();
    }
    function laneRadius(lane) {
      var i = Math.max(0, Math.min(cfg.laneRadii.length - 1, lane));
      return cfg.laneRadii[i];
    }
    // fromT를 주면 누르는 노트처럼 돌면서 조금씩 바깥으로 벌어지는 나선 위치를 돌려준다.
    function posAt(t, lane, fromT) {
      if (cfg.posFn) return cfg.posFn(t, lane, fromT);
      var a = angleAt(t);
      var r = laneRadius(lane);
      if (fromT !== undefined && fromT !== null) r += ((a - angleAt(fromT)) / 360) * cfg.spiralPerTurn;
      var rad = (a * Math.PI) / 180;
      return { x: Math.sin(rad) * r, y: -Math.cos(rad) * r };
    }
    // 체이스가 고리를 건너가는 경우: 꼭짓점(path) 사이에서 반지름이 시간에 비례해 옮겨 간다.
    function pathRadius(n, t) {
      var p = n.path;
      if (!p) return laneRadius(n.lane);
      if (t <= p[0].t) return laneRadius(p[0].lane);
      for (var i = 1; i < p.length; i++) {
        if (t <= p[i].t) {
          var a = p[i - 1];
          var b = p[i];
          var k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
          return laneRadius(a.lane) + (laneRadius(b.lane) - laneRadius(a.lane)) * k;
        }
      }
      return laneRadius(p[p.length - 1].lane);
    }
    // 누르는 노트가 t 시점에 지나는 자리(체이스 표식·롱의 사슬·홀드앤탭 리벳). 한 바퀴마다 조금씩 바깥으로 벌어진다.
    function notePos(n, t) {
      if (cfg.posFn) return cfg.posFn(t, n.lane, n.t);
      if (!n.path) return posAt(t, n.lane, n.t);
      var a = angleAt(t);
      var r = pathRadius(n, t) + ((a - angleAt(n.t)) / 360) * cfg.spiralPerTurn;
      var rad = (a * Math.PI) / 180;
      return { x: Math.sin(rad) * r, y: -Math.cos(rad) * r };
    }
    // 체이스가 t 시점에 가장 가까운 레인(화면 표시용)
    function laneAt(n, t) {
      if (!n.path) return n.lane;
      var r = pathRadius(n, t);
      var best = 0;
      for (var i = 1; i < cfg.laneRadii.length; i++) if (Math.abs(cfg.laneRadii[i] - r) < Math.abs(cfg.laneRadii[best] - r)) best = i;
      return best;
    }
    function slotPos(note, slot) {
      if (slot.kind === "start") return posAt(note.t, note.lane);
      return notePos(note, slot.time);
    }

    // ---------- 채보 → 판정 칸 ----------
    function buildNote(src) {
      var n = {
        id: src.id, type: src.type, t: src.t, end: src.type === TYPE.TAP ? src.t : src.end,
        lane: src.lane, interval: src.interval || 1,
        slots: [], state: "idle", holdKey: null, outSince: null,
        // 체이스 꼭짓점: [{t, lane}]. 레인을 건너가지 않으면 없다.
        path: src.type === TYPE.CHASE && src.path && src.path.length > 1 ? src.path.map(function (p) { return { t: p.t, lane: p.lane }; }) : null
      };
      n.slots.push({ kind: "start", time: n.t, result: null, delta: null });
      if (n.type === TYPE.HOLDTAP) {
        // 홀드앤탭 내부 탭(리벳): 채보의 taps(초). 없으면 interval 간격으로 시작 다음부터 끝 직전까지 채운다.
        var times = [];
        if (Array.isArray(src.taps)) times = src.taps.filter(function (x) { return x > n.t + 1e-4 && x < n.end - 1e-4; }).sort(function (a, b) { return a - b; });
        else for (var tt = n.t + n.interval * spb; tt < n.end - 1e-4; tt += n.interval * spb) times.push(tt);
        times.forEach(function (x) {
          n.slots.push({ kind: "tap", time: Math.round(x * 10000) / 10000, result: null, delta: null });
        });
      }
      if (n.type !== TYPE.TAP) n.slots.push({ kind: "end", time: n.end, result: null, delta: null });
      return n;
    }

    function freshState() {
      return {
        counts: { perfect: 0, great: 0, good: 0, miss: 0 },
        plus: 0, // 퍼펙트+ 수(counts.perfect에 들어 있는 부분 집합)
        combo: 0, maxCombo: 0,
        log: [], // 판정 기록(되감을 때 이 기록으로 점수·콤보를 다시 계산한다)
        failures: [], // 실수 기록(라이프 계산용). 한 번의 실수 = 라이프 1칸
        rewindsUsed: 0, penalty: 0,
        gameOver: false, gameOverTime: null,
        events: []
      };
    }

    function resetNote(n) {
      n.state = "idle";
      n.holdKey = null;
      n.outSince = null;
      n.slots.forEach(function (s) { s.result = null; s.delta = null; s.plus = false; });
    }

    function reset() {
      notes.forEach(resetNote);
      st = freshState();
    }

    // ---------- 판정 ----------
    function rankOf(absDelta, win) {
      var w = win || W;
      if (absDelta <= w.perfect) return "perfect";
      if (absDelta <= w.great) return "great";
      if (absDelta <= w.good) return "good";
      return "miss";
    }

    // 콤보 규칙: 퍼펙트·그레이트는 이어지고, 굿은 콤보만 끊기고, 미스는 콤보가 끊기면서 라이프도 깎인다.
    function applyToCombo(rank) {
      if (rank === "perfect" || rank === "great") {
        st.combo++;
        if (st.combo > st.maxCombo) st.maxCombo = st.combo;
      } else {
        st.combo = 0;
      }
    }

    // plus: 퍼펙트+ 여부. 등급은 그대로 "perfect"이고, 점수에 plusBonus만 더한다.
    function judgeSlot(note, index, rank, delta, plus) {
      var slot = note.slots[index];
      if (slot.result) return;
      plus = !!plus && rank === "perfect";
      slot.result = rank;
      slot.delta = delta;
      slot.plus = plus;
      st.counts[rank]++;
      if (plus) st.plus++;
      st.log.push({ noteT: note.t, rank: rank, plus: plus });
      st.lastRank = rank; // 타격음이 바로 쓸 수 있게 방금 나온 등급을 기억
      applyToCombo(rank);
      var p = slotPos(note, slot);
      st.events.push({ kind: "judge", rank: rank, plus: plus, delta: delta, x: p.x, y: p.y, noteType: note.type, slotKind: slot.kind, lane: note.lane });
    }

    // 퍼펙트+ 조건: 탭 노트를 퍼펙트로 쳤고, 누른 순간 커서가 태엽 가운데 빈 곳(sweetRadius) 안에 있다.
    function isPlus(note, rank, pos) {
      return note.type === TYPE.TAP && rank === "perfect" && dist(pos, posAt(note.t, note.lane)) <= cfg.sweetRadius;
    }

    function life() {
      return Math.max(0, cfg.lifeMax - cfg.lifePerMiss * st.failures.length);
    }

    function addFailure(note, musicTime) {
      st.failures.push({ noteT: note.t, time: musicTime });
      if (!st.gameOver && life() <= 0) {
        st.gameOver = true;
        st.gameOverTime = musicTime;
        st.events.push({ kind: "gameover" });
      }
    }

    // 노트 하나를 통째로 놓친 경우: 남은 판정 칸을 전부 미스로 채우되, 라이프는 한 번만 깎는다.
    function failNote(note, musicTime) {
      for (var i = 0; i < note.slots.length; i++) if (!note.slots[i].result) judgeSlot(note, i, "miss", null);
      note.state = "failed";
      note.holdKey = null;
      addFailure(note, musicTime);
    }

    function missTapSlot(note, index) {
      judgeSlot(note, index, "miss", null);
      addFailure(note, note.slots[index].time);
    }

    function finishIfDone(note) {
      for (var i = 0; i < note.slots.length; i++) if (!note.slots[i].result) return;
      if (note.state !== "failed") note.state = "done";
      note.holdKey = null;
    }

    // ---------- 입력 ----------
    // key: 누른 타격 키 이름(예: "Z", "X", "M1"). pos: 누른 순간의 커서(정규화 좌표).
    function press(key, t, pos) {
      if (st.gameOver) return false;

      // 1) 홀드앤탭을 누르고 있는 중이면, 다른 키 입력은 내부 탭 판정에 먼저 쓴다(위치 무관).
      for (var i = 0; i < notes.length; i++) {
        var h = notes[i];
        if (h.type !== TYPE.HOLDTAP || h.state !== "holding" || h.holdKey === key) continue;
        var best = -1;
        var bestAbs = Infinity;
        for (var j = 0; j < h.slots.length; j++) {
          var s = h.slots[j];
          if (s.kind !== "tap" || s.result) continue;
          var a = Math.abs(t - s.time);
          if (a <= W.good && a < bestAbs) { best = j; bestAbs = a; }
        }
        if (best >= 0) {
          judgeSlot(h, best, rankOf(bestAbs), t - h.slots[best].time);
          return h; // 맞힌 노트(참 값)
        }
      }

      // 2) 커서 근처에 있고 판정 범위 안에 든 노트 중 시간이 가장 가까운 것의 시작을 친다.
      var cand = null;
      var candAbs = Infinity;
      for (var k = 0; k < notes.length; k++) {
        var n = notes[k];
        if (n.t - W.good > t) break;
        if (n.state !== "idle") continue;
        var d = Math.abs(t - n.t);
        if (d > W.good) continue;
        if (dist(pos, posAt(n.t, n.lane)) > cfg.hitRadius) continue;
        if (d < candAbs) { cand = n; candAbs = d; }
      }
      if (!cand) return false; // 빈 곳을 친 것은 벌점 없음

      var rank = rankOf(candAbs);
      judgeSlot(cand, 0, rank, t - cand.t, isPlus(cand, rank, pos));
      if (cand.type === TYPE.TAP) {
        cand.state = "done";
      } else {
        cand.state = "holding";
        cand.holdKey = key;
        cand.outSince = null;
      }
      return cand; // 맞힌 노트(참 값)
    }

    function release(key, t) {
      if (st.gameOver) return;
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        if (n.state !== "holding" || n.holdKey !== key) continue;
        if (t >= n.end - RW.good) {
          // 끝 무렵에 뗀 것은 떼는 판정(releaseWindows)으로 처리한다.
          for (var j = 0; j < n.slots.length - 1; j++) if (!n.slots[j].result) missTapSlot(n, j);
          judgeSlot(n, n.slots.length - 1, rankOf(Math.abs(t - n.end), RW), t - n.end);
          finishIfDone(n);
        } else {
          failNote(n, t); // 일찍 뗌 = 한 번의 실수
        }
        if (st.gameOver) return;
      }
    }

    // 매 프레임 호출: 지나간 노트 미스 처리, 체이스 추적 검사, 끝에서 떼지 않은 노트 미스 처리.
    // heldKeys: 지금 눌려 있는 키 목록({Z:true}). 떼는 신호를 놓쳤을 때를 대비해 대조한다.
    function update(t, pos, heldKeys) {
      if (st.gameOver) return;
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        if (n.t - W.good > t) break;

        if (n.state === "idle") {
          if (t > n.t + W.good) failNote(n, n.t);
          if (st.gameOver) return;
          continue;
        }
        if (n.state !== "holding") continue;

        if (heldKeys && !heldKeys[n.holdKey]) {
          release(n.holdKey, t);
          if (st.gameOver) return;
          continue;
        }

        if (n.type === TYPE.HOLDTAP) {
          for (var j = 0; j < n.slots.length; j++) {
            var s = n.slots[j];
            if (s.kind === "tap" && !s.result && t > s.time + W.good) {
              missTapSlot(n, j);
              if (st.gameOver) return;
            }
          }
        }

        // 커서를 지켜야 하는 자리: 체이스는 시침을 따라 움직이는 표식, 롱은 시작 태엽 자리(움직이지 않음).
        // 허용 거리(followRadius)와 잠깐 벗어나도 봐주는 시간(followGrace)은 둘이 같다.
        var anchor = null;
        if (t < n.end) {
          if (n.type === TYPE.CHASE) anchor = notePos(n, t);
          else if (n.type === TYPE.LONG) anchor = posAt(n.t, n.lane);
        }
        if (anchor) {
          if (dist(pos, anchor) > cfg.followRadius) {
            if (n.outSince === null) n.outSince = t;
            else if (t - n.outSince > GRACE) {
              failNote(n, t);
              if (st.gameOver) return;
              continue;
            }
          } else {
            n.outSince = null;
          }
        }

        // 끝을 떼는 판정 범위만큼 지나서도 누르고 있으면 떼지 않은 것: 끝 판정 미스(라이프 한 번)
        if (t > n.end + RW.good) {
          failNote(n, n.end + RW.good);
          if (st.gameOver) return;
        }
      }
    }

    // ---------- 되돌리기 ----------
    function lastMistakeTime() {
      var last = null;
      st.failures.forEach(function (f) { if (last === null || f.time > last) last = f.time; });
      return last;
    }

    function rewindsLeft() {
      return cfg.rewindLimit < 0 ? Infinity : Math.max(0, cfg.rewindLimit - st.rewindsUsed);
    }

    // 가장 최근 실수(없거나 오래됐으면 지금)에서 rewindSeconds 전으로 되감는다.
    // 되감는 지점이 누르는 노트의 한가운데나 어떤 노트의 판정 범위에 걸리면, 그 노트가 시작되기 전으로 더 당긴다.
    function rewind(tNow) {
      if (st.gameOver) return { ok: false, reason: "gameover" };
      if (rewindsLeft() <= 0) return { ok: false, reason: "limit" };

      var last = lastMistakeTime();
      var anchor = last !== null && tNow - last <= cfg.rewindLookback ? Math.min(last, tNow) : tNow;
      var b = anchor - cfg.rewindSeconds;
      var moved = true;
      while (moved) {
        moved = false;
        for (var i = 0; i < notes.length; i++) {
          var lo = notes[i].t - W.good;
          var hi = notes[i].end + Math.max(W.good, RW.good);
          if (b > lo && b < hi) { b = lo - 0.05; moved = true; }
        }
      }
      if (b < 0) b = 0;

      // 경계 이후의 노트는 처음 상태로, 판정·실수 기록도 경계 이전 것만 남긴다.
      notes.forEach(function (n) { if (n.t > b) resetNote(n); });
      st.log = st.log.filter(function (e) { return e.noteT < b; });
      st.failures = st.failures.filter(function (f) { return f.noteT < b; });
      st.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
      st.plus = 0;
      st.combo = 0;
      st.maxCombo = 0;
      st.log.forEach(function (e) { st.counts[e.rank]++; if (e.plus) st.plus++; applyToCombo(e.rank); });
      st.rewindsUsed++;
      st.penalty += cfg.rewindPenalty;
      st.events.push({ kind: "rewind", boundary: b, penalty: cfg.rewindPenalty });
      return { ok: true, boundary: b, resumeAt: Math.max(0, b - cfg.preRoll), from: tNow };
    }

    // ---------- 조회 ----------
    // 점수 = 판정 배율 합(최대 maxScore) + 퍼펙트+ 가산 − 되돌리기 감점. 이론치 = maxScore + 탭 노트 수 × plusBonus
    function score() {
      var c = st.counts;
      var w = cfg.weights;
      var raw = Math.round((cfg.maxScore * (c.perfect * w.perfect + c.great * w.great + c.good * w.good)) / total);
      return Math.max(0, raw + st.plus * cfg.plusBonus - st.penalty);
    }

    function isFinished() {
      for (var i = 0; i < notes.length; i++) if (notes[i].state === "idle" || notes[i].state === "holding") return false;
      return true;
    }

    function getState() {
      return {
        score: score(), life: life(), lifeMax: cfg.lifeMax,
        combo: st.combo, maxCombo: st.maxCombo,
        // perfectPlus: 퍼펙트+ 수(perfect에 포함). 보더·정확도·등급은 perfect만 본다.
        counts: { perfect: st.counts.perfect, perfectPlus: st.plus, great: st.counts.great, good: st.counts.good, miss: st.counts.miss },
        total: total, taps: tapCount, maxScore: cfg.maxScore + tapCount * cfg.plusBonus, rewindsUsed: st.rewindsUsed, rewindsLeft: rewindsLeft(), penalty: st.penalty,
        gameOver: st.gameOver, finished: isFinished()
      };
    }

    function drainEvents() {
      var e = st.events;
      st.events = [];
      return e;
    }

    // 미리보기 화면용: t 이전에 끝난 노트를 전부 퍼펙트로 처리한다(이벤트 없음).
    function markPerfectBefore(t) {
      notes.forEach(function (n) {
        if (n.end < t - W.good) {
          n.slots.forEach(function (s) { if (!s.result) { s.result = "perfect"; s.delta = 0; st.counts.perfect++; st.log.push({ noteT: n.t, rank: "perfect" }); applyToCombo("perfect"); } });
          n.state = "done";
        }
      });
    }

    function setOptions(extra) {
      cfg = merge(cfg, extra);
    }

    reset();

    return {
      TYPE: TYPE, notes: notes, spb: spb, chart: chart,
      get config() { return cfg; },
      angleAt: angleAt, posAt: posAt, notePos: notePos, laneAt: laneAt, pathRadius: pathRadius, laneRadius: laneRadius, slotPos: slotPos,
      reset: reset, press: press, release: release, update: update, rewind: rewind,
      getState: getState, drainEvents: drainEvents, lastMistakeTime: lastMistakeTime,
      lastRank: function () { return st.lastRank; },
      markPerfectBefore: markPerfectBefore, setOptions: setOptions,
      // 노트가 판정 시점보다 얼마나 먼저 보이기 시작하는지(초). 각도 기준.
      degPerBeat: degPerBeat,
      leadTime: function (deg) { return (deg / degPerBeat()) * spb; }
    };
  }

  var api = { createEngine: createEngine, TYPE: TYPE, RANKS: RANKS, DEFAULTS: DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TDEngine = api;
})(this);
