// 목업의 화면·소리·입력 담당. 규칙(판정·점수·라이프·되돌리기)은 engine.js에 있고,
// 여기서는 그 규칙을 시계 무대 위에 그리고 레인 키 입력(키 하나 = 레인 하나, 커서 안 씀)을 연결한다.
// 곡·채보 불러오기, 저장 기록, 곡 선택 화면은 두 목업이 같이 쓰는 ../shared/ 에 있다.
(function () {
  "use strict";

  var TDE = window.TDEngine;
  var TDC = window.TDChart;
  var TYPE = TDE.TYPE;
  var MODE = "lanes"; // 저장 기록·채보 폴더 구분(rhythm-lanes/charts)
  var TAU = Math.PI * 2;
  var params = new URLSearchParams(location.search);
  var PREVIEW = params.has("preview") ? parseFloat(params.get("preview")) : null;
  var save = TDSave.create(MODE);
  var library = { online: TDLibrary.online, charts: [], songs: [], errors: [] };

  function $(id) { return document.getElementById(id); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function fmtNum(n) { return Math.round(n).toLocaleString("en-US"); }

  // ================= 설정 =================
  var SETTINGS_KEY = "td-rhythm-lanes-v1";
  var DEFAULT_KEYS = ["KeyD", "KeyF", "KeyK", "KeyL"]; // 안쪽 레인부터
  var SETTINGS_VER = 3; // 2: 기본 회전 속도 90°→30° · 3: 곡·타격음 기본 음량 0.8/0.6 → 0.5/0.8
  // keyHint: 시침 뒤 레인 키 글자. always 계속 / start 시작만(첫 노트가 시침에 닿은 뒤 1초에 걸쳐 사라짐) / off 끄기
  var settings = { offsetMs: 0, rewindSeconds: 3, rewindLimit: -1, rewindPenalty: 10000, leadDeg: 180, degPerBeat: 30, volume: 0.5, showDelta: true, keys: DEFAULT_KEYS.slice(), hitsound: true, hitVolume: 0.8, keyHint: "always", ver: SETTINGS_VER, layout: null, setupDone: false, rewindKey: "KeyR" };
  var DEFAULT_REWIND_KEY = "KeyR"; // 되돌리기 기본 키(09-30, 예전 Space — 너무 커서 못 누르는 경우가 있었다)
  // 게임 화면 배치(UI 조정). 항목마다 기준 자리 h(left·center·right) · v(top·middle·bottom),
  // 그 자리에서 떨어진 거리 x · y(픽셀, 오른쪽·아래가 +), 크기 s(%). 플레이 화면(시계)은 h(좌·중·우)만 쓴다.
  // 곡 제목 · 난이도(옆에 되돌리기 남은 횟수) · 일시정지 버튼은 여기 없다(고정). 플레이 화면이
  //   중: 제목 왼쪽 위 · 일시정지 오른쪽 위 / 좌: 제목 오른쪽 위(오른쪽 정렬) · 일시정지 그보다 오른쪽 / 우: 제목 왼쪽 위 · 일시정지 그보다 왼쪽.
  // 위 기준 자리(좌 · 상, 우 · 상)는 그쪽 고정 요소 바로 아래부터 센다.
  var LAYOUT_DEFAULT = {
    play: { h: "center", v: "middle", x: 0, y: 0, s: 100 },
    // 기본 순서(위에서부터): 라이프 → 점수 → 정확도 → 판정
    life: { h: "left", v: "top", x: 0, y: 0, s: 100 },
    score: { h: "left", v: "top", x: 0, y: 62, s: 100 },
    acc: { h: "left", v: "top", x: 0, y: 118, s: 100 },
    judge: { h: "left", v: "top", x: 0, y: 152, s: 100 },
    combo: { h: "left", v: "bottom", x: 0, y: 0, s: 100 },
    border: { h: "left", v: "bottom", x: 0, y: -70, s: 100 },
    guide: { h: "right", v: "bottom", x: 0, y: 0, s: 100 }
  };
  var LIFE_STYLES = [["both", "숫자 + 게이지"], ["number", "숫자"], ["gauge", "게이지"]];
  var JUDGE_STYLES = [["full", "완전형"], ["color", "간략형(색만)"]];
  // 콤보 위치 유형: 가장자리 상자 / 시계 안(판 위 · 시침과 노트 아래에 그린다). 시계 안이면 세로 자리(comboY)만 고른다.
  var COMBO_MODES = [["box", "상자"], ["clock", "시계 안"]];
  var COMBO_Y_DEFAULT = 46; // 시계 반지름 대비 %(아래가 +). 46 = 중심축 아래
  // 조작 안내: 전부(레인 키 · 되돌리기 · 일시정지) / 레인 키만 / 끔
  var GUIDE_MODES = [["on", "ON"], ["keys", "레인 키만"], ["off", "OFF"]];
  var LAYOUT_STYLE_FIELDS = ["lifeStyle", "judgeStyle", "comboMode", "guideMode"];
  function cloneLayout(src) {
    var out = {};
    for (var k in LAYOUT_DEFAULT) {
      var d = LAYOUT_DEFAULT[k];
      var v = src && src[k] ? src[k] : d;
      out[k] = { h: v.h || d.h, v: v.v || d.v, x: +v.x || 0, y: v.y === undefined ? d.y : +v.y || 0, s: Math.max(50, Math.min(200, +v.s || 100)) };
    }
    out.play.x = out.play.y = 0; // 플레이 화면은 좌 · 중 · 우만
    out.play.s = 100;
    out.lifeStyle = src && src.lifeStyle ? src.lifeStyle : "both";
    out.judgeStyle = src && src.judgeStyle ? src.judgeStyle : "full";
    out.comboMode = src && src.comboMode === "clock" ? "clock" : "box";
    out.comboY = src && src.comboY !== null && isFinite(+src.comboY) ? Math.max(-80, Math.min(80, +src.comboY)) : COMBO_Y_DEFAULT;
    out.guideMode = src && src.guideMode ? src.guideMode : "on";
    // auto: 기본 위치를 유형에 맞춰 계산하는 중(왼쪽 위 쌓임 · 보더). 사용자가 그 상자를 옮기면 꺼지고, 기본값으로 다시 켜진다.
    out.auto = src && src.auto === false ? false : true;
    return out;
  }
  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (saved) {
      for (var sk in saved) if (sk in settings) settings[sk] = saved[sk];
      // 예전 버전에서 저장한 설정은 바뀐 기본값만 옮긴다(싱크·키 설정, 직접 바꾼 음량은 그대로).
      var from = saved.ver || 1;
      if (from < 2) settings.degPerBeat = 30;
      if (from < 3) {
        if (saved.volume === undefined || saved.volume === 0.8) settings.volume = 0.5;
        if (saved.hitVolume === undefined || saved.hitVolume === 0.6) settings.hitVolume = 0.8;
      }
      if (from !== SETTINGS_VER) {
        settings.ver = SETTINGS_VER;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      }
    }
  } catch (e) { /* 저장소를 못 쓰는 환경이면 기본값으로 */ }
  if (!Array.isArray(settings.keys) || settings.keys.length !== 4) settings.keys = DEFAULT_KEYS.slice();
  if (["always", "start", "off"].indexOf(settings.keyHint) < 0) settings.keyHint = "always";
  settings.layout = cloneLayout(settings.layout);
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 무시 */ }
  }
  function offsetSec() { return settings.offsetMs / 1000; }
  function engineOptions() {
    return { rewindSeconds: settings.rewindSeconds, rewindLimit: settings.rewindLimit, rewindPenalty: settings.rewindPenalty, degPerBeat: settings.degPerBeat };
  }

  // 판마다 채보를 바꿔 끼운다(곡 선택·튜토리얼 단계). 처음에는 빈 채보.
  var EMPTY_CHART = { title: "", bpm: 120, offset: 0, degPerBeat: 90, notes: [] };
  var engine = TDE.createEngine(EMPTY_CHART, engineOptions());
  var LAST_END = 0;

  // ---------- 레인 키 ----------
  // 키 하나 = 레인 하나. 내부 키 이름은 "L0"~"L3"(안쪽 레인부터).
  var KEY_NAMES = { Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", ShiftLeft: "L⇧", ShiftRight: "R⇧", ControlLeft: "LCtrl", ControlRight: "RCtrl", AltLeft: "LAlt", AltRight: "RAlt", Enter: "Enter", Tab: "Tab", Space: "Space", Backspace: "Backspace", CapsLock: "Caps" };
  function codeLabel(code) {
    var m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(\d)$/.exec(code))) return "N" + m[1];
    return KEY_NAMES[code] || code;
  }
  // 되돌리기 키 표시(게임 중 안내 · 처음 화면 조작법, data-rw)
  function refreshRewindLabels() {
    var txt = codeLabel(settings.rewindKey);
    Array.prototype.forEach.call(document.querySelectorAll("[data-rw]"), function (el) { el.textContent = txt; });
  }
  function isInputKey(code) { return settings.keys.indexOf(code) >= 0; }
  function laneKeyOf(code) {
    var i = settings.keys.indexOf(code);
    return i >= 0 ? "L" + i : null;
  }
  function laneOfKey(k) { return parseInt(k.slice(1), 10); }
  function refreshKeyLabels() {
    for (var i = 0; i < 4; i++) {
      var txt = codeLabel(settings.keys[i]);
      Array.prototype.slice.call(document.querySelectorAll('[data-cap="L' + i + '"], [data-demo="L' + i + '"], [data-keylabel="L' + i + '"]')).forEach(function (el) { el.textContent = txt; });
    }
  }

  // ---------- 동시치기 묶음 ----------
  // 같은 순간에 시작하는 노트(탭·롱 머리)끼리 묶는다. 묶인 노트의 머리는 은빛, 서로 흰 점선으로 잇는다.
  function findChords(list) {
    var byT = {};
    var groups = [];
    var of = {};
    list.forEach(function (n) {
      var k = n.t.toFixed(4);
      (byT[k] = byT[k] || []).push(n);
    });
    Object.keys(byT).forEach(function (k) {
      if (byT[k].length < 2) return;
      var grp = byT[k].slice().sort(function (a, b) { return a.lane - b.lane; });
      groups.push(grp);
      grp.forEach(function (n) { of[n.id] = true; });
    });
    groups.of = of;
    return groups;
  }
  var CHORDS = []; // 판마다 useEngine이 다시 찾는다
  CHORDS.of = {};

  // ================= 소리 =================
  // 곡 위치는 "지금 귀에 들리는 소리"를 기준으로 계산한다(getOutputTimestamp).
  var audio = {
    ctx: null, master: null, sfx: null, buffer: null, src: null, playId: 0,
    anchorCtx: 0, anchorSong: 0, rate: 1, running: false, heldSong: 0,
    init: function () {
      if (this.ctx) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.master = this.ctx.createGain();
      this.master.gain.value = settings.volume;
      this.master.connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = 0.45;
      this.sfx.connect(this.ctx.destination);
      // 타격음 전용 버스(음량 따로)와 째깍 소리에 쓸 짧은 잡음
      this.hitBus = this.ctx.createGain();
      this.hitBus.gain.value = settings.hitVolume;
      this.hitBus.connect(this.ctx.destination);
      var len = Math.round(this.ctx.sampleRate * 0.05);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      var d = this.noise.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    },
    resume: function () {
      this.init();
      return this.ctx.state === "running" ? Promise.resolve() : this.ctx.resume();
    },
    heardCtx: function (perf) {
      var c = this.ctx;
      if (c.getOutputTimestamp) {
        var ts = c.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + (perf - ts.performanceTime) / 1000;
      }
      return c.currentTime - (c.outputLatency || c.baseLatency || 0);
    },
    songAt: function (perf) {
      if (!this.running) return this.heldSong;
      return this.anchorSong + (this.heardCtx(perf) - this.anchorCtx) * this.rate;
    },
    play: function (songPos, delay) {
      this.stopSource();
      var c = this.ctx;
      var src = c.createBufferSource();
      src.buffer = this.buffer;
      src.connect(this.master);
      var when = c.currentTime + (delay === undefined ? 0.06 : delay);
      if (songPos >= 0) src.start(when, songPos);
      else src.start(when - songPos, 0);
      this.master.gain.cancelScheduledValues(c.currentTime);
      this.master.gain.setValueAtTime(settings.volume, c.currentTime);
      this.src = src;
      this.anchorCtx = when;
      this.anchorSong = songPos;
      this.rate = 1;
      this.running = true;
      this.playId++;
    },
    stopSource: function () {
      if (!this.src) return;
      try { this.src.stop(); } catch (e) { /* 이미 멈춤 */ }
      this.src.disconnect();
      this.src = null;
    },
    stop: function (perf) {
      if (this.running) this.heldSong = this.songAt(perf === undefined ? performance.now() : perf);
      this.stopSource();
      this.stopMetronome();
      this.running = false;
    },
    // 튜토리얼 실습용: 음원 없이 시계만 돌린다.
    startClock: function (songPos, delay) {
      this.stopSource();
      this.anchorCtx = this.ctx.currentTime + (delay === undefined ? 0.06 : delay);
      this.anchorSong = songPos;
      this.rate = 1;
      this.running = true;
      this.playId++;
    },
    // 박자마다 딸깍. 멈출 때 한꺼번에 끊을 수 있게 전용 버스로 보낸다.
    metro: null,
    startMetronome: function (bpm, untilSong) {
      this.stopMetronome();
      var c = this.ctx;
      this.metro = c.createGain();
      this.metro.connect(this.sfx);
      var spb = 60 / bpm;
      for (var b = 0; b * spb <= untilSong; b++) {
        var at = this.anchorCtx + (b * spb - this.anchorSong) / this.rate;
        if (at < c.currentTime) continue;
        this.click(at, b % 4 === 0, b % 4 === 0 ? 0.3 : 0.18, this.metro);
      }
    },
    stopMetronome: function () {
      if (!this.metro) return;
      this.metro.disconnect();
      this.metro = null;
    },
    // 게임오버 연출용: 재생 속도를 바꾸면 음높이도 함께 내려가 태엽이 풀리는 소리가 된다.
    setRate: function (r) {
      var now = this.ctx.currentTime;
      this.anchorSong += (now - this.anchorCtx) * this.rate;
      this.anchorCtx = now;
      this.rate = r;
      if (this.src) this.src.playbackRate.setValueAtTime(r, now);
    },
    fadeOut: function (sec) {
      var now = this.ctx.currentTime;
      var gg = this.master.gain;
      gg.cancelScheduledValues(now);
      gg.setValueAtTime(gg.value, now);
      gg.linearRampToValueAtTime(0.0001, now + sec);
    },
    // 타격음: 판정 등급에 따라 선명도만 달라진다(노트 종류·손·동시치기·롱 시작/끝과 무관). 미스는 소리 없음.
    // 퍼펙트는 밝은 대역의 또렷한 째깍, 그레이트는 대역을 낮추고 시작을 조금 무르게, 굿은 더 낮고 무르게.
    // level은 곡(기본 음량 0.5)과 섞였을 때 퍼펙트 최고 세기가 곡 최고 세기(약 −6dB)와 비슷하도록 측정해서 맞춘 값.
    hitVoice: {
      perfect: { noiseF: 3500, q: 3, tone: 1950, toneAmp: 0.45, attack: 0.0015, decay: 0.045, level: 1.1 },
      great: { noiseF: 2300, q: 2.2, tone: 1450, toneAmp: 0.32, attack: 0.003, decay: 0.042, level: 1.13 },
      good: { noiseF: 1300, q: 1.6, tone: 950, toneAmp: 0.22, attack: 0.005, decay: 0.038, level: 1.37 }
    },
    hit: function (rank) {
      if (!settings.hitsound || !this.ctx || !this.hitBus) return;
      var v = this.hitVoice[rank];
      if (!v) return;
      var c = this.ctx;
      var now = c.currentTime;
      var out = c.createGain();
      out.gain.value = v.level;
      out.connect(this.hitBus);
      // 잡음 한 조각을 좁은 대역으로 걸러 금속성 째깍을 만들고, 짧은 사인파로 몸통을 더한다.
      var s = c.createBufferSource();
      s.buffer = this.noise;
      var bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = v.noiseF;
      bp.Q.value = v.q;
      var ng = c.createGain();
      ng.gain.setValueAtTime(0.0001, now);
      ng.gain.exponentialRampToValueAtTime(1, now + v.attack);
      ng.gain.exponentialRampToValueAtTime(0.0001, now + v.attack + v.decay);
      s.connect(bp);
      bp.connect(ng);
      ng.connect(out);
      s.start(now);
      s.stop(now + 0.05);
      var o = c.createOscillator();
      var og = c.createGain();
      o.type = "sine";
      o.frequency.value = v.tone;
      og.gain.setValueAtTime(0.0001, now);
      og.gain.exponentialRampToValueAtTime(v.toneAmp, now + v.attack);
      og.gain.exponentialRampToValueAtTime(0.0001, now + v.attack + v.decay * 0.8);
      o.connect(og);
      og.connect(out);
      o.start(now);
      o.stop(now + v.attack + v.decay + 0.02);
    },
    click: function (when, accent, vol, bus) {
      var c = this.ctx;
      var o = c.createOscillator();
      var gn = c.createGain();
      o.type = "square";
      o.frequency.value = accent ? 1760 : 1320;
      gn.gain.setValueAtTime(0.0001, when);
      gn.gain.exponentialRampToValueAtTime(vol || (accent ? 0.5 : 0.32), when + 0.002);
      gn.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
      o.connect(gn);
      gn.connect(bus || this.sfx);
      o.start(when);
      o.stop(when + 0.05);
    }
  };

  // 음원: 곡 파일 이름 → 해독한 소리. 한 번 해독한 곡은 다시 쓰는 동안 기억해 둔다.
  var buffers = {};
  function loadSong(file) {
    if (buffers[file]) return Promise.resolve(buffers[file]);
    return TDLibrary.loadAudio(file).then(function (buf) {
      // 해독은 소리를 내지 않는 오프라인 컨텍스트로 한다(클릭 전에도 동작). 결과 버퍼는 재생용 컨텍스트에서 그대로 쓸 수 있다.
      var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      var decoder = OAC ? new OAC(2, 44100, 44100) : (audio.init(), audio.ctx);
      return decoder.decodeAudioData(buf);
    }).then(function (b) {
      buffers[file] = b;
      return b;
    });
  }

  // ================= 화면 배치 =================
  var cv = $("stage");
  var g = cv.getContext("2d");
  var cvBg = $("stage-bg"); // 구석 장식 톱니(맨 아래 층). 시계·노트는 cv(맨 위 층)
  var gBg = cvBg.getContext("2d");
  var W = 0, H = 0, DPR = 1, CX = 0, CY = 0, R = 100;
  var dialCache = null;
  var dialDeg = 0; // 문자판을 그린 때의 한 박 각도(튜토리얼 들고 날 때 다시 그릴지 가른다)

  // 게임 화면 배치: 기준 자리(가장자리 여백 안쪽) + 거리. 상자는 기준 자리에 맞춰 붙는다(왼쪽 기준이면 왼쪽 끝이 그 자리).
  var LAYOUT_MARGIN_X = 18, LAYOUT_MARGIN_Y = 14;
  var LAYOUT_EL = { score: "hud-left", judge: "hud-judge", acc: "hud-acc", life: "hud-life", combo: "hud-combo", border: "hud-border", guide: "guide" };
  var H_FRAC = { left: 0, center: 50, right: 100 };
  var V_FRAC = { top: 0, middle: 50, bottom: 100 };
  var AUTO_KEYS = ["life", "score", "acc", "judge", "border"]; // 자동 기본 위치 대상
  var STACK_GAP = 8;
  // 기본 위치를 지금 유형 · 크기에 맞춰 계산한다: 왼쪽 위는 라이프 → 점수 → 정확도 → 판정을 실제 높이대로 빈칸 없이 쌓고,
  // 보더는 콤보가 상자면 그 바로 위, 시계 안이면 왼쪽 맨 아래. 튜토리얼처럼 상자가 숨은 때는 재지 않는다(0으로 저장되지 않게).
  function autoPlaceDefaults(L) {
    if (!L.auto || document.body.classList.contains("tutorial")) return;
    if (typeof hudPrev === "object" && engine) updateHud(); // 유형이 바뀐 내용을 먼저 그려 둬야 높이가 맞다
    function h(id) { return $(id).getBoundingClientRect().height; }
    var hl = h("hud-life"), hs = h("hud-left"), ha = h("hud-acc");
    if (!hl || !hs || !ha) return;
    ["life", "score", "acc", "judge"].forEach(function (k) { L[k].h = "left"; L[k].v = "top"; L[k].x = 0; });
    L.life.y = 0;
    L.score.y = Math.round(hl + STACK_GAP);
    L.acc.y = Math.round(L.score.y + hs + STACK_GAP);
    L.judge.y = Math.round(L.acc.y + ha + STACK_GAP);
    L.border.h = "left";
    L.border.v = "bottom";
    L.border.x = 0;
    L.border.y = L.comboMode === "box" ? -Math.round(h("hud-combo") + 6) : 0;
  }
  function applyLayout() {
    var L = settings.layout;
    document.body.classList.toggle("combo-in-clock", L.comboMode !== "box"); // 높이를 재기 전에 표시 유형부터
    document.body.classList.toggle("guide-keys", L.guideMode === "keys");
    document.body.classList.toggle("guide-off", L.guideMode === "off");
    var life = $("hud-life");
    life.classList.toggle("life-number", L.lifeStyle === "number");
    life.classList.toggle("life-gauge", L.lifeStyle === "gauge");
    if (typeof hudPrev === "object") hudPrev.counts = null; // 판정 표시 유형이 바뀌었을 수 있으니 다시 그린다
    autoPlaceDefaults(L);
    var titleSide = L.play.h === "left" ? "right" : "left"; // 시계 반대쪽(가운데면 왼쪽)
    var pauseSide = L.play.h === "right" ? "left" : "right";
    $("hud-title").classList.toggle("right", titleSide === "right");
    $("hud-title").classList.toggle("beside-pause", titleSide === pauseSide);
    $("btn-pause").classList.toggle("at-left", pauseSide === "left");
    // 양쪽 위 기준 자리: 그쪽에 있는 고정 요소(제목 · 일시정지) 아래
    var topOf = { left: LAYOUT_MARGIN_Y, right: LAYOUT_MARGIN_Y };
    topOf[titleSide] = Math.max(topOf[titleSide], $("hud-title").getBoundingClientRect().bottom + 8);
    topOf[pauseSide] = Math.max(topOf[pauseSide], $("btn-pause").getBoundingClientRect().bottom + 10);
    Object.keys(LAYOUT_EL).forEach(function (k) {
      var it = L[k];
      var el = $(LAYOUT_EL[k]);
      var ax = it.h === "left" ? LAYOUT_MARGIN_X : it.h === "right" ? W - LAYOUT_MARGIN_X : W / 2;
      var ay = it.v === "top" ? (topOf[it.h] || LAYOUT_MARGIN_Y) : it.v === "bottom" ? H - LAYOUT_MARGIN_Y : H / 2;
      el.style.left = Math.round(ax + it.x) + "px";
      el.style.top = Math.round(ay + it.y) + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      // 크기는 기준 자리를 중심으로 늘리고 줄인다(자리가 밀리지 않게)
      el.style.transformOrigin = H_FRAC[it.h] + "% " + V_FRAC[it.v] + "%";
      el.style.transform = "translate(-" + H_FRAC[it.h] + "%,-" + V_FRAC[it.v] + "%) scale(" + it.s / 100 + ")";
    });
  }
  // 편집 중: 시계에 가려지는 상자 표시(실제 플레이에서는 시계가 위에 그려져 안 보인다)
  function markUnderClock() {
    var on = document.body.classList.contains("layout-edit");
    Object.keys(LAYOUT_EL).forEach(function (k) {
      var el = $(LAYOUT_EL[k]);
      var hit = false;
      if (on && !(k === "combo" && settings.layout.comboMode !== "box")) {
        var r = el.getBoundingClientRect();
        var nx = Math.max(r.left, Math.min(CX, r.right));
        var ny = Math.max(r.top, Math.min(CY, r.bottom));
        hit = r.width > 0 && Math.hypot(CX - nx, CY - ny) < R * 1.125;
      }
      el.classList.toggle("under-clock", hit);
    });
  }

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width = cvBg.width = Math.round(W * DPR);
    cv.height = cvBg.height = Math.round(H * DPR);
    applyLayout();
    var BEZEL = 1.125; // 바깥 나무 테
    function edgeRadius(cx, cy) { return (Math.min(cx, W - cx, cy, H - cy) - 6) / BEZEL; }
    if (document.body.classList.contains("tutorial")) {
      // 튜토리얼: 오른쪽 카드와 아래 레인 키 칸 줄에 닿기 직전까지 키운다. 가운데를 조금 옮겨서 2% 넘게 커질 수 있으면 옮긴다.
      // 레인 키 칸은 시계 바로 아래 가운데에 두므로, 카드 왼쪽의 아래 한 줄(칸 높이)을 통째로 비워 둔다.
      var card = $("tut-card").getBoundingClientRect();
      var keysBox = $("tut-keys").getBoundingClientRect();
      var rects = card.width > 0 ? [card] : [];
      if (keysBox.height > 0) rects.push({ left: 0, right: card.width > 0 ? card.left : W, top: keysBox.top, bottom: H });
      var fitRadius = function (cx, cy) {
        var rMax = edgeRadius(cx, cy);
        rects.forEach(function (r) {
          var nx = Math.max(r.left, Math.min(cx, r.right)); // 상자에서 시계 중심에 가장 가까운 점
          var ny = Math.max(r.top, Math.min(cy, r.bottom));
          rMax = Math.min(rMax, (Math.sqrt((cx - nx) * (cx - nx) + (cy - ny) * (cy - ny)) - 12) / BEZEL);
        });
        return rMax;
      };
      CX = W / 2;
      CY = H / 2;
      var best = fitRadius(CX, CY);
      var center = best;
      for (var ix = -20; ix <= 20; ix++) {
        for (var iy = -20; iy <= 20; iy++) {
          var cx = W / 2 + (ix / 20) * W * 0.15;
          var cy = H / 2 + (iy / 20) * H * 0.15;
          var fr = fitRadius(cx, cy);
          if (fr > best && fr > center * 1.02) { best = fr; CX = cx; CY = cy; }
        }
      }
      R = Math.max(80, best);
      $("tut-keys").style.left = Math.round(CX) + "px";
    } else {
      // 본게임: UI 조정의 플레이 화면 자리. 화면 높이(가로가 좁으면 폭)에 맞춰 키우고, 좌·우면 그쪽 끝에 붙인다.
      // 점수 등 UI 상자는 시계 아래 층이라 겹쳐도 노트를 가리지 않는다.
      var P = settings.layout.play;
      var full = (Math.min(H / 2, W / 2) - 6) / BEZEL;
      var edge = full * BEZEL + 6;
      CX = P.h === "left" ? edge : P.h === "right" ? W - edge : W / 2;
      CY = H / 2;
      R = Math.max(80, Math.min(full, edgeRadius(CX, CY)));
    }
    // 콤보 알림은 시계 한가운데에 뜬다
    $("combo-burst").style.left = Math.round(CX) + "px";
    $("combo-burst").style.top = Math.round(CY) + "px";
    buildDialCache();
    markUnderClock();
  }
  function toScreen(p) { return { x: CX + p.x * R, y: CY + p.y * R }; }

  // ================= 색·모양 =================
  var OUTLINE = "#2A1A0E";
  var NOTE_STYLE = {};
  NOTE_STYLE[TYPE.TAP] = { base: "#D29A2E", hi: "#F6D77F", dark: "#8C6118", teeth: 10 }; // 놋쇠
  NOTE_STYLE[TYPE.LONG] = { base: "#C05A28", hi: "#EE9A68", dark: "#7E3414", teeth: 10 }; // 구리
  NOTE_STYLE[TYPE.CHASE] = { base: "#2A8A70", hi: "#6FD0B3", dark: "#175646", teeth: 8 }; // 청록(녹청)
  NOTE_STYLE[TYPE.HOLDTAP] = { base: "#3A62AA", hi: "#86A8E6", dark: "#223F75", teeth: 12 }; // 푸른 강철
  var CHORD_STYLE = { base: "#A7B1BF", hi: "#F3F6FA", dark: "#4F5A68", teeth: 10 }; // 은(동시치기)
  // 레인별 색: 1·2번 레인(왼손) 놋쇠, 3·4번 레인(오른손) 푸른 강철. 탭과 롱은 레인 색을 따르고, 체이스는 레인을 옮겨 다니므로 청록.
  var LANE_STYLE_LEFT = { base: "#D29A2E", hi: "#F6D77F", dark: "#8C6118", teeth: 10, line: "rgba(160,110,30,.5)", band: "rgba(210,154,46,.11)", ink: "#6E4C10" };
  var LANE_STYLE_RIGHT = { base: "#3A62AA", hi: "#86A8E6", dark: "#223F75", teeth: 10, line: "rgba(58,98,170,.45)", band: "rgba(58,98,170,.09)", ink: "#223F75" };
  function laneStyle(lane) { return lane < 2 ? LANE_STYLE_LEFT : LANE_STYLE_RIGHT; }
  // 안쪽 고리는 둘레가 짧아 회전이 느리면(30° 등) 1박 간격 태엽끼리 겹친다. 겹치지 않을 만큼만 그 레인 태엽을 줄인다.
  // 레인형은 키로만 판정하므로 크기는 보이는 데에만 영향이 있다.
  function laneGearScale(lane) {
    var arc = engine.laneRadius(lane) * (engine.degPerBeat() * Math.PI) / 180; // 1박 간격 태엽 중심 사이 거리(근사)
    return Math.min(1, (0.95 * arc) / (2 * 0.062 * NOTE_SCALE));
  }
  var NOTE_SCALE = 1.2; // 노트 크기 배율(태엽·사슬 전부). 에임형 1.5의 80%(09-29). 판정은 키로만 하므로 보이는 크기에만 영향
  var RANK_STYLE = {
    perfectPlus: { text: "PERFECT+", color: "#B97F0A", glow: "rgba(246,215,127,.95)" }, // 퍼펙트+(이론치): 퍼펙트보다 밝은 금빛 + 빛번짐(에임형과 같은 모양)
    perfect: { text: "PERFECT", color: "#A8740E" },
    great: { text: "GREAT", color: "#2E7D4F" },
    good: { text: "GOOD", color: "#3D6BA8" },
    miss: { text: "MISS", color: "#A83232" }
  };

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

  // 노트 태엽: 밝은 금속 몸체 + 굵은 어두운 테두리로 크림색 판 위에서 잘 보이게 한다.
  function drawGear(x, y, r, st, rot, alpha) {
    if (alpha <= 0) return;
    g.save();
    g.globalAlpha = alpha;
    g.translate(x, y);
    g.rotate(rot);
    gearPath(g, r, st.teeth, 0.25);
    var gr = g.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    gr.addColorStop(0, st.hi);
    gr.addColorStop(1, st.base);
    g.fillStyle = gr;
    g.fill();
    g.lineJoin = "round";
    g.lineWidth = Math.max(1.6, r * 0.11);
    g.strokeStyle = OUTLINE;
    g.stroke();
    g.lineWidth = Math.max(1, r * 0.07);
    g.strokeStyle = st.dark;
    g.beginPath();
    g.arc(0, 0, r * 0.5, 0, TAU);
    g.stroke();
    for (var s = 0; s < 4; s++) {
      var a = (s / 4) * TAU + Math.PI / 4;
      g.beginPath();
      g.moveTo(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2);
      g.lineTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
      g.stroke();
    }
    g.beginPath();
    g.arc(0, 0, r * 0.2, 0, TAU);
    g.fillStyle = OUTLINE;
    g.fill();
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
    g.lineWidth = Math.max(1.4, R * 0.005);
    g.strokeStyle = stroke;
    g.stroke();
  }

  // ================= 시계 판(고정 부분은 한 번만 그려 둔다) =================
  function buildDialCache() {
    var size = Math.ceil(R * 2.4);
    var oc = document.createElement("canvas");
    oc.width = oc.height = Math.round(size * DPR);
    var c = oc.getContext("2d");
    c.scale(DPR, DPR);
    c.translate(size / 2, size / 2);
    var i;

    // 그림자와 나무 테
    c.save();
    c.shadowColor = "rgba(63,38,22,.35)";
    c.shadowBlur = R * 0.08;
    c.shadowOffsetY = R * 0.03;
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
    c.strokeStyle = "rgba(30,16,8,.45)";
    c.lineWidth = 1;
    for (i = 0; i < 144; i++) {
      var ka = (i / 144) * TAU;
      c.beginPath();
      c.moveTo(Math.cos(ka) * R * 1.097, Math.sin(ka) * R * 1.097);
      c.lineTo(Math.cos(ka) * R * 1.12, Math.sin(ka) * R * 1.12);
      c.stroke();
    }

    // 로마 숫자(나무 테 위)
    c.fillStyle = "#F3E3BD";
    c.font = "700 " + Math.max(9, Math.round(R * 0.05)) + "px Cinzel, serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    var nums = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
    for (i = 0; i < 12; i++) {
      var na = (i / 12) * TAU - Math.PI / 2;
      c.save();
      c.translate(Math.cos(na) * R * 1.074, Math.sin(na) * R * 1.074);
      c.fillText(nums[i], 0, 0);
      c.restore();
    }

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
    c.strokeStyle = "rgba(107,66,38,.05)";
    c.lineWidth = 1;
    for (var gr = 0.12; gr < 1.0; gr += 0.025) {
      c.beginPath();
      c.arc(0, 0, R * gr, 0, TAU);
      c.stroke();
    }

    // 가운데 태엽(나선) 각인
    c.beginPath();
    for (var s = 0; s <= 1.0001; s += 0.002) {
      var sa = s * 5 * TAU;
      var sr = R * (0.08 + 0.13 * s);
      if (s === 0) c.moveTo(Math.cos(sa) * sr, Math.sin(sa) * sr);
      else c.lineTo(Math.cos(sa) * sr, Math.sin(sa) * sr);
    }
    c.strokeStyle = "rgba(107,66,38,.22)";
    c.lineWidth = Math.max(1, R * 0.006);
    c.stroke();

    // 레인(홈이 파인 궤도)
    engine.config.laneRadii.forEach(function (lr, li) {
      var ls = laneStyle(li);
      c.beginPath();
      c.arc(0, 0, R * lr, 0, TAU);
      c.strokeStyle = ls.band;
      c.lineWidth = R * 0.07;
      c.stroke();
      c.strokeStyle = ls.line;
      c.lineWidth = Math.max(1.2, R * 0.0035);
      c.stroke();
    });

    // 눈금: 60개, 박자(90도마다)는 놋쇠 마름모
    for (i = 0; i < 60; i++) {
      var ta = (i / 60) * TAU - Math.PI / 2;
      var major = i % 5 === 0;
      var r1 = R * (major ? 0.945 : 0.965);
      c.beginPath();
      c.moveTo(Math.cos(ta) * r1, Math.sin(ta) * r1);
      c.lineTo(Math.cos(ta) * R * 0.99, Math.sin(ta) * R * 0.99);
      c.strokeStyle = major ? "rgba(42,26,14,.7)" : "rgba(42,26,14,.35)";
      c.lineWidth = major ? Math.max(1.5, R * 0.006) : 1;
      c.stroke();
    }
    // 박자 표시: 판정선이 한 박자에 도는 각도마다 놋쇠 마름모를 둔다(회전 속도 설정을 따라감).
    var dpb = engine.degPerBeat();
    dialDeg = dpb;
    for (i = 0; i * dpb < 360 - 1e-6; i++) {
      var ba = ((i * dpb) / 360) * TAU - Math.PI / 2;
      c.save();
      c.translate(Math.cos(ba) * R * 0.967, Math.sin(ba) * R * 0.967);
      c.rotate(ba);
      c.beginPath();
      c.moveTo(-R * 0.028, 0);
      c.lineTo(0, -R * 0.014);
      c.lineTo(R * 0.028, 0);
      c.lineTo(0, R * 0.014);
      c.closePath();
      c.fillStyle = "#C99A40";
      c.fill();
      c.strokeStyle = OUTLINE;
      c.lineWidth = 1;
      c.stroke();
      c.restore();
    }
    dialCache = oc;
  }

  function drawDecorGear(x, y, r, teeth, rot) {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    gearPath(g, r, teeth, 0.12);
    g.fillStyle = "rgba(107,66,38,.05)";
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = "rgba(107,66,38,.12)";
    g.stroke();
    g.beginPath();
    g.arc(0, 0, r * 0.62, 0, TAU);
    g.stroke();
    g.beginPath();
    g.arc(0, 0, r * 0.16, 0, TAU);
    g.stroke();
    for (var s = 0; s < 6; s++) {
      var a = (s / 6) * TAU;
      g.beginPath();
      g.moveTo(Math.cos(a) * r * 0.16, Math.sin(a) * r * 0.16);
      g.lineTo(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62);
      g.stroke();
    }
    g.restore();
  }

  // ================= 시침(판정선) =================
  function drawHand(angleDeg) {
    var a = (angleDeg * Math.PI) / 180;
    var L = R;
    // 지나온 자리의 옅은 놋쇠 빛
    if (g.createConicGradient) {
      var sweep = 0.6;
      var start = a - Math.PI / 2 - sweep;
      var cg = g.createConicGradient(start, CX, CY);
      cg.addColorStop(0, "rgba(226,184,90,0)");
      cg.addColorStop(sweep / TAU, "rgba(226,184,90,.30)");
      cg.addColorStop(Math.min(1, sweep / TAU + 0.001), "rgba(226,184,90,0)");
      cg.addColorStop(1, "rgba(226,184,90,0)");
      g.beginPath();
      g.moveTo(CX, CY);
      g.arc(CX, CY, R * 0.97, start, start + sweep);
      g.closePath();
      g.fillStyle = cg;
      g.fill();
    }
    // 장식(구멍 뚫린 스페이드)은 가장 안쪽 레인보다 안에 두고, 레인 위로는 가는 바늘만 지나가게 해서
    // 판정 순간에 노트를 가리지 않게 한다.
    g.save();
    g.translate(CX, CY);
    g.rotate(a);
    g.beginPath();
    g.moveTo(-L * 0.016, L * 0.02);
    g.lineTo(-L * 0.014, -L * 0.085);
    g.bezierCurveTo(-L * 0.05, -L * 0.097, -L * 0.049, -L * 0.17, -L * 0.011, -L * 0.198);
    g.lineTo(-L * 0.005, -L * 0.5);
    g.lineTo(-L * 0.003, -L * 0.955);
    g.lineTo(L * 0.003, -L * 0.955);
    g.lineTo(L * 0.0055, -L * 0.5);
    g.lineTo(L * 0.011, -L * 0.198);
    g.bezierCurveTo(L * 0.049, -L * 0.17, L * 0.05, -L * 0.097, L * 0.014, -L * 0.085);
    g.lineTo(L * 0.016, L * 0.02);
    g.closePath();
    g.fillStyle = "#2A1A0E";
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = "#C99A40";
    g.stroke();
    g.beginPath();
    g.ellipse(0, -L * 0.14, L * 0.016, L * 0.027, 0, 0, TAU);
    g.fillStyle = "#E9DAB8";
    g.fill();
    // 꼬리와 균형추
    g.beginPath();
    g.moveTo(-L * 0.012, 0);
    g.lineTo(-L * 0.008, L * 0.13);
    g.lineTo(L * 0.008, L * 0.13);
    g.lineTo(L * 0.012, 0);
    g.closePath();
    g.fillStyle = "#2A1A0E";
    g.fill();
    g.beginPath();
    g.arc(0, L * 0.155, L * 0.03, 0, TAU);
    g.fill();
    g.strokeStyle = "#C99A40";
    g.stroke();
    g.restore();
  }

  // 판정 순간을 정확히 보이게 하는 가는 선. 노트 위에 한 번 더 그린다.
  function drawJudgeLine(angleDeg) {
    g.save();
    g.translate(CX, CY);
    g.rotate((angleDeg * Math.PI) / 180);
    g.beginPath();
    g.moveTo(0, -R * 0.2);
    g.lineTo(0, -R * 0.955);
    g.strokeStyle = "rgba(255,226,140,.95)";
    g.lineWidth = Math.max(1, R * 0.0035);
    g.stroke();
    g.restore();
  }

  function drawCap() {
    var cr = R * 0.058;
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
    g.beginPath();
    g.moveTo(CX - cr * 0.55, CY);
    g.lineTo(CX + cr * 0.55, CY);
    g.strokeStyle = "rgba(42,26,14,.75)";
    g.lineWidth = Math.max(1.5, cr * 0.16);
    g.stroke();
  }

  // ================= 노트 =================
  var noteAlphaMul = 1;

  function noteAlpha(n, t, lead) {
    if (n.state === "done" || n.state === "failed") return 0;
    var appear = n.t - lead;
    if (t < appear) return 0;
    return clamp01((t - appear) / (lead * 0.3)) * noteAlphaMul;
  }

  function strokeSpiral(n, a, b, st, alpha, pattern) {
    if (b - a < 1e-3 || alpha <= 0) return;
    var steps = Math.max(6, Math.ceil(((b - a) / engine.spb) * 28));
    var pts = [];
    for (var i = 0; i <= steps; i++) pts.push(toScreen(engine.notePos(n, a + ((b - a) * i) / steps)));
    strokePoints(pts, st, alpha, pattern);
  }

  // 누르는 노트의 길(사슬·구슬 줄·강철 띠)을 점 목록을 따라 그린다.
  function strokePoints(pts, st, alpha, pattern) {
    if (pts.length < 2 || alpha <= 0) return;
    g.save();
    g.globalAlpha = alpha;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    for (var i = 0; i < pts.length; i++) {
      if (i) g.lineTo(pts[i].x, pts[i].y); else g.moveTo(pts[i].x, pts[i].y);
    }
    g.strokeStyle = OUTLINE;
    g.lineWidth = R * 0.05 * NOTE_SCALE;
    g.stroke();
    g.strokeStyle = st.base;
    g.lineWidth = R * 0.033 * NOTE_SCALE;
    g.stroke();
    if (pattern === TYPE.LONG) {
      g.setLineDash([R * 0.032 * NOTE_SCALE, R * 0.02 * NOTE_SCALE]); // 사슬 고리
      g.strokeStyle = st.hi;
      g.lineWidth = R * 0.013 * NOTE_SCALE;
      g.stroke();
    } else if (pattern === TYPE.CHASE) {
      g.setLineDash([0.1, R * 0.045 * NOTE_SCALE]); // 구슬
      g.strokeStyle = "#F4FFF9";
      g.lineWidth = R * 0.019 * NOTE_SCALE;
      g.stroke();
    } else if (pattern === TYPE.HOLDTAP) {
      g.strokeStyle = st.hi;
      g.lineWidth = R * 0.008 * NOTE_SCALE;
      g.stroke();
    }
    g.restore();
  }

  function drawHoldBody(n, t, alpha) {
    var st = laneStyle(n.lane);
    var holding = n.state === "holding";
    var cur = holding ? Math.min(Math.max(t, n.t), n.end) : n.t;
    if (holding && cur > n.t) strokeSpiral(n, n.t, cur, st, alpha * 0.22, null);
    strokeSpiral(n, cur, n.end, st, alpha, n.type);
    // 끝 표시
    var e = toScreen(engine.notePos(n, n.end));
    g.save();
    g.globalAlpha = alpha;
    g.beginPath();
    g.arc(e.x, e.y, R * 0.026 * NOTE_SCALE, 0, TAU);
    g.fillStyle = st.hi;
    g.fill();
    g.lineWidth = Math.max(1.5, R * 0.006);
    g.strokeStyle = OUTLINE;
    g.stroke();
    g.restore();
  }

  function drawNoteHead(n, t, alpha) {
    var st = n.state === "idle" && CHORDS.of[n.id] ? CHORD_STYLE : laneStyle(n.lane);
    var gr = R * 0.062 * NOTE_SCALE * laneGearScale(n.lane);
    var spin = t * 1.3 * (n.id % 2 ? 1 : -1);
    g.save();
    g.globalAlpha = alpha;
    if (n.state === "holding") {
      var p = toScreen(engine.notePos(n, Math.min(t, n.end)));
      ring(p.x, p.y, gr * 1.3, "rgba(255,244,210,.95)", 3);
      g.restore();
      drawGear(p.x, p.y, gr * 0.85, st, spin * 2, alpha);
      return;
    }
    var s = toScreen(engine.posAt(n.t, n.lane));
    var until = n.t - t;
    if (until >= 0 && until <= engine.spb) {
      // 마지막 한 박자 동안 좁혀 드는 고리: 칠 순간을 알려 준다.
      var k = until / engine.spb;
      ring(s.x, s.y, gr * (1.12 + 0.8 * k), "rgba(140,97,24," + (0.95 * (1 - k)).toFixed(3) + ")", 2.5);
    }
    g.restore();
    drawGear(s.x, s.y, gr, st, spin, alpha);
  }

  function renderNotes(t) {
    var lead = engine.leadTime(settings.leadDeg);
    var list = engine.notes;
    var i, n, a;
    // 늦게 나올 노트를 먼저 그려서, 곧 칠 노트가 위에 오게 한다.
    for (i = list.length - 1; i >= 0; i--) {
      n = list[i];
      if (n.type === TYPE.TAP) continue;
      a = noteAlpha(n, t, lead);
      if (a > 0) drawHoldBody(n, t, a);
    }
    CHORDS.forEach(function (grp) {
      var idle = grp.filter(function (m) { return m.state === "idle"; });
      if (idle.length < 2) return;
      var ca = noteAlpha(idle[0], t, lead);
      if (ca > 0) drawChordLink(idle.map(function (m) { return toScreen(engine.posAt(m.t, m.lane)); }), ca, R * 0.062 * NOTE_SCALE);
    });
    for (i = list.length - 1; i >= 0; i--) {
      n = list[i];
      a = noteAlpha(n, t, lead);
      if (a > 0) drawNoteHead(n, t, a);
    }
  }

  // 동시치기 태엽을 잇는 흰 점선(점이 아니라 길게 끊긴 선). 크림색 판에서도 보이게 어두운 테두리를 먼저 깐다.
  function drawChordLink(pts, alpha, unit) {
    if (pts.length < 2) return;
    g.save();
    g.globalAlpha = alpha;
    g.lineCap = "butt";
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.setLineDash([unit * 0.95, unit * 0.45]);
    g.strokeStyle = "rgba(42,26,14,.8)";
    g.lineWidth = Math.max(4.5, unit * 0.34);
    g.stroke();
    g.strokeStyle = "#FFFFFF";
    g.lineWidth = Math.max(2.5, unit * 0.2);
    g.stroke();
    g.restore();
  }

  // 시침 뒤쪽(지나온 쪽)에 붙는 레인 키 글자와, 누르고 있는 레인의 빛.
  function laneScreen(angleDeg, lane, r) {
    var a = ((angleDeg - 90) * Math.PI) / 180;
    var rr = (r === undefined ? engine.laneRadius(lane) : r) * R;
    return { x: CX + Math.cos(a) * rr, y: CY + Math.sin(a) * rr };
  }
  function pressedKeys() { return (mode === "demo" || (mode === "rewinding" && rewindAnim && rewindAnim.back === "demo")) && demo ? demo.held : held; }
  function drawLaneGlow(angleDeg) {
    var pressed = pressedKeys();
    for (var i = 0; i < 4; i++) {
      if (!pressed["L" + i]) continue;
      var rr = engine.laneRadius(i) * R;
      var a = ((angleDeg - 90) * Math.PI) / 180;
      g.save();
      g.beginPath();
      g.arc(CX, CY, rr, a - 0.3, a + 0.06);
      g.strokeStyle = "rgba(226,184,90,.55)";
      g.lineWidth = R * 0.07;
      g.lineCap = "round";
      g.stroke();
      g.restore();
    }
  }
  // 레인 키 글자 표시(설정 keyHint)의 불투명도: 계속 1 · 끄기 0 · 시작만은 첫 노트가 시침에 닿은 뒤 KEY_HINT_FADE초에 걸쳐 0으로.
  // 첫 노트 앞으로 되감으면 다시 보인다. 튜토리얼은 키를 익히는 곳이라 설정과 무관하게 늘 보인다.
  var KEY_HINT_FADE = 1;
  function keyHintAlpha(t) {
    if (document.body.classList.contains("tutorial")) return 1;
    if (settings.keyHint === "off") return 0;
    if (settings.keyHint !== "start" || mode === "layout" || !engine.notes.length) return 1;
    return clamp01(1 - (t - engine.notes[0].t) / KEY_HINT_FADE);
  }
  function drawLaneLabels(angleDeg, alpha) {
    if (alpha <= 0) return;
    var pressed = pressedKeys();
    var cap = Math.max(16, R * 0.05);
    for (var i = 0; i < 4; i++) {
      var p = laneScreen(angleDeg - 11, i);
      var on = !!pressed["L" + i];
      g.save();
      g.globalAlpha = alpha;
      g.beginPath();
      if (g.roundRect) g.roundRect(p.x - cap * 0.62, p.y - cap * 0.55, cap * 1.24, cap * 1.1, 4);
      else g.rect(p.x - cap * 0.62, p.y - cap * 0.55, cap * 1.24, cap * 1.1);
      g.fillStyle = on ? "#E2B85A" : "rgba(251,246,236,.92)";
      g.fill();
      g.lineWidth = 1.8;
      g.strokeStyle = laneStyle(i).dark;
      g.stroke();
      g.fillStyle = laneStyle(i).ink;
      g.font = "700 " + Math.round(cap * 0.66) + "px Cinzel, serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(codeLabel(settings.keys[i]), p.x, p.y + 1);
      g.restore();
    }
  }

  // ================= 판정 표시 =================
  var popups = [];
  var sparks = [];
  // silent: 시연·미리보기처럼 타격음을 내지 않는 경우
  function onJudge(ev, perf, silent) {
    if (!silent) playEndSound(ev);
    var p = toScreen(ev);
    var rs = RANK_STYLE[ev.plus ? "perfectPlus" : ev.rank];
    var sub = "";
    if (settings.showDelta && ev.delta !== null && ev.rank !== "miss" && ev.slotKind !== "end") {
      var ms = Math.round(ev.delta * 1000);
      sub = (ms > 0 ? "+" : "") + ms + "ms";
    }
    popups.push({ x: p.x, y: p.y - R * 0.085, text: rs.text, color: rs.color, glow: rs.glow, sub: sub, born: perf });
    if (ev.rank === "perfect" || ev.rank === "great") {
      // 퍼펙트+는 불꽃을 더 많이, 더 밝게
      for (var i = 0; i < (ev.plus ? 11 : 7); i++) {
        var a = Math.random() * TAU;
        var sp = R * (0.25 + Math.random() * 0.35);
        sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, rot: a, born: perf, color: ev.plus ? "#F6D77F" : ev.rank === "perfect" ? "#E2B85A" : "#6FBF8F" });
      }
    }
  }
  function drawPopups(perf) {
    var life = 0.6;
    if (PREVIEW === null) popups = popups.filter(function (p) { return (perf - p.born) / 1000 < life; });
    g.textAlign = "center";
    g.textBaseline = "middle";
    popups.forEach(function (p) {
      var age = PREVIEW !== null ? 0.12 : (perf - p.born) / 1000;
      var y = p.y - age * R * 0.12;
      g.globalAlpha = 1 - age / life;
      g.font = "700 " + Math.round(R * (p.glow ? 0.064 : 0.058)) + "px Cinzel, serif"; // 퍼펙트+는 조금 크게
      g.lineWidth = 4;
      g.strokeStyle = "rgba(251,245,232,.95)";
      if (p.glow) { g.shadowColor = p.glow; g.shadowBlur = R * 0.03; }
      g.strokeText(p.text, p.x, y);
      g.shadowBlur = 0;
      g.fillStyle = p.color;
      g.fillText(p.text, p.x, y);
      if (p.sub) {
        g.font = "600 " + Math.round(R * 0.034) + "px Cinzel, serif";
        g.strokeText(p.sub, p.x, y + R * 0.05);
        g.fillStyle = "#5E4834";
        g.fillText(p.sub, p.x, y + R * 0.05);
      }
    });
    g.globalAlpha = 1;
  }
  function drawSparks(perf) {
    var life = 0.4;
    sparks = sparks.filter(function (s) { return (perf - s.born) / 1000 < life; });
    sparks.forEach(function (s) {
      var age = (perf - s.born) / 1000;
      var x = s.x + s.vx * age;
      var y = s.y + s.vy * age;
      g.save();
      g.globalAlpha = 1 - age / life;
      g.translate(x, y);
      g.rotate(s.rot + age * 6);
      g.fillStyle = s.color;
      g.strokeStyle = OUTLINE;
      g.lineWidth = 1;
      var k = R * 0.012;
      g.beginPath();
      g.moveTo(-k, k);
      g.lineTo(-k * 0.6, -k);
      g.lineTo(k * 0.6, -k);
      g.lineTo(k, k);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
    });
  }

  // ================= 커서 =================
  var cursorPx = { x: -9999, y: -9999 };
  function cursorNorm() { return { x: (cursorPx.x - CX) / R, y: (cursorPx.y - CY) / R }; }
  function drawCursor(p) {
    if (p.x < -999) return;
    var x = p.x;
    var y = p.y;
    var hr = engine.config.hitRadius * R;
    ring(x, y, hr, "rgba(42,26,14,.5)", 1.5);
    g.beginPath();
    g.moveTo(x - hr - 5, y); g.lineTo(x - hr + 5, y);
    g.moveTo(x + hr - 5, y); g.lineTo(x + hr + 5, y);
    g.moveTo(x, y - hr - 5); g.lineTo(x, y - hr + 5);
    g.moveTo(x, y + hr - 5); g.lineTo(x, y + hr + 5);
    g.strokeStyle = "rgba(42,26,14,.8)";
    g.lineWidth = 2;
    g.stroke();
    g.beginPath();
    g.arc(x, y, 3.2, 0, TAU);
    g.fillStyle = "#B8862B";
    g.fill();
    g.strokeStyle = OUTLINE;
    g.lineWidth = 1;
    g.stroke();
  }

  // 시계 안 콤보(UI 조정의 콤보 위치 유형). 노트가 늘 위에 오도록 판 바로 위 층에 옅게 그린다.
  function drawClockCombo() {
    var L = settings.layout;
    if (!L || L.comboMode === "box") return;
    var combo = mode === "demo" ? 0 : engine.getState().combo; // 튜토리얼 시연 중에는 0(상자와 같은 규칙)
    var sc = L.combo.s / 100;
    var y = CY + (R * L.comboY) / 100;
    g.save();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.globalAlpha = combo === 0 ? 0.35 : 0.62;
    g.fillStyle = "#3F2616";
    g.font = "700 " + Math.round(R * 0.15 * sc) + "px Cinzel, serif";
    g.fillText(String(combo), CX, y);
    g.font = "700 " + Math.round(R * 0.034 * sc) + "px Cinzel, serif";
    g.fillStyle = "#B8862B";
    g.fillText("C O M B O", CX, y + R * 0.105 * sc);
    g.restore();
  }

  // ================= 보더 =================
  // 지금 판에서 아직 살아 있는 기록: 올퍼펙트(전부 퍼펙트) · 풀콤보(굿·미스 없음) · 되돌리기 미사용.
  // 되돌리기를 쓰는 순간 셋 다 사라지고 그 판에서는 돌아오지 않는다(되감아 지운 실수로 풀콤보가 되살아나지 않게, 09-29 결정).
  function borderState() {
    var s = engine.getState();
    var c = s.counts;
    var nr = s.rewindsUsed === 0;
    return { ap: nr && c.miss === 0 && c.good === 0 && c.great === 0, fc: nr && c.miss === 0 && c.good === 0, nr: nr };
  }
  // 시계 바깥 테에 두르는 빛: 올퍼펙트면 갈색 주황, 풀콤보면 파랑, 둘 다 깨지면 없음.
  function drawBorderGlow() {
    var b = borderState();
    if (!b.fc) return;
    var col = b.ap ? "200,110,40" : "70,130,200"; // 보더 배지와 같은 색: AP 갈색 주황 · FC 파랑
    g.save();
    g.beginPath();
    g.arc(CX, CY, R * 1.128, 0, TAU);
    g.strokeStyle = "rgba(" + col + ",.95)";
    g.lineWidth = Math.max(3, R * 0.012);
    g.shadowColor = "rgba(" + col + ",.85)";
    g.shadowBlur = R * 0.035;
    g.stroke();
    g.restore();
  }

  // ================= 한 프레임 그리기 =================
  function render(perf, t) {
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    var spin = (t > 0 ? t : perf / 1000 * 0.12) * 0.45;
    // 장식 톱니는 맨 아래 층 캔버스에(점수 등 UI 상자를 가리지 않게)
    var gMain = g;
    g = gBg;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    drawDecorGear(Math.min(W * 0.08, CX - R * 1.4), H * 0.84, R * 0.62, 18, spin);
    drawDecorGear(Math.max(W * 0.93, CX + R * 1.45), H * 0.2, R * 0.42, 14, -spin * 1.45);
    g = gMain;
    var sz = dialCache.width / DPR;
    g.drawImage(dialCache, CX - sz / 2, CY - sz / 2, sz, sz);
    var inPlay = mode === "playing" || mode === "rewinding" || mode === "countdown" || mode === "paused" || mode === "demo" || mode === "gameover";
    if (inPlay && !inTutorialPlay()) drawBorderGlow(); // 튜토리얼에는 보더를 두지 않는다
    drawClockCombo(); // 콤보를 시계 안에 둔 경우: 판 위, 시침 · 노트 아래
    var ang = t < 0 ? 0 : engine.angleAt(t);
    drawHand(ang);
    drawLaneGlow(ang);
    renderNotes(t);
    drawJudgeLine(ang);
    drawLaneLabels(ang, keyHintAlpha(t));
    drawCap();
    drawSparks(perf);
    drawPopups(perf);
    if (mode === "demo" || (mode === "rewinding" && rewindAnim && rewindAnim.back === "demo")) drawDemoLabels(t);
  }

  // ================= HUD =================
  var hudPrev = {};
  (function buildLifeCells() {
    var box = $("life-cells");
    // 한 칸 = 미스 한 번(라이프 10)
    var n = Math.round(engine.getState().lifeMax / engine.config.lifePerMiss);
    for (var i = 0; i < n; i++) box.appendChild(document.createElement("i"));
  })();
  function setHtml(id, html) {
    if (hudPrev[id] === html) return;
    hudPrev[id] = html;
    $(id).innerHTML = html;
  }
  function updateHud() {
    var s = engine.getState();
    setHtml("score", String(s.score).padStart(7, "0")); // 퍼펙트+로 100만을 넘으면 자리가 늘어난다
    // 판정: 완전형(Perfect+ · Perfect · Great · Good · Miss와 수) / 간략형(색으로만 구분한 수). Perfect 수에는 Perfect+를 빼고 보인다.
    var c = s.counts;
    var JC = [["Perfect+", c.perfectPlus, "#B97F0A", "plus"], ["Perfect", c.perfect - c.perfectPlus, "#A8740E"], ["Great", c.great, "#2E7D4F"], ["Good", c.good, "#3D6BA8"], ["Miss", c.miss, "#A83232"]];
    setHtml("counts", settings.layout.judgeStyle === "color"
      ? '<div class="jc">' + JC.map(function (j) { return '<span class="' + (j[3] || "") + '" style="background:' + j[2] + '" title="' + j[0] + '">' + j[1] + "</span>"; }).join("") + "</div>"
      : JC.map(function (j) { return '<div class="jg ' + (j[3] || "") + '"><span class="nm" style="color:' + j[2] + '">' + j[0] + '</span><span class="n">' + j[1] + "</span></div>"; }).join(""));
    setHtml("penalty", s.penalty ? "되돌리기 감점 −" + fmtNum(s.penalty) : "");
    // 정확도: 지금까지 판정된 칸의 점수 배수 평균(퍼펙트+는 퍼펙트와 같게 1)
    var judged = c.perfect + c.great + c.good + c.miss;
    var w = engine.config.weights;
    var acc = judged ? ((c.perfect * w.perfect + c.great * w.great + c.good * w.good + c.miss * w.miss) / judged) * 100 : 100;
    setHtml("acc", acc.toFixed(2) + "%");
    var on = Math.round(s.life / 10);
    var low = isLowLife(s);
    var key = on + "|" + low;
    if (hudPrev.life !== key) {
      hudPrev.life = key;
      var cells = $("life-cells").children;
      for (var i = 0; i < cells.length; i++) cells[i].classList.toggle("off", i >= on);
      $("life-cells").classList.toggle("low", low);
      $("life-num").textContent = s.life;
    }
    // 빈사 경고: 연주 중(되감기·재개 대기·게임오버 연출 포함)에만 화면 가장자리를 붉게 깜박인다.
    var active = mode === "playing" || mode === "rewinding" || mode === "countdown" || mode === "gameover" || (mode === "preview" && params.has("danger"));
    document.body.classList.toggle("danger", active && (low || (mode === "preview" && params.has("danger"))));
    setHtml("rewinds", "되돌리기 <b>" + (isFinite(s.rewindsLeft) ? s.rewindsLeft : "∞") + "</b>");
    // 콤보는 상시 표시(왼쪽 아래). 25 단위 도달 알림(화면 한가운데)은 그대로 둔다. 튜토리얼 시연 중에는 0에 멈춰 둔다.
    var combo = mode === "demo" ? 0 : s.combo;
    if (hudPrev.combo !== combo) {
      var ce = $("combo");
      ce.textContent = combo;
      ce.classList.toggle("zero", combo === 0);
      if (combo > (hudPrev.combo || 0)) {
        ce.classList.remove("bump");
        void ce.offsetWidth;
        ce.classList.add("bump");
      }
      hudPrev.combo = combo;
    }
    var b = borderState();
    var bk = (b.ap ? "ap" : b.fc ? "fc" : "-") + "|" + b.nr;
    if (hudPrev.border !== bk) {
      hudPrev.border = bk;
      var cc = $("chip-combo");
      cc.className = "chip " + (b.ap ? "ap" : "fc") + (b.fc ? "" : " gone");
      cc.textContent = b.ap ? "ALL PERFECT" : "FULL COMBO";
      $("chip-nr").classList.toggle("gone", !b.nr);
    }
  }

  // 라이프가 최대치의 20% 이하(200이면 40 이하, 미스 4번 남음)면 빈사 상태로 본다.
  function isLowLife(s) { return s.life > 0 && s.life <= s.lifeMax * 0.2; }

  // 콤보 25 단위에 도달할 때마다 화면 한가운데에 잠깐 띄운다.
  var lastComboMark = 0;
  function checkComboBurst(combo) {
    var mark = Math.floor(combo / 25) * 25;
    if (mark < lastComboMark) lastComboMark = mark; // 콤보가 끊기거나 되감긴 경우 기준을 낮춘다
    if (mark >= 25 && mark > lastComboMark) {
      lastComboMark = mark;
      showComboBurst(mark);
    }
  }
  function showComboBurst(n) {
    var el = $("combo-burst");
    el.innerHTML = '<div class="n">' + n + '</div><div class="l">COMBO</div>';
    el.classList.remove("pop");
    void el.offsetWidth; // 애니메이션을 처음부터 다시 틀기 위해 한 번 배치를 강제한다
    el.classList.add("pop");
  }

  // ================= 흐름(상태) =================
  // title → select → countdown → playing ⇄ paused / rewinding → gameover → result
  // 튜토리얼: tutorial(단계 카드) → demo(자동 시연) → countdown → playing → tutorial(판정 결과)
  var mode = "title";
  var frozenTime = -0.5;
  var rewindAnim = null;
  var goSeq = null;
  var countdownToken = 0;
  var afterSettings = null;
  // 지금 판: { kind: "song"(곡 선택) | "test"(에디터 테스트, 기록 안 함) | "tutorial", chart(정리된 채보), from(시작 초), lesson }
  var session = null;

  var SCREENS = ["screen-title", "screen-select", "screen-sync", "screen-pause", "screen-settings", "screen-result", "screen-test"];
  function showScreen(id) {
    SCREENS.forEach(function (s) { $(s).classList.toggle("show", s === id); });
  }
  function setPlayingCursor(on) { document.body.classList.toggle("playing", on); }

  var toastTimer = 0;
  function toast(text, ms) {
    var el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, ms || 1600);
  }

  function runCountdown(done) {
    var token = ++countdownToken;
    mode = "countdown";
    var box = $("countdown");
    box.classList.add("show");
    var n = 3;
    function step() {
      if (token !== countdownToken) return;
      if (n === 0) {
        box.classList.remove("show");
        box.innerHTML = "";
        done();
        return;
      }
      box.innerHTML = "<span>" + n + "</span>";
      audio.click(audio.ctx.currentTime + 0.01, n === 1, 0.3);
      n--;
      setTimeout(step, 650);
    }
    step();
  }
  function cancelCountdown() {
    countdownToken++;
    $("countdown").classList.remove("show");
  }

  // 판마다 엔진을 새로 만든다. extra: 엔진 옵션 덮어쓰기(튜토리얼의 라이프·되돌리기 등)
  function useEngine(engChart, extra) {
    var o = engineOptions();
    if (extra) for (var k in extra) o[k] = extra[k];
    engine = TDE.createEngine(engChart, o);
    CHORDS = findChords(engine.notes);
    LAST_END = engChart.notes.reduce(function (m, n) { return Math.max(m, n.end); }, 0);
    lastComboMark = 0;
    if (dialCache && engine.degPerBeat() !== dialDeg) buildDialCache();
  }

  // 곡 제목(윗줄) · 난이도(아랫줄)
  function chartParts(c) { return { title: c.title, sub: TDC.difficultyLabel(c.difficulty) + " " + TDC.levelText(c.level) }; }
  function sessionParts() {
    if (!session) return null;
    if (session.kind === "tutorial") return { title: "튜토리얼", sub: (tut.index + 1) + "/" + LESSONS.length + " · " + session.lesson.name };
    if (session.kind === "setup") return { title: "처음 설정", sub: "가상 플레이" };
    var p = chartParts(session.chart);
    if (session.kind === "test") p.title = "[테스트] " + p.title;
    return p;
  }
  function sessionLabel() {
    var p = sessionParts();
    return p ? p.title + " · " + p.sub : "";
  }
  function setSongLabel(p) {
    $("song-title").textContent = p ? p.title : "";
    $("song-diff").textContent = p ? p.sub : "";
  }

  // 곡 선택·에디터 테스트에서 고른 채보로 시작한다. 음원을 불러온 뒤 카운트다운.
  // fromBeat: 테스트 플레이 시작 박자(그 앞 노트는 빼고 2초 전부터 튼다)
  function playChart(chart, kind, fromBeat) {
    if (!buffers[chart.song]) toast("음원 불러오는 중…", 4000);
    loadSong(chart.song).then(function (buf) {
      var eng = TDC.toEngineChart(chart);
      var from = 0;
      if (fromBeat > 0) {
        var t0 = chart.offset + (fromBeat * 60) / chart.bpm;
        eng.notes = eng.notes.filter(function (n) { return n.t >= t0 - 0.01; });
        from = Math.max(0, t0 - 2);
      }
      audio.buffer = buf;
      useEngine(eng);
      session = { kind: kind || "song", chart: chart, from: from };
      $("toast").classList.remove("show");
      startGame();
    }).catch(function (e) {
      toast("음원을 불러오지 못했습니다: " + (e && e.message ? e.message : e), 4000);
      if (mode !== "select") openSelect();
    });
  }

  function startGame() {
    if (!session) return;
    audio.stop();
    engine.setOptions(session.kind === "tutorial" ? tutEngineOptions(session.lesson) : engineOptions());
    engine.reset();
    engine.drainEvents();
    popups = [];
    sparks = [];
    noteAlphaMul = 1;
    frozenTime = session.from - offsetSec();
    audio.heldSong = session.from;
    lastComboMark = 0;
    hudPrev = {};
    releaseAllKeys();
    showScreen(null);
    setPlayingCursor(true);
    setSongLabel(sessionParts());
    audio.resume().then(function () {
      runCountdown(function () {
        if (audio.buffer) audio.play(session.from);
        else { audio.startClock(session.from); audio.startMetronome(TUT_SONG.bpm, LAST_END + 3); } // 음원 없는 튜토리얼
        mode = "playing";
      });
    });
  }

  function pauseGame() {
    if (mode === "countdown") {
      cancelCountdown();
      mode = "paused";
      setPlayingCursor(false);
      showPause();
      return;
    }
    if (mode !== "playing") return;
    audio.stop();
    frozenTime = audio.heldSong - offsetSec();
    mode = "paused";
    setPlayingCursor(false);
    showPause();
  }
  function inTutorialPlay() { return !!(session && session.kind === "tutorial"); }
  function showPause() {
    $("btn-stop").textContent = TEST_TAB ? "그만두기 (에디터로)" : session && session.kind === "tutorial" ? "그만두기 (단계 카드로)" : "그만두기 (곡 선택으로)";
    showScreen("screen-pause");
  }
  function resumeGame() {
    if (mode !== "paused") return;
    showScreen(null);
    setPlayingCursor(true);
    runCountdown(function () {
      if (audio.buffer) audio.play(audio.heldSong);
      else audio.startClock(audio.heldSong);
      mode = "playing";
    });
  }
  // 연주를 그만두고 곡 선택(튜토리얼이면 단계 카드)으로
  function quitPlay() {
    cancelCountdown();
    audio.stop();
    setPlayingCursor(false);
    engine.reset();
    engine.drainEvents();
    if (session && session.kind === "tutorial") { tutBackToCard(); return; }
    session = null;
    frozenTime = -0.5;
    openSelect();
  }

  function tryRewind(perf) {
    if (mode !== "playing" && mode !== "demo") return;
    if (session && session.kind === "tutorial") return; // 튜토리얼에서는 되돌리기를 쓰지 않는다
    var now = audio.songAt(perf) - offsetSec();
    var r = engine.rewind(now);
    if (!r.ok) {
      toast(r.reason === "limit" ? "되돌리기 횟수를 모두 썼습니다" : "지금은 되돌릴 수 없습니다");
      return;
    }
    audio.stop(perf);
    engine.drainEvents();
    popups = [];
    rewindAnim = { from: now, to: r.resumeAt, start: perf, dur: 750, back: mode };
    mode = "rewinding";
    // 태엽 감는 소리: 점점 빨라지는 딸깍
    var c = audio.ctx.currentTime;
    for (var i = 0; i < 9; i++) audio.click(c + 0.7 * (1 - Math.pow(1 - i / 9, 1.6)), false, 0.12);
    var left = engine.getState().rewindsLeft;
    toast("되돌리기 −" + fmtNum(engine.config.rewindPenalty) + (isFinite(left) ? " · 남은 횟수 " + left : ""));
  }
  function endRewind() {
    if (audio.buffer) audio.play(rewindAnim.to + offsetSec(), 0.03);
    else audio.startClock(rewindAnim.to + offsetSec(), 0.03);
    mode = rewindAnim.back || "playing";
  }

  // 라이프 0: 입력 차단 → 곡이 느려지며(음높이도 함께) 시침이 천천히 돌고 → 노트가 투명해져 사라지고 → 게임오버
  function startGameOver(perf) {
    mode = "gameover";
    goSeq = { start: perf, faded: false };
    releaseAllKeys();
    setPlayingCursor(false);
  }
  function stepGameOver(perf) {
    var p = clamp01((perf - goSeq.start) / 2800);
    var eased = 1 - (1 - p) * (1 - p);
    audio.setRate(Math.max(0.1, 1 - 0.9 * eased));
    if (!goSeq.faded && p > 0.5) {
      audio.fadeOut(1.3);
      goSeq.faded = true;
    }
    noteAlphaMul = 1 - clamp01(p / 0.75);
    if (p >= 1) finish("gameover");
  }

  function finish(kind) {
    var s = engine.getState();
    frozenTime = displayTime(performance.now());
    setPlayingCursor(false);
    if (kind === "clear") {
      audio.fadeOut(0.9);
      var id = audio.playId;
      setTimeout(function () { if (audio.playId === id) audio.stop(); }, 1000);
    } else {
      audio.stop();
    }
    if (session && session.kind === "tutorial") {
      mode = "tutorial";
      tutAfterPractice(s, kind);
      return;
    }
    mode = "result";
    var cleared = kind === "clear";
    var title = $("result-title");
    title.textContent = cleared ? "CLEAR" : "GAME OVER";
    title.classList.toggle("over", !cleared);
    $("result-song").textContent = sessionLabel();
    $("result-score").textContent = fmtNum(s.score);
    $("r-pp").textContent = s.counts.perfectPlus;
    $("r-p").textContent = s.counts.perfect - s.counts.perfectPlus; // 퍼펙트+를 뺀 퍼펙트
    $("r-g").textContent = s.counts.great;
    $("r-gd").textContent = s.counts.good;
    $("r-m").textContent = s.counts.miss;
    $("result-extra").innerHTML =
      "최대 콤보 <b>" + s.maxCombo + "</b> / 판정 " + s.total + "개 · 남은 라이프 <b>" + s.life + "</b> · 만점 " + fmtNum(s.maxScore) + "<br>" +
      "되돌리기 <b>" + s.rewindsUsed + "회</b>" + (s.penalty ? " (감점 −" + fmtNum(s.penalty) + ")" : "") +
      " · 싱크 오프셋 " + settings.offsetMs + "ms";
    // 기록: 곡 선택으로 시작한 판만 저장한다(에디터 테스트는 저장 안 함).
    var result = { cleared: cleared, score: s.score, counts: s.counts, maxCombo: s.maxCombo, total: s.total, rewindsUsed: s.rewindsUsed };
    var medal = TDSave.medalOf(result);
    var badges = "";
    if (cleared) badges += TDUI.rankBadge(TDSave.rankOf(s.score));
    if (medal) badges += TDUI.medalBadge(medal) + (TDUI.medalName(medal) ? " <b>" + TDUI.medalName(medal) + "</b>" : "");
    if (cleared) badges += s.rewindsUsed === 0 ? '<span class="badge nr">리와인드 미사용</span>' : '<span class="badge rw">리와인드 사용</span>'; // 횟수는 아래 줄에
    $("result-badges").innerHTML = badges;
    var best = "";
    var unlock = "";
    if (session.kind === "song") {
      var info = save.record(session.chart.id, result, library.charts);
      var rec = info.record;
      if (cleared && info.newBest) best = '<span class="up">최고 기록 갱신</span>' + (info.prevBest ? " (이전 " + fmtNum(info.prevBest) + ", +" + fmtNum(s.score - info.prevBest) + ")" : "");
      else if (rec.clears) best = "최고 기록 " + fmtNum(rec.bestScore) + " " + (rec.bestRank || "");
      else best = "아직 클리어 기록이 없습니다";
      best += " · 클리어 " + rec.clears + "회"; // 플레이 횟수 대신 클리어 횟수
      if (info.newMedal && medal) best += ' · <span class="up">새 보더 ' + TDSave.MEDAL_LABEL[medal] + "</span>";
      // 랭킹: 공식 채보의 판은 클리어 · 게임오버 모두 서버에 올린다(09-30, 게임오버는 랭킹에 FAIL로)
      if (session.chart.official && TDAccount.me()) best += ' · <span id="result-upload">랭킹에 올리는 중…</span>';
      else if (TDAccount.me()) best += session.chart.old ? " · 예전 버전이라 랭킹에 올리지 않습니다" : " · 커스텀 채보라 랭킹에 올리지 않습니다";
      if (info.unlocked.length) {
        unlock = "새로 열림: " + info.unlocked.map(function (id) {
          var c = library.charts.filter(function (x) { return x.id === id; })[0];
          return c ? TDUI.esc(c.title) + " [" + TDC.difficultyLabel(c.difficulty) + "]" : id;
        }).join(", ");
      }
    } else {
      best = "테스트 플레이라 기록하지 않습니다";
    }
    $("result-best").innerHTML = best;
    if (session.kind === "song" && session.chart.official && TDAccount.me()) uploadScore(session.chart, result, medal, cleared);
    $("result-unlock").innerHTML = unlock;
    $("result-unlock").hidden = !unlock;
    $("btn-result-select").textContent = TEST_TAB ? "에디터로 (Esc)" : "곡 선택";
    $("btn-result-title").style.display = TEST_TAB ? "none" : "";
    showScreen("screen-result");
  }

  function displayTime(perf) {
    switch (mode) {
      case "playing":
      case "gameover":
      case "demo":
        return audio.songAt(perf) - offsetSec();
      case "rewinding":
        var p = clamp01((perf - rewindAnim.start) / rewindAnim.dur);
        var e = 1 - Math.pow(1 - p, 3);
        return rewindAnim.from + (rewindAnim.to - rewindAnim.from) * e;
      case "preview":
        return PREVIEW;
      default:
        return frozenTime;
    }
  }

  function step(perf) {
    if (mode === "playing") {
      var t = displayTime(perf);
      engine.update(t, cursorNorm(), held);
      engine.drainEvents().forEach(function (ev) { if (ev.kind === "judge") onJudge(ev, perf); });
      checkComboBurst(engine.getState().combo);
      var s = engine.getState();
      if (s.gameOver) startGameOver(perf);
      else if (s.finished && t > LAST_END + 1.5) finish("clear");
      else if (audio.buffer && t + offsetSec() > audio.buffer.duration) finish("clear");
    } else if (mode === "demo") {
      demoStep(perf);
    } else if (mode === "gameover") {
      stepGameOver(perf);
    } else if (mode === "rewinding" && perf - rewindAnim.start >= rewindAnim.dur) {
      endRewind();
    } else if (mode === "sync") {
      stepSync(perf);
    }
  }
  function frame() {
    // 화면 갱신 신호의 시각 대신 지금 시각을 쓴다(입력 시각과 같은 기준을 유지).
    var perf = performance.now();
    step(perf);
    render(perf, displayTime(perf));
    updateHud();
    requestAnimationFrame(frame);
  }

  // ================= 공식 채보 · 랭킹 =================
  // 공식 채보는 서버(소유자가 게시)에서 받는다. 같은 id의 로컬 채보는 공식판으로 바꾸고, 로컬에 없는 공식 채보는 더한다.
  // 나머지(이 기기에만 있는 채보)는 커스텀: 기록은 계정에 남지만 랭킹에는 올리지 않는다. 채보의 official = { row, version } 또는 null.
  // 예전 공식 버전(09-30): 같은 채보에 지금 버전이 있을 때만(내린 채보는 숨김) 곡을 따로 한 줄 "제목 (old 게시한 날)"로 더한다.
  //   채보 id · 곡 묶음은 "<원래>_old-v<버전>"(기록이 지금 버전과 따로 쌓인다), old = { row, version, date }, 랭킹 없음.
  var localCharts = []; // 이 기기의 채보(서버로 연 경우 charts 폴더, 아니면 사본)
  var official = []; // 서버의 지금 버전 공식 채보
  var officialOld = []; // 서버의 예전 버전(지금 버전이 있는 채보만)
  function mmdd(iso) {
    var d = new Date(iso);
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return two(d.getMonth() + 1) + "-" + two(d.getDate());
  }
  function withOfficial(charts) {
    var byId = {};
    official.forEach(function (o) { byId[o.chart_id] = o; });
    function fromServer(o) {
      var oc = TDC.normalizeChart(o.data, o.chart_id);
      oc.official = { row: o.id, version: o.version };
      return oc;
    }
    var out = charts.map(function (c) {
      var o = byId[c.id];
      if (!o) { c.official = null; return c; }
      delete byId[c.id];
      return fromServer(o);
    });
    Object.keys(byId).forEach(function (id) { out.push(fromServer(byId[id])); });
    officialOld.forEach(function (o) {
      var oc = TDC.normalizeChart(o.data, o.chart_id);
      var tag = "_old-v" + o.version;
      oc.id = o.chart_id + tag;
      oc.songId = oc.songId + tag;
      oc.title = oc.title + " (old " + mmdd(o.published_at) + ")";
      oc.order = (oc.order || 0) + 1000; // 지금 버전들 아래
      oc.official = null;
      oc.old = { row: o.id, version: o.version, date: o.published_at };
      out.push(oc);
    });
    return out;
  }
  function refreshOfficial() {
    if (!TDAccount.me()) return Promise.resolve();
    // 예전 account.js(모든 버전 받기 없음)가 섞여 들어와도 멈추지 않게 지금 버전만 받는 쪽으로 물러선다
    return Promise.resolve().then(function () {
      if (TDAccount.loadOfficialAll) return TDAccount.loadOfficialAll(MODE);
      return TDAccount.loadOfficialCharts(MODE).then(function (rows) { return (rows || []).map(function (r) { return Object.assign({ is_current: true }, r); }); });
    }).then(function (rows) {
      rows = rows || [];
      official = rows.filter(function (r) { return r.is_current; });
      var live = {};
      official.forEach(function (r) { live[r.chart_id] = true; });
      officialOld = rows.filter(function (r) { return !r.is_current && live[r.chart_id]; }); // 내린 채보(지금 버전 없음)는 예전 버전까지 숨긴다
      rankCache = {};
    }, function (e) { toast("공식 채보를 받지 못했습니다: " + TDAccount.errorText(e), 4000); });
  }
  // 랭킹 상태(shared/ui.js rankingHtml): 채보 id마다 한 번 불러 두고, 곡 선택을 열 때마다 새로 받는다.
  var rankCache = {};
  function rankingFor(c) {
    if (!TDAccount.me()) return { status: "none" };
    if (c.old) return { status: "old" };
    if (!c.official) return { status: "custom" };
    if (rankCache[c.id]) return rankCache[c.id];
    rankCache[c.id] = { status: "loading" };
    TDAccount.getRanking(MODE, c.id).then(function (rows) {
      rankCache[c.id] = { status: "ok", entries: rows || [] };
    }, function (e) {
      rankCache[c.id] = { status: "error", message: TDAccount.errorText(e) };
    }).then(function () { if (songSelect) songSelect.refreshRanking(); });
    return rankCache[c.id];
  }
  // 공식 채보를 클리어하면 기록을 서버에 올린다(규칙 값을 함께 보내, 서버의 지금 규칙과 다르면 거절된다).
  function uploadScore(chart, result, medal, cleared) {
    var el = $("result-upload");
    TDAccount.submitScore({
      row: chart.official.row, cleared: !!cleared, score: result.score, grade: cleared ? TDSave.rankOf(result.score) : null, medal: medal, // 게임오버는 등급 없이 FAIL
      maxCombo: result.maxCombo, rewindsUsed: result.rewindsUsed, rewindLimit: settings.rewindLimit, rewindPenalty: settings.rewindPenalty
    }).then(function () {
      delete rankCache[chart.id];
      if (el) el.textContent = "랭킹에 올렸습니다";
    }, function (e) {
      if (el) { el.textContent = "랭킹에 올리지 못했습니다: " + TDAccount.errorText(e); el.className = "no"; }
    });
  }

  // ================= 곡 선택 =================
  var songSelect = null;
  function openSelect() {
    mode = "select";
    session = null;
    frozenTime = -0.5;
    if (!songSelect) {
      songSelect = TDUI.songSelect($("select-body"), {
        charts: library.charts, errors: library.errors, save: save, online: library.online,
        onPlay: function (c) { playChart(c, "song", 0); },
        diffSlots: ["easy", "normal", "hard"], // 난이도 3칸(쉬움 · 보통 · 어려움, 에임형과 같다)
        onBack: function () { mode = "title"; renderTitle(); showScreen("screen-title"); },
        onLayout: function () { openLayout("select"); },
        onSettings: function () { setSelectSettings(!selectSettingsOpen); },
        settingsOpen: function () { return selectSettingsOpen; },
        rankingEl: $("select-ranking"), ranking: rankingFor // 왼쪽 랭킹(공식 채보만)
      });
    }
    songSelect.render();
    showScreen("screen-select");
    // 열 때마다 공식 채보(랭킹도 새로)를 다시 받고, 서버로 연 경우 채보 폴더도 다시 읽는다(에디터에서 방금 저장한 채보도 바로 보이게).
    var reload = !library.online ? null : TDLibrary.load(MODE).then(function (lib) {
      library = lib;
      localCharts = lib.charts;
    }, function () { /* 못 읽으면 이전 목록 그대로 */ });
    Promise.all([reload, refreshOfficial()]).then(function () {
      library.charts = withOfficial(localCharts);
      save.setCharts(library.charts);
      songSelect.setCharts(library.charts, library.errors);
      if (mode === "select") songSelect.render();
    });
  }

  // ================= 입력 =================
  var held = {};
  // 누른 키 칸을 켠다: 오른쪽 아래 조작 안내와 튜토리얼 아래 레인 키 칸 모두
  function setCap(k, on) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-cap="' + k + '"]'), function (el) { el.classList.toggle("on", on); });
  }
  function strikeDown(k, ts) {
    if (held[k]) return;
    held[k] = true;
    setCap(k, true);
    if (mode === "sync") { syncTap(ts); return; }
    if (mode === "playing") playHitsound(engine, engine.pressLane(laneOfKey(k), audio.songAt(ts) - offsetSec(), k));
  }
  // 타격음은 노트에 묶고, 소리는 판정 등급으로만 가른다. 누른 순간 노트를 맞혔으면 그 판정 등급의 째깍, 빈 곳·미스는 소리 없음.
  function playHitsound(eng, hitNote) {
    if (hitNote) audio.hit(eng.lastRank());
  }
  // 누르는 노트의 끝을 성공하면(끝 근처에서 뗌) 그 끝 판정 등급의 째깍.
  function playEndSound(ev) {
    if (ev.slotKind === "end" && ev.rank !== "miss") audio.hit(ev.rank);
  }
  function strikeUp(k, ts) {
    if (!held[k]) return;
    delete held[k];
    setCap(k, false);
    if (mode === "playing") engine.release(k, audio.songAt(ts) - offsetSec());
  }
  function releaseAllKeys() {
    Object.keys(held).forEach(function (k) { delete held[k]; setCap(k, false); });
  }

  function onEscape() {
    if ($("screen-settings").classList.contains("show")) { closeSettings(); return; }
    if (TEST_TAB) { backToEditor(); return; } // 테스트 플레이 탭: 어느 화면이든 에디터로
    if (setup) { finishSetup(); return; } // 처음 설정: 지금 설정 그대로 마친다
    if (mode === "layout") { closeLayout(); return; }
    if (mode === "select" && selectSettingsOpen) { setSelectSettings(false); return; } // 먼저 옆 설정을 접는다
    if (mode === "playing" || mode === "countdown") { if (!inTutorialPlay()) pauseGame(); } // 튜토리얼은 일시정지 없음
    else if (mode === "paused") resumeGame();
    else if ((mode === "demo" || mode === "tutorial") && tut.skipWarn) { tut.skipWarn = 0; renderTutCard(); } // 건너뛰기 경고만 닫는다
    else if (mode === "demo") closeTutorial(false);
    else if (mode === "tutorial") { if (tut.phase !== "loading") closeTutorial(false); }
    else if (mode === "select") { mode = "title"; renderTitle(); showScreen("screen-title"); }
    else if (mode === "result") openSelect();
    else if (mode === "sync") syncDone();
    else if (mode === "test-prompt") openSelect();
  }

  window.addEventListener("keydown", function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return; // 글자 입력 칸(로그인 창 등)
    if (keyCapture !== null) { captureKey(e); return; }
    if (e.code === "Escape") {
      e.preventDefault();
      if (!e.repeat) onEscape();
      return;
    }
    if (mode === "select" && songSelect && $("screen-select").classList.contains("show")) {
      if (songSelect.handleKey(e)) e.preventDefault();
      return;
    }
    if ((mode === "tutorial" || mode === "demo") && e.code === "Enter") {
      e.preventDefault();
      if (!e.repeat) tutPrimary();
      return;
    }
    if (e.code === settings.rewindKey) {
      e.preventDefault();
      if (!e.repeat) { setCap("RW", true); tryRewind(e.timeStamp); }
      return;
    }
    var k = laneKeyOf(e.code);
    if (!k) return;
    e.preventDefault();
    if (!e.repeat) strikeDown(k, e.timeStamp);
  });
  window.addEventListener("keyup", function (e) {
    if (e.code === settings.rewindKey) { setCap("RW", false); return; }
    var k = laneKeyOf(e.code);
    if (k) strikeUp(k, e.timeStamp);
  });
  window.addEventListener("mousemove", function (e) {
    cursorPx.x = e.clientX;
    cursorPx.y = e.clientY;
  });
  window.addEventListener("blur", function () {
    if ((mode === "playing" || mode === "countdown") && !inTutorialPlay()) pauseGame();
    releaseAllKeys();
  });
  window.addEventListener("resize", resize);

  // ================= 싱크 맞추기 =================
  var sync = null;
  function renderOffset() {
    $("offset-val").textContent = (settings.offsetMs > 0 ? "+" : "") + settings.offsetMs + "ms";
  }
  function openSync() {
    mode = "sync";
    sync = null;
    showScreen("screen-sync");
    renderOffset();
    $("sync-count").textContent = "준비";
    $("sync-hint").textContent = "측정 시작을 누르면 소리가 납니다";
    $("sync-avg").textContent = "–";
    $("btn-sync-apply").disabled = true;
    clearSyncDots();
  }
  function clearSyncDots() {
    Array.prototype.slice.call(document.querySelectorAll("#sync-track .tick")).forEach(function (d) { d.remove(); });
  }
  function startMeasure() {
    audio.resume().then(function () {
      var c = audio.ctx;
      var t0 = c.currentTime + 0.6;
      sync = { clicks: [], used: {}, deltas: [], lead: 4, done: false, median: null };
      for (var i = 0; i < 20; i++) {
        var at = t0 + i * 0.5;
        sync.clicks.push(at);
        audio.click(at, i % 4 === 0);
      }
      clearSyncDots();
      $("sync-avg").textContent = "–";
      $("btn-sync-apply").disabled = true;
    });
  }
  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function syncTap(ts) {
    if (!sync || sync.done) return;
    var tc = audio.heardCtx(ts);
    var best = -1;
    var bestD = 0;
    sync.clicks.forEach(function (c, i) {
      var d = tc - c;
      if (best < 0 || Math.abs(d) < Math.abs(bestD)) { best = i; bestD = d; }
    });
    if (best < sync.lead || Math.abs(bestD) > 0.25 || sync.used[best]) return;
    sync.used[best] = true;
    var ms = bestD * 1000;
    sync.deltas.push(ms);
    var dot = document.createElement("span");
    dot.className = "tick";
    dot.style.left = (50 + (Math.max(-150, Math.min(150, ms)) / 150) * 48) + "%";
    $("sync-track").appendChild(dot);
    sync.median = Math.round(median(sync.deltas));
    $("sync-avg").textContent = (sync.median > 0 ? "+" : "") + sync.median + "ms (" + sync.deltas.length + "회)";
    if (sync.deltas.length >= 4) $("btn-sync-apply").disabled = false;
  }
  function stepSync(perf) {
    var bob = $("sync-bob");
    if (!sync) { bob.classList.remove("beat"); return; }
    var heard = audio.heardCtx(perf);
    var idx = -1;
    for (var i = 0; i < sync.clicks.length; i++) if (sync.clicks[i] <= heard) idx = i;
    bob.classList.toggle("beat", idx >= 0 && heard - sync.clicks[idx] < 0.09);
    bob.classList.toggle("lead", idx < sync.lead);
    if (idx < 0) $("sync-count").textContent = "곧 시작";
    else if (idx < sync.lead) $("sync-count").textContent = "듣기 " + (idx + 1);
    else $("sync-count").textContent = sync.deltas.length + " / 16";
    if (!sync.done && heard > sync.clicks[sync.clicks.length - 1] + 0.4) {
      sync.done = true;
      $("sync-hint").textContent = sync.deltas.length >= 4 ? "측정 끝. 측정값 적용 후 시작하세요." : "입력이 너무 적습니다. 다시 측정해 주세요.";
    } else if (!sync.done) {
      $("sync-hint").textContent = idx < sync.lead ? "소리를 들으며 박자를 느끼세요" : "소리에 맞춰 누르세요";
    }
  }
  $("screen-sync").addEventListener("mousedown", function (e) {
    if (e.target.closest("button")) return;
    if (e.button === 0 || e.button === 2) syncTap(e.timeStamp);
  });
  $("btn-sync-measure").addEventListener("click", startMeasure);
  $("btn-sync-apply").addEventListener("click", function () {
    if (!sync || sync.median === null) return;
    settings.offsetMs = sync.median;
    saveSettings();
    renderOffset();
    toast("오프셋 " + settings.offsetMs + "ms 적용");
  });
  Array.prototype.slice.call(document.querySelectorAll("[data-off]")).forEach(function (b) {
    b.addEventListener("click", function () {
      settings.offsetMs = Math.max(-300, Math.min(300, settings.offsetMs + parseInt(b.getAttribute("data-off"), 10)));
      saveSettings();
      renderOffset();
    });
  });
  var firstRun = false; // 처음 켠 경우: 싱크 화면을 마치면 이어서 튜토리얼을 연다
  var syncReturn = null; // "select": 곡 선택 옆 플레이 설정에서 왔다(끝나면 곡 선택으로)
  function syncDone() {
    sync = null;
    if (syncReturn === "select") {
      syncReturn = null;
      openSelect();
      if (selectSettingsOpen) buildSettings($("select-settings-body")); // 새 오프셋을 보이게
      return;
    }
    if (firstRun) {
      firstRun = false;
      openTutorial();
      return;
    }
    mode = "title";
    renderTitle();
    showScreen("screen-title");
  }
  $("btn-sync-back").addEventListener("click", syncDone);

  // ================= 설정 =================
  // locked: 서버의 게임 규칙(목업별). 관리자 이상만 바꾸고, 바꾸면 모든 플레이어에게 적용된다(맨 아래에 모아 둔다)
  var SETTING_DEFS = [
    { key: "degPerBeat", label: "박자당 회전 각도", range: [15, 150, 15] }, // 15° 단위 15 ~ 150°(09-30), 슬라이더
    { key: "rewindSeconds", label: "되돌리기 간격", options: [[2, "2초"], [3, "3초"], [4, "4초"], [5, "5초"]] },
    { key: "leadDeg", label: "노트 등장 시점", options: [[180, "반 바퀴 전"], [270, "3/4 바퀴 전"]] },
    { key: "showDelta", label: "판정 오차 표시", options: [[true, "켜기"], [false, "끄기"]] },
    // 시침 뒤 레인 키 글자. 시작만 = 첫 노트가 시침에 닿은 뒤 1초에 걸쳐 사라진다(첫 노트 앞으로 되감으면 다시 보임)
    { key: "keyHint", label: "레인 키 표시", options: [["always", "계속"], ["start", "시작만"], ["off", "끄기"]] },
    { key: "hitsound", label: "타격음", options: [[true, "켜기"], [false, "끄기"]] },
    { key: "rewindLimit", label: "되돌리기 횟수", locked: true, options: [[-1, "무제한"], [3, "3회"], [1, "1회"], [0, "없음"]] },
    { key: "rewindPenalty", label: "되돌리기 감점", locked: true, options: [[0, "0"], [10000, "10,000"], [30000, "30,000"], [50000, "50,000"]] }
  ];
  // 설정 설명(이름 아래 작은 줄, 09-30): 읽고 체감할 수 있게
  var SETTING_HELP = {
    degPerBeat: "시침이 한 박에 도는 각도입니다. 각도가 클수록 시침이 빨리 돌아 노트 사이가 넓게 벌어지고, 작을수록 천천히 돌아 노트가 촘촘하게 모입니다.",
    leadDeg: "노트가 시침에 닿기 얼마 전부터 보일지입니다. 3/4 바퀴 전이면 더 일찍 보이는 대신 한 화면에 노트가 많아집니다.",
    rewindSeconds: "되돌리기 키를 누르면 몇 초 전으로 돌아갈지입니다.",
    rewindKey: "되돌리기에 쓸 키입니다. 버튼을 누른 뒤 원하는 키를 누르세요(Esc 취소). 입력 키와 Enter는 쓸 수 없습니다.",
    showDelta: "판정마다 얼마나 빠르거나 느렸는지(ms)를 보여 줍니다.",
    hitsound: "노트를 칠 때 소리를 냅니다.",
    keyHint: "시침 뒤에 레인 키 글자를 보여 줄지입니다.",
    keys: "레인마다 쓸 키입니다. 버튼을 누른 뒤 원하는 키를 누르세요.",
    volume: "음악 소리 크기입니다.",
    hitVolume: "타격음 크기입니다.",
    offsetMs: "판정이 늘 한쪽으로 치우치면 조정합니다. 「싱크 맞추기」로 재면 자동으로 맞춰집니다."
  };
  // 잠긴 설정(게임 규칙)은 관리자 이상 계정으로 로그인했을 때만 풀린다
  function settingsUnlocked() { return TDAccount.isAdmin(TDAccount.me()); }
  // 서버의 게임 규칙 { rewind_limit, rewind_penalty }를 설정에 적용한다(켤 때 받은 값 · 관리자가 바꾼 값)
  function applyRules(r) {
    if (!r) return;
    settings.rewindLimit = r.rewind_limit;
    settings.rewindPenalty = r.rewind_penalty;
    saveSettings();
    engine.setOptions(engineOptions());
  }
  function saveRule(key, value, done) {
    // 바꾼 항목 하나만 쓴다(09-30): 다른 탭 · 예전 화면이 들고 있던 나머지 값으로 서버 값을 덮어쓰지 않게
    var next = {};
    next[key === "rewindLimit" ? "rewind_limit" : "rewind_penalty"] = value;
    TDAccount.saveRules(MODE, next).then(function (r) {
      applyRules(r);
      toast("게임 규칙을 서버에 저장했습니다(모든 플레이어에게 적용)", 2600);
      done();
    }, function (e) {
      toast("게임 규칙을 저장하지 못했습니다: " + TDAccount.errorText(e), 4000);
      done();
    });
  }
  // target: 그릴 곳. 생략하면 설정 화면, 곡 선택 옆 플레이 설정이면 그 칸(기록 줄은 빼고 플레이 관련만).
  // 순서: 음량 → 싱크 오프셋 → 일반 항목 → 타격음 음량 → 레인 키 → 잠긴 항목(되돌리기 횟수·감점) → 기록(설정 화면만)
  // only: 이 항목만 그린다(처음 설정 화면. 설정 키 이름 · "volume" · "hitVolume" · "offsetMs" · "keys"). 없으면 전부.
  function buildSettings(target, only) {
    var body = target || $("settings-body");
    function rebuild() { buildSettings(target, only); }
    function want(k) { return !only || only.indexOf(k) >= 0; }
    body.innerHTML = "";
    // extra: 이름 줄 오른쪽에 붙일 요소(있으면)
    function row(label, el, extra, help) {
      var k = document.createElement("div");
      k.className = "k";
      k.textContent = label;
      if (extra) {
        k.classList.add("k-row");
        var grow = document.createElement("span");
        grow.className = "grow";
        k.appendChild(grow);
        k.appendChild(extra);
      }
      if (help) {
        var hp = document.createElement("small");
        hp.className = "k-help";
        hp.textContent = help;
        k.appendChild(hp);
      }
      body.appendChild(k);
      body.appendChild(el);
      return k;
    }
    function playLockNote(k) {
      var note = document.createElement("small");
      note.className = "k-note";
      note.textContent = "연주 중 변경 불가";
      k.appendChild(note); // 이름 칸 아래 작은 줄
    }
    // 일시정지에서 연 설정: 판정선 속도(박자당 회전 각도) · 되돌리기 간격 · 레인 키는 바꿀 수 없다(연주 중인 판의 진행·누르고 있는 키가 달라지므로)
    var inPlay = !target && afterSettings === "screen-pause";
    var PLAY_LOCKED = ["degPerBeat", "rewindSeconds"];
    function segRow(d, disabled) {
      var playLocked = inPlay && PLAY_LOCKED.indexOf(d.key) >= 0;
      if (playLocked) disabled = true;
      var seg = document.createElement("div");
      seg.className = "seg";
      d.options.forEach(function (o) {
        var b = document.createElement("button");
        b.textContent = o[1];
        if (settings[d.key] === o[0]) b.className = "on";
        b.disabled = !!disabled;
        b.onclick = function () {
          if (d.locked) { saveRule(d.key, o[0], rebuild); return; }
          settings[d.key] = o[0];
          saveSettings();
          engine.setOptions(engineOptions());
          if (d.key === "degPerBeat") buildDialCache();
          rebuild();
          if (setup) setupChanged(d.key);
        };
        seg.appendChild(b);
      });
      var k = row(d.label, seg, null, SETTING_HELP[d.key]);
      if (playLocked) playLockNote(k);
    }
    // 슬라이더 줄(박자당 회전 각도): 옆에 "90° · 4박에 한 바퀴". 움직이는 동안 바로 적용(처음 설정 화면은 가상 플레이가 곧바로 다시 돈다)
    function degText(x) { return x + "° · " + Math.round(3600 / x) / 10 + "박에 한 바퀴"; }
    function rangeRow(d) {
      var playLocked = inPlay && PLAY_LOCKED.indexOf(d.key) >= 0;
      var wrap = document.createElement("div");
      wrap.className = "range-row";
      var r = document.createElement("input");
      r.type = "range";
      r.min = d.range[0];
      r.max = d.range[1];
      r.step = d.range[2];
      r.value = settings[d.key];
      r.disabled = playLocked;
      var v = document.createElement("b");
      v.className = "range-val";
      v.textContent = degText(settings[d.key]);
      r.oninput = function () {
        var x = +r.value;
        v.textContent = degText(x);
        if (x === settings[d.key]) return;
        settings[d.key] = x;
        saveSettings();
        engine.setOptions(engineOptions());
        buildDialCache();
        if (setup) setupChanged(d.key);
      };
      wrap.appendChild(r);
      wrap.appendChild(v);
      var k = row(d.label, wrap, null, SETTING_HELP[d.key]);
      if (playLocked) {
        var note = document.createElement("small");
        note.className = "k-note";
        note.textContent = "연주 중 변경 불가";
        k.appendChild(note);
      }
    }
    var vol = document.createElement("input");
    vol.type = "range";
    vol.min = 0;
    vol.max = 100;
    vol.value = Math.round(settings.volume * 100);
    vol.oninput = function () {
      settings.volume = vol.value / 100;
      saveSettings();
      if (audio.master && mode !== "gameover") audio.master.gain.value = settings.volume;
    };
    if (want("volume")) row("음량", vol, null, SETTING_HELP.volume);
    var off = document.createElement("div");
    off.className = "seg";
    [-10, -1, 1, 10].forEach(function (v, i) {
      if (i === 2) {
        var val = document.createElement("b");
        val.style.cssText = "font-family:Cinzel,serif;min-width:4.5em;text-align:center;align-self:center";
        val.textContent = (settings.offsetMs > 0 ? "+" : "") + settings.offsetMs + "ms";
        off.appendChild(val);
      }
      var b = document.createElement("button");
      b.textContent = (v > 0 ? "+" : "−") + Math.abs(v);
      b.onclick = function () {
        settings.offsetMs = Math.max(-300, Math.min(300, settings.offsetMs + v));
        saveSettings();
        rebuild();
      };
      off.appendChild(b);
    });
    // 곡 선택 옆 플레이 설정에서는 싱크 측정으로 바로 갈 수 있다(끝나면 곡 선택으로 돌아온다).
    var goSync = null;
    if (target) {
      goSync = document.createElement("button");
      goSync.className = "btn small";
      goSync.textContent = "싱크 맞추러 가기";
      goSync.onclick = function () { syncReturn = "select"; keyCapture = null; audio.resume().then(openSync); };
    }
    if (want("offsetMs")) row("싱크 오프셋", off, goSync, SETTING_HELP.offsetMs);
    SETTING_DEFS.forEach(function (d) { if (!d.locked && want(d.key)) { if (d.range) rangeRow(d); else segRow(d); } });
    var hv = document.createElement("input");
    hv.type = "range";
    hv.min = 0;
    hv.max = 100;
    hv.value = Math.round(settings.hitVolume * 100);
    hv.oninput = function () {
      settings.hitVolume = hv.value / 100;
      saveSettings();
      if (audio.hitBus) audio.hitBus.gain.value = settings.hitVolume;
    };
    hv.onchange = function () { audio.hit("perfect"); }; // 손을 뗄 때 한 번 들려준다
    if (want("hitVolume")) row("타격음 음량", hv, null, SETTING_HELP.hitVolume);
    // 되돌리기 키(09-30, 기본 R): 버튼을 누른 뒤 다음에 누른 키를 쓴다. 입력 키 · Enter는 막는다.
    if (want("rewindKey")) {
      var rwRow = document.createElement("div");
      rwRow.className = "seg";
      var rb = document.createElement("button");
      rb.textContent = keyCapture === "rw" ? "키를 누르세요 (Esc 취소)" : codeLabel(settings.rewindKey);
      if (keyCapture === "rw") rb.className = "on";
      rb.onclick = function () { keyCapture = "rw"; rebuild(); };
      rwRow.appendChild(rb);
      var rd = document.createElement("button");
      rd.textContent = "기본값(" + codeLabel(DEFAULT_REWIND_KEY) + ")";
      rd.onclick = function () { settings.rewindKey = DEFAULT_REWIND_KEY; keyCapture = null; saveSettings(); refreshRewindLabels(); rebuild(); };
      rwRow.appendChild(rd);
      row("되돌리기 키", rwRow, null, SETTING_HELP.rewindKey);
    }

    // 레인 키: 버튼을 누른 뒤 다음에 누른 키를 그 레인에 붙인다
    var keysRow = document.createElement("div");
    keysRow.className = "seg";
    var laneNames = ["안쪽", "2번", "3번", "바깥"];
    settings.keys.forEach(function (code, i) {
      var b = document.createElement("button");
      b.textContent = keyCapture === i ? laneNames[i] + ": 키를 누르세요" : laneNames[i] + " " + codeLabel(code);
      if (keyCapture === i) b.className = "on";
      b.disabled = inPlay;
      b.onclick = function () { keyCapture = i; rebuild(); };
      keysRow.appendChild(b);
    });
    var def = document.createElement("button");
    def.textContent = "기본값(D F K L)";
    def.disabled = inPlay;
    def.onclick = function () {
      settings.keys = DEFAULT_KEYS.slice();
      keyCapture = null;
      saveSettings();
      refreshKeyLabels();
      rebuild();
    };
    keysRow.appendChild(def);
    var kk = want("keys") ? row("레인 키", keysRow, null, SETTING_HELP.keys) : null;
    if (inPlay && kk) { keyCapture = null; playLockNote(kk); }
    if (only) return; // 처음 설정 화면: 고른 항목만
    // 잠긴 항목(게임 규칙): 관리자 이상이 아니면 값만 보인다
    var unlocked = settingsUnlocked();
    var note = document.createElement("div");
    note.className = "locked-note";
    note.textContent = unlocked ? "🔓 게임 규칙 · 바꾸면 서버에 저장되어 모든 플레이어에게 적용" : "🔒 게임 규칙 · 관리자 이상만 바꿀 수 있음";
    body.appendChild(note);
    SETTING_DEFS.forEach(function (d) { if (d.locked) segRow(d, !unlocked); });
    if (target) return; // 곡 선택 옆 플레이 설정에는 기록 줄을 두지 않는다
    // 기록(테스트용): 모든 채보 해금, 기록 초기화. 연주 도중(일시정지에서 연 설정)에는 막는다.
    var rec = document.createElement("div");
    rec.className = "seg";
    var ua = document.createElement("button");
    ua.textContent = save.data.unlockAll ? "모두 해금 켜짐" : "모두 해금 꺼짐";
    if (save.data.unlockAll) ua.className = "on";
    ua.onclick = function () {
      save.setUnlockAll(!save.data.unlockAll);
      if (songSelect) songSelect.render();
      buildSettings();
    };
    rec.appendChild(ua);
    var rs = document.createElement("button");
    rs.textContent = "기록 초기화";
    rs.onclick = function () {
      if (!confirm("이 목업(건반형)의 튜토리얼 진행과 곡 기록을 모두 지웁니다. 계속할까요?")) return;
      save.reset();
      save.setFirstRunDone();
      if (songSelect) songSelect.render();
      renderTitle();
      toast("기록을 지웠습니다");
      buildSettings();
    };
    rec.appendChild(rs);
    if (inPlay) Array.prototype.slice.call(rec.querySelectorAll("button")).forEach(function (b) { b.disabled = true; });
    row("기록(테스트용)", rec);
  }
  // 열려 있는 설정 칸(설정 화면 · 곡 선택 옆 플레이 설정)을 다시 그린다(레인 키를 바꾼 뒤)
  function rebuildOpenSettings() {
    if ($("screen-settings").classList.contains("show")) buildSettings();
    if (selectSettingsOpen) buildSettings($("select-settings-body"));
    if (setup && $("setup-set")) buildSettings($("setup-set"), SETUP_KEYS); // 처음 설정 카드
  }
  function openSettings(returnTo) {
    afterSettings = returnTo;
    keyCapture = null;
    buildSettings();
    showScreen("screen-settings");
  }
  // 키 바꾸기: 버튼을 누른 뒤 다음에 누른 키를 그 레인에 붙인다. 이미 쓰는 키면 두 레인의 키를 맞바꾼다.
  var keyCapture = null;
  function captureKey(e) {
    e.preventDefault();
    if (e.repeat) return;
    if (e.code === "Escape") { keyCapture = null; rebuildOpenSettings(); return; }
    if (keyCapture === "rw") { // 되돌리기 키
      if (e.code === "Enter" || e.code === "F11") { toast(codeLabel(e.code) + "는 쓸 수 없는 키입니다"); return; }
      if (isInputKey(e.code)) { toast(codeLabel(e.code) + "는 입력 키라 되돌리기 키로 쓸 수 없습니다"); return; }
      settings.rewindKey = e.code;
      keyCapture = null;
      saveSettings();
      refreshRewindLabels();
      rebuildOpenSettings();
      return;
    }
    if (e.code === settings.rewindKey) { toast(codeLabel(e.code) + "는 되돌리기 키라 쓸 수 없습니다"); return; }
    if (e.code === "Enter") { toast("Enter는 곡 시작 · 튜토리얼 버튼 키라 쓸 수 없습니다"); return; }
    var i = keyCapture;
    var j = settings.keys.indexOf(e.code);
    if (j >= 0 && j !== i) settings.keys[j] = settings.keys[i];
    settings.keys[i] = e.code;
    keyCapture = null;
    saveSettings();
    refreshKeyLabels();
    rebuildOpenSettings();
  }
  function closeSettings() {
    keyCapture = null;
    showScreen(afterSettings);
    if (afterSettings === "screen-sync") renderOffset();
  }
  $("btn-settings-close").addEventListener("click", closeSettings);

  // 곡 선택 옆 플레이 설정: 곡 선택의 「설정」으로 펼치고 접는다. 열어 둔 채 곡을 골라 시작할 수 있다.
  var selectSettingsOpen = false;
  function setSelectSettings(open) {
    selectSettingsOpen = open;
    if (!open) keyCapture = null;
    if (open) buildSettings($("select-settings-body"));
    $("select-settings").classList.toggle("open", open);
    $("select-settings").setAttribute("aria-hidden", open ? "false" : "true");
    if (songSelect) songSelect.render(); // 「설정」 버튼의 눌린 모양
  }
  $("btn-select-settings-close").addEventListener("click", function () { setSelectSettings(false); });
  $("btn-title-settings").addEventListener("click", function () { openSettings("screen-title"); });
  $("btn-pause-settings").addEventListener("click", function () { openSettings("screen-pause"); });

  // ================= UI 조정 =================
  // 멈춘 게임 화면(기본 곡 한 장면) 위에 편집 창을 띄운다. 항목마다 기준 자리(좌/중/우 · 상/중/하)와 거리(x · y 픽셀)를 고르고,
  // 화면의 상자를 직접 끌어도 된다. 편집 창은 머리를 잡고 끌어 옮긴다. 바꾼 값은 바로 저장된다.
  // 곡 제목 · 난이도 · 일시정지 버튼은 고정이라 목록에 없다. 시침 뒤 레인 키 글자는 설정의 「레인 키 표시」에서 고른다. style: 표시 유형을 고르는 항목
  var LAYOUT_ITEMS = [
    { key: "play", name: "플레이 화면(시계)" },
    { key: "life", name: "라이프", style: { field: "lifeStyle", list: LIFE_STYLES } },
    { key: "score", name: "점수" },
    { key: "acc", name: "정확도" },
    { key: "judge", name: "판정", style: { field: "judgeStyle", list: JUDGE_STYLES } },
    { key: "combo", name: "콤보", style: { field: "comboMode", list: COMBO_MODES, label: "위치" } },
    { key: "border", name: "보더" },
    { key: "guide", name: "조작 안내(레인 키)", style: { field: "guideMode", list: GUIDE_MODES, label: "표시" } }
  ];
  var LAYOUT_H = [["left", "좌"], ["center", "중"], ["right", "우"]];
  var LAYOUT_V = [["top", "상"], ["middle", "중"], ["bottom", "하"]];
  var layoutFrom = "title"; // 완료하면 돌아갈 화면: 처음 화면(title) 또는 곡 선택(select)
  function openLayout(from) {
    layoutFrom = from;
    mode = "layout";
    session = null;
    showScreen(null);
    document.body.classList.add("layout-edit");
    // 미리보기 장면: 기본 곡의 40박 무렵(지나간 노트는 퍼펙트로 채워 점수·콤보·보더가 보이게)
    var c = library.charts[0];
    if (c) {
      useEngine(TDC.toEngineChart(c));
      var t0 = c.offset + (40 * 60) / c.bpm;
      engine.markPerfectBefore(t0);
      frozenTime = t0;
    }
    // 곡 제목 · 난이도 칸은 견본으로: 가장 긴 모양(어려움 · LV. VIII)으로 자리를 보게
    setSongLabel({ title: "견본 제목[For Example]", sub: TDC.difficultyLabel("hard") + " " + TDC.levelText(8) });
    hudPrev = {};
    var panel = $("layout-panel");
    panel.style.left = panel.style.top = panel.style.right = panel.style.transform = ""; // 열 때마다 기본 자리(끌어 둔 자리 지움)
    panel.hidden = false;
    buildLayoutPanel();
    resize();
  }
  function closeLayout() {
    $("layout-panel").hidden = true;
    document.body.classList.remove("layout-edit");
    useEngine(EMPTY_CHART);
    frozenTime = -0.5;
    hudPrev = {};
    setSongLabel(null);
    resize(); // 가려짐 표시 지우기
    if (layoutFrom === "select") { openSelect(); return; }
    mode = "title";
    renderTitle();
    showScreen("screen-title");
  }
  function layoutChanged(rebuildPanel) {
    saveSettings();
    resize(); // 배치 적용 + 시계 자리 + 가려짐 표시
    if (rebuildPanel) buildLayoutPanel();
    else syncLayoutInputs();
  }
  function buildLayoutPanel() {
    var body = $("layout-body");
    body.innerHTML = "";
    LAYOUT_ITEMS.forEach(function (item) {
      var it = settings.layout[item.key];
      var box = document.createElement("div");
      box.className = "lp-item";
      box.innerHTML = '<div class="lp-name">' + item.name + "</div>";
      function segOf(list, field) {
        var seg = document.createElement("div");
        seg.className = "seg";
        list.forEach(function (o) {
          var b = document.createElement("button");
          b.textContent = o[1];
          if (it[field] === o[0]) b.className = "on";
          b.onclick = function () {
            it[field] = o[0];
            if (field === "h") it.x = 0; else it.y = 0; // 기준 자리를 바꾸면 그 방향 거리는 0부터
            if (AUTO_KEYS.indexOf(item.key) >= 0) settings.layout.auto = false;
            layoutChanged(true);
          };
          seg.appendChild(b);
        });
        return seg;
      }
      function tag(text) { var sp = document.createElement("span"); sp.className = "lp-tag"; sp.textContent = text; return sp; }
      var r1 = document.createElement("div");
      r1.className = "lp-row";
      r1.appendChild(tag("가로"));
      r1.appendChild(segOf(LAYOUT_H, "h"));
      if (item.key !== "play") { r1.appendChild(tag("세로")); r1.appendChild(segOf(LAYOUT_V, "v")); }
      var inClock = item.key === "combo" && settings.layout.comboMode !== "box"; // 시계 안 콤보는 자리 대신 세로 자리 · 크기만
      if (!inClock) box.appendChild(r1);
      if (item.key === "play") { body.appendChild(box); return; } // 플레이 화면은 좌 · 중 · 우만
      // 표시 유형(라이프 · 판정 · 콤보 위치 · 조작 안내)
      if (item.style) {
        var rs = document.createElement("div");
        rs.className = "lp-row";
        rs.appendChild(tag(item.style.label || "유형"));
        var seg = document.createElement("div");
        seg.className = "seg";
        item.style.list.forEach(function (o) {
          var b = document.createElement("button");
          b.textContent = o[1];
          if (settings.layout[item.style.field] === o[0]) b.className = "on";
          b.onclick = function () { settings.layout[item.style.field] = o[0]; layoutChanged(true); };
          seg.appendChild(b);
        });
        rs.appendChild(seg);
        box.appendChild(rs);
      }
      if (inClock) {
        // 시계 안 콤보: 세로 자리만(시계 반지름 대비 %, 아래가 +)
        var cy = document.createElement("input");
        cy.type = "range";
        cy.min = -80;
        cy.max = 80;
        cy.step = 1;
        cy.value = settings.layout.comboY;
        cy.className = "lp-size";
        var cyv = document.createElement("span");
        cyv.className = "lp-size-v";
        cyv.textContent = settings.layout.comboY + "%";
        cy.oninput = function () {
          settings.layout.comboY = parseInt(cy.value, 10);
          cyv.textContent = settings.layout.comboY + "%";
          saveSettings();
        };
        var cyRow = document.createElement("div");
        cyRow.className = "lp-row";
        cyRow.appendChild(tag("Y"));
        cyRow.appendChild(cy);
        cyRow.appendChild(cyv);
        var hint = document.createElement("span");
        hint.textContent = "시계 반지름 기준 · 아래가 +";
        cyRow.appendChild(hint);
        box.appendChild(cyRow);
      }
      var r2 = document.createElement("div");
      r2.className = "lp-row";
      if (!inClock) {
        ["x", "y"].forEach(function (f) {
          var inp = document.createElement("input");
          inp.type = "number";
          inp.step = 1;
          inp.value = it[f];
          inp.setAttribute("data-lkey", item.key);
          inp.setAttribute("data-lf", f);
          inp.oninput = function () {
            var v = parseFloat(inp.value);
            if (!isFinite(v)) return;
            it[f] = Math.round(v);
            if (AUTO_KEYS.indexOf(item.key) >= 0) settings.layout.auto = false;
            layoutChanged(false);
          };
          r2.appendChild(tag(f.toUpperCase()));
          r2.appendChild(inp);
        });
        var unit = document.createElement("span");
        unit.textContent = "px";
        r2.appendChild(unit);
      }
      // 크기 50~200%
      var sz = document.createElement("input");
      sz.type = "range";
      sz.min = 50;
      sz.max = 200;
      sz.step = 5;
      sz.value = it.s;
      sz.className = "lp-size";
      var szv = document.createElement("span");
      szv.className = "lp-size-v";
      szv.textContent = it.s + "%";
      sz.oninput = function () {
        it.s = parseInt(sz.value, 10);
        szv.textContent = it.s + "%";
        layoutChanged(false);
      };
      r2.appendChild(tag("크기"));
      r2.appendChild(sz);
      r2.appendChild(szv);
      box.appendChild(r2);
      body.appendChild(box);
    });
  }
  // 끌어서 옮기는 중에는 입력 칸 값만 고친다(칸을 다시 만들면 입력 중인 칸이 사라지므로)
  function syncLayoutInputs() {
    Array.prototype.forEach.call(document.querySelectorAll("#layout-body input[data-lkey]"), function (inp) {
      if (inp === document.activeElement) return;
      inp.value = settings.layout[inp.getAttribute("data-lkey")][inp.getAttribute("data-lf")];
    });
  }
  $("btn-layout").addEventListener("click", function () { openLayout("title"); });
  $("btn-layout-done").addEventListener("click", closeLayout);
  // 기본값: 위치(가로 · 세로 · x · y)만 되돌린다. 표시 유형(라이프 · 판정 · 콤보 · 조작 안내)과 크기는 지금 그대로.
  $("btn-layout-reset").addEventListener("click", function () {
    var cur = settings.layout;
    var def = cloneLayout(null);
    Object.keys(LAYOUT_DEFAULT).forEach(function (k) { def[k].s = cur[k].s; });
    LAYOUT_STYLE_FIELDS.forEach(function (f) { def[f] = cur[f]; }); // comboY(시계 안 세로 자리)는 위치라 기본값으로
    def.auto = true; // 기본 위치를 다시 유형에 맞춰 계산
    settings.layout = def;
    layoutChanged(true);
  });
  // 끌기: 편집 창(머리) · 화면의 상자
  var layoutDrag = null;
  var LAYOUT_KEY_OF_EL = {};
  Object.keys(LAYOUT_EL).forEach(function (k) { LAYOUT_KEY_OF_EL[LAYOUT_EL[k]] = k; });
  window.addEventListener("mousedown", function (e) {
    if (mode !== "layout" || e.button !== 0) return;
    var panel = $("layout-panel");
    if (e.target.closest("#layout-drag") && !e.target.closest("button")) {
      var pr = panel.getBoundingClientRect();
      layoutDrag = { kind: "panel", dx: e.clientX - pr.left, dy: e.clientY - pr.top };
    } else if (e.target.closest("#layout-panel")) {
      return;
    } else {
      // 시계는 반투명이고 마우스를 받지 않아 아래 상자를 바로 잡을 수 있다. 시계 자체는 끌지 않는다(좌 · 중 · 우만).
      var box = e.target.closest(".hud-box");
      var key = box ? LAYOUT_KEY_OF_EL[box.id] : null;
      if (!key) return;
      var it = settings.layout[key];
      layoutDrag = { kind: "item", key: key, el: box, mx: e.clientX, my: e.clientY, x0: it.x, y0: it.y };
      box.classList.add("drag");
    }
    e.preventDefault();
  });
  window.addEventListener("mousemove", function (e) {
    if (!layoutDrag) return;
    if (layoutDrag.kind === "panel") {
      var panel = $("layout-panel");
      var w = panel.offsetWidth, h = panel.offsetHeight;
      panel.style.left = Math.max(0, Math.min(W - w, e.clientX - layoutDrag.dx)) + "px";
      panel.style.top = Math.max(0, Math.min(H - Math.min(h, 60), e.clientY - layoutDrag.dy)) + "px";
      panel.style.right = "auto";
      panel.style.transform = "none";
    } else {
      var it = settings.layout[layoutDrag.key];
      if (AUTO_KEYS.indexOf(layoutDrag.key) >= 0) settings.layout.auto = false;
      it.x = Math.round(layoutDrag.x0 + e.clientX - layoutDrag.mx);
      it.y = Math.round(layoutDrag.y0 + e.clientY - layoutDrag.my);
      applyLayout();
      markUnderClock();
      syncLayoutInputs();
    }
  });
  window.addEventListener("mouseup", function () {
    if (!layoutDrag) return;
    if (layoutDrag.el) layoutDrag.el.classList.remove("drag");
    if (layoutDrag.kind === "item") saveSettings();
    layoutDrag = null;
  });

  // ================= 버튼 =================
  $("btn-play").addEventListener("click", function () { audio.resume(); openSelect(); });
  $("btn-tutorial").addEventListener("click", function () { openTutorial(); });
  $("btn-go-sync").addEventListener("click", function () { audio.resume().then(openSync); });
  // 이 유형의 공식 채보 · 받은 채보 요청(shared/ui.js adminScreen). 닫으면 공식 채보를 다시 받는다(내리기 · 되돌리기 반영)
  $("btn-admin").addEventListener("click", function () {
    TDUI.adminScreen(function () {
      refreshOfficial().then(function () { library.charts = withOfficial(localCharts); });
    }, { mode: MODE });
  });
  $("btn-editor").addEventListener("click", function () {
    if (TDAccount.isAdmin(TDAccount.me())) location.href = "../editor/index.html?mode=" + MODE;
    else toast("에디터는 관리자 이상만 열 수 있습니다", 2600);
  });
  $("btn-pause").addEventListener("click", function () {
    if (inTutorialPlay()) return;
    if (mode === "playing" || mode === "countdown") pauseGame();
    else if (mode === "paused") resumeGame();
  });
  $("btn-resume").addEventListener("click", resumeGame);
  $("btn-restart").addEventListener("click", startGame);
  $("btn-stop").addEventListener("click", function () { if (TEST_TAB) backToEditor(); else quitPlay(); });
  $("btn-again").addEventListener("click", startGame);
  $("btn-result-select").addEventListener("click", function () { if (TEST_TAB) backToEditor(); else openSelect(); });
  $("btn-result-title").addEventListener("click", function () { session = null; mode = "title"; renderTitle(); showScreen("screen-title"); });

  // 처음 화면: 게임 시작은 늘 진한 색. 튜토리얼은 마치기 전에는 게임 시작처럼 진한 색, 마친 뒤에는 ✓와 함께 다른 메뉴와 같은 색(에임형과 같게)
  function renderTitle() {
    var done = save.tutorialDone();
    $("btn-tutorial").innerHTML = "튜토리얼" + (done ? ' <span class="ok-mark">✓</span>' : "");
    $("btn-tutorial").classList.toggle("primary", !done);
    $("btn-editor").innerHTML = "에디터" + (TDAccount.isAdmin(TDAccount.me()) ? "" : ' <span class="lock">🔒</span>'); // 관리자 이상이면 잠금 표시 없음
    $("btn-admin").hidden = !TDAccount.isOwner(TDAccount.me()); // 이 유형의 채보 관리: 소유자만
    refreshKeyLabels();
  }

  // ================= 튜토리얼 =================
  // 실제 시계 위에서 enchanted love의 한 구간을 틀어 놓고, 단계마다 설명 → 시연(자동 연주) → 직접 해보기 → 통과 순서로 넘어간다.
  // 판정은 본게임과 같은 엔진·같은 입력을 쓴다. 튜토리얼에서는 회전을 한 박 30°로 고정하고,
  // 되돌리기·점수·라이프·일시정지를 쓰지 않는다(점수·라이프·일시정지 버튼·보더는 화면에서도 숨긴다, 에임형 09-29 변경 이식).
  // 단계 통과는 저장되어, 다음에 열면 통과하지 못한 단계부터 시작한다. 전부 마치면 튜토리얼 해금 조건인 채보가 열린다.
  var TUT_SONG = { song: "linear ring - Enchanted love.mp3", bpm: 190, offset: 0 };
  var TUT_PASS = 0.75; // 미스 없이 친 노트가 이 비율 이상이면 통과
  var TUT_PREROLL = 8; // 구간 첫 노트 몇 박 전부터 음악을 트는가(두 마디)
  var TUT_DEG = 30; // 튜토리얼 회전 속도(한 박 각도). 설정값과 무관하게 고정
  function tapRow(r) { return { type: TYPE.TAP, b: r[0], lane: r[1] }; }
  function longRow(r) { return { type: TYPE.LONG, b: r[0], eb: r[1], lane: r[2] }; }
  function keysText() { return settings.keys.map(codeLabel).join(" · "); }
  function kl(i) { return "<b>" + codeLabel(settings.keys[i]) + "</b>"; }

  // at: 구간 첫 박(곡 전체 기준, 마디 첫 박). notes의 박자는 at 기준 상대값이고 모두 정박.
  // demo: 시연에 쓰는 앞쪽 노트 수. demoNotes: 시연 전용 노트(있으면 demo 대신).
  // steps는 함수: 레인 키를 바꾸면 설명의 키 글자도 바뀐다.
  var LESSONS = [
    {
      key: "tap", name: "탭", at: 8, demo: 4,
      steps: function () {
        return [
          "네 고리는 안쪽부터 <b>" + keysText() + "</b> 키입니다. 시침 뒤에 붙은 글자가 각 고리의 키이고, 아래 키 칸은 누르는 동안 켜집니다.",
          "태엽이 시침에 닿는 순간 <b>그 고리의 키</b>를 한 번 누릅니다. 커서는 쓰지 않습니다.",
          "태엽 색은 손마다 다릅니다. " + kl(0) + "·" + kl(1) + "(왼손)는 놋쇠, " + kl(2) + "·" + kl(3) + "(오른손)는 푸른 강철. 판정은 퍼펙트 ±50ms · 그레이트 ±100ms · 굿 ±150ms.",
          "탭을 ±25ms 안에 치면 <b>PERFECT+</b>(이론치)입니다. 퍼펙트와 같게 치고 점수만 1점 더합니다. 롱에는 없습니다."
        ];
      },
      notes: [[0, 0], [2, 1], [4, 2], [6, 3], [8, 2], [10, 1], [12, 0], [16, 3], [18, 2], [20, 1], [24, 0], [26, 3]].map(tapRow)
    },
    {
      key: "long", name: "롱", at: 44,
      steps: function () {
        return [
          "사슬이 달린 태엽은 시침에 닿을 때 그 고리의 키를 누르고, <b>사슬 끝까지 누른 채</b> 유지합니다.",
          "<b>사슬 끝이 시침에 닿는 순간 뗍니다</b>. 떼는 순간도 판정합니다(퍼펙트 ±100ms · 그레이트 ±150ms · 굿 ±200ms). 그보다 일찍 떼거나, 끝을 지나서도 계속 누르고 있으면 미스입니다."
        ];
      },
      // 곡은 4박마다 마디 첫 박(킥)이다. 롱은 한 마디(4박) 길이로 마디 첫 박에 누르고 다음 마디 첫 박에 뗀다.
      notes: [[0, 4, 1], [8, 12, 2], [16, 20, 0], [24, 28, 3], [32, 36, 1]].map(longRow),
      // 시연은 누르고 있는 모습을 오래 보도록 길게(8박, 약 2.5초)
      demoNotes: [[0, 8, 1], [12, 20, 2]].map(longRow)
    },
    {
      key: "chord", name: "동시 치기", at: 80, demo: 4,
      steps: function () {
        return [
          "<b>은빛 태엽</b>은 다른 고리의 태엽과 같은 순간에 칩니다. 흰 점선으로 이어진 태엽끼리가 한 묶음입니다.",
          "묶음의 키들을 <b>동시에</b> 누릅니다. 롱 머리가 묶음에 들어가도 똑같이 은빛입니다.",
          "하나만 치면 친 쪽은 판정되고, 놓친 쪽만 미스가 됩니다."
        ];
      },
      // 묶음은 모두 마디 첫 박. 롱이 낀 묶음의 롱은 한 마디(마디 첫 박 → 다음 마디 첫 박)
      notes: [[0, 0], [0, 2], [4, 1], [4, 3], [8, 0], [8, 3], [12, 1], [12, 2]].map(tapRow)
        .concat([longRow([16, 20, 0]), tapRow([16, 3])])
        .concat([[24, 1], [24, 3], [28, 0], [28, 2]].map(tapRow))
    },
    {
      key: "hold", name: "롱잡", at: 116, demo: 4,
      steps: function () {
        return [
          "한 고리의 롱을 <b>누른 채로</b> 다른 고리의 태엽을 칩니다.",
          "롱을 누른 손가락은 <b>사슬 끝이 시침에 닿는 순간</b> 뗍니다. 보통 한 손으로 롱, 다른 손으로 탭을 칩니다.",
          "탭을 치다가 롱 키까지 떼면 롱이 미스가 됩니다."
        ];
      },
      // 롱은 두 마디(마디 첫 박 → 두 마디 뒤 첫 박), 탭은 2박 간격
      notes: [longRow([0, 8, 1]), tapRow([2, 2]), tapRow([4, 3]), tapRow([6, 2]),
        longRow([12, 20, 2]), tapRow([14, 0]), tapRow([16, 1]), tapRow([18, 0]),
        longRow([24, 32, 0]), tapRow([26, 3]), tapRow([28, 2]), tapRow([30, 3])]
    }
  ];
  function lessonIndexOf(key) {
    for (var i = 0; i < LESSONS.length; i++) if (LESSONS[i].key === key) return i;
    return -1;
  }
  // 단계의 노트(곡 전체 기준 박자)를 엔진 채보로. forDemo: 시연용(demoNotes, 없으면 앞쪽 demo개)
  function lessonChart(lesson, forDemo) {
    var src = !forDemo ? lesson.notes : lesson.demoNotes || lesson.notes.slice(0, lesson.demo);
    var rows = src.map(function (n) {
      var o = { type: n.type, b: n.b + lesson.at, lane: n.lane };
      if (n.eb !== undefined) o.eb = n.eb + lesson.at;
      return o;
    });
    var c = TDC.normalizeChart({ mode: MODE, title: "튜토리얼 " + lesson.name, bpm: TUT_SONG.bpm, offset: TUT_SONG.offset, notes: rows });
    return TDC.toEngineChart(c);
  }
  function lessonFrom(lesson) { return Math.max(0, TUT_SONG.offset + ((lesson.at - TUT_PREROLL) * 60) / TUT_SONG.bpm); }
  // 카드만 떠 있는 동안 시계를 멈춰 둘 시각: 첫 노트들이 시침 앞에 보이도록
  function lessonIdleTime(lesson) { return TUT_SONG.offset + (lesson.at * 60) / TUT_SONG.bpm - engine.leadTime(settings.leadDeg) * 0.85; }
  // 튜토리얼 판: 회전 30° 고정, 라이프가 줄지 않고(게임오버 없음), 되돌리기 없음
  function tutEngineOptions() {
    var o = engineOptions();
    o.degPerBeat = TUT_DEG;
    o.lifePerMiss = 0;
    o.rewindLimit = 0;
    return o;
  }

  // phase: intro(설명) · demo(시연 중) · ready(시연 끝) · play(직접 해보는 중) · result(판정 결과) · done(전부 끝)
  var tut = { index: 0, phase: "intro", fails: 0, last: null, token: 0, skipWarn: 0 }; // skipWarn: 건너뛰기 경고 단계(0 없음 · 1 · 2)
  var demo = null; // 시연 상태: { held, holdKeys, releases, lastEnd }

  function openTutorial(index) {
    audio.resume();
    if (index === undefined || index < 0) {
      // 통과하지 못한 첫 단계부터(전부 통과했으면 처음부터)
      index = 0;
      if (!save.tutorialDone()) for (var i = 0; i < LESSONS.length; i++) if (!save.data.tutorial.lessons[LESSONS[i].key]) { index = i; break; }
    }
    showScreen(null);
    document.body.classList.add("tutorial");
    resize();
    mode = "tutorial";
    tut.index = index;
    tut.phase = "loading";
    renderTutCard();
    loadSong(TUT_SONG.song).then(function (b) { audio.buffer = b; }).catch(function () {
      audio.buffer = null;
      toast("enchanted love 음원이 없어 메트로놈으로 진행합니다", 3000);
    }).then(function () { enterLesson(index); });
  }

  function enterLesson(i) {
    tut.skipWarn = 0;
    tut.index = i;
    tut.fails = 0;
    tut.last = null;
    var lesson = LESSONS[i];
    session = { kind: "tutorial", lesson: lesson, chart: null, from: lessonFrom(lesson) };
    useEngine(lessonChart(lesson), tutEngineOptions());
    mode = "tutorial";
    frozenTime = lessonIdleTime(lesson);
    setSongLabel(sessionParts());
    hudPrev = {};
    tut.phase = "intro";
    renderTutCard();
    // 설명을 읽을 틈을 조금 준 뒤 시연을 자동으로 튼다.
    var token = ++tut.token;
    setTimeout(function () { if (token === tut.token && tut.phase === "intro" && mode === "tutorial") startDemo(); }, 1200);
  }

  // ---------- 시연: 이 단계 앞쪽 노트를 자동으로 친다 ----------
  // 노래 없이 소리 없는 시계로 돌리고, 끝나면 처음부터 다시 돈다(직접 해보기를 누를 때까지).
  function startDemo() {
    var lesson = LESSONS[tut.index];
    tut.token++;
    useEngine(lessonChart(lesson, true), tutEngineOptions());
    engine.reset();
    engine.drainEvents();
    popups = [];
    sparks = [];
    hudPrev = {};
    demo = { held: {}, holdKeys: {}, releases: [], lastEnd: LAST_END };
    tut.phase = "demo";
    renderTutCard();
    var token = tut.token;
    audio.resume().then(function () {
      if (token !== tut.token || tut.phase !== "demo") return; // 그 사이 직접 해보기·나가기를 눌렀다
      audio.stop();
      audio.startClock(session.from, 0.1);
      mode = "demo";
    });
  }
  // 한 바퀴 끝: 판을 처음 상태로 돌리고 시계만 다시 튼다
  function restartDemoLoop() {
    if (setup) { startSetupLoop(); return; } // 처음 설정 화면: 음원과 함께 처음부터
    engine.reset();
    engine.drainEvents();
    popups = [];
    sparks = [];
    hudPrev = {};
    lastComboMark = 0;
    demo = { held: {}, holdKeys: {}, releases: [], lastEnd: LAST_END };
    demoCaps({});
    audio.startClock(session.from, 0.4);
  }
  function demoStep(perf) {
    var t = audio.songAt(perf) - offsetSec();
    var d = demo;
    // 롱은 끝 시각에 정확히 뗀다(떼는 순간을 판정한다). 탭은 누른 뒤 잠깐 뒤에 칸 불만 끈다.
    d.releases = d.releases.filter(function (r) {
      if (t >= r.at) { delete d.held[r.key]; if (r.judge) engine.release(r.key, r.at); return false; }
      return true;
    });
    engine.notes.forEach(function (n) {
      // 화면 갱신이 늦어도 흔들리지 않게, 누르는 시각은 노트의 정확한 판정 시각으로 넣는다.
      if (n.state === "idle" && t >= n.t) {
        var k = "L" + n.lane;
        var hitN = engine.pressLane(n.lane, n.t, k);
        if (setup) playHitsound(engine, hitN); // 처음 설정 화면만 타격음(튜토리얼 시연은 조용히)
        d.held[k] = true;
        if (n.type === TYPE.TAP) d.releases.push({ key: k, at: n.t + 0.12 });
        else { d.holdKeys[k] = n; d.releases.push({ key: k, at: n.end, judge: true }); }
      }
    });
    engine.update(t, { x: 0, y: 0 }, d.held);
    // 롱이 끝나기 전에 실패했으면 칸 불을 끈다
    Object.keys(d.holdKeys).forEach(function (k) {
      if (d.holdKeys[k].state !== "holding") { delete d.held[k]; delete d.holdKeys[k]; }
    });
    engine.drainEvents().forEach(function (ev) { if (ev.kind === "judge") onJudge(ev, perf, !setup); }); // 처음 설정 화면은 누르는 노트 끝소리도
    demoCaps(d.held);
    if (engine.getState().finished && t > d.lastEnd + 1) restartDemoLoop();
  }
  function demoCaps(map) {
    for (var i = 0; i < 4; i++) setCap("L" + i, !!map["L" + i]);
  }
  // 시연 멈춤(직접 해보기로 넘어갈 때)
  function stopDemo() {
    audio.stop();
    demo = null;
    demoCaps({});
    popups = [];
    var lesson = LESSONS[tut.index];
    useEngine(lessonChart(lesson), tutEngineOptions());
    mode = "tutorial";
    frozenTime = lessonIdleTime(lesson);
    hudPrev = {};
  }

  // 시연 중 태엽 곁에 붙이는 이름표: 무엇을 해야 하는지. on: 누르는 중(아래 키 칸이 켜진 색)
  function clockLabel(text, x, y, on) {
    g.save();
    var fs = Math.max(12, Math.round(R * 0.034));
    g.font = "700 " + fs + "px 'Gowun Batang', serif";
    var w = g.measureText(text).width + 14;
    var hh = Math.max(fs + 8, fs * 1.65);
    var bx = x - w / 2;
    var by = y - hh / 2;
    g.beginPath();
    if (g.roundRect) g.roundRect(bx, by, w, hh, 6); else g.rect(bx, by, w, hh);
    g.fillStyle = on ? "#E2B85A" : "rgba(251,246,236,.96)";
    g.fill();
    g.strokeStyle = on ? "#3F2616" : "rgba(107,66,38,.7)";
    g.lineWidth = on ? 1.6 : 1.2;
    g.stroke();
    g.fillStyle = "#3F2616";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, x, y + 0.5);
    g.restore();
  }
  function drawDemoLabels(t) {
    if (setup) return; // 처음 설정 화면은 실제 플레이처럼(튜토리얼 이름표 없음)
    var lead = engine.leadTime(settings.leadDeg);
    var up = R * 0.13;
    var key = function (lane) { return codeLabel(settings.keys[lane]); };
    var labeled = 0;
    engine.notes.forEach(function (n) {
      if (n.state !== "holding") return;
      // 누르고 있는 롱: 시침 바로 앞, 그 고리 바깥쪽에 켜진 이름표(시침 뒤 키 글자를 가리지 않게). 끝이 가까우면 끝에 「끝에서 뗌」
      var p = laneScreen(engine.angleAt(t) + 10, n.lane, engine.laneRadius(n.lane) + 0.1);
      clockLabel(key(n.lane) + " 누른 채 유지", p.x, p.y, true);
      labeled++;
      if (n.end - t < lead * 0.8) { p = toScreen(engine.notePos(n, n.end)); clockLabel("끝에서 뗌", p.x, p.y + up); labeled++; }
    });
    // 다음에 칠 태엽(동시치기면 묶음 전체)
    var next = engine.notes.filter(function (n) { return n.state === "idle" && n.t - t < lead && n.t > t - 0.2; })[0];
    if (!next || labeled > 2) return;
    var group = engine.notes.filter(function (n) { return n.state === "idle" && Math.abs(n.t - next.t) < 1e-3; });
    var s = toScreen(engine.posAt(next.t, next.lane));
    var txt;
    if (group.length > 1) txt = group.map(function (n) { return key(n.lane); }).join("+") + " 동시에";
    else if (next.type === TYPE.TAP) txt = key(next.lane) + " 누름";
    else txt = key(next.lane) + " 누른 채 유지";
    clockLabel(txt, s.x, s.y - up);
  }

  // ---------- 직접 해보기 ----------
  function startPractice() {
    var lesson = LESSONS[tut.index];
    tut.token++;
    useEngine(lessonChart(lesson), tutEngineOptions());
    session = { kind: "tutorial", lesson: lesson, chart: null, from: lessonFrom(lesson) };
    tut.phase = "play";
    renderTutCard();
    startGame();
  }
  function tutAfterPractice(s, kind) {
    var lesson = LESSONS[tut.index];
    var ok = engine.notes.filter(function (n) {
      return n.slots.every(function (sl) { return sl.result && sl.result !== "miss"; });
    }).length;
    var need = Math.ceil(engine.notes.length * TUT_PASS);
    var pass = kind === "clear" && ok >= need;
    tut.last = { ok: ok, total: engine.notes.length, need: need, pass: pass, counts: s.counts };
    if (pass) save.setTutorialLesson(lesson.key, true);
    else tut.fails++;
    tut.phase = "result";
    renderTutCard();
  }
  // 직접 해보기를 그만두고 단계 카드로(카드의 「튜토리얼 나가기」 전에 판을 정리할 때)
  function tutBackToCard() {
    mode = "tutorial";
    var lesson = LESSONS[tut.index];
    useEngine(lessonChart(lesson), tutEngineOptions());
    frozenTime = lessonIdleTime(lesson);
    tut.phase = tut.last ? "result" : "ready";
    showScreen(null);
    renderTutCard();
  }
  function nextLesson() {
    if (tut.index < LESSONS.length - 1) { enterLesson(tut.index + 1); return; }
    var wasDone = save.tutorialDone();
    save.setTutorialDone();
    tut.phase = "done";
    tut.unlocked = wasDone ? [] : library.charts.filter(function (c) { return c.unlock && c.unlock.type === "tutorial"; });
    renderTutCard();
  }
  // 튜토리얼 건너뛰기(경고 두 번 뒤): 마친 것으로 기록하고(쉬움 · 보통 해금) 곡 선택으로 간다.
  function skipTutorial() {
    tut.skipWarn = 0;
    var before = library.charts.filter(function (c) { return save.isUnlocked(c); }).map(function (c) { return c.id; });
    save.setTutorialDone();
    var opened = library.charts.filter(function (c) { return save.isUnlocked(c) && before.indexOf(c.id) < 0; });
    closeTutorial(true);
    toast("튜토리얼을 건너뛰었습니다" + (opened.length ? " · 새로 열림: " + opened.map(function (c) { return c.title + " [" + TDC.difficultyLabel(c.difficulty) + "]"; }).join(", ") : "") +
      " · 처음 화면 「튜토리얼」에서 다시 할 수 있습니다", 5000);
  }
  function closeTutorial(toSelect) {
    tut.token++;
    if (mode === "demo" || mode === "rewinding") audio.stop();
    demo = null;
    demoCaps({});
    releaseAllKeys();
    session = null;
    document.body.classList.remove("tutorial");
    useEngine(EMPTY_CHART);
    frozenTime = -0.5;
    hudPrev = {};
    setSongLabel(null);
    resize();
    if (toSelect) openSelect();
    else { mode = "title"; renderTitle(); showScreen("screen-title"); }
  }

  // ---------- 오른쪽 카드 ----------
  function countsText(c) {
    return "P+ " + c.perfectPlus + " · P " + (c.perfect - c.perfectPlus) + " · G " + c.great + " · Gd " + c.good + " · M " + c.miss;
  }
  function renderTutCard() {
    var lesson = LESSONS[tut.index];
    var box = $("tut-card");
    var dots = LESSONS.map(function (l, i) {
      return '<i class="' + (i === tut.index && tut.phase !== "done" ? "cur" : save.data.tutorial.lessons[l.key] ? "done" : "") + '"></i>';
    }).join("");
    var html = '<div class="tc-step">TUTORIAL · ' + (tut.index + 1) + " / " + LESSONS.length + "</div>";
    if (tut.phase === "done") {
      html += "<h3>튜토리얼 완료</h3><div class=\"tc-dots\">" + dots + "</div>" +
        "<div class=\"tc-status\">조작을 모두 익혔습니다. 곡 선택에서 곡을 골라 연주하세요." +
        (tut.unlocked && tut.unlocked.length ? "<br><b>새로 열림:</b> " + tut.unlocked.map(function (c) { return TDUI.esc(c.title) + " [" + TDC.difficultyLabel(c.difficulty) + "]"; }).join(", ") : "") + "</div>" +
        '<div class="stack"><button class="btn primary" data-tut="select">곡 선택으로 (Enter)</button><button class="btn" data-tut="title">처음 화면</button></div>';
      box.innerHTML = html;
      return;
    }
    // 건너뛰기 경고 두 번(09-30, 사용자). 기본 버튼(Enter)은 「튜토리얼 계속하기」라 실수로 건너뛰지 않는다.
    if (tut.skipWarn) {
      var second = tut.skipWarn >= 2;
      html += "<h3>" + (second ? "정말 건너뛸까요?" : "튜토리얼을 건너뛸까요?") + '</h3><div class="tc-dots">' + dots + "</div>" +
        '<div class="tc-status tc-warn">' + (second
          ? "튜토리얼을 마친 것으로 기록되어 쉬움 · 보통 채보가 열립니다.<br>처음 화면의 「튜토리얼」에서 언제든 다시 할 수 있습니다."
          : "튜토리얼은 이 유형의 조작과 노트 종류를 단계별로 익히는 과정입니다.<br>건너뛰면 조작을 익히지 않은 채 곡을 시작하게 됩니다.") + "</div>" +
        '<div class="stack"><button class="btn primary" data-tut="skip-cancel">튜토리얼 계속하기 (Enter)</button><button class="btn" data-tut="skip">' + (second ? "건너뛰기" : "그래도 건너뛰기") + "</button></div>" +
        '<div class="tc-quit"><button data-tut="skip-cancel">돌아가기 (Esc)</button></div>';
      box.innerHTML = html;
      return;
    }
    var phaseText = { loading: "음원 준비 중", intro: "곧 시연", demo: "시연 중 · 되풀이", ready: "대기", play: "직접 해보는 중", result: "결과" }[tut.phase];
    var live = tut.phase === "demo" || tut.phase === "play";
    html += "<h3>" + lesson.name + '</h3><div class="tc-dots">' + dots + "</div>" +
      '<span class="tc-phase' + (live ? " live" : "") + '">' + phaseText + "</span>" +
      "<ol>" + lesson.steps().map(function (s) { return "<li>" + s + "</li>"; }).join("") + "</ol>";
    var status = "";
    var btns = "";
    var need = Math.ceil(lesson.notes.length * TUT_PASS);
    if (tut.phase === "intro" || tut.phase === "loading") {
      status = "곧 자동 연주로 치는 법을 보여 줍니다(노래 없이 되풀이).";
      btns = '<button class="btn primary" data-tut="demo">시연 보기 (Enter)</button><button class="btn" data-tut="play">바로 해보기</button>';
    } else if (tut.phase === "demo") {
      status = "시계 위 이름표와 아래 키 칸의 불빛을 보세요. 준비되면 직접 해 봅니다. " + lesson.notes.length + "개 중 미스 없이 " + need + "개 이상이면 통과.";
      btns = '<button class="btn primary" data-tut="play">직접 해보기 (Enter)</button>';
    } else if (tut.phase === "ready") {
      status = "이제 직접 해 봅니다. " + lesson.notes.length + "개 중 미스 없이 " + need + "개 이상이면 통과.";
      btns = '<button class="btn primary" data-tut="play">직접 해보기 (Enter)</button><button class="btn" data-tut="demo">시연 다시 보기</button>';
    } else if (tut.phase === "play") {
      status = "직접 해보는 중";
    } else if (tut.phase === "result") {
      var L = tut.last;
      if (L.pass) {
        status = '<b class="pass">통과</b> · 미스 없이 ' + L.ok + " / " + L.total + "<br>" + countsText(L.counts);
        btns = '<button class="btn primary" data-tut="next">' + (tut.index < LESSONS.length - 1 ? "다음 단계 (Enter)" : "튜토리얼 마치기 (Enter)") + '</button><button class="btn" data-tut="play">한 번 더 해보기</button>';
      } else {
        status = '<b class="fail">아쉬워요</b> · 미스 없이 ' + L.ok + " / " + L.total + " (기준 " + L.need + "개)<br>" + countsText(L.counts);
        btns = '<button class="btn primary" data-tut="play">다시 해보기 (Enter)</button><button class="btn" data-tut="demo">시연 다시 보기</button>' +
          (tut.fails >= 2 ? '<button class="btn" data-tut="next">이 단계 넘어가기</button>' : "");
      }
    }
    html += '<div class="tc-status">' + status + '</div><div class="stack">' + btns + "</div>" +
      '<div class="tc-quit">' + (!save.tutorialDone() && tut.phase !== "play" ? '<button data-tut="skip">튜토리얼 건너뛰기</button> · ' : "") +
      '<button data-tut="quit">튜토리얼 나가기' + (tut.phase === "play" ? "" : " (Esc)") + "</button></div>";
    box.innerHTML = html;
  }
  // 카드의 첫 버튼(Enter)
  function tutPrimary() {
    var b = $("tut-card").querySelector(".btn.primary");
    if (b) b.click();
  }
  $("tut-card").addEventListener("click", function (e) {
    var b = e.target.closest("[data-tut]");
    if (!b) return;
    var act = b.getAttribute("data-tut");
    if (act === "demo") { if (mode === "tutorial") startDemo(); }
    else if (act === "play") {
      if (mode === "demo") stopDemo();
      if (mode === "tutorial") startPractice();
    }
    else if (act === "next") nextLesson();
    else if (act === "skip") {
      if (tut.skipWarn < 2) { tut.skipWarn++; renderTutCard(); }
      else skipTutorial();
    }
    else if (act === "skip-cancel") { tut.skipWarn = 0; renderTutCard(); }
    else if (act === "setup-done") finishSetup();
    else if (act === "select") closeTutorial(true);
    else if (act === "title") closeTutorial(false);
    else if (act === "quit") {
      if (mode === "playing" || mode === "countdown" || mode === "paused") { quitPlay(); }
      closeTutorial(false);
    }
  });

  // ================= 처음 설정(09-30) =================
  // 가상의 플레이(자동 연주 + 음원)를 계속 돌리고, 오른쪽 카드에서 고른 설정대로 곧바로 다시 돈다. 기기마다 한 번(settings.setupDone).
  // 처음 켤 때는 처음 설정 → 싱크 맞추기 → 튜토리얼. 튜토리얼 시연 장치(demo)를 쓰되 회전은 지금 설정값을 따른다.
  var SETUP_LESSON = {
    key: "setup", name: "처음 설정", at: 8, notes: [],
    // 네 레인 탭 → 반 박 탭 → 동시치기 → 롱 → 탭 → 롱(구간 첫 박 기준, 박자)
    demoNotes: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 0], [4.5, 1], [5, 2], [5.5, 3], [6, 0], [6, 3]].map(tapRow)
      .concat([[8, 12, 1]].map(longRow)).concat([[13, 0], [14, 3], [15, 2]].map(tapRow)).concat([[16, 20, 3]].map(longRow))
  };
  var SETUP_KEYS = ["degPerBeat", "leadDeg", "keys", "rewindKey", "keyHint", "volume", "hitsound", "hitVolume", "showDelta"];
  var setup = null; // { started: 가상 플레이가 도는 중(브라우저는 한 번 누르기 전에는 소리를 못 낸다) }
  function setupEngineOptions() {
    var o = engineOptions(); // 회전 · 되돌리기 간격은 설정값 그대로
    o.lifePerMiss = 0;
    o.rewindLimit = 0;
    return o;
  }
  function openSetup() {
    showScreen(null);
    document.body.classList.add("tutorial", "setup");
    resize();
    session = { kind: "setup", lesson: SETUP_LESSON, chart: null, from: lessonFrom(SETUP_LESSON) };
    setup = { started: false };
    setSongLabel(sessionParts());
    demo = null;
    mode = "demo";
    renderSetupCard();
    startSetupLoop();
    loadSong(TUT_SONG.song).then(function (b) { audio.buffer = b; if (setup && setup.started) startSetupLoop(); }, function () { /* 음원이 없으면 소리 없이 시계만 */ });
  }
  // 가상 플레이를 처음부터: 지금 설정(회전 각도 등)으로 엔진을 새로 만들고 음원(있으면)과 함께 튼다
  function startSetupLoop() {
    if (!setup) return;
    useEngine(lessonChart(SETUP_LESSON, true), setupEngineOptions());
    engine.reset();
    engine.drainEvents();
    popups = [];
    sparks = [];
    hudPrev = {};
    lastComboMark = 0;
    demo = { held: {}, holdKeys: {}, releases: [], cursor: demo ? demo.cursor : null, move: null, lastEnd: LAST_END };
    demoCaps({});
    audio.resume().then(function () {
      if (!setup) return;
      audio.stop();
      if (audio.buffer) audio.play(session.from, 0.1);
      else audio.startClock(session.from, 0.1);
      mode = "demo";
      if (!setup.started) { setup.started = true; renderSetupCard(); }
    });
  }
  // 설정을 바꿨을 때: 회전 · 등장 시점은 판을 새로 돌리고, 나머지(소리 · 표시)는 도는 중에 바로 반영된다
  function setupChanged(key) {
    if (key === "degPerBeat" || key === "leadDeg") startSetupLoop();
  }
  // 브라우저는 누르기 전에는 소리를 못 낸다: 처음 설정 화면에서 아무 곳이나 누르면 가상 플레이를 시작한다
  function wakeSetup() { if (setup && !setup.started) audio.resume(); }
  window.addEventListener("pointerdown", wakeSetup, true);
  window.addEventListener("keydown", wakeSetup, true);
  function renderSetupCard() {
    var box = $("tut-card");
    box.innerHTML = '<div class="tc-step">FIRST SETUP</div><h3>처음 설정</h3>' +
      '<div class="tc-status">' + (setup.started ? "왼쪽에서 가상 플레이가 계속 재생됩니다. 설정을 바꾸면 곧바로 그 설정으로 다시 재생됩니다."
        : "화면을 한 번 누르면 가상 플레이가 시작됩니다(브라우저는 누르기 전에는 소리를 낼 수 없습니다).") + "</div>" +
      '<div class="set" id="setup-set"></div>' +
      '<div class="tc-status">처음 화면 · 곡 선택의 「설정」에서 언제든 바꿀 수 있습니다.</div>' +
      '<div class="stack"><button class="btn primary" data-tut="setup-done">' + (firstRun ? "다음: 싱크 맞추기 (Enter)" : "완료 (Enter)") + "</button></div>";
    buildSettings($("setup-set"), SETUP_KEYS);
  }
  function finishSetup() {
    if (!setup) return;
    setup = null;
    keyCapture = null;
    settings.setupDone = true;
    saveSettings();
    audio.stop();
    demo = null;
    demoCaps({});
    session = null;
    popups = [];
    sparks = [];
    document.body.classList.remove("tutorial", "setup");
    useEngine(EMPTY_CHART);
    frozenTime = -0.5;
    hudPrev = {};
    setSongLabel(null);
    resize();
    if (firstRun) { openSync(); return; } // 처음 켠 경우: 싱크 맞추기 → 튜토리얼
    mode = "title";
    renderTitle();
    showScreen("screen-title");
  }

  // ================= 시작 =================
  refreshKeyLabels();
  refreshRewindLabels();
  resize();
  // 웹 글꼴이 늦게 들어오면 UI 상자 크기가 바뀔 수 있어 한 번 더 잰다.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(resize);

  function findChart(id) { return library.charts.filter(function (c) { return c.id === id; })[0] || null; }

  // 스크린샷 확인용 미리보기: ?preview=초 [&chart=id] [&cx=..&cy=..] [&screen=screen-title] [&deg=..] [&combo=..] [&danger]
  function setupPreview() {
    mode = "preview";
    var c = findChart(params.get("chart") || "enchanted-love_normal") || library.charts[0];
    if (c) useEngine(TDC.toEngineChart(c));
    if (params.has("deg")) {
      settings.degPerBeat = parseFloat(params.get("deg"));
      engine.setOptions(engineOptions());
      buildDialCache();
    }
    engine.markPerfectBefore(PREVIEW);
    engine.notes.forEach(function (n) {
      if (n.type !== TYPE.TAP && n.t < PREVIEW && n.end > PREVIEW && n.state === "idle") {
        n.state = "holding";
        n.holdKey = "L" + n.lane;
        n.slots.forEach(function (s) { if (s.time < PREVIEW - 0.15) s.result = "perfect"; });
      }
    });
    var next = engine.notes.filter(function (n) { return n.state === "idle" && n.t >= PREVIEW; })[0];
    var aim = next ? toScreen(engine.posAt(next.t, next.lane)) : { x: CX, y: CY };
    cursorPx.x = params.has("cx") ? parseFloat(params.get("cx")) : aim.x + 6;
    cursorPx.y = params.has("cy") ? parseFloat(params.get("cy")) : aim.y + 4;
    var justDone = engine.notes.filter(function (n) { return n.state === "done"; }).slice(-1)[0];
    if (justDone) {
      var p0 = engine.posAt(justDone.t, justDone.lane);
      onJudge({ rank: "perfect", delta: 0.012, x: p0.x, y: p0.y, slotKind: "start" }, performance.now(), true);
    }
    if (c) setSongLabel(chartParts(c));
    if (params.get("screen") === "screen-settings") buildSettings();
    if (params.get("screen") === "screen-select") { openSelect(); mode = "preview"; }
    if (params.has("combo")) {
      showComboBurst(parseInt(params.get("combo"), 10));
      $("combo-burst").classList.add("static");
    }
    if (params.get("screen") !== "screen-select") showScreen(params.get("screen") || null);
  }

  // 에디터의 테스트 플레이 탭(?test=): 나가면(Esc · 그만두기 · 결과 화면) 에디터로 돌아간다(09-30).
  // 이 탭은 계정 확인 없이 열리므로, 곡 선택 · 처음 화면으로 가면 「에디터」 버튼이 잠겨 에디터에 다시 들어갈 수 없었다.
  var TEST_TAB = !!params.get("test");
  function backToEditor() {
    cancelCountdown();
    audio.stop();
    setPlayingCursor(false);
    // 에디터가 연 탭이면 닫고 그 에디터로(편집하던 상태 그대로). 닫히지 않으면(에디터 탭이 없는 등) 이 탭에서 에디터를 연다.
    try {
      if (window.opener && !window.opener.closed) { window.opener.focus(); window.close(); }
    } catch (e) { /* 막히면 아래로 */ }
    setTimeout(function () {
      location.href = "../editor/index.html?mode=" + MODE + "&chart=" + encodeURIComponent(params.get("test"));
    }, 300);
  }

  // 에디터의 테스트 플레이(새 탭): 브라우저는 클릭 전에는 소리를 못 내므로 시작 버튼을 한 번 누르게 한다.
  function openTestPrompt(c, fromBeat) {
    $("test-title").textContent = c.title + " · " + TDC.difficultyLabel(c.difficulty) + " " + TDC.levelText(c.level);
    $("test-sub").textContent = fromBeat > 0 ? fromBeat + "박부터 시작합니다(그 앞 노트는 빼고 2초 전부터). 기록은 남기지 않습니다." : "처음부터 시작합니다. 기록은 남기지 않습니다.";
    $("test-sub").textContent += " Esc를 누르면 에디터로 돌아갑니다.";
    $("btn-test-start").onclick = function () { audio.resume(); playChart(c, "test", fromBeat); };
    mode = "test-prompt";
    showScreen("screen-test");
  }

  function boot() {
    // 계정을 확인하고(안내문 · 로그인은 메인 화면 index.html에서 한다. 로그인해 있지 않으면 그리로 보낸다) 처음 화면을 연다.
    // 채보는 그동안 함께 불러 둔다. 미리보기 · 자동 점검 · 에디터의 테스트 플레이는 계정 확인 없이 연다.
    var skipAccount = PREVIEW !== null || params.has("test") || params.has("selftest");
    $("title-foot").hidden = location.protocol !== "file:"; // start.bat 안내는 파일을 더블클릭해 열었을 때만
    if (skipAccount) showScreen(PREVIEW === null ? "screen-title" : null);
    var gate = skipAccount ? null : TDUI.requireAccount("../index.html").then(function () {
      TDUI.accountBar($("title-account"), { mainUrl: "../index.html" });
      // 플레이 데이터(튜토리얼 · 기록 · 해금)는 계정에 저장하고, 되돌리기 횟수 · 감점은 서버의 게임 규칙을 따른다
      return Promise.all([
        TDAccount.bindProgress(save, MODE, function (msg) { toast(msg, 5000); }),
        refreshOfficial(),
        TDAccount.loadRules(MODE).then(applyRules, function (e) { toast("게임 규칙을 받지 못했습니다: " + TDAccount.errorText(e), 4000); })
      ]);
    }).catch(function (e) {
      // 켜는 도중 오류가 나도 처음 화면은 연다(09-30: 옛 파일이 섞여 빈 화면에 멈추던 문제)
      toast("일부 정보를 불러오지 못했습니다. 새로 고침(Ctrl+F5)해 보세요: " + (e && e.message ? e.message : e), 6000);
    }).then(function () { showScreen("screen-title"); });
    var loaded = TDLibrary.load(MODE).then(function (lib) { library = lib; }, function (e) {
      library = { online: TDLibrary.online, charts: [], songs: [], errors: [{ file: "(서버)", error: e && e.message ? e.message : String(e) }] };
    });
    Promise.all([loaded, gate]).then(function () {
      localCharts = library.charts;
      library.charts = withOfficial(localCharts); // 공식 채보(서버)를 합친다
      save.setCharts(library.charts); // 해금 규칙(어려움 = 같은 곡 보통 클리어)에 쓴다
      renderTitle();
      if (PREVIEW !== null) { setupPreview(); return; }
      var test = params.get("test");
      if (test) {
        var tc = findChart(test);
        // 에디터가 테스트 플레이를 누를 때 넘겨 둔 사본(저장 전 모습 포함)이 같은 채보면 그것을 쓴다.
        try {
          var handed = JSON.parse(localStorage.getItem("td-test-chart-" + MODE) || "null");
          if (handed && handed.id === test) tc = TDC.normalizeChart(handed, handed.id);
        } catch (e) { /* 없으면 파일의 채보 */ }
        if (tc) { openTestPrompt(tc, parseFloat(params.get("from")) || 0); return; }
        toast("테스트할 채보를 찾지 못했습니다: " + test, 4000);
      }
      if (params.has("selftest")) return;
      if (params.has("tutorial")) { openTutorial(lessonIndexOf(params.get("tutorial"))); return; }
      if (params.has("select")) { openSelect(); return; }
      if (params.has("setup")) { openSetup(); return; } // 주소에 ?setup이 있으면 처음 설정을 다시 연다(09-30)
      if (!save.firstRunDone()) {
        // 처음 켰을 때: 처음 설정 → 싱크 맞추기 → 튜토리얼 순서로 안내한다. 싱크 값이 튜토리얼 판정에도 쓰이기 때문.
        save.setFirstRunDone();
        firstRun = true;
        openSetup();
      } else if (!settings.setupDone) openSetup(); // 이 기기에서 처음 설정을 아직 안 했다(예전부터 하던 플레이어도 한 번, 09-30)
    });
  }

  // 자동 점검용 손잡이(tests/selftest.js). 게임 동작에는 영향 없음.
  window.__td = {
    audio: audio, toScreen: toScreen, cursorPx: cursorPx, buffers: buffers, save: save,
    get engine() { return engine; },
    get library() { return library; },
    startChart: function (id) { playChart(findChart(id) || library.charts[0], "test", 0); },
    startGame: startGame, pauseGame: pauseGame, resumeGame: resumeGame, tryRewind: tryRewind,
    strikeDown: strikeDown, strikeUp: strikeUp, openTutorial: openTutorial, openSelect: openSelect,
    getMode: function () { return mode; },
    step: function (perf) { step(perf); render(perf, displayTime(perf)); updateHud(); },
    tut: tut, LESSONS: LESSONS
  };
  if (params.has("selftest")) {
    var st = document.createElement("script");
    st.src = "tests/selftest.js";
    document.body.appendChild(st);
  }
  boot();
  // 새 버전 안내(shared/ui.js): 연주 · 카운트다운 · 되감기 · 게임오버 · 일시정지 · 시연 · 싱크 측정 중에는 미룬다
  TDUI.watchVersion({ isBusy: function () { return ["playing", "countdown", "rewinding", "gameover", "paused", "demo", "sync"].indexOf(mode) >= 0; } });
  requestAnimationFrame(frame);
})();
