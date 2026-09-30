// 맵 에디터의 순수 로직. 화면·입력 장치·소리와 무관해서 브라우저와 node 테스트에서 똑같이 돈다.
//
// 좌표 규칙은 게임(engine.js)과 같다: 시계 판 반지름을 1로 둔 정규화 좌표, 12시가 0도이고 시계 방향으로 커진다, y는 아래가 +.
// 한 페이지 = 시계 한 바퀴 = beatsPerPage 박. 페이지 시작 박자가 12시에 온다.
// 박자 값은 채보 형식처럼 소수 넷째 자리까지만 쓴다(1/3박 = 0.3333).
(function (root) {
  "use strict";

  var TDChart = typeof module !== "undefined" && module.exports ? require("../shared/chart-format.js") : root.TDChart;
  var TYPE = TDChart.TYPE;

  var LANE_RADII = [0.30, 0.49, 0.68, 0.87]; // 게임과 같은 레인 반지름(안쪽부터 0~3)
  var SNAPS = [1, 2, 3, 4, 6, 8]; // 한 박을 몇 칸으로 나눌지
  var PAGE_BEATS = [4, 8, 12, 16]; // 한 페이지 박자 수. 전부 4의 배수라 마디선이 늘 12시에 온다
  // 12시(페이지 끝)를 넘어 다음 페이지로 이어지는 부분은 고리에서 BEYOND만큼 바깥으로 비켜 그리고, 한 바퀴마다 SPIRAL씩 더 벌린다.
  // 고리 위에 그대로 두면 끝 손잡이가 이 페이지 첫 칸(12시) 노트와 같은 자리에 와서 고르기가 엉킨다.
  var BEYOND = 0.085;
  var SPIRAL = 0.05;
  var EPS = 1e-4; // 박자 비교 허용 오차(채보 값이 소수 넷째 자리라서)

  function round4(v) { return Math.round(v * 10000) / 10000; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function noteEnd(n) { return n.type === TYPE.TAP ? n.b : n.eb; }
  function clone(n) { return JSON.parse(JSON.stringify(n)); }

  // ---------- 각도·박자 ----------
  // 이 페이지에서 박자 b가 놓이는 각도(도). 페이지를 넘으면 360 이상이 된다(감지 않음).
  function angleOfBeat(b, pageStart, bpp) { return ((b - pageStart) / bpp) * 360; }
  function beatOfAngle(deg, pageStart, bpp) { return pageStart + (deg / 360) * bpp; }
  // 정규화 좌표 → 각도(0 이상 360 미만)·반지름
  function polarOf(x, y) {
    var a = (Math.atan2(x, -y) * 180) / Math.PI;
    if (a < 0) a += 360;
    if (a >= 360) a -= 360;
    return { angle: a, r: Math.sqrt(x * x + y * y) };
  }
  function pointAt(deg, r) {
    var a = (deg * Math.PI) / 180;
    return { x: Math.sin(a) * r, y: -Math.cos(a) * r };
  }
  function laneRadius(lane) { return LANE_RADII[clamp(Math.round(lane), 0, LANE_RADII.length - 1)]; }
  function nearestLane(r) {
    var best = 0;
    for (var i = 1; i < LANE_RADII.length; i++) if (Math.abs(r - LANE_RADII[i]) < Math.abs(r - LANE_RADII[best])) best = i;
    return best;
  }

  // ---------- 격자·페이지 ----------
  function stepOf(div) { return 1 / div; }
  function snapBeat(b, div) { return round4(Math.round(b * div) / div); }
  function pageOfBeat(b, bpp) { return Math.max(0, Math.floor((b + EPS) / bpp)); }
  function pageStartOf(page, bpp) { return page * bpp; }
  // 채보의 회전 속도(1박 각도)로 한 바퀴 박자 수를 정한다. 에임형 90° → 4박, 건반형 30° → 12박.
  function defaultBeatsPerPage(degPerBeat) {
    var v = 360 / degPerBeat;
    if (!isFinite(v) || v <= 0) return PAGE_BEATS[0];
    var best = PAGE_BEATS[0];
    PAGE_BEATS.forEach(function (p) { if (Math.abs(p - v) < Math.abs(best - v)) best = p; });
    return best;
  }
  // 누른 자리의 시작 박자. 12시 바로 왼쪽을 눌러 페이지 끝으로 반올림되면 화면에서 같은 자리인 페이지 시작으로 돌린다.
  function wrapSnapStart(rawBeat, pageStart, bpp, div) {
    var s = snapBeat(rawBeat, div);
    if (s >= pageStart + bpp - EPS || s < pageStart - EPS) s = pageStart;
    return s;
  }
  // 끌어서 옮기는 시작 박자는 이 페이지 안에 묶는다(Unity 에디터와 같음). 넘으면 마지막 칸 / 첫 칸.
  function clampStart(b, pageStart, bpp, div) {
    var s = snapBeat(b, div);
    var last = snapBeat(pageStart + bpp - stepOf(div), div);
    return s < pageStart ? pageStart : s > last ? last : s;
  }

  // ---------- 끄는 동안 각도 이어 붙이기(Unity GetContinuousDragTime과 같은 발상) ----------
  // 12시를 시계 방향으로 넘으면 +360, 거꾸로 넘으면 −360을 더해서 다음 페이지까지 끊기지 않게 한다.
  // hintAngle: 시작할 때 커서가 가리키는 것으로 볼 이어진 각도(예: 다음 페이지에 있는 끝점을 잡으면 360 이상).
  function createUnwrap(rawAngle, hintAngle) {
    return { last: rawAngle, turns: Math.round(((hintAngle === undefined ? rawAngle : hintAngle) - rawAngle) / 360) };
  }
  function unwrapAngle(st, rawAngle) {
    var d = rawAngle - st.last;
    if (d < -180) st.turns++;
    else if (d > 180) st.turns--;
    st.last = rawAngle;
    return rawAngle + st.turns * 360;
  }
  // 끄는 도중 보이는 페이지를 k장 넘기면 같은 박자를 가리키도록 바퀴 수를 맞춘다.
  function shiftUnwrapPages(st, k) { st.turns -= k; }

  // ---------- 체이스 그리기 기록 ----------
  // 누른 채 끌면서 지나간 격자 칸마다 가장 가까운 레인을 적는다. 뒤로 돌아오면 지나친 칸을 지운다.
  // 마우스가 한 번에 여러 칸을 건너뛰면 그 사이 반지름을 직선으로 이어서 칸마다 레인을 매긴다.
  function createChaseRecorder(b, lane, div) {
    return { b: b, lane: lane, div: div, step: stepOf(div), pts: [{ b: b, lane: lane }], lastBeat: b, lastR: laneRadius(lane) };
  }
  function recordChase(rec, beat, r) {
    var k = Math.max(0, Math.round((beat - rec.b) / rec.step));
    var lastK = rec.pts.length - 1;
    if (k > lastK) {
      for (var j = lastK + 1; j <= k; j++) {
        var sb = snapBeat(rec.b + j * rec.step, rec.div);
        var span = beat - rec.lastBeat;
        var f = span > 1e-9 ? clamp((sb - rec.lastBeat) / span, 0, 1) : 1;
        rec.pts.push({ b: sb, lane: nearestLane(rec.lastR + (r - rec.lastR) * f) });
      }
    } else if (k < lastK) {
      rec.pts.length = k + 1;
    }
    // 지금 머무는 칸은 커서를 따라간다. 첫 칸(시작)은 누른 레인으로 고정.
    if (k > 0) rec.pts[k].lane = nearestLane(r);
    rec.lastBeat = beat;
    rec.lastR = r;
    return rec;
  }
  // 칸마다 적은 레인에서 꼭짓점만 남긴다: 레인이 바뀌는 칸과 그 직전 칸.
  // 직전 칸을 남겨야 에임형에서 표식이 한 칸 동안 비스듬히 건너간다(건반형은 바뀌는 칸 시각에 키를 바꿈).
  function compressChasePath(pts) {
    if (!pts.length) return [];
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      if (pts[i].lane === pts[i - 1].lane) continue;
      if (out[out.length - 1] !== pts[i - 1]) out.push(pts[i - 1]);
      out.push(pts[i]);
    }
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out.map(function (p) { return { b: p.b, lane: p.lane }; });
  }
  // 기록으로 체이스 노트를 만든다. 한 칸도 못 갔으면 fallbackLen 박 길이의 직선 체이스.
  function buildChase(rec, fallbackLen) {
    var last = rec.pts[rec.pts.length - 1];
    var eb = rec.pts.length > 1 ? last.b : round4(rec.b + fallbackLen);
    var src = { type: TYPE.CHASE, b: rec.b, eb: eb, lane: rec.lane };
    if (rec.pts.length > 1) src.path = TDChart.normalizePath(compressChasePath(rec.pts), rec.b, eb, rec.lane);
    return TDChart.normalizeNote(src);
  }

  // ---------- 노트 연산(원본은 건드리지 않고 새 노트를 돌려준다) ----------
  // iv: 홀드앤탭을 만들 때 리벳을 미리 채울 간격(박). 0이면 리벳 없이 만든다.
  function makeNote(type, b, lane, eb, iv) {
    var src = { type: type, b: b, lane: lane };
    if (type !== TYPE.TAP) src.eb = eb;
    if (type === TYPE.HOLDTAP) {
      if (iv > 0) src.iv = iv;
      else src.taps = [];
    }
    return TDChart.normalizeNote(src);
  }
  // 홀드앤탭의 박자 beat 자리 리벳을 넣거나 뺀다. 시작·끝 자리나 홀드앤탭이 아니면 null.
  // 돌려주는 값: { note: 새 노트, added: 넣었으면 true }
  function toggleRivet(n, beat) {
    if (n.type !== TYPE.HOLDTAP) return null;
    beat = round4(beat);
    if (beat <= n.b + EPS || beat >= n.eb - EPS) return null;
    var taps = (n.taps || []).slice();
    var k = -1;
    for (var i = 0; i < taps.length; i++) if (Math.abs(taps[i] - beat) < EPS) k = i;
    if (k >= 0) taps.splice(k, 1);
    else taps.push(beat);
    var out = clone(n);
    out.taps = taps;
    return { note: TDChart.normalizeNote(out), added: k < 0 };
  }
  // 길이는 그대로 두고 시작 박자·레인을 옮긴다. 체이스 경로는 레인 차이만큼 통째로 옮기되 0~3을 벗어나지 않게 차이를 줄인다.
  function moveNote(n, newB, newLane) {
    var db = newB - n.b;
    var dl = Math.round(newLane) - n.lane;
    var lo = n.lane, hi = n.lane;
    if (n.type === TYPE.CHASE && n.path) n.path.forEach(function (p) { lo = Math.min(lo, p.lane); hi = Math.max(hi, p.lane); });
    dl = clamp(dl, -lo, LANE_RADII.length - 1 - hi);
    var out = clone(n);
    out.b = round4(n.b + db);
    out.lane = n.lane + dl;
    if (n.type !== TYPE.TAP) out.eb = round4(n.eb + db);
    if (out.path) out.path = out.path.map(function (p) { return { b: round4(p.b + db), lane: p.lane + dl }; });
    if (out.taps) out.taps = out.taps.map(function (t) { return round4(t + db); });
    return TDChart.normalizeNote(out);
  }
  // 끝 박자만 바꾼다. 최소 길이 minLen. 체이스는 새 끝 뒤의 꼭짓점을 버리고, 늘리면 마지막 레인으로 이어 간다.
  function resizeNoteEnd(n, eb, minLen) {
    if (n.type === TYPE.TAP) return clone(n);
    var out = clone(n);
    out.eb = round4(Math.max(n.b + minLen, eb));
    return TDChart.normalizeNote(out);
  }
  function sortNotes(notes) { return notes.sort(TDChart.compareNotes); }
  function isOnPage(n, pageStart, bpp) { return n.b >= pageStart - EPS && n.b < pageStart + bpp - EPS; }
  // 앞 페이지에서 시작해 이 페이지까지 이어지는 누르는 노트(흐리게만 그리고 고르지 않음)
  function continuesInto(n, pageStart) { return n.type !== TYPE.TAP && n.b < pageStart - EPS && n.eb > pageStart + EPS; }
  function occupied(notes, b, lane, skip) {
    for (var i = 0; i < notes.length; i++) if (i !== skip && notes[i].lane === lane && Math.abs(notes[i].b - b) < EPS) return i;
    return -1;
  }
  // 실시간 입력(09-30): 재생 중 누른 키 하나를 노트로 만든다. down · up = 누른 · 뗀 박자(싱크 보정 뒤), div = 스냅.
  // 실제로 누른 길이가 스냅 한 칸 이상이고 minHold(박, 생략하면 0) 이상이면 롱(끝은 스냅에 맞추되 최소 한 칸), 아니면 탭.
  // 같은 레인에서 이미 있는 노트와 시간이 겹치면(같은 박자 포함) null.
  function recordedNote(notes, down, up, lane, div, minHold) {
    var step = stepOf(div);
    var b = Math.max(0, snapBeat(down, div));
    var held = up - down;
    var n = held >= Math.max(step, minHold || 0) - EPS
      ? makeNote(TYPE.LONG, b, lane, Math.max(snapBeat(up, div), round4(b + step)))
      : makeNote(TYPE.TAP, b, lane);
    var end = noteEnd(n);
    for (var i = 0; i < notes.length; i++) {
      var m = notes[i];
      if (m.lane === lane && b <= noteEnd(m) + EPS && end >= m.b - EPS) return null;
    }
    return n;
  }
  // 같은 박자에 시작하는 노트(건반형 동시치기) 번호 표
  function findChords(notes) {
    var byB = {};
    var of = {};
    notes.forEach(function (n, i) { var k = n.b.toFixed(4); (byB[k] = byB[k] || []).push(i); });
    Object.keys(byB).forEach(function (k) { if (byB[k].length > 1) byB[k].forEach(function (i) { of[i] = byB[k]; }); });
    return of;
  }

  // ---------- 모양(화면 그리기와 고르기가 같이 쓴다) ----------
  // 박자 b에서 노트가 있는 반지름. 체이스 경로: 에임형은 꼭짓점 사이를 시간에 비례해 옮겨 가고, 건반형은 꼭짓점 시각에 바로 바뀐다.
  function radiusAtBeat(n, b, mode) {
    if (n.type !== TYPE.CHASE || !n.path) return laneRadius(n.lane);
    if (mode === "lanes") return laneRadius(TDChart.laneAtBeat(n, b));
    var p = n.path;
    if (b <= p[0].b) return laneRadius(p[0].lane);
    for (var i = 1; i < p.length; i++) {
      if (b <= p[i].b + 1e-9) {
        var f = (b - p[i - 1].b) / Math.max(1e-9, p[i].b - p[i - 1].b);
        return laneRadius(p[i - 1].lane) + (laneRadius(p[i].lane) - laneRadius(p[i - 1].lane)) * f;
      }
    }
    return laneRadius(p[p.length - 1].lane);
  }
  function spiralOffset(b, pageStart, bpp) {
    var pe = pageStart + bpp;
    return b < pe - 1e-6 ? 0 : BEYOND + ((b - pe) / bpp) * SPIRAL;
  }
  function notePoint(n, b, pageStart, bpp, mode) {
    return pointAt(angleOfBeat(b, pageStart, bpp), radiusAtBeat(n, b, mode) + spiralOffset(b, pageStart, bpp));
  }
  // 누르는 노트 몸통을 점 목록으로 만든다(각 점: x, y, 박자 b, 다음 페이지 쪽이면 over). from~to 박자 구간만.
  // 한 페이지(360°)를 180조각으로 나누고 체이스 꼭짓점을 끼워 넣는다. 건반형 체이스는 꼭짓점에서 반지름 방향으로 꺾는다.
  // 12시를 넘는 자리에서는 고리 위 점과 비켜 난 점을 함께 넣어 바깥으로 한 번 꺾어 나가게 한다(to가 페이지 끝까지면 꺾지 않음).
  function notePolyline(n, pageStart, bpp, mode, from, to) {
    var a = Math.max(n.b, from);
    var z = Math.min(noteEnd(n), to);
    if (!(z > a + 1e-9)) return [];
    var pe = pageStart + bpp;
    var beats = [];
    var step = bpp / 180;
    for (var x = a; x < z - 1e-9; x += step) beats.push(x);
    beats.push(z);
    if (a < pe - 1e-6 && z > pe + 1e-9) beats.push(pe);
    var verts = n.type === TYPE.CHASE && n.path ? n.path : [];
    verts.forEach(function (v) { if (v.b > a + 1e-9 && v.b < z - 1e-9) beats.push(v.b); });
    beats.sort(function (p, q) { return p - q; });
    var pts = [];
    function push(ang, r, bb, over) {
      var p = pointAt(ang, r);
      pts.push({ x: p.x, y: p.y, b: bb, over: over });
    }
    beats.forEach(function (bb, i) {
      if (i && bb - beats[i - 1] < 1e-9) return;
      var ang = angleOfBeat(bb, pageStart, bpp);
      var over = to > pe + 1e-9 && bb >= pe - 1e-6;
      var sp = over ? spiralOffset(bb, pageStart, bpp) : 0;
      var rBefore, rAfter;
      if (mode === "lanes" && verts.length) {
        rBefore = laneRadius(TDChart.laneAtBeat(n, bb - EPS));
        rAfter = laneRadius(TDChart.laneAtBeat(n, bb));
        if (bb <= a + 1e-9) rBefore = rAfter;
      } else {
        rBefore = rAfter = radiusAtBeat(n, bb, mode);
      }
      if (over && Math.abs(bb - pe) < 1e-6) push(ang, rBefore, bb, false); // 12시에서 고리 위 점 → 바깥으로 꺾기
      else if (rBefore !== rAfter) push(ang, rBefore + sp, bb, over);
      push(ang, rAfter + sp, bb, over);
    });
    return pts;
  }
  // 점(x, y)에서 꺾은선까지 가장 가까운 거리와 그 자리의 박자. accept(p, q, b)로 구간을 거를 수 있다.
  function nearestOnPolyline(pts, x, y, accept) {
    var best = { d: Infinity, b: null };
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i - 1], q = pts[i];
      var dx = q.x - p.x, dy = q.y - p.y;
      var L = dx * dx + dy * dy;
      var t = L > 0 ? clamp(((x - p.x) * dx + (y - p.y) * dy) / L, 0, 1) : 0;
      var cx = p.x + dx * t, cy = p.y + dy * t;
      var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      var b = p.b + (q.b - p.b) * t;
      if (d < best.d && (!accept || accept(p, q, b))) best = { d: d, b: b };
    }
    return best;
  }
  // 커서 아래 노트 찾기. 이 페이지에서 시작하는 노트만 고른다.
  // 우선순위: 끝 손잡이 → 머리 → 홀드앤탭 리벳 → 몸통(작은 손잡이가 큰 머리에 가려지지 않게). 같은 종류끼리는 가까운 것.
  // 리벳이 탭 머리와 겹치면 머리가 먼저 잡힌다(탭을 옮기거나 지운 뒤 리벳을 고른다). 리벳의 beat는 그 리벳 박자.
  // q: { x, y, pageStart, bpp, mode, headR, endR, rivetR, bodyR, maxBeat, only(이 종류만 고름, 생략하면 전부) }
  function hitTest(notes, q) {
    var best = null;
    function consider(rank, d, i, part, beat, lane) {
      if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { rank: rank, d: d, index: i, part: part, beat: beat, lane: lane };
    }
    var maxBeat = q.maxBeat === undefined ? q.pageStart + q.bpp * 3 : q.maxBeat;
    // 12시에서는 이 바퀴의 끝과 다음 바퀴의 시작이 같은 자리다. 몸통은 커서가 가리키는 박자와 맞는 바퀴에서만 잡는다:
    // 페이지 안 구간은 이번 바퀴, 넘어간 구간은 다음 바퀴 이후. 고리에서 바깥으로 꺾어 나가는 짧은 선은 잡지 않는다.
    var pBeat = beatOfAngle(polarOf(q.x, q.y).angle, q.pageStart, q.bpp);
    function sameTurn(p, s, b) {
      if (p.over !== s.over) return false;
      var k = s.over ? Math.round((b - pBeat) / q.bpp) : 0;
      if (s.over && k < 1) return false;
      return Math.abs(b - (pBeat + k * q.bpp)) <= q.bpp / 8;
    }
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (!isOnPage(n, q.pageStart, q.bpp)) continue;
      if (q.only !== undefined && n.type !== q.only) continue;
      var h = notePoint(n, n.b, q.pageStart, q.bpp, q.mode);
      var dh = Math.sqrt((q.x - h.x) * (q.x - h.x) + (q.y - h.y) * (q.y - h.y));
      if (dh <= q.headR) consider(1, dh, i, "head", n.b, n.lane);
      if (n.type === TYPE.TAP) continue;
      if (n.eb <= maxBeat) {
        var e = notePoint(n, n.eb, q.pageStart, q.bpp, q.mode);
        var de = Math.sqrt((q.x - e.x) * (q.x - e.x) + (q.y - e.y) * (q.y - e.y));
        if (de <= q.endR) consider(0, de, i, "end", n.eb, TDChart.laneAtBeat(n, n.eb));
      }
      if (n.type === TYPE.HOLDTAP && n.taps) {
        for (var k = 0; k < n.taps.length; k++) {
          var tb = n.taps[k];
          if (tb > maxBeat) break;
          var rp = notePoint(n, tb, q.pageStart, q.bpp, q.mode);
          var dr = Math.sqrt((q.x - rp.x) * (q.x - rp.x) + (q.y - rp.y) * (q.y - rp.y));
          if (dr <= (q.rivetR || q.endR)) consider(1.5, dr, i, "rivet", tb, n.lane);
        }
      }
      var near = nearestOnPolyline(notePolyline(n, q.pageStart, q.bpp, q.mode, n.b, maxBeat), q.x, q.y, sameTurn);
      if (near.d <= q.bodyR) consider(2, near.d, i, "body", near.b, nearestLane(radiusAtBeat(n, near.b, q.mode)));
    }
    return best;
  }

  // ---------- 되돌리기 ----------
  // 상태는 문자열(채보 JSON) 그대로 쌓는다. 채보 하나가 수십 KB라 수백 단계도 가볍다.
  function createHistory(limit) {
    var undoStack = [];
    var redoStack = [];
    limit = limit || 200;
    return {
      record: function (before) {
        undoStack.push(before);
        if (undoStack.length > limit) undoStack.shift();
        redoStack.length = 0;
      },
      undo: function (current) {
        if (!undoStack.length) return null;
        redoStack.push(current);
        return undoStack.pop();
      },
      redo: function (current) {
        if (!redoStack.length) return null;
        undoStack.push(current);
        return redoStack.pop();
      },
      canUndo: function () { return undoStack.length > 0; },
      canRedo: function () { return redoStack.length > 0; },
      clear: function () { undoStack.length = 0; redoStack.length = 0; }
    };
  }

  // ---------- 표시용 ----------
  // 박자를 "12", "12 1/2", "12 1/3"처럼. 격자 분수가 아니면 소수로.
  function fmtBeat(b) {
    b = round4(b);
    var neg = b < 0;
    var a = Math.abs(b);
    var whole = Math.floor(a + 1e-6);
    var frac = a - whole;
    if (frac < 1e-3) return (neg ? "-" : "") + whole;
    var dens = [2, 3, 4, 6, 8];
    for (var i = 0; i < dens.length; i++) {
      var num = frac * dens[i];
      if (Math.abs(num - Math.round(num)) < 2e-3) {
        var nn = Math.round(num), dd = dens[i];
        var g = gcd(nn, dd);
        return (neg ? "-" : "") + (whole ? whole + " " : "") + nn / g + "/" + dd / g;
      }
    }
    return (neg ? "-" : "") + String(a);
  }
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }
  // 초 → "m:ss.cc"
  function fmtTime(sec) {
    if (!isFinite(sec)) return "-:--.--";
    var neg = sec < 0;
    var s = Math.abs(sec);
    var m = Math.floor(s / 60);
    var r = s - m * 60;
    var cs = Math.floor(r * 100 + 1e-6);
    var ss = Math.floor(cs / 100);
    var cc = cs % 100;
    return (neg ? "-" : "") + m + ":" + (ss < 10 ? "0" : "") + ss + "." + (cc < 10 ? "0" : "") + cc;
  }

  var api = {
    LANE_RADII: LANE_RADII, SNAPS: SNAPS, PAGE_BEATS: PAGE_BEATS, BEYOND: BEYOND, SPIRAL: SPIRAL, EPS: EPS,
    round4: round4, noteEnd: noteEnd,
    angleOfBeat: angleOfBeat, beatOfAngle: beatOfAngle, polarOf: polarOf, pointAt: pointAt, laneRadius: laneRadius, nearestLane: nearestLane,
    stepOf: stepOf, snapBeat: snapBeat, pageOfBeat: pageOfBeat, pageStartOf: pageStartOf, defaultBeatsPerPage: defaultBeatsPerPage,
    wrapSnapStart: wrapSnapStart, clampStart: clampStart,
    createUnwrap: createUnwrap, unwrapAngle: unwrapAngle, shiftUnwrapPages: shiftUnwrapPages,
    createChaseRecorder: createChaseRecorder, recordChase: recordChase, compressChasePath: compressChasePath, buildChase: buildChase,
    makeNote: makeNote, toggleRivet: toggleRivet, moveNote: moveNote, resizeNoteEnd: resizeNoteEnd, sortNotes: sortNotes,
    isOnPage: isOnPage, continuesInto: continuesInto, occupied: occupied, recordedNote: recordedNote, findChords: findChords,
    radiusAtBeat: radiusAtBeat, spiralOffset: spiralOffset, notePoint: notePoint, notePolyline: notePolyline,
    nearestOnPolyline: nearestOnPolyline, hitTest: hitTest,
    createHistory: createHistory, fmtBeat: fmtBeat, fmtTime: fmtTime
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TDEditorModel = api;
})(this);
