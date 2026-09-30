// 맵 에디터의 화면·입력·소리. 계산은 editor-model.js, 채보 형식은 shared/chart-format.js, 읽기·저장은 shared/library.js가 맡는다.
// 주소: editor/index.html?mode=core|lanes
// 주소 값(언제나): chart=<id> 바로 열기, page=<n> n번째 페이지(1부터), snap=<1|2|3|4|6|8>, bpp=<4|8|12|16>, type=<1~4>
// 스크린샷 도우미(주소에 shot이 있을 때만): unlock=1 권한 확인 건너뛰기, hover=<노트 번호> 흰색 강조 고정, pointer=<박자>,<레인(0~3)> 커서 흉내
(function () {
  "use strict";

  var M = window.TDEditorModel;
  var TDChart = window.TDChart;
  var LIB = window.TDLibrary;
  var TYPE = TDChart.TYPE;
  var TAU = Math.PI * 2;
  var params = new URLSearchParams(location.search);
  var MODE = params.get("mode") === "lanes" ? "lanes" : "core";
  var MODE_DIR = "rhythm-" + MODE;
  var MODE_LABEL = MODE === "core" ? "에임형" : "건반형";
  var ALLOWED = TDChart.MODE_TYPES[MODE];
  var TYPE_NAMES = TDChart.TYPE_NAMES;
  var SHOT = params.has("shot");
  var ONLINE = !!LIB.online;
  var LAST_KEY = "td-editor-last-" + MODE;
  var PREFS_KEY = "td-editor-prefs-v1";
  var IV_OPTS = [0, 2, 1, 0.5, 0.25]; // 새 홀드앤탭에 리벳을 미리 채울 간격(박). 0 = 채우지 않음

  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(true); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }

  // ================= 저장해 두는 설정 =================
  // fill: 새 홀드앤탭에 리벳을 미리 채울 간격. 예전 "안쪽 탭 간격"(iv)과 뜻이 달라 이름을 바꿨다(예전 값은 읽지 않는다, 09-30)
  var prefs = { div: 4, rate: 1, tick: true, metro: false, volume: 0.7, fill: 0 };
  try {
    var savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (savedPrefs) for (var pk in savedPrefs) if (pk in prefs) prefs[pk] = savedPrefs[pk];
  } catch (e) { /* 저장소를 못 쓰면 기본값 */ }
  if (M.SNAPS.indexOf(prefs.div) < 0) prefs.div = 4;
  if ([1, 0.75, 0.5].indexOf(prefs.rate) < 0) prefs.rate = 1;
  if (IV_OPTS.indexOf(prefs.fill) < 0) prefs.fill = 0;
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 무시 */ }
  }

  // ================= 상태 =================
  var lib = { charts: [], songs: [], errors: [] };
  var chart = null; // 편집 중인 채보(TDChart.normalizeChart 모양)
  var savedJson = ""; // 마지막으로 저장(또는 연)했을 때 모습. 다르면 ● 표시
  var dirty = false;
  var history = M.createHistory(300);
  var issues = [];
  var issueOf = {}; // 노트 번호 → "error" | "warn"
  var chords = {}; // (건반형) 노트 번호 → 같은 박자 노트 번호 목록
  var ed = { type: ALLOWED[0], bpp: 4, page: 0, hover: -1, hoverPart: null, flash: null, rivetSpot: null };
  var playBeat = 0; // 멈춰 있을 때 재생 위치(박자)
  var drag = null; // 끌기 중인 작업
  var pointer = { inside: false, px: 0, py: 0, x: 9, y: 9, angle: 0, r: 9 };
  var forcedHover = -1; // 스크린샷용
  var shotPointer = null; // 스크린샷용 { b, lane }
  var needsDraw = true;
  var needsTimeline = true;

  // ================= 박자·초 =================
  function spb() { return 60 / (chart && chart.bpm > 0 ? chart.bpm : 120); }
  function offset() { return chart && isFinite(chart.offset) ? chart.offset : 0; }
  function timeOfBeat(b) { return offset() + b * spb(); }
  function beatOfTime(t) { return (t - offset()) / spb(); }
  function pageStart() { return M.pageStartOf(ed.page, ed.bpp); }
  function pageEnd() { return pageStart() + ed.bpp; }
  function lastNoteBeat() {
    var m = 0;
    if (chart) chart.notes.forEach(function (n) { m = Math.max(m, M.noteEnd(n)); });
    return m;
  }
  // 곡 전체 길이(박). 음원이 없으면 마지막 노트 뒤로 몇 페이지 여유를 둔다.
  function totalBeats() {
    var notes = lastNoteBeat();
    if (audio.buffer) return Math.max(beatOfTime(audio.buffer.duration), notes, ed.bpp);
    return Math.max(notes + ed.bpp * 4, 64);
  }
  function lastPage() { return Math.max(0, Math.ceil(totalBeats() / ed.bpp - 1e-6) - 1); }
  function songEndTime() { return audio.buffer ? audio.buffer.duration : timeOfBeat(totalBeats()); }
  function currentBeat() {
    if (audio.running) return beatOfTime(audio.songNow());
    return playBeat;
  }

  // ================= 소리 =================
  // 재생 위치는 "지금 귀에 들리는 소리" 기준(게임과 같은 getOutputTimestamp 방식).
  var audio = {
    ctx: null, master: null, bus: null, noise: null, buffer: null, src: null,
    running: false, anchorCtx: 0, anchorSong: 0, rate: 1, file: "", token: 0, error: "", loading: false,
    init: function () {
      if (this.ctx) return true;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.master = this.ctx.createGain();
      this.master.gain.value = prefs.volume;
      this.master.connect(this.ctx.destination);
      var len = Math.round(this.ctx.sampleRate * 0.05);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      var d = this.noise.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return true;
    },
    heardCtx: function () {
      var c = this.ctx;
      if (c.getOutputTimestamp) {
        var ts = c.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
      return c.currentTime - (c.outputLatency || c.baseLatency || 0);
    },
    // 시작 직후 출력 지연 때문에 시작점보다 앞으로 계산되면 페이지가 잠깐 뒤로 넘어가 보이므로 시작점 아래로는 내리지 않는다.
    songNow: function () {
      return Math.max(this.anchorSong, this.anchorSong + (this.heardCtx() - this.anchorCtx) * this.rate);
    },
    start: function (songPos, rate) {
      this.stopSource();
      var c = this.ctx;
      this.rate = rate;
      var when = c.currentTime + 0.05;
      if (this.buffer && songPos < this.buffer.duration) {
        var src = c.createBufferSource();
        src.buffer = this.buffer;
        src.playbackRate.value = rate;
        src.connect(this.master);
        if (songPos >= 0) src.start(when, songPos);
        else src.start(when - songPos / rate, 0);
        this.src = src;
      }
      // 째깍·메트로놈은 전용 버스로 보낸다. 멈출 때 버스를 끊으면 미리 걸어 둔 소리까지 한꺼번에 사라진다.
      this.bus = c.createGain();
      this.bus.gain.value = 0.6;
      this.bus.connect(c.destination);
      this.anchorCtx = when;
      this.anchorSong = songPos;
      this.running = true;
    },
    stopSource: function () {
      if (this.src) {
        try { this.src.stop(); } catch (e) { /* 이미 멈춤 */ }
        this.src.disconnect();
        this.src = null;
      }
      if (this.bus) { this.bus.disconnect(); this.bus = null; }
    },
    stop: function () {
      var t = this.running ? this.songNow() : null;
      this.stopSource();
      this.running = false;
      return t;
    },
    ctxAt: function (songT) { return this.anchorCtx + (songT - this.anchorSong) / this.rate; },
    // 메트로놈: 게임의 싱크 딸깍과 같은 네모파
    click: function (when, accent) {
      var c = this.ctx;
      var o = c.createOscillator();
      var gn = c.createGain();
      o.type = "square";
      o.frequency.value = accent ? 1760 : 1320;
      gn.gain.setValueAtTime(0.0001, when);
      gn.gain.exponentialRampToValueAtTime(accent ? 0.34 : 0.2, when + 0.002);
      gn.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
      o.connect(gn);
      gn.connect(this.bus);
      o.start(when);
      o.stop(when + 0.05);
    },
    // 노트 소리: 게임 퍼펙트 타격음과 같은 금속성 째깍(잡음 한 조각 + 짧은 사인파)
    tick: function (when) {
      var c = this.ctx;
      var s = c.createBufferSource();
      s.buffer = this.noise;
      var bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 3500;
      bp.Q.value = 3;
      var ng = c.createGain();
      ng.gain.setValueAtTime(0.0001, when);
      ng.gain.exponentialRampToValueAtTime(1, when + 0.0015);
      ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      s.connect(bp);
      bp.connect(ng);
      ng.connect(this.bus);
      s.start(when);
      s.stop(when + 0.06);
      var o = c.createOscillator();
      var og = c.createGain();
      o.type = "sine";
      o.frequency.value = 1950;
      og.gain.setValueAtTime(0.0001, when);
      og.gain.exponentialRampToValueAtTime(0.45, when + 0.0015);
      og.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
      o.connect(og);
      og.connect(this.bus);
      o.start(when);
      o.stop(when + 0.06);
    }
  };

  function loadSong(file) {
    var token = ++audio.token;
    audio.buffer = null;
    audio.file = file;
    audio.error = "";
    audio.loading = !!file;
    updateSongInfo();
    if (!file) {
      audio.error = "음원이 지정되지 않았습니다";
      updateSongInfo();
      return;
    }
    LIB.loadAudio(file).then(function (buf) {
      if (token !== audio.token) return null;
      // 해독은 소리를 내지 않는 오프라인 컨텍스트로 한다(클릭 전에도 동작). 결과는 재생용 컨텍스트에서 그대로 쓴다.
      var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      var dec = OAC ? new OAC(2, 44100, 44100) : (audio.init(), audio.ctx);
      return dec.decodeAudioData(buf);
    }).then(function (b) {
      if (token !== audio.token || !b) return;
      audio.buffer = b;
      audio.loading = false;
      updateSongInfo();
      refreshPageInfo();
      needsTimeline = true;
    }).catch(function (e) {
      if (token !== audio.token) return;
      audio.loading = false;
      audio.error = (e && e.message) || "음원을 해독하지 못했습니다";
      updateSongInfo();
      needsTimeline = true;
      status("음원 없음: " + audio.error + " · 편집과 소리 없는 재생은 됩니다", "warn");
    });
  }

  // ================= 화면 배치 =================
  var cv = $("stage");
  var g = cv.getContext("2d");
  var tl = $("timeline");
  var tg = tl.getContext("2d");
  var W = 0, H = 0, DPR = 1, CX = 0, CY = 0, R = 100;
  var TW = 0, TH = 0;
  var dialCache = null, dialScale = 1;

  // 확대(09-30, 팀원 피드백: 안쪽 레인이 좁아 노트 놓기 · 박자 조정이 어렵다). 에디터 화면만 키우고 게임과는 무관하다.
  // 화면 좌표 = 가운데 + pan + (배치 좌표 - 가운데) × zoom. 그리기는 render의 캔버스 변환 하나로 하고, 마우스 좌표는 viewToLayout으로 되돌린다.
  var ZOOMS = [1, 1.5, 2, 3];
  var view = { zoom: 1, panX: 0, panY: 0 };
  function layoutToView(p) { return { x: CX + view.panX + (p.x - CX) * view.zoom, y: CY + view.panY + (p.y - CY) * view.zoom }; }
  function viewToLayout(px, py) { return { x: CX + (px - CX - view.panX) / view.zoom, y: CY + (py - CY - view.panY) / view.zoom }; }
  // 시계 판(나무 테 포함)이 화면 밖으로 다 빠져나가지 않게 옮길 수 있는 범위를 막는다
  function clampPan() {
    function lim(half) { return Math.max(0, R * 1.15 * view.zoom - half); }
    view.panX = clamp(view.panX, -lim(W / 2), lim(W / 2));
    view.panY = clamp(view.panY, -lim(H / 2), lim(H / 2));
  }
  // 확대 배율을 z로. (ax, ay)(캔버스 안 화면 좌표) 아래 자리는 그대로 둔다. 1이면 가운데로 되돌린다.
  function setZoom(z, ax, ay) {
    if (ax === undefined) { ax = CX; ay = CY; }
    var at = viewToLayout(ax, ay);
    view.zoom = z;
    if (z === 1) { view.panX = 0; view.panY = 0; }
    else {
      view.panX = ax - CX - (at.x - CX) * z;
      view.panY = ay - CY - (at.y - CY) * z;
      clampPan();
    }
    buildDial();
    refreshZoomChip();
    if (pointer.inside) { pointer = pointerAt(pointer.px, pointer.py); updateHover(); updateCursorTag(); }
    needsDraw = true;
  }
  // dir: +1 키우기 · -1 줄이기(ZOOMS 단계). 기준은 커서 자리(캔버스 밖이면 가운데)
  function stepZoom(dir) {
    var i = ZOOMS.indexOf(view.zoom);
    var j = clamp((i < 0 ? 0 : i) + dir, 0, ZOOMS.length - 1);
    if (ZOOMS[j] === view.zoom) return;
    if (pointer.inside) setZoom(ZOOMS[j], pointer.px, pointer.py);
    else setZoom(ZOOMS[j]);
  }
  function refreshZoomChip() {
    var el = $("zoom-chip");
    el.hidden = view.zoom === 1;
    el.textContent = "확대 " + view.zoom + "배 · 0 원래대로";
  }
  $("zoom-chip").addEventListener("click", function () { setZoom(1); });

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    var rect = $("stage-wrap").getBoundingClientRect();
    W = Math.max(50, rect.width);
    H = Math.max(50, rect.height);
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    CX = W / 2;
    CY = H / 2;
    // 바깥 나무 테(1.12R)와 박자 번호가 화면 끝에 닿기 직전까지 키운다.
    R = Math.max(60, (Math.min(W, H) / 2 - 8) / 1.125);
    clampPan();
    var tr = tl.getBoundingClientRect();
    TW = Math.max(50, tr.width);
    TH = Math.max(20, tr.height);
    tl.width = Math.round(TW * DPR);
    tl.height = Math.round(TH * DPR);
    buildDial();
    needsDraw = true;
    needsTimeline = true;
  }
  function toScreen(p) { return { x: CX + p.x * R, y: CY + p.y * R }; }

  // ================= 색·모양(게임과 같은 태엽) =================
  var OUTLINE = "#2A1A0E";
  var NOTE_STYLE = {};
  NOTE_STYLE[TYPE.TAP] = { base: "#D29A2E", hi: "#F6D77F", dark: "#8C6118", teeth: 10, hub: 0.4 }; // 놋쇠. hub: 가운데 빈 곳이 큰 에임형 탭 태엽(게임과 같게, 퍼펙트+ 자리)
  NOTE_STYLE[TYPE.LONG] = { base: "#C05A28", hi: "#EE9A68", dark: "#7E3414", teeth: 10 }; // 구리
  NOTE_STYLE[TYPE.CHASE] = { base: "#2A8A70", hi: "#6FD0B3", dark: "#175646", teeth: 8 }; // 청록(녹청)
  NOTE_STYLE[TYPE.HOLDTAP] = { base: "#3A62AA", hi: "#86A8E6", dark: "#223F75", teeth: 12 }; // 푸른 강철
  var CHORD_STYLE = { base: "#A7B1BF", hi: "#F3F6FA", dark: "#4F5A68", teeth: 10 }; // 은(건반형 동시치기)
  // 건반형은 탭·롱을 레인 색으로: 안쪽 두 레인(왼손) 놋쇠, 바깥 두 레인(오른손) 푸른 강철
  var LANE_LEFT = { base: "#D29A2E", hi: "#F6D77F", dark: "#8C6118", teeth: 10, line: "rgba(160,110,30,.5)", band: "rgba(210,154,46,.11)", ink: "#6E4C10" };
  var LANE_RIGHT = { base: "#3A62AA", hi: "#86A8E6", dark: "#223F75", teeth: 10, line: "rgba(58,98,170,.45)", band: "rgba(58,98,170,.09)", ink: "#223F75" };
  function laneStyle(lane) { return lane < 2 ? LANE_LEFT : LANE_RIGHT; }
  function whiteOf(st) { return { base: "#FFFFFF", hi: "#FFFFFF", dark: "#8A7560", teeth: st.teeth, hub: st.hub }; }
  function headStyle(n, i) {
    if (MODE === "lanes") {
      if (n.type === TYPE.CHASE) return NOTE_STYLE[TYPE.CHASE];
      if (i >= 0 && chords[i]) return CHORD_STYLE;
      return laneStyle(n.lane);
    }
    return NOTE_STYLE[n.type] || NOTE_STYLE[TYPE.TAP];
  }
  function bodyStyle(n) {
    if (MODE === "lanes" && n.type !== TYPE.CHASE) return laneStyle(n.lane);
    return NOTE_STYLE[n.type] || NOTE_STYLE[TYPE.TAP];
  }
  // 크기(판 반지름 기준). 게임(0.093)보다 작게 해서 촘촘한 격자에서도 겹치지 않게.
  var HEAD_R = 0.055, END_R = 0.022;
  var HIT_HEAD = 0.065, HIT_END = 0.038, HIT_RIVET = 0.03, HIT_BODY = 0.03;
  var RIVET_R = 0.021; // 리벳 별 크기(판 반지름 기준)
  var BODY_OUT = 0.034, BODY_IN = 0.022;
  var ISSUE_COLOR = { error: "rgba(200,36,28,.9)", warn: "rgba(200,36,28,.65)" };

  function gearPath(c, r, teeth, depth) {
    var inner = r * (1 - depth);
    c.beginPath();
    for (var i = 0; i < teeth; i++) {
      var a = (i / teeth) * TAU;
      var w = Math.PI / teeth;
      var pts = [[inner, a - w * 0.62], [r, a - w * 0.34], [r, a + w * 0.34], [inner, a + w * 0.62]];
      for (var j = 0; j < 4; j++) {
        var x = Math.sin(pts[j][1]) * pts[j][0];
        var y = -Math.cos(pts[j][1]) * pts[j][0];
        if (i === 0 && j === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
    }
    c.closePath();
  }
  function drawGear(x, y, r, st, alpha) {
    if (alpha <= 0) return;
    g.save();
    g.globalAlpha = alpha;
    g.translate(x, y);
    gearPath(g, r, st.teeth, 0.25);
    var gr = g.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    gr.addColorStop(0, st.hi);
    gr.addColorStop(1, st.base);
    g.fillStyle = gr;
    g.fill();
    g.lineJoin = "round";
    g.lineWidth = Math.max(1.6, r * 0.12);
    g.strokeStyle = OUTLINE;
    g.stroke();
    // 가운데 빈 곳 = r × st.hub(없으면 0.2), 안쪽 테 = 빈 곳 + 0.2(최소 0.5). 게임(rhythm-core drawGear)과 같은 규칙
    var hub = st.hub || 0.2;
    var rim = Math.max(0.5, hub + 0.2);
    g.lineWidth = Math.max(1, r * 0.07);
    g.strokeStyle = st.dark;
    g.beginPath();
    g.arc(0, 0, r * rim, 0, TAU);
    g.stroke();
    for (var s = 0; s < 4; s++) {
      var a = (s / 4) * TAU + Math.PI / 4;
      g.beginPath();
      g.moveTo(Math.cos(a) * r * hub, Math.sin(a) * r * hub);
      g.lineTo(Math.cos(a) * r * rim, Math.sin(a) * r * rim);
      g.stroke();
    }
    g.beginPath();
    g.arc(0, 0, r * hub, 0, TAU);
    g.fillStyle = OUTLINE;
    g.fill();
    if (hub > 0.2) {
      g.lineWidth = Math.max(1, r * 0.05);
      g.strokeStyle = st.hi;
      g.globalAlpha = alpha * 0.55;
      g.beginPath();
      g.arc(0, 0, r * (hub - 0.05), 0, TAU);
      g.stroke();
      g.globalAlpha = alpha;
    }
    g.beginPath();
    g.arc(0, 0, r * 0.09, 0, TAU);
    g.fillStyle = st.hi;
    g.fill();
    g.restore();
  }
  function ring(x, y, r, color, width, dash) {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.strokeStyle = color;
    g.lineWidth = width;
    if (dash) g.setLineDash(dash);
    g.stroke();
    if (dash) g.setLineDash([]);
  }
  function star(x, y, r, fill, stroke) {
    g.beginPath();
    for (var i = 0; i < 12; i++) {
      var a = (i / 12) * TAU;
      var rr = i % 2 ? r * 0.5 : r;
      var px = x + Math.sin(a) * rr;
      var py = y - Math.cos(a) * rr;
      if (i) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = Math.max(1.3, R * 0.004);
    g.strokeStyle = stroke;
    g.stroke();
  }
  function diamond(x, y, r, fill) {
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 1.2;
    g.strokeStyle = OUTLINE;
    g.stroke();
  }

  // ================= 시계 판(고정 부분은 한 번만 그려 둔다) =================
  function buildDial() {
    var size = Math.ceil(R * 2.4);
    var oc = document.createElement("canvas");
    dialScale = Math.min(DPR * view.zoom, 4); // 확대했을 때도 선명하게(너무 큰 사본은 막는다)
    oc.width = oc.height = Math.round(size * dialScale);
    var c = oc.getContext("2d");
    c.scale(dialScale, dialScale);
    c.translate(size / 2, size / 2);
    var i;
    // 그림자와 나무 테
    c.save();
    c.shadowColor = "rgba(63,38,22,.35)";
    c.shadowBlur = R * 0.06;
    c.shadowOffsetY = R * 0.025;
    c.beginPath();
    c.arc(0, 0, R * 1.12, 0, TAU);
    c.fillStyle = "#5A3620";
    c.fill();
    c.restore();
    var wg = c.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.2, 0, 0, R * 1.14);
    wg.addColorStop(0, "#8A5733");
    wg.addColorStop(0.7, "#6B4226");
    wg.addColorStop(1, "#3F2616");
    c.beginPath();
    c.arc(0, 0, R * 1.12, 0, TAU);
    c.fillStyle = wg;
    c.fill();
    // 놋쇠 안쪽 테
    var bg = c.createLinearGradient(-R, -R, R, R);
    bg.addColorStop(0, "#F0CF7A");
    bg.addColorStop(0.5, "#B8862B");
    bg.addColorStop(1, "#7E5A1A");
    c.beginPath();
    c.arc(0, 0, R * 1.037, 0, TAU);
    c.lineWidth = R * 0.028;
    c.strokeStyle = bg;
    c.stroke();
    // 문자판
    var fg = c.createRadialGradient(0, -R * 0.2, R * 0.1, 0, 0, R);
    fg.addColorStop(0, "#FBF5E8");
    fg.addColorStop(1, "#E8DABD");
    c.beginPath();
    c.arc(0, 0, R * 1.023, 0, TAU);
    c.fillStyle = fg;
    c.fill();
    // 가운데 태엽(나선) 각인
    c.beginPath();
    for (var s = 0; s <= 1.0001; s += 0.002) {
      var sa = s * 5 * TAU;
      var sr = R * (0.05 + 0.08 * s);
      if (s === 0) c.moveTo(Math.cos(sa) * sr, Math.sin(sa) * sr);
      else c.lineTo(Math.cos(sa) * sr, Math.sin(sa) * sr);
    }
    c.strokeStyle = "rgba(107,66,38,.2)";
    c.lineWidth = Math.max(1, R * 0.005);
    c.stroke();
    // 레인(홈이 파인 궤도). 건반형은 레인 색 띠.
    M.LANE_RADII.forEach(function (lr, li) {
      var band = MODE === "lanes" ? laneStyle(li).band : "rgba(107,66,38,.07)";
      var line = MODE === "lanes" ? laneStyle(li).line : "rgba(107,66,38,.34)";
      c.beginPath();
      c.arc(0, 0, R * lr, 0, TAU);
      c.strokeStyle = band;
      c.lineWidth = R * 0.07;
      c.stroke();
      c.strokeStyle = line;
      c.lineWidth = Math.max(1.2, R * 0.0035);
      c.stroke();
    });
    // 나무 테 눈금
    c.strokeStyle = "rgba(30,16,8,.45)";
    c.lineWidth = 1;
    for (i = 0; i < 144; i++) {
      var ka = (i / 144) * TAU;
      c.beginPath();
      c.moveTo(Math.cos(ka) * R * 1.1, Math.sin(ka) * R * 1.1);
      c.lineTo(Math.cos(ka) * R * 1.12, Math.sin(ka) * R * 1.12);
      c.stroke();
    }
    dialCache = oc;
  }

  // 박자선: 마디(4박) 굵고 진하게, 박 보통, 스냅 칸 가늘고 옅게. 박자 번호는 나무 테 위에.
  function drawGrid() {
    var ps = pageStart();
    var div = prefs.div;
    var steps = ed.bpp * div;
    g.save();
    g.translate(CX, CY);
    g.lineCap = "butt";
    for (var i = 0; i < steps; i++) {
      var a = (i / steps) * TAU;
      var sn = Math.sin(a), cs = -Math.cos(a);
      var onBeat = i % div === 0;
      var beat = ps + i / div;
      var bar = onBeat && Math.abs(beat % 4) < 1e-6;
      var r0 = bar ? 0.14 : onBeat ? 0.2 : 0.24;
      var r1 = bar ? 1.0 : onBeat ? 0.985 : 0.965;
      g.beginPath();
      g.moveTo(sn * r0 * R, cs * r0 * R);
      g.lineTo(sn * r1 * R, cs * r1 * R);
      g.strokeStyle = bar ? "rgba(42,26,14,.75)" : onBeat ? "rgba(63,38,22,.45)" : "rgba(107,66,38,.27)";
      g.lineWidth = bar ? Math.max(2.2, R * 0.0068) : onBeat ? Math.max(1.3, R * 0.0035) : 1;
      g.stroke();
    }
    // 12시 = 페이지 시작 표시(놋쇠 마름모)
    g.save();
    g.translate(0, -R * 1.0);
    g.beginPath();
    g.moveTo(0, -R * 0.03);
    g.lineTo(R * 0.016, 0);
    g.lineTo(0, R * 0.03);
    g.lineTo(-R * 0.016, 0);
    g.closePath();
    g.fillStyle = "#E2B85A";
    g.fill();
    g.strokeStyle = OUTLINE;
    g.lineWidth = 1;
    g.stroke();
    g.restore();
    // 박자 번호
    g.textAlign = "center";
    g.textBaseline = "middle";
    var fs = Math.max(10, Math.round(R * (ed.bpp > 12 ? 0.04 : 0.046)));
    for (var k = 0; k < ed.bpp; k++) {
      var ang = (k / ed.bpp) * TAU;
      var bb = ps + k;
      var isBar = bb % 4 === 0;
      g.font = (isBar ? "700 " : "500 ") + (isBar ? fs + 1 : fs) + "px Cinzel, serif";
      g.fillStyle = isBar ? "#F6D77F" : "#EAD9B4";
      g.fillText(String(bb), Math.sin(ang) * R * 1.078, -Math.cos(ang) * R * 1.078);
    }
    g.restore();
  }

  // ================= (건반형) 고리마다 레인 키 글자 =================
  // 게임(건반형)의 레인 키 설정(브라우저 저장소 td-rhythm-lanes-v1의 keys, 없으면 D F K L)을 읽어
  // 게임 시침 뒤 글자처럼 12시(페이지 시작) 바로 앞, 고리 조금 안쪽에 둔다(12시 노트와 겹치지 않게). 노트보다 먼저(아래에) 그린다.
  var KEY_NAMES = { Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", ShiftLeft: "L⇧", ShiftRight: "R⇧", ControlLeft: "LCtrl", ControlRight: "RCtrl", AltLeft: "LAlt", AltRight: "RAlt", Enter: "Enter", Tab: "Tab" };
  function codeLabel(code) {
    var m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(\d)$/.exec(code))) return "N" + m[1];
    return KEY_NAMES[code] || code;
  }
  var laneKeys = ["D", "F", "K", "L"];
  var laneCodes = ["KeyD", "KeyF", "KeyK", "KeyL"]; // 건반형 실시간 입력에 쓰는 게임 레인 키(e.code)
  // 레인 표시 글자: "레인 2", 건반형은 키를 붙여 "레인 2(F)"
  function laneText(lane) { return "레인 " + (lane + 1) + (MODE === "lanes" ? "(" + laneKeys[lane] + ")" : ""); }
  function readLaneKeys() {
    var codes = ["KeyD", "KeyF", "KeyK", "KeyL"];
    try {
      var s = JSON.parse(localStorage.getItem("td-rhythm-lanes-v1") || "null");
      if (s && Array.isArray(s.keys) && s.keys.length === 4) codes = s.keys;
    } catch (e) { /* 저장소를 못 쓰면 기본 키 */ }
    laneCodes = codes.slice();
    laneKeys = codes.map(codeLabel);
    needsDraw = true;
  }
  function drawLaneKeys() {
    var a = (-6 * Math.PI) / 180; // 12시에서 반시계로 조금
    var cap = Math.max(14, R * 0.04);
    g.save();
    g.font = "700 " + Math.round(cap * 0.64) + "px Cinzel, serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    M.LANE_RADII.forEach(function (lr, li) {
      var rr = (lr - 0.068) * R; // 고리에서 안쪽으로(노트 반지름 HEAD_R보다 조금 더)
      var x = CX + Math.sin(a) * rr;
      var y = CY - Math.cos(a) * rr;
      var w = Math.max(cap * 1.2, g.measureText(laneKeys[li]).width + cap * 0.5);
      var st = laneStyle(li);
      g.beginPath();
      if (g.roundRect) g.roundRect(x - w / 2, y - cap * 0.55, w, cap * 1.1, 4); else g.rect(x - w / 2, y - cap * 0.55, w, cap * 1.1);
      g.fillStyle = "rgba(251,246,236,.9)";
      g.fill();
      g.lineWidth = 1.4;
      g.strokeStyle = st.dark;
      g.stroke();
      g.fillStyle = st.ink;
      g.fillText(laneKeys[li], x, y + 1);
    });
    g.restore();
  }

  // ================= 재생 위치 바늘(게임 시침 모양) =================
  function drawHand(angleDeg) {
    var a = (angleDeg * Math.PI) / 180;
    var L = R;
    if (audio.running && g.createConicGradient) {
      var sweep = 0.5;
      var start = a - Math.PI / 2 - sweep;
      var cg = g.createConicGradient(start, CX, CY);
      cg.addColorStop(0, "rgba(226,184,90,0)");
      cg.addColorStop(sweep / TAU, "rgba(226,184,90,.3)");
      cg.addColorStop(Math.min(1, sweep / TAU + 0.001), "rgba(226,184,90,0)");
      cg.addColorStop(1, "rgba(226,184,90,0)");
      g.beginPath();
      g.moveTo(CX, CY);
      g.arc(CX, CY, R * 0.97, start, start + sweep);
      g.closePath();
      g.fillStyle = cg;
      g.fill();
    }
    g.save();
    g.translate(CX, CY);
    g.rotate(a);
    g.beginPath();
    g.moveTo(-L * 0.016, L * 0.02);
    g.lineTo(-L * 0.014, -L * 0.085);
    g.bezierCurveTo(-L * 0.05, -L * 0.097, -L * 0.049, -L * 0.17, -L * 0.011, -L * 0.198);
    g.lineTo(-L * 0.004, -L * 0.5);
    g.lineTo(-L * 0.0025, -L * 0.965);
    g.lineTo(L * 0.0025, -L * 0.965);
    g.lineTo(L * 0.0045, -L * 0.5);
    g.lineTo(L * 0.011, -L * 0.198);
    g.bezierCurveTo(L * 0.049, -L * 0.17, L * 0.05, -L * 0.097, L * 0.014, -L * 0.085);
    g.lineTo(L * 0.016, L * 0.02);
    g.closePath();
    g.fillStyle = "rgba(42,26,14,.88)";
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = "#C99A40";
    g.stroke();
    g.beginPath();
    g.ellipse(0, -L * 0.14, L * 0.016, L * 0.027, 0, 0, TAU);
    g.fillStyle = "#E9DAB8";
    g.fill();
    g.beginPath();
    g.moveTo(-L * 0.012, 0);
    g.lineTo(-L * 0.008, L * 0.1);
    g.lineTo(L * 0.008, L * 0.1);
    g.lineTo(L * 0.012, 0);
    g.closePath();
    g.fillStyle = "#2A1A0E";
    g.fill();
    g.restore();
  }
  function drawCap() {
    var cr = R * 0.05;
    var cg = g.createRadialGradient(CX - cr * 0.35, CY - cr * 0.4, cr * 0.1, CX, CY, cr);
    cg.addColorStop(0, "#F6D98A");
    cg.addColorStop(1, "#9C7021");
    g.beginPath();
    g.arc(CX, CY, cr, 0, TAU);
    g.fillStyle = cg;
    g.fill();
    g.lineWidth = Math.max(1.5, R * 0.006);
    g.strokeStyle = OUTLINE;
    g.stroke();
  }

  // ================= 노트 그리기 =================
  function screenPts(pts) { return pts.map(toScreen); }
  function pathLine(pts) {
    g.beginPath();
    for (var i = 0; i < pts.length; i++) {
      if (i) g.lineTo(pts[i].x, pts[i].y); else g.moveTo(pts[i].x, pts[i].y);
    }
  }
  // 누르는 노트 몸통: 어두운 테두리 + 색 띠 + 종류별 무늬(롱 사슬, 체이스 구슬, 홀드앤탭 가는 선). 흰색이면 무늬 없이.
  // ghost: 다음 페이지로 이어지는 부분. 테두리를 점선으로 하고 무늬를 빼서 "여기는 다음 페이지"로 읽히게 한다.
  function strokeBody(pts, st, alpha, type, white, ghost) {
    if (pts.length < 2 || alpha <= 0) return;
    var sp = screenPts(pts);
    g.save();
    g.globalAlpha = alpha;
    g.lineCap = ghost ? "butt" : "round";
    g.lineJoin = "round";
    pathLine(sp);
    if (ghost) g.setLineDash([R * 0.02, R * 0.012]);
    g.strokeStyle = OUTLINE;
    g.lineWidth = R * BODY_OUT;
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = white ? "#FFFFFF" : st.base;
    g.lineWidth = R * BODY_IN;
    g.stroke();
    if (!white && !ghost) {
      if (type === TYPE.LONG) {
        g.setLineDash([R * 0.022, R * 0.014]); // 사슬 고리
        g.strokeStyle = st.hi;
        g.lineWidth = R * 0.009;
        g.stroke();
      } else if (type === TYPE.CHASE) {
        g.setLineDash([0.1, R * 0.03]); // 구슬
        g.strokeStyle = "#F4FFF9";
        g.lineWidth = R * 0.013;
        g.stroke();
      } else if (type === TYPE.HOLDTAP) {
        g.strokeStyle = st.hi;
        g.lineWidth = R * 0.006;
        g.stroke();
      }
    }
    g.restore();
  }
  function strokeIssue(pts, level, alpha) {
    if (pts.length < 2) return;
    g.save();
    g.globalAlpha = alpha;
    g.lineCap = "round";
    g.lineJoin = "round";
    pathLine(screenPts(pts));
    g.strokeStyle = ISSUE_COLOR[level];
    g.lineWidth = R * BODY_OUT + 7;
    if (level === "warn") g.setLineDash([R * 0.03, R * 0.02]);
    g.stroke();
    g.restore();
  }
  // 노트 하나의 몸통·끝 손잡이·안쪽 탭·체이스 꼭짓점. faded: 앞 페이지에서 이어진 노트(이 페이지 구간만).
  function drawHoldPart(n, i, alpha, white, faded) {
    var ps = pageStart(), pe = pageEnd(), bpp = ed.bpp;
    var from = faded ? ps : n.b;
    var to = faded ? pe : pe + bpp * 2;
    var pts = M.notePolyline(n, ps, bpp, MODE, from, to);
    var inPage = [], beyond = [];
    pts.forEach(function (p) {
      if (!p.over) inPage.push(p);
      else {
        if (!beyond.length && inPage.length) beyond.push(inPage[inPage.length - 1]);
        beyond.push(p);
      }
    });
    var st = white ? whiteOf(bodyStyle(n)) : bodyStyle(n);
    var lvl = !white && i >= 0 ? issueOf[i] : null;
    if (lvl) strokeIssue(pts, lvl, alpha);
    strokeBody(inPage, st, alpha, n.type, white);
    // 12시를 넘어 다음 페이지로 이어지는 부분: 나선처럼 바깥으로 벌려 흐리게
    strokeBody(beyond, st, alpha * 0.5, n.type, white, true);
    var lim = to + 1e-6;
    // 체이스 꼭짓점(레인을 바꾸는 자리)
    if (n.type === TYPE.CHASE && n.path) {
      for (var v = 1; v < n.path.length - 1; v++) {
        var vb = n.path[v].b;
        if (vb < from - 1e-6 || vb > lim) continue;
        var vp = toScreen(M.notePoint(n, vb, ps, bpp, MODE));
        g.save();
        g.globalAlpha = vb > pe ? alpha * 0.5 : alpha;
        diamond(vp.x, vp.y, R * 0.011, white ? "#FFFFFF" : "#F4FFF9");
        g.restore();
      }
    }
    // 끝 손잡이(앞 페이지에서 이어진 노트가 딱 12시에 끝나면 다음 페이지 첫 자리이므로 그리지 않음)
    if (faded ? n.eb < pe - 1e-6 : n.eb <= lim) {
      var e = toScreen(M.notePoint(n, n.eb, ps, bpp, MODE));
      g.save();
      g.globalAlpha = n.eb > pe + 1e-6 ? alpha * 0.7 : alpha;
      g.beginPath();
      g.arc(e.x, e.y, R * END_R, 0, TAU);
      g.fillStyle = white ? "#FFFFFF" : st.hi;
      g.fill();
      g.lineWidth = Math.max(1.6, R * 0.006);
      g.strokeStyle = OUTLINE;
      g.stroke();
      g.restore();
    }
  }
  // 홀드앤탭 리벳(별). 탭 머리와 같은 자리에 겹쳐도 보이도록 모든 노트를 그린 뒤 맨 위에 따로 그린다(09-30).
  function drawRivets(n, alpha, white, faded) {
    if (n.type !== TYPE.HOLDTAP || !n.taps || !n.taps.length) return;
    var ps = pageStart(), pe = pageEnd();
    var from = faded ? ps : n.b;
    var lim = (faded ? pe : pe + ed.bpp * 2) + 1e-6;
    var st = bodyStyle(n);
    n.taps.forEach(function (t) {
      if (t < from - 1e-6 || t > lim || (faded && t >= pe - 1e-6)) return;
      var sp = toScreen(M.notePoint(n, t, ps, ed.bpp, MODE));
      g.save();
      g.globalAlpha = t > pe ? alpha * 0.5 : alpha;
      star(sp.x, sp.y, R * RIVET_R, "#FFFFFF", white ? OUTLINE : st.dark);
      g.restore();
    });
  }
  // 리벳 넣기/빼기 자리 표시: 빈 자리는 흐린 점선 별, 이미 있는 리벳은 빨간 고리(S · 휠클릭 · 오른쪽 클릭 대상)
  function drawRivetSpot() {
    var rs = ed.rivetSpot;
    if (!rs || drag || audio.running || !pointer.inside) return;
    var n = chart.notes[rs.index];
    if (!n || n.type !== TYPE.HOLDTAP || !M.isOnPage(n, pageStart(), ed.bpp)) return;
    var p = toScreen(M.notePoint(n, rs.beat, pageStart(), ed.bpp, MODE));
    g.save();
    if (rs.exists) {
      ring(p.x, p.y, R * RIVET_R * 1.7, "#C8241C", 2.4);
    } else {
      g.globalAlpha = 0.75;
      star(p.x, p.y, R * RIVET_R, "rgba(255,255,255,.55)", NOTE_STYLE[TYPE.HOLDTAP].dark);
      ring(p.x, p.y, R * RIVET_R * 1.7, NOTE_STYLE[TYPE.HOLDTAP].dark, 1.6, [3, 3]);
    }
    g.restore();
  }
  function drawHead(n, i, alpha, white) {
    var p = toScreen(M.notePoint(n, n.b, pageStart(), ed.bpp, MODE));
    var st = headStyle(n, i);
    var r = R * HEAD_R;
    var lvl = !white && i >= 0 ? issueOf[i] : null;
    if (lvl) {
      g.save();
      g.globalAlpha = alpha;
      ring(p.x, p.y, r * 1.38, ISSUE_COLOR[lvl], 3.2, lvl === "warn" ? [5, 4] : null);
      g.restore();
    }
    drawGear(p.x, p.y, r, white ? whiteOf(st) : st, alpha);
  }
  function drawChordLinks(onPage) {
    if (MODE !== "lanes") return;
    var done = {};
    onPage.forEach(function (i) {
      var grp = chords[i];
      if (!grp || done[grp[0]]) return;
      done[grp[0]] = true;
      var pts = grp.slice().sort(function (a, b) { return chart.notes[a].lane - chart.notes[b].lane; })
        .map(function (k) { var n = chart.notes[k]; return toScreen(M.notePoint(n, n.b, pageStart(), ed.bpp, MODE)); });
      var unit = R * HEAD_R;
      g.save();
      g.lineCap = "butt";
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var k = 1; k < pts.length; k++) g.lineTo(pts[k].x, pts[k].y);
      g.setLineDash([unit * 0.9, unit * 0.45]);
      g.strokeStyle = "rgba(42,26,14,.8)";
      g.lineWidth = Math.max(4, unit * 0.34);
      g.stroke();
      g.strokeStyle = "#FFFFFF";
      g.lineWidth = Math.max(2.2, unit * 0.2);
      g.stroke();
      g.restore();
    });
  }
  function hoverIndex() {
    if (ed.hover >= 0) return ed.hover;
    if (forcedHover >= 0 && chart && forcedHover < chart.notes.length && M.isOnPage(chart.notes[forcedHover], pageStart(), ed.bpp)) return forcedHover;
    return -1;
  }
  function renderNotes() {
    var ps = pageStart();
    var notes = chart.notes;
    var hov = hoverIndex();
    var creating = drag && drag.kind === "create" ? drag.note : null;
    var i, n;
    // 1) 앞 페이지에서 시작해 이 페이지까지 이어지는 노트: 흐리게, 고를 수 없음
    for (i = 0; i < notes.length; i++) if (M.continuesInto(notes[i], ps)) drawHoldPart(notes[i], i, 0.3, false, true);
    // 2) 이 페이지에서 시작하는 노트의 몸통(늦은 것부터 그려서 이른 것이 위로)
    var onPage = [];
    for (i = 0; i < notes.length; i++) if (M.isOnPage(notes[i], ps, ed.bpp)) onPage.push(i);
    for (var j = onPage.length - 1; j >= 0; j--) {
      i = onPage[j];
      n = notes[i];
      if (n.type !== TYPE.TAP && i !== hov) drawHoldPart(n, i, 1, false, false);
    }
    drawChordLinks(onPage);
    for (j = onPage.length - 1; j >= 0; j--) {
      i = onPage[j];
      if (i !== hov) drawHead(notes[i], i, 1, false);
    }
    // 3) 커서 아래 노트는 흰색으로 맨 위에(몸통·머리 모두)
    if (hov >= 0 && notes[hov]) {
      if (notes[hov].type !== TYPE.TAP) drawHoldPart(notes[hov], hov, 1, true, false);
      drawHead(notes[hov], hov, 1, true);
    }
    // 4) 홀드앤탭 리벳은 모든 노트 위에(탭과 겹쳐도 보이게). 커서 아래 노트의 리벳은 흰 노트에 맞춰 테두리를 진하게
    for (i = 0; i < notes.length; i++) if (M.continuesInto(notes[i], ps)) drawRivets(notes[i], 0.3, false, true);
    for (j = onPage.length - 1; j >= 0; j--) {
      i = onPage[j];
      drawRivets(notes[i], 1, i === hov, false);
    }
    drawRivetSpot();
    // 5) 만들고 있는 노트
    if (creating) {
      if (creating.type !== TYPE.TAP) drawHoldPart(creating, -1, 0.9, false, false);
      drawHead(creating, -1, creating.type === TYPE.TAP ? 0.8 : 0.95, false);
      drawRivets(creating, 0.95, false, false);
    }
  }
  // 빈 곳 위에서 커서가 가리키는 격자 자리(놓일 자리) 표시
  function drawSnapMarker() {
    if (drag || audio.running || !pointer.inside || hoverIndex() >= 0) return;
    if (pointer.r < 0.12 || pointer.r > 1.02) return;
    var spot = spotUnderPointer();
    var p = toScreen(M.pointAt(M.angleOfBeat(spot.b, pageStart(), ed.bpp), M.laneRadius(spot.lane)));
    var st = MODE === "lanes" && ed.type !== TYPE.CHASE ? laneStyle(spot.lane) : NOTE_STYLE[ed.type];
    g.save();
    ring(p.x, p.y, R * HEAD_R * 1.05, st.base, 2.4, [4, 3]);
    g.beginPath();
    g.arc(p.x, p.y, 3, 0, TAU);
    g.fillStyle = st.dark;
    g.fill();
    g.restore();
  }
  function drawFlash(now) {
    if (!ed.flash) return;
    if (now > ed.flash.until || !chart.notes[ed.flash.index]) { ed.flash = null; return; }
    var n = chart.notes[ed.flash.index];
    if (!M.isOnPage(n, pageStart(), ed.bpp)) return;
    var p = toScreen(M.notePoint(n, n.b, pageStart(), ed.bpp, MODE));
    var k = (ed.flash.until - now) / 1400;
    ring(p.x, p.y, R * HEAD_R * (1.5 + 0.8 * (1 - k)), "rgba(200,36,28," + (0.9 * k).toFixed(3) + ")", 3);
  }

  function render(now) {
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    // 확대: 아래 그리기는 모두 배치 좌표(CX · CY · R)로 하고, 여기서 한 번에 키운다
    var z = view.zoom;
    g.setTransform(DPR * z, 0, 0, DPR * z, DPR * (CX + view.panX - CX * z), DPR * (CY + view.panY - CY * z));
    if (dialCache) {
      var sz = dialCache.width / dialScale;
      g.drawImage(dialCache, CX - sz / 2, CY - sz / 2, sz, sz);
    }
    if (!chart) { drawCap(); return; }
    if (shotPointer) syncShotPointer();
    drawGrid();
    if (MODE === "lanes") drawLaneKeys();
    var cb = currentBeat();
    var ps = pageStart();
    if (cb >= ps - 1e-6 && cb <= ps + ed.bpp + 1e-6) drawHand(M.angleOfBeat(cb, ps, ed.bpp));
    renderNotes();
    drawSnapMarker();
    drawFlash(now);
    drawCap();
  }

  // ================= 시간 막대(곡 전체) =================
  var TL_PAD = 10;
  function tlRange() {
    var b0 = Math.min(0, beatOfTime(0));
    return { b0: b0, b1: Math.max(b0 + 1, totalBeats()) };
  }
  function tlX(b, rg) { return TL_PAD + ((b - rg.b0) / (rg.b1 - rg.b0)) * (TW - TL_PAD * 2); }
  function drawTimeline() {
    tg.setTransform(DPR, 0, 0, DPR, 0, 0);
    tg.clearRect(0, 0, TW, TH);
    var top = 3, bot = TH - 15;
    tg.fillStyle = "#F8F2E6";
    tg.strokeStyle = "#CDB894";
    tg.lineWidth = 1;
    tg.beginPath();
    if (tg.roundRect) tg.roundRect(TL_PAD - 4, top - 1, TW - TL_PAD * 2 + 8, bot - top + 2, 5); else tg.rect(TL_PAD - 4, top - 1, TW - TL_PAD * 2 + 8, bot - top + 2);
    tg.fill();
    tg.stroke();
    if (!chart) return;
    var rg = tlRange();
    // 페이지 줄무늬: 몇 번째 페이지인지 감을 잡게
    var lp = lastPage();
    for (var p = 0; p <= lp; p += 2) {
      var xa = tlX(p * ed.bpp, rg), xb = tlX((p + 1) * ed.bpp, rg);
      tg.fillStyle = "rgba(107,66,38,.05)";
      tg.fillRect(xa, top, xb - xa, bot - top);
    }
    // 노트: 레인별 줄(안쪽 레인이 아래), 누르는 노트는 막대
    var rowH = (bot - top - 4) / 4;
    chart.notes.forEach(function (n, i) {
      var st = MODE === "lanes" && n.type !== TYPE.CHASE ? laneStyle(n.lane) : NOTE_STYLE[n.type] || NOTE_STYLE[0];
      var y = bot - 2 - (n.lane + 1) * rowH;
      var x = tlX(n.b, rg);
      tg.fillStyle = issueOf[i] ? "#C8241C" : st.base;
      if (n.type === TYPE.TAP) tg.fillRect(x - 0.75, y + 1, 1.5, rowH - 2);
      else tg.fillRect(x - 0.75, y + rowH * 0.25, Math.max(1.5, tlX(n.eb, rg) - x), rowH * 0.5);
    });
    // 지금 페이지
    var x0 = tlX(pageStart(), rg), x1 = tlX(pageEnd(), rg);
    tg.fillStyle = "rgba(226,184,90,.35)";
    tg.fillRect(x0, top, Math.max(2, x1 - x0), bot - top);
    tg.strokeStyle = "#8C6118";
    tg.lineWidth = 1.2;
    tg.strokeRect(x0, top, Math.max(2, x1 - x0), bot - top);
    // 재생 위치
    var xp = tlX(clamp(currentBeat(), rg.b0, rg.b1), rg);
    tg.strokeStyle = "#A83232";
    tg.lineWidth = 2;
    tg.beginPath();
    tg.moveTo(xp, top - 2);
    tg.lineTo(xp, bot + 2);
    tg.stroke();
    tg.fillStyle = "#A83232";
    tg.beginPath();
    tg.moveTo(xp - 5, top - 3);
    tg.lineTo(xp + 5, top - 3);
    tg.lineTo(xp, top + 4);
    tg.closePath();
    tg.fill();
    // 시간 글자
    tg.font = "11px Cinzel, serif";
    tg.fillStyle = "#8A7560";
    tg.textBaseline = "alphabetic";
    tg.textAlign = "left";
    tg.fillText(M.fmtTime(timeOfBeat(rg.b0)), TL_PAD - 2, TH - 3);
    tg.textAlign = "right";
    tg.fillText(M.fmtTime(timeOfBeat(rg.b1)) + (audio.buffer ? "" : audio.loading ? " (음원 읽는 중)" : " (음원 없음)"), TW - TL_PAD + 2, TH - 3);
    // 재생 위치 시각: 양 끝 글자와 겹치면 생략(페이지 칸에 같은 값이 있다)
    if (xp > TL_PAD + 70 && xp < TW - 170) {
      tg.textAlign = "center";
      tg.fillStyle = "#5E4834";
      tg.fillText(M.fmtTime(timeOfBeat(currentBeat())), xp, TH - 3);
    }
  }
  var tlDragging = false;
  function beatFromTimeline(e) {
    var rect = tl.getBoundingClientRect();
    var rg = tlRange();
    var f = clamp((e.clientX - rect.left - TL_PAD) / (TW - TL_PAD * 2), 0, 1);
    return rg.b0 + f * (rg.b1 - rg.b0);
  }
  tl.addEventListener("pointerdown", function (e) {
    if (!chart || e.button !== 0 || drag) return;
    tlDragging = true;
    tl.setPointerCapture(e.pointerId);
    seekBeat(beatFromTimeline(e));
  });
  tl.addEventListener("pointermove", function (e) {
    // 재생 중에는 끌 때마다 다시 틀면 소리가 끊겨서, 멈춰 있을 때만 따라 움직인다(재생 중에는 놓을 때 옮김).
    if (tlDragging && !audio.running) seekBeat(beatFromTimeline(e));
  });
  tl.addEventListener("pointerup", function (e) {
    if (!tlDragging) return;
    tlDragging = false;
    if (audio.running) seekBeat(beatFromTimeline(e));
  });
  tl.addEventListener("lostpointercapture", function () { tlDragging = false; });

  // ================= 페이지·재생 =================
  function goPage(p) {
    if (!chart) return;
    p = clamp(p, 0, lastPage());
    if (audio.running) { seekBeat(M.pageStartOf(p, ed.bpp)); return; }
    var old = ed.page;
    ed.page = p;
    playBeat = pageStart(); // 멈춰 있을 때 페이지를 넘기면 재생 위치도 그 페이지 시작으로
    // 끄는 도중 페이지를 넘길 때: 옮기던 노트(탭 놓기 포함)는 새 페이지에서 커서 아래로 따라오고,
    // 늘이던 끝(롱·체이스·홀드앤탭)은 같은 박자를 계속 가리킨다(시작은 원래 페이지에 그대로).
    if (drag && p !== old) {
      if (drag.kind === "move" || (drag.kind === "create" && drag.type === TYPE.TAP)) drag.unwrap.turns = 0;
      else M.shiftUnwrapPages(drag.unwrap, p - old);
      updateDrag();
    }
    onPageChanged();
  }
  function onPageChanged() {
    updateHover();
    refreshPageInfo();
    needsDraw = true;
    needsTimeline = true;
  }
  function seekBeat(b) {
    if (!chart) return;
    var rg = tlRange();
    b = clamp(b, rg.b0, rg.b1);
    if (audio.running) {
      startPlaybackAt(b);
    } else {
      playBeat = b;
      ed.page = clamp(M.pageOfBeat(Math.max(0, b), ed.bpp), 0, lastPage());
    }
    onPageChanged();
  }
  function togglePlay() {
    if (!chart) return;
    if (audio.running) stopPlayback();
    else startPlayback();
  }
  function startPlayback() {
    if (drag) cancelDrag();
    if (!audio.init()) { status("이 브라우저는 소리를 재생할 수 없습니다", "err"); return; }
    var b = playBeat;
    if (timeOfBeat(b) >= songEndTime() - 0.05) b = 0; // 끝에 있으면 처음부터
    if (!audio.buffer) status(audio.loading ? "음원을 불러오는 중이라 소리 없이 시계만 돕니다" : "음원이 없어 소리 없이 시계만 돕니다", "warn");
    // 처음 한 번은 소리 장치가 잠들어 있다. 깨어난 뒤에 시작해야 음원과 바늘이 어긋나지 않는다.
    if (audio.ctx.state !== "running") {
      audio.ctx.resume().then(function () { if (!audio.running && chart) startPlaybackAt(b); });
      return;
    }
    startPlaybackAt(b);
  }
  var sched = { until: 0 };
  function startPlaybackAt(b) {
    rec.before = null;
    rec.count = 0;
    var t = timeOfBeat(b);
    audio.start(t, prefs.rate);
    sched.until = t - 0.002; // 시작 자리에 있는 노트 소리도 나게
    updatePlayButton();
    needsDraw = true;
  }
  function stopPlayback(atTime) {
    if (audio.running) recFlush(recBeatNow());
    rec.before = null;
    var t = audio.stop();
    if (atTime !== undefined) t = atTime;
    if (t !== null && isFinite(t)) playBeat = beatOfTime(t);
    ed.page = clamp(M.pageOfBeat(Math.max(0, playBeat), ed.bpp), 0, lastPage());
    updatePlayButton();
    onPageChanged();
  }
  // 소리 예약: 앞으로 0.2초(곡 시간은 속도만큼) 안에 올 메트로놈·노트 소리를 미리 걸어 둔다.
  function schedule() {
    var c = audio.ctx;
    var nowSong = audio.anchorSong + (c.currentTime - audio.anchorCtx) * audio.rate;
    var horizon = Math.max(nowSong, audio.anchorSong) + 0.2 * audio.rate;
    if (!isFinite(horizon) || !isFinite(sched.until) || horizon <= sched.until) return; // 값이 깨지면 아래 반복이 끝나지 않으므로
    var from = sched.until, to = horizon;
    var minCtx = c.currentTime - 0.01;
    if (prefs.metro) {
      for (var k = Math.ceil(beatOfTime(from) - 1e-9); ; k++) {
        var tk = timeOfBeat(k);
        if (tk > to) break;
        if (tk <= from) continue;
        var at = audio.ctxAt(tk);
        if (at >= minCtx) audio.click(Math.max(at, c.currentTime), ((k % 4) + 4) % 4 === 0);
      }
    }
    if (prefs.tick) {
      var lastB = null;
      for (var i = 0; i < chart.notes.length; i++) {
        var nb = chart.notes[i].b;
        if (lastB !== null && Math.abs(nb - lastB) < 1e-4) continue; // 동시에 시작하는 노트는 한 번만
        var tn = timeOfBeat(nb);
        if (tn <= from) continue;
        if (tn > to) break;
        lastB = nb;
        var an = audio.ctxAt(tn);
        if (an >= minCtx) audio.tick(Math.max(an, c.currentTime));
      }
    }
    sched.until = to;
  }
  function stepPlayback() {
    schedule();
    var t = audio.songNow();
    var end = songEndTime();
    if (t >= end) {
      stopPlayback(end);
      status("곡 끝까지 재생했습니다");
      return;
    }
    var p = clamp(M.pageOfBeat(Math.max(0, beatOfTime(t)), ed.bpp), 0, lastPage());
    if (p !== ed.page) { ed.page = p; updateHover(); }
    refreshPageInfo();
  }

  // ================= 편집 =================
  function snapshot() { return JSON.stringify(chart); }
  function afterEdit(keep) {
    M.sortNotes(chart.notes);
    var idx = keep ? chart.notes.indexOf(keep) : -1;
    revalidate();
    updateDirty();
    refreshPageInfo();
    updateHover();
    needsDraw = true;
    needsTimeline = true;
    return idx;
  }
  function restore(s) {
    var songBefore = chart.song;
    chart = JSON.parse(s);
    ed.hover = -1;
    ed.flash = null;
    ed.page = clamp(ed.page, 0, lastPage());
    revalidate();
    updateDirty();
    refreshAll();
    if (chart.song !== songBefore) loadSong(chart.song);
    updateHover();
  }
  function undo() {
    if (!chart || drag) return;
    var s = history.undo(snapshot());
    if (s === null) { status("되돌릴 것이 없습니다"); return; }
    restore(s);
    status("되돌렸습니다");
  }
  function redo() {
    if (!chart || drag) return;
    var s = history.redo(snapshot());
    if (s === null) { status("다시 할 것이 없습니다"); return; }
    restore(s);
    status("다시 했습니다");
  }
  function deleteHovered() {
    var i = hoverIndex();
    if (!chart || i < 0 || drag) return;
    if (audio.running) { status("재생 중에는 편집할 수 없습니다. Space로 멈추세요", "warn"); return; }
    // 리벳 위: 그 리벳만 뺀다
    if (i === ed.hover && ed.hoverPart === "rivet") { applyRivetToggle(i, ed.hoverHit.beat); return; }
    var before = snapshot();
    var n = chart.notes[i];
    chart.notes.splice(i, 1);
    history.record(before);
    ed.hover = -1;
    forcedHover = -1;
    afterEdit();
    status(TYPE_NAMES[n.type] + " 노트를 지웠습니다 · " + M.fmtBeat(n.b) + "박 " + laneText(n.lane));
  }
  // 커서 아래 홀드앤탭의 리벳 자리: 리벳 위면 그 리벳, 몸통 위면 지금 스냅에 맞춘 박자. 탭 머리가 겹쳐 있어도 홀드앤탭만 본다.
  // 돌려주는 값: { index, beat, exists } 또는 null(홀드앤탭 밖 · 시작/끝 자리)
  function findRivetSpot() {
    if (MODE !== "core" || !chart || !pointer.inside || audio.running) return null;
    var h = M.hitTest(chart.notes, {
      x: pointer.x, y: pointer.y, pageStart: pageStart(), bpp: ed.bpp, mode: MODE, only: TYPE.HOLDTAP,
      headR: HIT_HEAD, endR: HIT_END, rivetR: HIT_RIVET, bodyR: HIT_BODY, maxBeat: pageEnd() + ed.bpp * 2
    });
    if (!h || (h.part !== "rivet" && h.part !== "body")) return null;
    var n = chart.notes[h.index];
    var beat = h.part === "rivet" ? h.beat : M.snapBeat(h.beat, prefs.div);
    if (beat <= n.b + M.EPS || beat >= n.eb - M.EPS) return null;
    var exists = (n.taps || []).some(function (t) { return Math.abs(t - beat) < M.EPS; });
    return { index: h.index, beat: beat, exists: exists };
  }
  function applyRivetToggle(i, beat) {
    var r = M.toggleRivet(chart.notes[i], beat);
    if (!r) { status("시작·끝 자리에는 리벳을 넣을 수 없습니다"); return; }
    var before = snapshot();
    chart.notes[i] = r.note;
    history.record(before);
    afterEdit(r.note);
    status("리벳 " + (r.added ? "넣음" : "뺌") + " · " + M.fmtBeat(beat) + "박 (리벳 " + r.note.taps.length + "개)");
  }
  // S · 휠클릭: 커서 아래 홀드앤탭에 스냅 자리 리벳을 넣거나 뺀다(09-30. 예전에는 간격 바꾸기)
  function toggleRivetAtPointer() {
    if (!chart || drag) return;
    if (audio.running) { status("재생 중에는 편집할 수 없습니다. Space로 멈추세요", "warn"); return; }
    var rs = findRivetSpot();
    if (!rs) { status("홀드앤탭 몸통 위에 커서를 두고 누르세요(시작·끝 자리 제외)"); return; }
    applyRivetToggle(rs.index, rs.beat);
  }

  // ================= 마우스 =================
  function pointerFromEvent(e) {
    var rect = cv.getBoundingClientRect();
    return pointerAt(e.clientX - rect.left, e.clientY - rect.top);
  }
  // 캔버스 안 화면 좌표(px, py) → 커서 정보. x · y는 확대를 되돌린 시계 판 좌표(반지름 1 기준)
  function pointerAt(px, py) {
    var l = viewToLayout(px, py);
    var x = (l.x - CX) / R, y = (l.y - CY) / R;
    var pol = M.polarOf(x, y);
    return { inside: true, px: px, py: py, x: x, y: y, angle: pol.angle, r: pol.r };
  }
  // 커서 아래 격자 자리(시작 박자·레인). 12시 바로 왼쪽은 페이지 시작으로 본다.
  function spotUnderPointer() {
    var ps = pageStart();
    return {
      b: M.wrapSnapStart(M.beatOfAngle(pointer.angle, ps, ed.bpp), ps, ed.bpp, prefs.div),
      lane: M.nearestLane(pointer.r)
    };
  }
  function updateHover() {
    if (!chart || drag) return;
    var h = null;
    if (pointer.inside && !audio.running) {
      h = M.hitTest(chart.notes, {
        x: pointer.x, y: pointer.y, pageStart: pageStart(), bpp: ed.bpp, mode: MODE,
        headR: HIT_HEAD, endR: HIT_END, rivetR: HIT_RIVET, bodyR: HIT_BODY, maxBeat: pageEnd() + ed.bpp * 2
      });
    }
    var idx = h ? h.index : -1;
    if (idx !== ed.hover || (h ? h.part : null) !== ed.hoverPart) needsDraw = true;
    ed.hover = idx;
    ed.hoverPart = h ? h.part : null;
    ed.hoverHit = h;
    // 리벳 자리 표시는 홀드앤탭 위이거나, 그 위에 겹친 탭 위일 때만
    var rs = findRivetSpot();
    if (rs && !(idx === rs.index || (idx >= 0 && chart.notes[idx].type === TYPE.TAP))) rs = null;
    ed.rivetSpot = rs;
    setCanvasCursor();
    updateCursorTag();
  }
  // 탭을 고른 채 홀드앤탭 몸통 · 리벳 위에 있으면 누를 때 옮기기 대신 그 자리에 탭을 놓는다(겹친 탭, 09-30).
  // 옮기려면 머리(시작 태엽)를 잡거나 다른 노트 종류를 고른다. 오른쪽 클릭 지우기 · S 리벳은 그대로.
  function tapOverHoldtap() {
    if (ed.type !== TYPE.TAP || ed.hover < 0 || (ed.hoverPart !== "body" && ed.hoverPart !== "rivet")) return false;
    return chart.notes[ed.hover].type === TYPE.HOLDTAP;
  }
  function setCanvasCursor() {
    var c = drag ? (drag.kind === "move" ? "grabbing" : drag.kind === "resize" ? "ew-resize" : "crosshair")
      : ed.hover < 0 || tapOverHoldtap() ? "crosshair" : ed.hoverPart === "end" ? "ew-resize" : "grab";
    if (cv.style.cursor !== c) cv.style.cursor = c;
  }

  // 확대 중 가운데 버튼(휠) 끌기 = 화면 옮기기. 4px 넘게 움직이지 않고 떼면 원래 휠클릭(에임형 리벳 넣기 · 빼기)
  var panDrag = null;
  cv.addEventListener("pointermove", function (e) {
    if (panDrag) {
      var dx = e.clientX - panDrag.x, dy = e.clientY - panDrag.y;
      if (!panDrag.moved && dx * dx + dy * dy > 16) { panDrag.moved = true; litKeys["M-pan"] = true; cv.style.cursor = "grabbing"; }
      if (panDrag.moved) {
        view.panX = panDrag.panX + dx;
        view.panY = panDrag.panY + dy;
        clampPan();
      }
    }
    pointer = pointerFromEvent(e);
    shotPointer = null;
    if (panDrag) { needsDraw = true; return; }
    if (drag) updateDrag();
    else updateHover();
    updateCursorTag();
    needsDraw = true;
  });
  cv.addEventListener("pointerleave", function () {
    if (drag) return;
    pointer.inside = false;
    ed.hover = -1;
    updateCursorTag();
    needsDraw = true;
  });
  // 왼쪽을 누른 채 오른쪽을 누르면 pointerdown이 다시 오지 않으므로, 끌기 취소는 메뉴 이벤트에서 받는다
  cv.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    if (drag) cancelDrag();
  });
  cv.addEventListener("pointerdown", function (e) {
    if (!chart) return;
    pointer = pointerFromEvent(e);
    shotPointer = null;
    litKeys["M-button" + e.button] = true;
    if (rec.on && MODE === "core" && audio.running && (e.button === 0 || e.button === 2) && !drag) {
      recDown("M" + e.button, "aim");
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      if (view.zoom > 1 && !drag) {
        panDrag = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, moved: false };
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
        return;
      }
      if (MODE === "core" && !drag) { updateHover(); toggleRivetAtPointer(); }
      return;
    }
    if (e.button === 2) {
      if (drag) cancelDrag();
      else { updateHover(); deleteHovered(); }
      return;
    }
    if (e.button !== 0 || drag) return;
    if (audio.running) { status("재생 중에는 편집할 수 없습니다. Space로 멈추세요", "warn"); return; }
    updateHover();
    if (ed.hover >= 0 && !tapOverHoldtap()) startEditDrag(ed.hoverHit);
    else startCreate();
    if (drag) {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      setCanvasCursor();
    }
  });
  cv.addEventListener("pointerup", function (e) {
    if (rec.held["M" + e.button]) { recUp("M" + e.button); return; }
    if (e.button === 1 && panDrag) {
      var clickOnly = !panDrag.moved;
      endPan();
      if (clickOnly && MODE === "core" && !drag) { updateHover(); toggleRivetAtPointer(); }
      return;
    }
    if (e.button === 0 && drag) finishDrag();
  });
  function endPan() {
    panDrag = null;
    delete litKeys["M-pan"];
    cv.style.cursor = "";
    setCanvasCursor();
    updateHover();
    needsDraw = true;
  }
  // 휠클릭의 자동 스크롤을 막는다
  cv.addEventListener("mousedown", function (e) { if (e.button === 1) e.preventDefault(); });
  cv.addEventListener("pointercancel", function () { if (drag) cancelDrag(); });
  cv.addEventListener("lostpointercapture", function () { if (panDrag) endPan(); if (drag) cancelDrag(); });
  var wheelAcc = 0, wheelAt = 0, zoomAcc = 0, zoomAt = 0, litZoomUntil = 0;
  cv.addEventListener("wheel", function (e) {
    e.preventDefault();
    if (!chart) return;
    var now = performance.now();
    if (e.ctrlKey || e.metaKey) { // 터치패드 모으기 · 벌리기도 Ctrl+휠로 온다
      litZoomUntil = now + 180;
      if (now - zoomAt > 250) zoomAcc = 0;
      zoomAt = now;
      zoomAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      if (Math.abs(zoomAcc) >= 40) {
        pointer = pointerFromEvent(e);
        stepZoom(zoomAcc < 0 ? 1 : -1);
        zoomAcc = 0;
      }
      return;
    }
    litWheelUntil = now + 180;
    if (now - wheelAt > 250) wheelAcc = 0; // 트랙패드처럼 잘게 오는 값은 모아서 한 페이지씩
    wheelAt = now;
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    if (Math.abs(wheelAcc) >= 50) {
      goPage(ed.page + (wheelAcc > 0 ? 1 : -1));
      wheelAcc = 0;
    }
  }, { passive: false });

  function startCreate() {
    if (pointer.r < 0.12 || pointer.r > 1.02) return; // 가운데 축과 테 밖은 무시
    if (ALLOWED.indexOf(ed.type) < 0) { status("이 목업에서 쓸 수 없는 노트입니다", "warn"); return; }
    var spot = spotUnderPointer();
    var ps = pageStart();
    drag = {
      kind: "create", type: ed.type, b: spot.b, lane: spot.lane, div: prefs.div,
      unwrap: M.createUnwrap(pointer.angle, M.angleOfBeat(spot.b, ps, ed.bpp)),
      startPx: { x: pointer.px, y: pointer.py }, moved: false, before: snapshot(), note: null,
      rec: ed.type === TYPE.CHASE ? M.createChaseRecorder(spot.b, spot.lane, prefs.div) : null
    };
    updateDrag();
  }
  function startEditDrag(hit) {
    var n = chart.notes[hit.index];
    var ps = pageStart();
    var resize = hit.part === "end" && n.type !== TYPE.TAP;
    var onBody = hit.part === "body" || hit.part === "rivet"; // 리벳을 잡고 끌면 몸통을 잡은 것과 같다
    var grabBeat = resize ? n.eb : onBody ? hit.beat : n.b;
    drag = {
      kind: resize ? "resize" : "move", index: hit.index, orig: JSON.parse(JSON.stringify(n)), div: prefs.div,
      grabOffset: onBody ? hit.beat - n.b : 0, grabLane: onBody ? hit.lane : n.lane,
      unwrap: M.createUnwrap(pointer.angle, M.angleOfBeat(grabBeat, ps, ed.bpp)),
      startPx: { x: pointer.px, y: pointer.py }, moved: false, before: snapshot()
    };
    status(resize ? "끝 동그라미를 끌면 길이가 바뀝니다. 12시를 넘기면 다음 페이지까지 이어집니다" : "끌어서 놓으면 옮겨집니다(시간은 스냅, 레인은 가까운 고리)");
  }
  function updateDrag() {
    if (!drag) return;
    var ps = pageStart(), bpp = ed.bpp, div = drag.div, step = M.stepOf(div);
    // 가운데 축 근처는 각도가 튀므로 마지막 각도를 그대로 쓴다
    var cont = pointer.r < 0.1 ? drag.unwrap.last + drag.unwrap.turns * 360 : M.unwrapAngle(drag.unwrap, pointer.angle);
    var contBeat = M.beatOfAngle(cont, ps, bpp);
    if (!drag.moved) {
      var dx = pointer.px - drag.startPx.x, dy = pointer.py - drag.startPx.y;
      if (dx * dx + dy * dy >= 16) drag.moved = true;
    }
    if (drag.kind === "create") {
      var t = drag.type;
      if (t === TYPE.TAP) {
        drag.note = drag.moved ? M.makeNote(TYPE.TAP, M.clampStart(contBeat, ps, bpp, div), M.nearestLane(pointer.r)) : M.makeNote(TYPE.TAP, drag.b, drag.lane);
      } else if (t === TYPE.CHASE) {
        if (drag.moved) M.recordChase(drag.rec, contBeat, pointer.r);
        drag.note = M.buildChase(drag.rec, drag.moved ? step : 1);
      } else {
        var eb = drag.moved ? Math.max(M.snapBeat(drag.b + step, div), M.snapBeat(contBeat, div)) : drag.b + 1;
        drag.note = M.makeNote(t, drag.b, drag.lane, eb, prefs.fill);
      }
    } else if (drag.moved) {
      var n;
      if (drag.kind === "move") {
        var nb = M.clampStart(contBeat - drag.grabOffset, ps, bpp, div);
        n = M.moveNote(drag.orig, nb, drag.orig.lane + (M.nearestLane(pointer.r) - drag.grabLane));
      } else {
        n = M.resizeNoteEnd(drag.orig, M.snapBeat(contBeat, div), step);
      }
      chart.notes[drag.index] = n;
      ed.hover = drag.index; // 끄는 노트는 흰색으로
    }
    updateCursorTag();
    needsDraw = true;
  }
  function finishDrag() {
    var d = drag;
    drag = null;
    if (d.kind === "create") {
      var n = d.note;
      if (!n) return;
      if (n.type === TYPE.TAP && d.moved && pointer.r > 1.1) { status("시계 밖에서 놓아서 취소했습니다"); needsDraw = true; return; }
      var occ = M.occupied(chart.notes, n.b, n.lane);
      if (occ >= 0) { status("그 자리(" + M.fmtBeat(n.b) + "박 " + laneText(n.lane) + ")에 이미 노트가 있습니다", "warn"); needsDraw = true; updateHover(); return; }
      chart.notes.push(n);
      history.record(d.before);
      afterEdit(n);
      status(TYPE_NAMES[n.type] + " 노트를 놓았습니다 · " + describeNote(n));
      return;
    }
    var now = chart.notes[d.index];
    if (!d.moved || JSON.stringify(now) === JSON.stringify(d.orig)) {
      chart.notes[d.index] = d.orig;
      ed.hover = -1;
      needsDraw = true;
      updateHover();
      if (!d.moved) status(TYPE_NAMES[d.orig.type] + " · " + describeNote(d.orig));
      return;
    }
    history.record(d.before);
    ed.hover = -1;
    afterEdit(now);
    status((d.kind === "move" ? "옮겼습니다 · " : "길이를 바꿨습니다 · ") + describeNote(now));
  }
  function cancelDrag() {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.kind !== "create") chart.notes[d.index] = d.orig;
    ed.hover = -1;
    needsDraw = true;
    updateHover();
    status("끌던 것을 취소했습니다");
  }
  function describeNote(n) {
    var s = M.fmtBeat(n.b) + (n.type === TYPE.TAP ? "" : "~" + M.fmtBeat(n.eb)) + "박 · " + laneText(n.lane);
    if (n.type === TYPE.CHASE && n.path) {
      var lanes = n.path.map(function (p) { return p.lane + 1; }).filter(function (l, i, a) { return i === 0 || a[i - 1] !== l; });
      s += " → " + lanes.slice(1).join("→");
    }
    if (n.type === TYPE.HOLDTAP) s += " · 리벳 " + (n.taps || []).length + "개";
    if (n.type !== TYPE.TAP && n.eb > pageEnd() + 1e-6 && M.isOnPage(n, pageStart(), ed.bpp)) s += " (다음 페이지로 이어짐)";
    return s;
  }

  // 커서를 따라다니는 노트 종류 표시("2 롱")
  var tagEl = $("cursor-tag");
  function swatchHtml(type, lane) {
    if (MODE === "lanes" && type !== TYPE.CHASE) {
      var st = laneStyle(lane);
      return '<span class="sw" style="background:radial-gradient(circle at 35% 35%,' + st.hi + "," + st.base + ')' + (type === TYPE.LONG ? ";border-radius:4px" : "") + '"></span>';
    }
    return '<span class="sw t' + type + '"></span>';
  }
  function updateCursorTag() {
    if (!chart || !pointer.inside || modalOpen() || (pointer.r > 1.25 && !drag)) { tagEl.classList.remove("show"); return; }
    var type = drag && drag.kind === "create" ? drag.type : ed.type;
    var laneForColor = M.nearestLane(pointer.r);
    var detail = "";
    if (drag && drag.kind === "create" && drag.note) {
      var dn = drag.note;
      detail = M.fmtBeat(dn.b) + (dn.type === TYPE.TAP ? "" : "~" + M.fmtBeat(dn.eb)) + "박" + (dn.type === TYPE.TAP ? " · " + laneText(dn.lane) : "");
      if (dn.type !== TYPE.TAP && dn.eb > pageEnd() + 1e-6) detail += " · 다음 페이지로";
      laneForColor = dn.lane;
    } else if (drag) {
      var cur = chart.notes[drag.index];
      detail = drag.kind === "move" ? "옮기기 " + M.fmtBeat(cur.b) + "박 · " + laneText(cur.lane) : "끝 " + M.fmtBeat(cur.eb) + "박" + (cur.eb > pageEnd() + 1e-6 ? " · 다음 페이지로" : "");
    } else if (audio.running) {
      detail = "재생 중";
    } else if (hoverIndex() >= 0 && tapOverHoldtap()) {
      var ts = spotUnderPointer();
      detail = "탭 놓기 " + M.fmtBeat(ts.b) + "박 · " + laneText(ts.lane) + " (홀드앤탭 위)";
      laneForColor = ts.lane;
    } else if (hoverIndex() >= 0) {
      var hn = chart.notes[hoverIndex()];
      detail = ed.hoverPart === "rivet" ? "리벳 " + M.fmtBeat(ed.hoverHit.beat) + "박 · S · 오른쪽 클릭으로 빼기"
        : (ed.hoverPart === "end" ? "길이 · " : "옮기기 · ") + TYPE_NAMES[hn.type] + " " + M.fmtBeat(hn.b) + "박";
      var rsp = ed.rivetSpot;
      if (rsp && ed.hoverPart !== "rivet") detail += " · S 리벳 " + (rsp.exists ? "빼기 " : "넣기 ") + M.fmtBeat(rsp.beat) + "박";
    } else if (pointer.r >= 0.12 && pointer.r <= 1.02) {
      var spot = spotUnderPointer();
      detail = M.fmtBeat(spot.b) + "박 · " + laneText(spot.lane);
      laneForColor = spot.lane;
    }
    tagEl.innerHTML = swatchHtml(type, laneForColor) + "<b>" + (type + 1) + "</b>" + TYPE_NAMES[type] + (detail ? ' <span class="d">' + esc(detail) + "</span>" : "");
    tagEl.classList.add("show");
    var w = tagEl.offsetWidth, h = tagEl.offsetHeight;
    var left = pointer.px + 16, top = pointer.py + 16;
    if (left + w > W - 4) left = pointer.px - w - 12;
    if (top + h > H - 4) top = pointer.py - h - 12;
    tagEl.style.left = Math.max(2, left) + "px";
    tagEl.style.top = Math.max(2, top) + "px";
  }
  function syncShotPointer() {
    var p = layoutToView(toScreen(M.pointAt(M.angleOfBeat(shotPointer.b, pageStart(), ed.bpp), M.laneRadius(shotPointer.lane))));
    if (Math.abs(p.x - pointer.px) < 0.5 && Math.abs(p.y - pointer.py) < 0.5 && pointer.inside) return;
    pointer = pointerAt(p.x, p.y);
    updateHover();
  }

  // ================= 키보드 =================
  function isTyping(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName;
    if (t === "TEXTAREA" || t === "SELECT" || el.isContentEditable) return true;
    if (t === "INPUT") return ["checkbox", "radio", "range", "button"].indexOf(el.type) < 0;
    return false;
  }
  document.addEventListener("keydown", function (e) {
    var ctrl = e.ctrlKey || e.metaKey;
    if (!modalOpen() && !isTyping(e.target)) litKeys[(ctrl ? "Ctrl+" : "") + (ctrl && e.shiftKey ? "Shift+" : "") + e.code] = true;
    // 브라우저의 "페이지 저장" 창이 뜨지 않게 Ctrl+S는 언제나 막는다
    if (ctrl && e.code === "KeyS") {
      e.preventDefault();
      if (!modalOpen() && !drag) saveChart();
      return;
    }
    if (modalOpen()) { onModalKey(e); return; }
    if (isTyping(e.target) || !chart) return;
    if (rec.on && !ctrl && !e.altKey) {
      var rl = recLaneOf(e.code);
      if (rl !== null) { e.preventDefault(); if (!e.repeat) recDown(e.code, rl); return; }
      if (e.code === "Escape" && !drag) { e.preventDefault(); setRec(false); return; }
    }
    if (ctrl) {
      if (e.code === "KeyZ") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (e.code === "KeyY") { e.preventDefault(); redo(); }
      return;
    }
    if (e.altKey) return;
    // 한글 입력 상태에서도 되도록 글자(e.key)가 아니라 자판 위치(e.code)로 본다
    switch (e.code) {
      case "Digit1": case "Numpad1": setType(TYPE.TAP); break;
      case "Digit2": case "Numpad2": setType(TYPE.LONG); break;
      case "Digit3": case "Numpad3": setType(TYPE.CHASE); break;
      case "Digit4": case "Numpad4": setType(TYPE.HOLDTAP); break;
      case "KeyQ": goPage(ed.page - 1); break;
      case "KeyE": goPage(ed.page + 1); break;
      case "Home": goPage(0); break;
      case "End": goPage(M.pageOfBeat(chart.notes.length ? chart.notes[chart.notes.length - 1].b : 0, ed.bpp)); break;
      case "Space": if (!e.repeat) togglePlay(); break;
      case "Delete": deleteHovered(); break;
      case "KeyA": changeSnap(-1); break;
      case "KeyZ": changeBpp(-1); break;
      case "KeyC": changeBpp(1); break;
      case "KeyD": changeSnap(1); break;
      case "KeyS": if (MODE === "core" && !e.repeat) toggleRivetAtPointer(); break;
      case "Equal": case "NumpadAdd": stepZoom(1); break;
      case "Minus": case "NumpadSubtract": stepZoom(-1); break;
      case "Digit0": case "Numpad0": setZoom(1); break;
      case "KeyR": if (!e.repeat && !drag) setRec(!rec.on); break;
      case "Escape": if (drag) cancelDrag(); break;
      default: return;
    }
    e.preventDefault();
  });
  // 조작키 칸 켜기: 누르고 있는 키·마우스 동작의 칸(data-k)을 강조색으로
  var litKeys = {};
  var litWheelUntil = 0;
  var litSig = "";
  document.addEventListener("keyup", function (e) {
    if (rec.held[e.code]) recUp(e.code);
    Object.keys(litKeys).forEach(function (k) {
      if (k === e.code || k.slice(-e.code.length - 1) === "+" + e.code) delete litKeys[k];
      else if (/^(Control|Meta)/.test(e.code) && k.indexOf("Ctrl+") === 0) delete litKeys[k];
    });
  });
  window.addEventListener("blur", function () { litKeys = {}; if (audio.running) recFlush(recBeatNow()); else rec.held = {}; });
  window.addEventListener("pointerup", function (e) { delete litKeys["M-button" + e.button]; });
  function paintKeys() {
    var on = Object.assign({}, litKeys);
    if (drag) on["M-" + drag.kind] = true;
    if (performance.now() < litWheelUntil) on["M-wheel"] = true;
    if (performance.now() < litZoomUntil) on["M-zoom"] = true;
    var sig = Object.keys(on).sort().join(" ");
    if (sig === litSig) return;
    litSig = sig;
    Array.prototype.forEach.call(document.querySelectorAll("#keys [data-k]"), function (el) {
      el.classList.toggle("on", el.getAttribute("data-k").split(" ").some(function (k) { return on[k]; }));
    });
  }
  // 마우스로 누른 버튼·체크 상자에 초점이 남으면 Space가 그 버튼을 다시 누르므로 초점을 뺀다
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button, input[type=checkbox]");
    if (b && e.detail > 0 && !b.closest(".screen")) b.blur();
  });

  // ================= 왼쪽 도구 =================
  function setType(t) {
    if (ALLOWED.indexOf(t) < 0) { status("건반형에는 " + TYPE_NAMES[t] + " 노트가 없습니다", "warn"); return; }
    if (drag) return;
    ed.type = t;
    refreshPalette();
    updateCursorTag();
    needsDraw = true;
  }
  function changeSnap(dir) {
    if (drag) return;
    var i = clamp(M.SNAPS.indexOf(prefs.div) + dir, 0, M.SNAPS.length - 1);
    setSnap(M.SNAPS[i]);
  }
  function setSnap(div) {
    if (drag) return;
    prefs.div = div;
    savePrefs();
    refreshSeg($("snap-seg"), div);
    status("스냅 1/" + div + "박");
    updateCursorTag();
    needsDraw = true;
  }
  // Z · C: 한 바퀴 박자 수를 한 단계 줄이기 · 늘리기(4 · 8 · 12 · 16박)
  function changeBpp(dir) {
    if (drag || !chart) return;
    var i = clamp(M.PAGE_BEATS.indexOf(ed.bpp) + dir, 0, M.PAGE_BEATS.length - 1);
    if (M.PAGE_BEATS[i] === ed.bpp) return;
    setBpp(M.PAGE_BEATS[i]);
    status("한 바퀴 " + ed.bpp + "박");
  }
  function setBpp(v) {
    if (drag || !chart) return;
    var anchor = audio.running ? currentBeat() : playBeat;
    ed.bpp = v;
    ed.page = clamp(M.pageOfBeat(Math.max(0, anchor), v), 0, lastPage());
    refreshSeg($("bpp-seg"), v);
    onPageChanged();
  }
  function buildSeg(el, items, onPick) {
    el.innerHTML = "";
    items.forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      b.dataset.v = String(it.v);
      if (it.title) b.title = it.title;
      b.addEventListener("click", function () { onPick(it.v); });
      el.appendChild(b);
    });
  }
  function refreshSeg(el, cur) {
    Array.prototype.forEach.call(el.children, function (b) { b.classList.toggle("on", b.dataset.v === String(cur)); });
  }
  function refreshPalette() {
    Array.prototype.forEach.call(document.querySelectorAll(".type-btn"), function (b) {
      var t = parseInt(b.dataset.type, 10);
      b.classList.toggle("on", t === ed.type);
      b.disabled = ALLOWED.indexOf(t) < 0;
    });
  }
  function setupTools() {
    Array.prototype.forEach.call(document.querySelectorAll(".type-btn"), function (b) {
      var t = parseInt(b.dataset.type, 10);
      b.addEventListener("click", function () { setType(t); });
      if (ALLOWED.indexOf(t) < 0) b.title = "건반형에는 없는 노트입니다";
    });
    if (MODE === "lanes") {
      $("holdtap-note").textContent = "건반형 없음";
      $("chase-note").textContent = "건반형 없음";
      $("iv-field").style.display = "none";
      $("key-i").style.display = "none";
      $("key-i-desc").style.display = "none";
    }
    buildSeg($("snap-seg"), M.SNAPS.map(function (d) { return { v: d, label: "1/" + d, title: "한 박을 " + d + "칸으로" }; }), setSnap);
    buildSeg($("bpp-seg"), M.PAGE_BEATS.map(function (d) { return { v: d, label: d + "박" }; }), setBpp);
    buildSeg($("iv-seg"), IV_OPTS.map(function (d) { return { v: d, label: d ? M.fmtBeat(d) + "박" : "없음", title: d ? "새 홀드앤탭에 " + M.fmtBeat(d) + "박마다 리벳을 채운다" : "리벳 없이 만든다" }; }), function (v) {
      prefs.fill = v;
      savePrefs();
      refreshSeg($("iv-seg"), v);
      status(v ? "새 홀드앤탭에 리벳을 " + M.fmtBeat(v) + "박마다 채웁니다(하나씩은 몸통 위에서 S 또는 휠클릭)" : "새 홀드앤탭을 리벳 없이 만듭니다(몸통 위에서 S 또는 휠클릭으로 넣기)");
    });
    buildSeg($("rate-seg"), [1, 0.75, 0.5].map(function (r) { return { v: r, label: r === 1 ? "1.0배" : r + "배" }; }), function (r) {
      prefs.rate = r;
      savePrefs();
      refreshSeg($("rate-seg"), r);
      if (audio.running) startPlaybackAt(currentBeat());
    });
    refreshSeg($("snap-seg"), prefs.div);
    refreshSeg($("iv-seg"), prefs.fill);
    refreshSeg($("rate-seg"), prefs.rate);
    $("volume").value = prefs.volume;
    $("volume").addEventListener("input", function () {
      prefs.volume = parseFloat(this.value);
      if (audio.master) audio.master.gain.value = prefs.volume;
      savePrefs();
    });
    $("chk-tick").checked = prefs.tick;
    $("chk-metro").checked = prefs.metro;
    $("chk-tick").addEventListener("change", function () { prefs.tick = this.checked; savePrefs(); });
    $("chk-metro").addEventListener("change", function () { prefs.metro = this.checked; savePrefs(); });
    $("btn-prev").addEventListener("click", function () { goPage(ed.page - 1); });
    $("btn-next").addEventListener("click", function () { goPage(ed.page + 1); });
    $("btn-play").addEventListener("click", togglePlay);
    $("btn-offset-here").addEventListener("click", offsetHere);
    $("btn-bpm-auto").addEventListener("click", autoDetectBpm);
    $("btn-auto-apply").addEventListener("click", applyAutoBpm);
    $("auto-cands").addEventListener("click", function (e) {
      var b = e.target.closest("[data-bpm]");
      if (!b) return;
      autoBpm = parseFloat(b.getAttribute("data-bpm"));
      renderAutoBpm();
    });
    refreshPalette();
  }
  function updatePlayButton() {
    $("btn-play").textContent = audio.running ? "❚❚ 멈춤" : "▶ 재생";
    var msg = $("stage-msg");
    msg.textContent = rec.on ? (audio.running ? "● 실시간 입력 중 · " + recKeysText() + "로 치기 · Space 멈춤" : "● 실시간 입력 켜짐 · Space로 재생하며 " + recKeysText() + "로 치기 · R 끄기")
      : audio.running ? "재생 중 · 편집하려면 Space로 멈추세요" : "";
    msg.classList.toggle("show", audio.running || rec.on);
    msg.classList.toggle("rec", rec.on);
  }
  var pageInfoText = "";
  function refreshPageInfo() {
    if (!chart) { $("page-info").textContent = ""; return; }
    var ps = pageStart();
    var cb = currentBeat();
    var html = "페이지 <b>" + (ed.page + 1) + "</b> / " + (lastPage() + 1) + "<br>" +
      M.fmtBeat(ps) + "–" + M.fmtBeat(ps + ed.bpp) + "박 · " + M.fmtTime(timeOfBeat(ps)) + "<br>" +
      "재생 위치 " + M.fmtBeat(M.round4(Math.round(cb * 100) / 100)) + "박 · " + M.fmtTime(timeOfBeat(cb));
    if (html !== pageInfoText) { pageInfoText = html; $("page-info").innerHTML = html; }
  }
  function updateSongInfo() {
    var el = $("song-info");
    if (!chart) { el.textContent = ""; return; }
    el.classList.toggle("err", !!audio.error);
    if (audio.error) el.textContent = "음원 없음: " + audio.error + " · 소리 없이 시계만 돕니다";
    else if (audio.loading) el.textContent = "음원 불러오는 중… " + audio.file;
    else if (audio.buffer) el.textContent = audio.file + " · " + M.fmtTime(audio.buffer.duration);
    else el.textContent = audio.file;
  }
  function updateBpmInfo() {
    $("bpm-info").textContent = chart ? "지금 BPM " + chart.bpm + " · 오프셋 " + chart.offset.toFixed(3) + "초" : "";
  }

  // ---------- BPM 자동 계산 ----------
  // 음원 전체를 22050Hz 모노로 바꿔(OfflineAudioContext) TDBpm.detect로 잰다. 한 번 잰 곡은 기억해 둔다.
  var bpmCache = {};
  function decodeFile(file) {
    return LIB.loadAudio(file).then(function (buf) {
      var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      return new OAC(2, 44100, 44100).decodeAudioData(buf);
    });
  }
  function monoOf(buffer) {
    var SR = 22050;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var oc = new OAC(1, Math.max(1, Math.ceil(buffer.duration * SR)), SR);
    var src = oc.createBufferSource();
    src.buffer = buffer;
    src.connect(oc.destination);
    src.start();
    return oc.startRendering().then(function (b) { return { samples: b.getChannelData(0), sr: SR }; });
  }
  function detectBpm(file) {
    if (bpmCache[file]) return Promise.resolve(bpmCache[file]);
    var got = audio.file === file && audio.buffer ? Promise.resolve(audio.buffer) : decodeFile(file); // 이미 연 곡이면 다시 해독하지 않는다
    return got.then(monoOf).then(function (m) {
      // "계산 중"이 먼저 화면에 그려지게 한 박자 쉬었다가 계산한다(곡 길이에 따라 1~3초)
      return new Promise(function (resolve) { setTimeout(function () { resolve(TDBpm.detect(m.samples, m.sr)); }, 30); });
    }).then(function (r) {
      if (!r) throw new Error("곡이 너무 짧아 잴 수 없습니다");
      r.file = file;
      bpmCache[file] = r;
      return r;
    });
  }
  function candButtons(r, selected) {
    return r.candidates.map(function (c) {
      return '<button type="button" class="cand' + (c.bpm === selected ? " on" : "") + '" data-bpm="' + c.bpm + '" title="' + c.bpm + ' BPM으로">' + c.bpm + "</button>";
    }).join("");
  }
  // 에디터 안 BPM 도우미: 열린 채보의 음원으로 잰다. 적용을 눌러야 채보가 바뀐다(되돌리기 가능).
  var autoRes = null;
  var autoBpm = null;
  var autoBusy = false; // 계산 중에는 다른 화면 갱신이 "계산 중" 표시를 지우지 않게
  function renderAutoBpm() {
    if (autoBusy) {
      $("auto-bpm").innerHTML = "<small>계산 중…</small>";
      $("auto-cands").innerHTML = "";
      $("btn-auto-apply").disabled = true;
      $("btn-bpm-auto").disabled = true;
      return;
    }
    var fresh = autoRes && chart && autoRes.file === chart.song;
    $("auto-bpm").innerHTML = fresh ? autoBpm + " <small>(신뢰도 " + autoRes.confidence + ")</small>" : "–";
    $("auto-cands").innerHTML = fresh ? candButtons(autoRes, autoBpm) : "";
    $("btn-auto-apply").disabled = !fresh || !autoBpm;
  }
  function autoDetectBpm() {
    if (!chart || !chart.song) { status("이 채보에는 음원이 지정되지 않았습니다", "warn"); return; }
    autoBusy = true;
    renderAutoBpm();
    detectBpm(chart.song).then(function (r) {
      autoBusy = false;
      autoRes = r;
      autoBpm = r.bpm;
      renderAutoBpm();
      status("추정 BPM " + r.bpm + "(신뢰도 " + r.confidence + ", 지금 " + chart.bpm + "). 반·두 배로 잡혔으면 아래 후보를 누른 뒤 적용하세요", "ok");
    }).catch(function (e) {
      autoBusy = false;
      renderAutoBpm();
      $("auto-bpm").innerHTML = "<small>실패</small>";
      status("BPM을 계산하지 못했습니다: " + ((e && e.message) || e), "warn");
    }).then(function () { $("btn-bpm-auto").disabled = !chart; });
  }
  function applyAutoBpm() {
    if (!chart || !autoBpm) return;
    var before = snapshot();
    chart.bpm = autoBpm;
    history.record(before);
    afterEdit();
    refreshAll();
    status("BPM을 " + autoBpm + "(으)로 바꿨습니다. 노트는 박자 위치 그대로입니다. 메트로놈을 켜고 들어 보세요", "ok");
  }

  // 오프셋 = 지금 재생 위치: 지금 들리는 자리를 0박으로 삼는다(재생 중이면 그 순간, 멈춰 있으면 멈춘 자리)
  function offsetHere() {
    if (!chart || drag) return;
    var t = audio.running ? audio.songNow() : timeOfBeat(playBeat);
    if (!isFinite(t)) return;
    var before = snapshot();
    chart.offset = Math.round(t * 1000) / 1000;
    history.record(before);
    if (audio.running) {
      // 재생 위치를 새 기준으로 다시 잡는다(초 위치는 그대로)
      afterEdit();
    } else {
      playBeat = 0;
      ed.page = 0;
      afterEdit();
    }
    refreshAll();
    status("오프셋을 " + chart.offset.toFixed(3) + "초로 맞췄습니다(이 자리가 0박). 노트는 박자 위치 그대로입니다", "ok");
  }

  // ================= 검사 =================
  function revalidate() {
    issues = chart ? TDChart.validateChart(chart) : [];
    issueOf = {};
    issues.forEach(function (w) { if (w.level === "error" || !issueOf[w.index]) issueOf[w.index] = w.level; });
    chords = chart && MODE === "lanes" ? M.findChords(chart.notes) : {};
    renderIssues();
  }
  function renderIssues() {
    var errs = issues.filter(function (w) { return w.level === "error"; }).length;
    var warns = issues.length - errs;
    var cnt = $("val-count");
    var chip = $("val-chip");
    var label = !chart ? "" : issues.length ? (errs ? "오류 " + errs : "") + (errs && warns ? " · " : "") + (warns ? "경고 " + warns : "") : "문제 없음";
    cnt.textContent = label;
    cnt.className = errs ? "err" : warns ? "warn" : "";
    chip.textContent = chart ? "검사 · " + label : "";
    chip.className = errs ? "err" : warns ? "warn" : "";
    chip.style.display = chart ? "" : "none";
    var list = $("val-list");
    list.innerHTML = "";
    if (!chart) return;
    if (!issues.length) {
      list.innerHTML = '<li class="empty">게임 규칙으로 칠 수 없는 배치가 없습니다.</li>';
      return;
    }
    var sorted = issues.slice().sort(function (a, b) { return a.index - b.index || (a.level === "error" ? -1 : 1); });
    sorted.slice(0, 300).forEach(function (w) {
      var n = chart.notes[w.index];
      if (!n) return;
      var li = document.createElement("li");
      li.className = w.level;
      li.innerHTML = "<b>" + esc(M.fmtBeat(n.b)) + "박</b> · " + laneText(n.lane) + " · " + esc(TYPE_NAMES[n.type]) + "<br>" + esc(w.msg);
      li.title = "눌러서 이 노트가 있는 페이지로";
      li.addEventListener("click", function () { jumpToNote(w.index); });
      list.appendChild(li);
    });
    if (sorted.length > 300) {
      var more = document.createElement("li");
      more.className = "empty";
      more.textContent = "…외 " + (sorted.length - 300) + "건";
      list.appendChild(more);
    }
  }
  function jumpToNote(i) {
    var n = chart.notes[i];
    if (!n) return;
    var p = M.pageOfBeat(n.b, ed.bpp);
    if (audio.running) seekBeat(M.pageStartOf(p, ed.bpp));
    else goPage(p);
    ed.flash = { index: i, until: performance.now() + 1400 };
    needsDraw = true;
  }

  // ================= 상단 막대·알림 =================
  function status(text, kind) {
    var el = $("status");
    el.textContent = text;
    el.className = kind || "";
  }
  function updateDirty() {
    dirty = !!chart && JSON.stringify(chart) !== savedJson;
    $("dirty").classList.toggle("on", dirty);
    document.title = (dirty ? "● " : "") + (chart ? chart.title + " · " : "") + "채보 에디터";
  }
  // 위쪽 막대 채보 바꾸기: 이 목업의 채보 목록(곡별 묶음). 고르면 저장 안 한 변경을 확인한 뒤 연다(09-30, 사용자).
  var switchSig = "";
  function refreshSwitch() {
    var sel = $("chart-switch");
    var list = (lib && lib.charts ? lib.charts : []).slice().sort(function (a, b) {
      return a.title.localeCompare(b.title) || TDChart.difficultyIndex(a.difficulty) - TDChart.difficultyIndex(b.difficulty) || a.level - b.level;
    });
    var sig = list.map(function (c) { return c.id + "|" + c.title + "|" + c.difficulty + "|" + c.level; }).join(",") + "#" + (chart ? chart.id : "");
    sel.hidden = !list.length;
    if (sig === switchSig) return;
    switchSig = sig;
    var html = chart && !list.some(function (c) { return c.id === chart.id; }) ? '<option value="">(저장 전 채보)</option>' : ""; // 새로 만들어 아직 목록에 없는 채보
    var song = null;
    list.forEach(function (c) {
      if (c.songId !== song) { if (song !== null) html += "</optgroup>"; song = c.songId; html += '<optgroup label="' + esc(c.title) + '">'; }
      html += '<option value="' + esc(c.id) + '">' + esc(c.title + " · " + TDChart.difficultyLabel(c.difficulty) + " " + TDChart.levelText(c.level)) + "</option>";
    });
    if (song !== null) html += "</optgroup>";
    sel.innerHTML = html;
    sel.value = chart ? chart.id : "";
  }
  $("chart-switch").addEventListener("change", function () {
    var sel = this;
    var c = findChart(sel.value);
    sel.blur(); // 단축키가 목록 상자로 가지 않게
    if (!c || (chart && c.id === chart.id)) { sel.value = chart ? chart.id : ""; return; }
    sel.value = chart ? chart.id : ""; // 확인 전에는 지금 채보를 보인다(취소하면 그대로)
    guardDirty(function () { openChart(c); });
  });
  function refreshTitle() {
    $("mode-chip").textContent = MODE_LABEL;
    refreshSwitch();
    if (!chart) {
      $("chart-title").textContent = "채보 없음";
      $("chart-sub").textContent = "";
      $("chart-id").textContent = "";
    } else {
      $("chart-title").textContent = chart.title;
      $("chart-sub").textContent = TDChart.difficultyLabel(chart.difficulty) + " " + TDChart.levelText(chart.level);
      $("chart-id").textContent = chart.id + ".json";
    }
    refreshOfficial();
    updateDirty();
  }
  function refreshButtons() {
    var has = !!chart;
    $("btn-rec").disabled = !has;
    if (!has && rec.on) setRec(false);
    $("btn-info").disabled = !has;
    $("btn-save").disabled = !has;
    $("btn-test").disabled = !has;
    $("btn-delete").disabled = !has || !ONLINE;
    $("btn-delete").title = ONLINE ? "채보 파일을 지웁니다(charts/_deleted/로 옮김)" : "서버 없이 열려 있어 지울 수 없습니다";
    $("btn-save").textContent = ONLINE ? "저장" : "JSON 내려받기";
    $("btn-save").title = ONLINE ? "Ctrl+S" : "서버 없이 열려 있어 파일로 내려받습니다 (Ctrl+S)";
    $("btn-offset-here").disabled = !has;
    $("btn-bpm-auto").disabled = !has;
    renderAutoBpm();
    $("offline-chip").hidden = ONLINE;
  }
  function refreshAll() {
    refreshTitle();
    refreshButtons();
    refreshPalette();
    refreshSeg($("bpp-seg"), ed.bpp);
    refreshSeg($("snap-seg"), prefs.div);
    refreshPageInfo();
    updateSongInfo();
    updateBpmInfo();
    updatePlayButton();
    renderIssues();
    needsDraw = true;
    needsTimeline = true;
  }

  // ================= 채보 열기·저장·삭제 =================
  function findChart(id) {
    for (var i = 0; i < lib.charts.length; i++) if (lib.charts[i].id === id) return lib.charts[i];
    return null;
  }
  function upsertLib(c) {
    var copy = JSON.parse(JSON.stringify(c));
    var i = 0;
    while (i < lib.charts.length && lib.charts[i].id !== c.id) i++;
    lib.charts[i] = copy; // 없으면 끝에 더한다
    refreshSwitch();
  }
  function openChart(c) {
    if (audio.running) stopPlayback();
    drag = null;
    chart = JSON.parse(JSON.stringify(c));
    chart.mode = MODE;
    savedJson = JSON.stringify(chart);
    backupJson = "";
    history.clear();
    ed.bpp = M.defaultBeatsPerPage(chart.degPerBeat);
    ed.page = 0;
    ed.hover = -1;
    ed.flash = null;
    playBeat = 0;
    forcedHover = -1;
    try { localStorage.setItem(LAST_KEY, chart.id); } catch (e) { /* 무시 */ }
    revalidate();
    refreshAll();
    loadSong(chart.song);
    status("열었습니다 · " + MODE_DIR + "/charts/" + chart.id + ".json · 노트 " + chart.notes.length + "개");
  }
  // 저장하지 않은 변경이 있으면 먼저 묻는다. 버리기로 하면 그 채보의 자동 저장 백업도 지운다.
  function guardDirty(then) {
    if (!dirty) { then(); return; }
    confirmBox("저장하지 않은 변경이 있습니다. 버리고 계속할까요?", "버리고 계속").then(function (ok) {
      if (!ok) return;
      if (chart) dropBackup(chart.id);
      then();
    });
  }

  // ---- 자동 저장(백업) ----
  // 5분마다, 저장하지 않은 변경이 있으면 채보 파일과 따로 백업한다(서버: charts/_autosave/<id>.json, 서버 없이: 브라우저 저장소).
  // 저장하거나 변경을 버리면 백업을 지운다. 남은 백업은 다음에 에디터를 켤 때 처리(불러오기·삭제·보류)를 묻는다.
  var AUTOSAVE_MS = (numParam("autosave") > 0 ? numParam("autosave") : 300) * 1000; // 주소 값 autosave=<초>는 점검용
  var backupJson = ""; // 마지막으로 백업한 내용(같으면 다시 쓰지 않는다)
  function clockText(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "?";
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return (d.getMonth() + 1) + "월 " + d.getDate() + "일 " + p2(d.getHours()) + ":" + p2(d.getMinutes());
  }
  function backupPlace(id) { return ONLINE ? MODE_DIR + "/charts/_autosave/" + id + ".json" : "브라우저 저장소"; }
  function autoSave() {
    if (!chart || !dirty || drag) return;
    var s = JSON.stringify(chart);
    if (s === backupJson) return;
    var id = chart.id;
    LIB.saveBackup(MODE, JSON.parse(s)).then(function (at) {
      backupJson = s;
      status("자동 저장(백업) " + clockText(at) + " · " + backupPlace(id) + " · 채보 파일에는 저장(Ctrl+S)해야 들어갑니다", "ok");
    }).catch(function (e) {
      status("자동 저장하지 못했습니다: " + (e && e.message ? e.message : e), "warn");
    });
  }
  function dropBackup(id) {
    backupJson = "";
    LIB.deleteBackup(MODE, id).catch(function () { /* 다음 시작 때 다시 묻는다 */ });
  }
  // 백업 불러오기: 백업 내용으로 채보를 연다. 원본 파일과 다르면 "저장 안 함(●)" 상태.
  function openBackup(bk) {
    var c = TDChart.normalizeChart(bk.chart, bk.id);
    c.id = bk.id;
    c.mode = MODE;
    var orig = findChart(bk.id);
    openChart(c);
    if (orig) {
      var o = JSON.parse(JSON.stringify(orig));
      o.mode = MODE;
      savedJson = JSON.stringify(o);
    } else savedJson = ""; // 원본 파일이 없다(지웠거나 서버 없이 만든 채보)
    backupJson = JSON.stringify(chart);
    updateDirty();
    status("백업(" + clockText(bk.savedAt) + ")을 불러왔습니다 · 채보 파일에는 저장(Ctrl+S)해야 들어갑니다" + (orig ? "" : " · 원본 파일 없음"), "ok");
  }
  // 시작할 때 남은 백업마다 처리를 묻는다. 모두 고르면 닫힌다. 불러온 백업이 있으면 true.
  function checkBackups() {
    return LIB.listBackups(MODE).catch(function () { return []; }).then(function (list) {
      if (!list.length) return false;
      return new Promise(function (resolve) {
        var loaded = false;
        var left = list.length;
        var box = $("backup-list");
        box.innerHTML = "";
        function done(row) {
          row.classList.add("done");
          Array.prototype.forEach.call(row.querySelectorAll("button"), function (b) { b.disabled = true; });
          if (--left === 0) { hideModal("dlg-backup"); resolve(loaded); }
        }
        list.forEach(function (bk) {
          var c = bk.chart || {};
          var orig = findChart(bk.id);
          var row = document.createElement("div");
          row.className = "backup-row";
          row.innerHTML = '<div class="bk-info"><b>' + esc(c.title || bk.id) + "</b> <span>" + esc(TDChart.difficultyLabel(c.difficulty) + " " + TDChart.levelText(c.level)) + "</span>" +
            "<small>백업 " + esc(clockText(bk.savedAt)) + " · 노트 " + ((c.notes || []).length) + "개" +
            (orig ? " (저장된 파일 " + orig.notes.length + "개)" : " · 원본 파일 없음") + " · " + esc(bk.id) + ".json</small></div>" +
            '<button class="btn small primary" data-act="load">불러오기</button><button class="btn small danger" data-act="del">삭제</button><button class="btn small" data-act="hold">보류</button>' +
            '<span class="bk-result"></span>';
          row.addEventListener("click", function (e) {
            var b = e.target.closest("button[data-act]");
            if (!b || b.disabled) return;
            var act = b.getAttribute("data-act");
            var result = row.querySelector(".bk-result");
            if (act === "load") {
              openBackup(bk);
              loaded = true;
              result.textContent = "불러옴";
              // 채보는 한 번에 하나만 열 수 있다
              Array.prototype.forEach.call(box.querySelectorAll('button[data-act="load"]'), function (x) { x.disabled = true; x.title = "채보는 한 번에 하나만 열 수 있습니다"; });
              done(row);
            } else if (act === "del") {
              b.disabled = true;
              LIB.deleteBackup(MODE, bk.id).then(function () { result.textContent = "삭제함"; done(row); })
                .catch(function (err) { b.disabled = false; result.textContent = "지우지 못함: " + (err && err.message ? err.message : err); });
            } else {
              result.textContent = "보류(다음에 다시 묻습니다)";
              done(row);
            }
          });
          box.appendChild(row);
        });
        showModal("dlg-backup");
      });
    });
  }
  function saveChart() {
    if (!chart) return Promise.resolve(false);
    if (drag) return Promise.resolve(false);
    if (!ONLINE) { downloadJson(); return Promise.resolve(false); }
    var sent = JSON.stringify(chart);
    var id = chart.id;
    status("저장 중…");
    return LIB.saveChart(MODE, JSON.parse(sent)).then(function () {
      savedJson = sent;
      upsertLib(JSON.parse(sent));
      updateDirty();
      dropBackup(id);
      status("저장했습니다 · Mockups/" + MODE_DIR + "/charts/" + id + ".json", "ok");
      return true;
    }).catch(function (e) {
      status("저장하지 못했습니다: " + (e && e.message ? e.message : e), "err");
      return false;
    });
  }
  function downloadJson() {
    var blob = new Blob([TDChart.stringifyChart(chart)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = chart.id + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    savedJson = JSON.stringify(chart);
    updateDirty();
    dropBackup(chart.id);
    status("서버 없이 열려 있어 " + chart.id + ".json 파일로 내려받았습니다. Mockups/" + MODE_DIR + "/charts/ 폴더에 넣으세요", "warn");
  }
  function testPlay() {
    if (!chart) return;
    var from = M.pageStartOf(audio.running ? M.pageOfBeat(Math.max(0, currentBeat()), ed.bpp) : ed.page, ed.bpp);
    var url = new URL("../" + MODE_DIR + "/index.html?test=" + encodeURIComponent(chart.id) + "&from=" + from, location.href).href;
    // 저장 전 모습까지 게임이 읽을 수 있게 사본도 남긴다(게임 쪽이 쓰면 서버 없이도 테스트 가능)
    try { localStorage.setItem("td-test-chart-" + MODE, JSON.stringify(chart)); } catch (e) { /* 무시 */ }
    // 팝업 차단을 피하려고 누른 순간 빈 탭을 먼저 열고, 저장이 끝나면 주소를 넣는다
    var win = window.open("about:blank", "_blank");
    function go() {
      if (win && !win.closed) win.location.href = url;
      else window.open(url, "_blank");
    }
    if (!ONLINE) {
      go();
      status("서버 없이 열려 있어 저장하지 못했습니다. 게임은 마지막으로 저장된 채보(bundle.js)로 열립니다", "warn");
      return;
    }
    saveChart().then(function (ok) {
      if (ok) { go(); status("저장하고 테스트 플레이를 열었습니다 · " + M.fmtBeat(from) + "박부터", "ok"); }
      else if (win) win.close();
    });
  }
  function deleteChart() {
    if (!chart) return;
    if (!ONLINE) { status("서버 없이 열려 있어 지울 수 없습니다", "warn"); return; }
    var c = chart;
    confirmBox("「" + c.title + " · " + TDChart.difficultyLabel(c.difficulty) + "」 채보를 지울까요? 파일(" + c.id + ".json)은 charts/_deleted/ 폴더로 옮겨집니다.", "지우기").then(function (ok) {
      if (!ok) return;
      LIB.deleteChart(MODE, c.id).then(function () {
        dropBackup(c.id);
        lib.charts = lib.charts.filter(function (x) { return x.id !== c.id; });
        refreshSwitch();
        if (audio.running) stopPlayback();
        chart = null;
        savedJson = "";
        history.clear();
        try { if (localStorage.getItem(LAST_KEY) === c.id) localStorage.removeItem(LAST_KEY); } catch (e) { /* 무시 */ }
        revalidate();
        refreshAll();
        status("지웠습니다 · " + c.id + ".json → charts/_deleted/", "ok");
        showOpen();
      }).catch(function (e) { status("지우지 못했습니다: " + (e && e.message ? e.message : e), "err"); });
    });
  }
  function backToGame() {
    guardDirty(function () {
      dirty = false; // 버리기로 했으니 떠날 때 다시 묻지 않는다
      location.href = "../" + MODE_DIR + "/index.html";
    });
  }

  // ================= 창(모달) =================
  function modalOpen() { return !!document.querySelector(".screen.show"); }
  function showModal(id) { $(id).classList.add("show"); tagEl.classList.remove("show"); if (drag) cancelDrag(); }
  function hideModal(id) { $(id).classList.remove("show"); }
  function onModalKey(e) {
    if ($("dlg-confirm").classList.contains("show")) {
      if (e.code === "Escape") closeConfirm(false);
      else if (e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); closeConfirm(true); }
      return;
    }
    if ($("dlg-form").classList.contains("show")) {
      if (e.code === "Escape") cancelForm();
      else if ((e.code === "Enter" || e.code === "NumpadEnter") && e.target.tagName === "INPUT") { e.preventDefault(); submitForm(); }
      return;
    }
    if ($("dlg-open").classList.contains("show")) {
      if (e.code === "Escape" && chart) hideModal("dlg-open");
      return;
    }
    if ($("dlg-publish").classList.contains("show")) {
      if (e.code === "Escape") hideModal("dlg-publish");
    }
  }
  var confirmResolve = null;
  function confirmBox(text, okLabel) {
    return new Promise(function (resolve) {
      $("confirm-text").textContent = text;
      $("confirm-ok").textContent = okLabel || "확인";
      confirmResolve = resolve;
      showModal("dlg-confirm");
      $("confirm-ok").focus();
    });
  }
  function closeConfirm(v) {
    hideModal("dlg-confirm");
    var r = confirmResolve;
    confirmResolve = null;
    if (r) r(v);
  }
  $("confirm-ok").addEventListener("click", function () { closeConfirm(true); });
  $("confirm-cancel").addEventListener("click", function () { closeConfirm(false); });

  // ---- 실시간 입력(09-30, 팀원 피드백) ----
  // 켜 두고(R · 「실시간 입력」) 재생하면서 게임처럼 치면 그 순간에 노트가 들어간다. 세부 타이밍은 멈춘 뒤 마우스로 다듬는다.
  // 건반형: 게임의 레인 키(설정에서 바꾼 키 포함). 에임형: 커서가 가리키는 고리 + Z · X 또는 좌 · 우클릭(게임과 같다).
  // 박자 = 누른 순간의 곡 시각 - 게임의 싱크 오프셋(유형별 설정값) → 지금 스냅에 맞춤. 스냅 한 칸 이상 누르고 있으면 롱.
  // 한 번 재생(시작 ~ 멈춤)에 넣은 노트는 Ctrl+Z 한 번으로 되돌린다.
  var rec = { on: false, held: {}, before: null, count: 0 };
  var REC_LONG_SEC = 0.2; // 이만큼(초) 이상 누르고 있어야 롱. 잘게 나눈 스냅에서 보통 탭이 롱이 되지 않게
  var GAME_SETTINGS_KEY = MODE === "lanes" ? "td-rhythm-lanes-v1" : "td-rhythm-mockup-v1";
  function recOffsetSec() {
    try {
      var s = JSON.parse(localStorage.getItem(GAME_SETTINGS_KEY) || "null");
      if (s && typeof s.offsetMs === "number" && isFinite(s.offsetMs)) return s.offsetMs / 1000;
    } catch (e) { /* 저장소를 못 쓰면 0 */ }
    return 0;
  }
  function recBeatNow() { return beatOfTime(audio.songNow() - recOffsetSec()); }
  // 이 키가 노트 입력 키면 레인(에임형은 "aim" = 커서 고리), 아니면 null
  function recLaneOf(code) {
    if (MODE === "lanes") { var i = laneCodes.indexOf(code); return i >= 0 ? i : null; }
    return code === "KeyZ" || code === "KeyX" ? "aim" : null;
  }
  function recKeysText() { return MODE === "lanes" ? laneKeys.join(" ") : "커서 + Z · X(좌 · 우클릭)"; }
  function setRec(on) {
    if (on && !chart) return;
    recFlush();
    rec.on = on;
    rec.before = null;
    rec.count = 0;
    $("btn-rec").classList.toggle("on", on);
    $("btn-rec").textContent = on ? "● 실시간 입력 끄기 (R)" : "● 실시간 입력 (R)";
    document.body.classList.toggle("rec", on);
    updatePlayButton();
    status(on ? "실시간 입력 켬 · Space로 재생하면서 " + recKeysText() + "로 치면 노트가 들어갑니다(스냅 1/" + prefs.div + "박에 맞춤, 0.2초 넘게 누르면 롱) · R · Esc로 끄기"
      : "실시간 입력 끔");
  }
  function recDown(code, lane) {
    if (!audio.running) { status("실시간 입력: Space로 재생하면서 누르세요", "warn"); return; }
    if (lane === "aim") {
      if (!pointer.inside) { status("실시간 입력: 커서를 시계 판 위 고리에 두고 누르세요", "warn"); return; }
      lane = M.nearestLane(pointer.r);
    }
    rec.held[code] = { b: recBeatNow(), lane: lane };
  }
  function recUp(code, upBeat) {
    var h = rec.held[code];
    if (!h) return;
    delete rec.held[code];
    if (!chart) return;
    var n = M.recordedNote(chart.notes, h.b, upBeat === undefined ? recBeatNow() : upBeat, h.lane, prefs.div, REC_LONG_SEC / spb());
    if (!n) { status("실시간 입력: 같은 레인에 노트가 있어 넣지 않았습니다 · " + M.fmtBeat(M.snapBeat(h.b, prefs.div)) + "박 " + laneText(h.lane), "warn"); return; }
    if (!rec.before) { rec.before = snapshot(); history.record(rec.before); } // 이번 재생에서 처음 넣을 때만 되돌리기 기록
    chart.notes.push(n);
    var idx = afterEdit(n);
    ed.flash = { index: idx, until: performance.now() + 500 };
    rec.count++;
    status("실시간 입력 · " + TYPE_NAMES[n.type] + " " + describeNote(n) + " · 이번 재생 " + rec.count + "개(Ctrl+Z 한 번에 되돌리기)", "ok");
  }
  // 누르고 있던 키를 지금(재생 중이면 지금 박자, 아니면 멈춘 자리)에서 뗀 것으로 친다
  function recFlush(atBeat) {
    Object.keys(rec.held).forEach(function (code) { recUp(code, atBeat); });
  }
  $("btn-rec").addEventListener("click", function () { setRec(!rec.on); });

  // ---- 권한 ----
  // 에디터는 관리자 이상 계정만 연다. 로그인은 메인 화면(index.html)에서 하고, 같은 브라우저면 이어진다(shared/account.js).
  // 확인하는 동안과 막혔을 때는 권한 창을 띄워 두고 멈춘다. 스크린샷 도우미(shot&unlock=1)는 확인 없이 연다.
  function gate() {
    if (SHOT && params.get("unlock") === "1") return Promise.resolve();
    showModal("dlg-gate");
    function stop(msg) {
      $("gate-msg").textContent = msg;
      return new Promise(function () { /* 멈춘다 */ });
    }
    return TDAccount.current().then(function (acc) {
      if (TDAccount.isAdmin(acc)) { account = acc; hideModal("dlg-gate"); loadOfficial(); return; }
      return stop(acc ? acc.name + " 계정(" + TDAccount.ROLE_LABEL[acc.role] + ")으로는 열 수 없습니다. 에디터는 관리자 이상만 씁니다."
        : "로그인하지 않았습니다. 메인 화면(목업 고르는 첫 화면)에서 관리자 이상 계정으로 로그인한 뒤 다시 여세요.");
    }, function (e) { return stop(TDAccount.errorText(e)); });
  }
  $("gate-back").addEventListener("click", function () { location.href = "../" + MODE_DIR + "/index.html"; });

  // ---- 공식 게시 · 소유자에게 보내기 ----
  // 소유자: 지금 채보를 공식으로 게시한다(서버에 새 버전, 이전 버전은 old로 남고 랭킹 초기화는 고를 수 있다).
  // 관리자: 지금 채보를 소유자에게 보낸다(관리자 화면의 받은 채보 요청). 공식 여부는 채보 id로 서버의 지금 버전과 맞춘다.
  var account = null; // gate에서 확인한 관리자 이상 계정(스크린샷 도우미로 열면 null)
  var officialRows = {}; // 채보 id → 서버의 지금 버전 공식 채보 { id, version, published_at }
  function loadOfficial() {
    if (!account) return;
    loadServerSongs();
    TDAccount.loadOfficialCharts(MODE).then(function (rows) {
      officialRows = {};
      (rows || []).forEach(function (r) { officialRows[r.chart_id] = r; });
      refreshOfficial();
    }, function (e) { status("공식 채보 목록을 받지 못했습니다: " + TDAccount.errorText(e), "warn"); });
  }
  function refreshOfficial() {
    refreshDeploy();
    refreshSongServer();
    var chip = $("official-chip");
    var btn = $("btn-publish");
    var owner = TDAccount.isOwner(account);
    btn.hidden = !account || !chart;
    chip.hidden = !account || !chart;
    if (!account || !chart) return;
    var row = officialRows[chart.id];
    chip.textContent = row ? "공식 v" + row.version : "커스텀";
    chip.title = row ? "서버에 게시된 공식 채보(" + new Date(row.published_at).toLocaleString("ko-KR") + "). 파일을 고쳤다면 다시 게시해야 게임에 반영됩니다" : "서버에 게시되지 않은 채보(이 기기에만 있음, 랭킹 없음)";
    chip.classList.toggle("on", !!row);
    btn.textContent = owner ? (row ? "공식 다시 게시" : "공식 게시") : "소유자에게 보내기";
  }
  // 배포에 포함(채보 파일 deploy 칸, 기본 꺼짐): 배포본(GitHub Pages)에 넣을 커스텀 채보를 고른다. 저장해야 파일에 남는다.
  // 배포 사본은 tools/deploy.js가 이 칸이 켜진 채보만으로 만든다. 공식 채보는 서버에서 받으므로 고를 수 없다.
  function refreshDeploy() {
    var box = $("deploy-box");
    var check = $("deploy-check");
    box.hidden = !chart;
    if (!chart) return;
    var off = !!officialRows[chart.id];
    check.checked = !!chart.deploy;
    check.disabled = off;
    box.classList.toggle("on", !!chart.deploy && !off);
    box.classList.toggle("off", off);
    box.title = off ? "공식 채보는 서버에서 받으므로 배포본에 넣지 않습니다"
      : chart.deploy ? "배포할 때 이 채보를 배포본(GitHub Pages)에 넣습니다. 저장해야 파일에 남습니다"
      : "배포본에 넣지 않습니다(로컬 곡 선택에 「미배포」). 켜고 저장하면 배포할 때 넣습니다";
  }
  $("deploy-check").addEventListener("change", function () {
    if (!chart || drag) { refreshDeploy(); return; }
    var before = snapshot();
    chart.deploy = $("deploy-check").checked;
    history.record(before);
    updateDirty();
    refreshDeploy();
    this.blur(); // 단축키(Space 등)가 체크 칸으로 가지 않게
    status(chart.deploy ? "배포에 포함했습니다 · 저장하면 파일에 남습니다" : "배포에서 뺐습니다 · 저장하면 파일에 남습니다");
  });
  // 서버 음원(소유자): 이 채보의 음원이 서버에 있는지 보이고, 이 기기의 음원을 곡마다 새 열쇠로 암호화해 올린다(09-30).
  // 저장소 파일 이름은 영문 곡 id(채보 songId) + .bin. 공개 페이지는 이 음원을 받아 재생한다(shared/library.js).
  var serverSongs = {}; // 곡 파일 이름 → { object_path, size, uploaded_at }
  var songUploading = false;
  function loadServerSongs() {
    if (!account || !TDAccount.isOwner(account)) return;
    TDAccount.listSongs().then(function (rows) {
      serverSongs = {};
      (rows || []).forEach(function (r) { serverSongs[r.song_file] = r; });
      refreshSongServer();
    }, function (e) { status("서버 음원 목록을 받지 못했습니다: " + TDAccount.errorText(e), "warn"); });
  }
  function songObjectPath(c) { return TDChart.slug(c.songId || c.song) + ".bin"; }
  function refreshSongServer() {
    var show = !!(account && TDAccount.isOwner(account) && chart && chart.song);
    $("song-server-row").hidden = !show;
    if (!show) return;
    var r = serverSongs[chart.song];
    var el = $("song-server");
    el.className = r ? "" : "none";
    el.textContent = r ? "서버 음원 있음 · " + new Date(r.uploaded_at).toLocaleDateString("ko-KR") + " · " + (r.size / 1048576).toFixed(1) + "MB"
      : "서버 음원 없음(공개 페이지에서 재생 안 됨)";
    el.title = r ? "저장소 " + r.object_path : "";
    $("btn-song-upload").textContent = songUploading ? "올리는 중…" : r ? "다시 올리기" : "음원 올리기";
    $("btn-song-upload").disabled = songUploading;
  }
  $("btn-song-upload").addEventListener("click", function () {
    if (!chart || !chart.song || songUploading) return;
    var file = chart.song;
    var path = songObjectPath(chart);
    var cfg = window.TD_CONFIG || {};
    LIB.loadLocalAudio(file).then(function (bytes) {
      var again = !!serverSongs[file];
      return confirmBox((cfg.serverShown ? "[" + cfg.serverName + "] " : "") + file + "(" + (bytes.byteLength / 1048576).toFixed(1) + "MB)을 곡 열쇠로 암호화해 서버에 " +
        (again ? "다시 올립니다(열쇠도 새로 바뀝니다)" : "올립니다") + ". 저장소 이름 " + path + ". 승인된 플레이어가 공개 페이지에서 받아 재생합니다.", again ? "다시 올리기" : "올리기").then(function (ok) {
        if (!ok) return;
        songUploading = true;
        refreshSongServer();
        status("음원을 암호화해 올리는 중… " + file);
        return TDAccount.uploadSong(file, bytes, path).then(function () {
          status("서버에 음원을 올렸습니다 · " + file + " → " + path, "ok");
        }, function (e) {
          status("음원을 올리지 못했습니다: " + TDAccount.errorText(e), "err");
        }).then(function () {
          songUploading = false;
          loadServerSongs();
          refreshSongServer();
        });
      });
    }, function (e) { status("올릴 음원을 읽지 못했습니다: " + (e && e.message ? e.message : e), "err"); });
  });
  function chartData() {
    var data = JSON.parse(TDChart.stringifyChart(chart));
    data.id = chart.id;
    data.mode = MODE;
    return data;
  }
  function openPublish() {
    if (!chart || !account) return;
    if (issues.some(function (w) { return w.level === "error"; })) { status("검사 오류가 있는 채보는 게시하거나 보낼 수 없습니다. 오른쪽 검사 목록을 확인하세요", "warn"); return; }
    if (ONLINE && dirty) { status("저장하지 않은 변경이 있습니다. 먼저 저장하세요(Ctrl+S)", "warn"); return; }
    var owner = TDAccount.isOwner(account);
    var row = officialRows[chart.id];
    var name = chart.title + " [" + TDChart.difficultyLabel(chart.difficulty) + "]";
    $("publish-title").textContent = owner ? (row ? "공식 다시 게시" : "공식 게시") : "소유자에게 보내기";
    var cfg = window.TD_CONFIG || {};
    $("publish-text").textContent = (cfg.serverShown ? "[" + cfg.serverName + "] " : "") + (owner
      ? name + (row ? "을(를) 새 버전(v" + (row.version + 1) + ")으로 게시합니다. 지금 버전(v" + row.version + ")은 old로 남고, 랭킹은 이어집니다." : "을(를) 공식 채보로 게시합니다. 승인된 모든 플레이어의 곡 목록에 공식으로 나타나고 랭킹이 생깁니다.")
      : name + "을(를) 소유자에게 보냅니다. 소유자가 관리자 화면의 「받은 채보 요청」에서 확인합니다.");
    $("publish-reset-row").hidden = !owner || !row;
    $("publish-reset").checked = false;
    $("publish-note").hidden = owner;
    $("publish-note").value = "";
    $("publish-msg").textContent = "";
    $("publish-ok").disabled = false;
    $("publish-ok").textContent = owner ? "게시" : "보내기";
    showModal("dlg-publish");
  }
  function doPublish() {
    var owner = TDAccount.isOwner(account);
    var data = chartData();
    var name = chart.title + " [" + TDChart.difficultyLabel(chart.difficulty) + "]";
    $("publish-ok").disabled = true;
    $("publish-msg").textContent = "";
    var job = owner ? TDAccount.publishChart(MODE, data, $("publish-reset").checked)
      : TDAccount.sendChartRequest(MODE, data, name, $("publish-note").value.trim());
    job.then(function () {
      hideModal("dlg-publish");
      status(owner ? "공식 채보로 게시했습니다 · " + name : "소유자에게 보냈습니다 · " + name);
      // 공식이 된 채보는 서버에서 받으므로 배포본에 넣지 않는다
      if (owner && chart && chart.deploy) {
        var before = snapshot();
        chart.deploy = false;
        history.record(before);
        updateDirty();
        status("공식 채보로 게시했습니다 · " + name + " · 「배포에 포함」을 껐습니다(저장하세요)", "warn");
      }
      if (owner) loadOfficial();
    }, function (e) {
      $("publish-ok").disabled = false;
      $("publish-msg").textContent = TDAccount.errorText(e);
    });
  }
  $("btn-publish").addEventListener("click", openPublish);
  $("publish-ok").addEventListener("click", doPublish);
  $("publish-cancel").addEventListener("click", function () { hideModal("dlg-publish"); });

  // ---- 채보 열기 ----
  function lastChartId() {
    try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; }
  }
  function showOpen() {
    $("open-sub").textContent = MODE_LABEL + " 채보 · " + MODE_DIR + "/charts/" + (ONLINE ? "" : " (서버 없이 열려 bundle.js 사본을 읽었습니다)");
    var last = lastChartId();
    refreshSwitch(); // 채보 목록을 불러온 뒤 처음 여는 경우
    $("open-errors").innerHTML = (lib.errors || []).map(function (er) { return "읽지 못한 파일: " + esc(er.file) + " · " + esc(er.error); }).join("<br>");
    var list = $("open-list");
    list.innerHTML = "";
    if (!lib.charts.length) {
      list.innerHTML = '<p class="note-box">이 목업의 채보가 아직 없습니다. <b>새 채보</b>로 만들면 곧바로 파일로 저장되고 게임 곡 선택 화면에 나타납니다.</p>';
    }
    var groups = {};
    var order = [];
    lib.charts.forEach(function (c) {
      if (!groups[c.songId]) { groups[c.songId] = []; order.push(c.songId); }
      groups[c.songId].push(c);
    });
    order.sort(function (a, b) { return groups[a][0].title.localeCompare(groups[b][0].title); });
    // 마지막으로 연 채보가 든 곡을 맨 위로
    var lastSong = null;
    lib.charts.forEach(function (c) { if (c.id === last) lastSong = c.songId; });
    if (lastSong) order = [lastSong].concat(order.filter(function (x) { return x !== lastSong; }));
    order.forEach(function (sid) {
      var cs = groups[sid].slice().sort(function (a, b) { return TDChart.difficultyIndex(a.difficulty) - TDChart.difficultyIndex(b.difficulty) || a.level - b.level; });
      var box = document.createElement("div");
      box.className = "song-group";
      var head = document.createElement("div");
      head.className = "sg-head";
      head.innerHTML = "<b>" + esc(cs[0].title) + "</b>" + (cs[0].artist ? "<span>" + esc(cs[0].artist) + "</span>" : "") + "<span>" + esc(cs[0].song || "음원 없음") + " · " + esc(sid) + "</span>";
      box.appendChild(head);
      cs.forEach(function (c) {
        var row = document.createElement("div");
        row.className = "chart-row" + (chart && chart.id === c.id ? " cur" : "") + (c.id === last ? " last" : "");
        row.innerHTML = '<span class="d">' + esc(TDChart.difficultyLabel(c.difficulty)) + "</span><span>" + TDChart.levelText(c.level) + "</span><span>노트 " + c.notes.length + '</span><span class="id">' +
          (c.id === last ? '<b class="last-tag">마지막으로 연 채보</b> ' : "") + esc(c.id) + "</span>";
        row.addEventListener("click", function () {
          if (chart && chart.id === c.id) { hideModal("dlg-open"); return; }
          guardDirty(function () { hideModal("dlg-open"); openChart(c); });
        });
        box.appendChild(row);
      });
      list.appendChild(box);
    });
    $("open-close").style.display = chart ? "" : "none";
    showModal("dlg-open");
  }
  $("open-new").addEventListener("click", function () { guardDirty(function () { hideModal("dlg-open"); showForm("new"); }); });
  $("open-close").addEventListener("click", function () { hideModal("dlg-open"); });
  $("open-back").addEventListener("click", backToGame);

  // ---- 새 채보 / 정보 수정 ----
  var form = { kind: "new", auto: { title: true, songId: true, id: true } };
  function fillSelect(el, items, cur) {
    el.innerHTML = "";
    items.forEach(function (it) {
      var o = document.createElement("option");
      o.value = it.v;
      o.textContent = it.label;
      if (it.disabled) o.disabled = true;
      el.appendChild(o);
    });
    if (cur !== undefined) el.value = cur;
  }
  function songTitleOf(file) { return String(file || "").replace(/\.[^.]+$/, ""); }
  function showForm(kind) {
    form.kind = kind;
    var editing = kind === "edit";
    var c = editing ? chart : null;
    form.auto = { title: !editing, songId: !editing, id: !editing };
    $("form-title").textContent = editing ? "정보 수정" : "새 채보";
    $("form-sub").textContent = editing ? c.id + ".json · " + MODE_LABEL : MODE_LABEL + " 채보를 만듭니다";
    $("form-ok").textContent = editing ? "적용" : "만들기";
    $("f-bpm-auto-msg").textContent = "";
    $("f-bpm-cands").innerHTML = "";
    var songs = (lib.songs || []).slice();
    if (editing && c.song && songs.indexOf(c.song) < 0) songs.unshift(c.song);
    var items = songs.map(function (s) { return { v: s, label: s + ((lib.songs || []).indexOf(s) < 0 ? " (songs 폴더에 없음)" : "") }; });
    if (!items.length) items = [{ v: "", label: "songs 폴더에 음원이 없습니다", disabled: true }];
    fillSelect($("f-song"), items, editing ? c.song : songs[0] || "");
    $("f-song-hint").textContent = (lib.songs || []).length ? (ONLINE ? "songs/ 폴더의 음원 " : "음원 사본(서버 없이 열림) ") + lib.songs.length + "개" :
      ONLINE ? "songs/ 폴더에 음원(mp3·ogg·wav·m4a)을 넣고 새로고침하세요" : "서버 없이 열려 있어 사본이 있는 음원만 보입니다. start.bat으로 실행하세요";
    $("f-song-hint").className = "hint" + ((lib.songs || []).length ? "" : " bad");
    fillSelect($("f-diff"), TDChart.DIFFICULTIES.map(function (d) { return { v: d.key, label: d.label + " (" + d.short + ")" }; }), editing ? c.difficulty : "normal");
    $("f-title").value = editing ? c.title : songTitleOf($("f-song").value);
    $("f-artist").value = editing ? c.artist : "";
    $("f-songid").value = editing ? c.songId : TDChart.slug($("f-title").value);
    fillLevels(editing ? c.level : 5);
    $("f-bpm").value = editing ? c.bpm : 120;
    $("f-offset").value = editing ? c.offset : 0;
    $("f-id").readOnly = editing;
    $("f-id").value = editing ? c.id : TDChart.chartIdOf($("f-songid").value, $("f-diff").value);
    $("form-note").innerHTML = editing
      ? "BPM·오프셋을 바꿔도 노트는 <b>박자 위치 그대로</b> 남습니다(초로 치면 함께 움직입니다). 파일 이름은 바꿀 수 없습니다. 이 변경도 Ctrl+Z로 되돌릴 수 있습니다."
      : ONLINE ? "만들면 곧바로 <b>Mockups/" + MODE_DIR + "/charts/&lt;파일 이름&gt;.json</b> 파일로 저장되고, 게임을 켤 때 곡 선택 화면에 나타납니다."
        : "서버 없이 열려 있어 파일이 만들어지지 않습니다. 편집한 뒤 <b>JSON 내려받기</b>로 받아 Mockups/" + MODE_DIR + "/charts/ 폴더에 넣으세요.";
    $("form-msg").textContent = "";
    showUnlockRule();
    validateIdHint();
    showModal("dlg-form");
    $("f-title").focus();
  }
  // 해금 조건은 난이도 규칙으로 정해진다(chart-format.js unlockRule). 정보 창에서는 고르지 않고 보여 주기만 한다.
  function formUnlock() {
    return TDChart.unlockRule({ id: $("f-id").value.trim(), songId: $("f-songid").value.trim(), difficulty: $("f-diff").value }, lib.charts);
  }
  function showUnlockRule() {
    var u = formUnlock();
    var src = u.type === "clear" ? lib.charts.filter(function (x) { return x.id === u.chart; })[0] : null;
    $("f-unlock-rule").textContent = (u.type === "clear" ? (src ? src.title + " [" + TDChart.difficultyLabel(src.difficulty) + "]" : u.chart) + " 클리어" : "튜토리얼 완료") +
      " · 난이도로 정해짐(쉬움 · 보통 = 튜토리얼 완료, 어려움 = 같은 곡 보통 클리어)";
  }
  // 레벨 칸: 고른 난이도의 범위만(chart-format.js LEVEL_RANGE, 쉬움 I~VI · 보통 IV~IX · 어려움 VII~OVER). 범위 밖 값은 가까운 끝으로
  function fillLevels(want) {
    var r = TDChart.levelRange($("f-diff").value);
    var items = [];
    for (var lv = r[0]; lv <= r[1]; lv++) items.push({ v: String(lv), label: TDChart.levelText(lv) });
    fillSelect($("f-level"), items, String(Math.max(r[0], Math.min(r[1], parseInt(want, 10) || r[0]))));
  }
  function recomputeAuto() {
    if (form.kind !== "new") return;
    if (form.auto.songId) $("f-songid").value = TDChart.slug($("f-title").value);
    if (form.auto.id) $("f-id").value = TDChart.chartIdOf($("f-songid").value || $("f-title").value, $("f-diff").value);
    validateIdHint();
  }
  function idProblem(id) {
    if (!TDChart.isValidId(id)) return "영문 소문자·숫자·-·_ 만, 64자 이하(첫 글자는 영문·숫자)";
    if (form.kind === "new" && findChart(id)) return "이미 같은 이름의 채보가 있습니다";
    return "";
  }
  function validateIdHint() {
    var el = $("f-id-hint");
    if (form.kind === "edit") { el.textContent = "파일 이름은 바꿀 수 없습니다"; el.className = "hint"; return; }
    var p = idProblem($("f-id").value.trim());
    el.textContent = p || "Mockups/" + MODE_DIR + "/charts/" + $("f-id").value.trim() + ".json";
    el.className = "hint" + (p ? " bad" : "");
  }
  $("f-song").addEventListener("change", function () {
    if (form.auto.title) { $("f-title").value = songTitleOf(this.value); recomputeAuto(); }
    $("f-bpm-auto-msg").textContent = "";
    $("f-bpm-cands").innerHTML = "";
  });
  // 창의 BPM 자동 계산: 고른 음원으로 재서 BPM 칸을 채운다. 후보를 누르면 그 값으로 바꾼다.
  $("f-bpm-auto").addEventListener("click", function () {
    var file = $("f-song").value;
    var btn = this;
    if (!file) { $("f-bpm-auto-msg").textContent = "음원을 먼저 고르세요"; return; }
    btn.disabled = true;
    $("f-bpm-auto-msg").innerHTML = "<small>계산 중… 곡 길이에 따라 몇 초 걸립니다</small>";
    $("f-bpm-cands").innerHTML = "";
    detectBpm(file).then(function (r) {
      if ($("f-song").value !== file) return; // 그 사이 음원을 바꿨다
      $("f-bpm").value = r.bpm;
      $("f-bpm-auto-msg").innerHTML = "<small>추정 " + r.bpm + " · 신뢰도 " + r.confidence + " · 반·두 배로 잡혔으면 후보를 누르세요</small>";
      $("f-bpm-cands").innerHTML = candButtons(r, r.bpm);
    }).catch(function (e) {
      $("f-bpm-auto-msg").textContent = "계산하지 못했습니다: " + ((e && e.message) || e);
    }).then(function () { btn.disabled = false; });
  });
  $("f-bpm-cands").addEventListener("click", function (e) {
    var b = e.target.closest("[data-bpm]");
    if (!b) return;
    $("f-bpm").value = b.getAttribute("data-bpm");
    Array.prototype.forEach.call(this.querySelectorAll(".cand"), function (x) { x.classList.toggle("on", x === b); });
  });
  $("f-title").addEventListener("input", function () { form.auto.title = false; recomputeAuto(); });
  $("f-songid").addEventListener("input", function () { form.auto.songId = false; recomputeAuto(); });
  $("f-diff").addEventListener("change", function () { fillLevels($("f-level").value); recomputeAuto(); });
  $("f-id").addEventListener("input", function () { form.auto.id = false; validateIdHint(); });
  ["f-diff", "f-songid", "f-id"].forEach(function (id) { $(id).addEventListener("input", showUnlockRule); $(id).addEventListener("change", showUnlockRule); });
  function cancelForm() {
    hideModal("dlg-form");
    if (!chart) showOpen(); // 열린 채보가 없으면 고르는 창으로
  }
  $("form-cancel").addEventListener("click", cancelForm);
  $("form-ok").addEventListener("click", submitForm);
  function readForm() {
    var v = {
      song: $("f-song").value,
      title: $("f-title").value.trim(),
      artist: $("f-artist").value.trim(),
      songId: TDChart.slug($("f-songid").value.trim() || $("f-title").value),
      difficulty: $("f-diff").value,
      level: parseInt($("f-level").value, 10),
      bpm: parseFloat($("f-bpm").value),
      offset: parseFloat($("f-offset").value),
      id: $("f-id").value.trim()
    };
    v.unlock = formUnlock();
    if (!v.song) return { error: "음원을 고르세요" };
    if (!v.title) return { error: "제목을 쓰세요" };
    var lr = TDChart.levelRange(v.difficulty);
    if (!(v.level >= lr[0] && v.level <= lr[1])) return { error: TDChart.difficultyLabel(v.difficulty) + " 레벨은 " + TDChart.levelLabel(lr[0]) + "~" + TDChart.levelLabel(lr[1]) };
    if (!(v.bpm > 0 && v.bpm < 1000)) return { error: "BPM은 0보다 큰 수" };
    if (!isFinite(v.offset)) return { error: "오프셋(초)은 숫자" };
    if (form.kind === "new") {
      var p = idProblem(v.id);
      if (p) return { error: "파일 이름: " + p };
    }
    return { v: v };
  }
  function submitForm() {
    var r = readForm();
    if (r.error) { $("form-msg").textContent = r.error; return; }
    var v = r.v;
    if (form.kind === "edit") {
      var before = snapshot();
      var songBefore = chart.song;
      var bpmBefore = chart.bpm, offBefore = chart.offset;
      ["song", "title", "artist", "songId", "difficulty", "level", "bpm", "offset", "unlock"].forEach(function (k) { chart[k] = v[k]; });
      var next = TDChart.normalizeChart(chart, chart.id);
      next.id = chart.id;
      next.mode = MODE;
      if (JSON.stringify(next) === before) { hideModal("dlg-form"); status("바뀐 것이 없습니다"); return; }
      chart = next;
      history.record(before);
      hideModal("dlg-form");
      afterEdit();
      refreshAll();
      if (chart.song !== songBefore) loadSong(chart.song);
      status("정보를 바꿨습니다" + (chart.bpm !== bpmBefore || chart.offset !== offBefore ? " · 노트는 박자 위치 그대로입니다" : ""), "ok");
      return;
    }
    var c = TDChart.normalizeChart({
      format: 1, mode: MODE, id: v.id, songId: v.songId, title: v.title, artist: v.artist, song: v.song,
      bpm: v.bpm, offset: v.offset, degPerBeat: MODE === "core" ? 90 : 30, difficulty: v.difficulty, level: v.level,
      unlock: v.unlock, order: 0, notes: []
    }, v.id);
    c.id = v.id;
    c.mode = MODE;
    if (!ONLINE) {
      upsertLib(c);
      hideModal("dlg-form");
      openChart(c);
      savedJson = ""; // 아직 어디에도 저장되지 않았다
      updateDirty();
      status("새 채보를 만들었습니다. 서버 없이 열려 있어 파일은 아직 없습니다 · 다 만들면 JSON 내려받기", "warn");
      return;
    }
    $("form-ok").disabled = true;
    $("form-msg").textContent = "";
    LIB.saveChart(MODE, c).then(function () {
      upsertLib(c);
      hideModal("dlg-form");
      openChart(c);
      status("새 채보를 만들고 저장했습니다 · Mockups/" + MODE_DIR + "/charts/" + c.id + ".json", "ok");
    }).catch(function (e) {
      $("form-msg").textContent = "저장하지 못했습니다: " + (e && e.message ? e.message : e);
    }).then(function () { $("form-ok").disabled = false; });
  }

  // ================= 상단 버튼 =================
  $("btn-back").addEventListener("click", backToGame);
  $("btn-open").addEventListener("click", showOpen);
  $("btn-new").addEventListener("click", function () { guardDirty(function () { showForm("new"); }); });
  $("btn-info").addEventListener("click", function () { if (chart) showForm("edit"); });
  $("btn-save").addEventListener("click", saveChart);
  $("btn-test").addEventListener("click", testPlay);
  $("btn-delete").addEventListener("click", deleteChart);
  $("val-chip").addEventListener("click", function () {
    var first = issues.slice().sort(function (a, b) { return (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1) || a.index - b.index; })[0];
    if (first) jumpToNote(first.index);
  });
  window.addEventListener("beforeunload", function (e) {
    if (dirty && !SHOT) { e.preventDefault(); e.returnValue = ""; }
  });

  // ================= 매 프레임 =================
  function frame(now) {
    requestAnimationFrame(frame);
    if (audio.running && chart) {
      stepPlayback();
      needsDraw = true;
      needsTimeline = true;
    }
    if (ed.flash) needsDraw = true;
    if (needsDraw) { needsDraw = false; render(now || performance.now()); }
    if (needsTimeline) { needsTimeline = false; drawTimeline(); }
    paintKeys();
  }

  // ================= 시작 =================
  // 서버 없이 열면 채보 사본(bundle.js)과 음원 사본을 먼저 읽는다.
  // 음원 사본은 shared/offline-songs.js가 기준이고, 없으면 예전 목업의 song-data.js(enchanted love 하나)를 대신 쓴다.
  function loadLibrary() {
    status("채보 목록을 읽는 중…");
    var pre = ONLINE ? Promise.resolve() : loadScript("../" + MODE_DIR + "/charts/bundle.js").then(function () {
      return window.TD_OFFLINE_SONGS ? true : loadScript("../shared/offline-songs.js");
    }).then(function () {
      if (window.TD_OFFLINE_SONGS || window.TD_SONG_B64) return true;
      return loadScript("../" + MODE_DIR + "/song-data.js");
    });
    return pre.then(function () { return LIB.load(MODE); }).then(function (res) {
      lib = { charts: res.charts || [], songs: res.songs || [], errors: res.errors || [] };
      lib.charts.forEach(function (c) { c.mode = MODE; });
      status(MODE_LABEL + " 채보 " + lib.charts.length + "개 · 음원 " + lib.songs.length + "개" + (ONLINE ? "" : " · 서버 없이 열림(저장 대신 내려받기)"));
    }).catch(function (e) {
      lib = { charts: [], songs: [], errors: [] };
      status("채보 목록을 읽지 못했습니다: " + (e && e.message ? e.message : e), "err");
    });
  }
  function numParam(name) {
    var v = params.get(name);
    return v === null || v === "" ? null : parseFloat(v);
  }
  function applyUrlParams() {
    var snap = numParam("snap");
    if (snap !== null && M.SNAPS.indexOf(snap) >= 0) { prefs.div = snap; refreshSeg($("snap-seg"), snap); }
    var type = numParam("type");
    if (type !== null && ALLOWED.indexOf(type - 1) >= 0) { ed.type = type - 1; refreshPalette(); }
    if (!chart) return;
    var bpp = numParam("bpp");
    if (bpp !== null && M.PAGE_BEATS.indexOf(bpp) >= 0) { ed.bpp = bpp; refreshSeg($("bpp-seg"), bpp); }
    var hover = SHOT ? numParam("hover") : null;
    if (hover !== null && chart.notes[hover]) {
      forcedHover = hover;
      ed.page = M.pageOfBeat(chart.notes[hover].b, ed.bpp);
    }
    var page = numParam("page");
    if (page !== null && page >= 1) ed.page = Math.floor(page) - 1; // 음원 길이를 아직 모르므로 끝으로 자르지 않는다
    playBeat = pageStart();
    var pt = SHOT ? params.get("pointer") : null;
    if (pt) {
      var parts = pt.split(",");
      shotPointer = { b: parseFloat(parts[0]), lane: clamp(parseInt(parts[1], 10) || 0, 0, 3) };
      if (!isFinite(shotPointer.b)) shotPointer = null;
    }
    onPageChanged();
    refreshAll();
  }
  function afterLoad(backupLoaded) {
    if (backupLoaded) { applyUrlParams(); return; }
    // 주소에 채보가 있으면(테스트 플레이에서 돌아옴 등) 그 채보를 바로 연다. 없으면(게임의 「에디터」) 늘 「채보 열기」를 띄우고
    // 마지막으로 연 채보를 맨 위에 강조한다(09-30, 사용자).
    var want = params.get("chart");
    var c = want ? findChart(want) : null;
    if (c) {
      openChart(c);
      applyUrlParams();
      return;
    }
    applyUrlParams();
    if (want) status("채보를 찾지 못했습니다: " + want, "warn");
    if (!lib.charts.length) showForm("new");
    else showOpen();
  }
  function boot() {
    document.body.classList.toggle("lanes", MODE === "lanes");
    if (MODE === "lanes") {
      readLaneKeys();
      window.addEventListener("focus", readLaneKeys); // 게임 탭에서 레인 키를 바꾸고 돌아온 경우
    }
    setupTools();
    refreshAll();
    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe($("stage-wrap"));
    window.addEventListener("resize", resize); // 배율(devicePixelRatio)만 바뀌는 경우도 받으려고 함께 둔다
    requestAnimationFrame(frame);
    gate().then(loadLibrary).then(checkBackups).then(afterLoad);
    TDUI.watchVersion(); // 새 버전 안내(shared/ui.js). 저장하지 않은 변경이 있으면 새로 고칠 때 브라우저가 묻는다
    setInterval(autoSave, AUTOSAVE_MS);
    // 스크린샷·자동 점검용 들여다보기 창구(주소에 shot이 있을 때만)
    if (SHOT) {
      window.TDEditorDebug = {
        state: function () { return { chart: chart, page: ed.page, bpp: ed.bpp, div: prefs.div, type: ed.type, hover: ed.hover, dragging: !!drag, dirty: dirty, playBeat: playBeat, issues: issues, view: view, rec: { on: rec.on, count: rec.count, held: Object.keys(rec.held) } }; },
        // 박자·레인(또는 반지름)의 화면 좌표(clientX/Y)
        clientAt: function (b, laneOrR, isRadius) {
          var rect = cv.getBoundingClientRect();
          var p = layoutToView(toScreen(M.pointAt(M.angleOfBeat(b, pageStart(), ed.bpp), isRadius ? laneOrR : M.laneRadius(laneOrR))));
          return { x: rect.left + p.x, y: rect.top + p.y };
        },
        clientAtAngle: function (deg, r) {
          var rect = cv.getBoundingClientRect();
          var p = layoutToView(toScreen(M.pointAt(deg, r)));
          return { x: rect.left + p.x, y: rect.top + p.y };
        }
      };
    }
  }
  boot();
})();
