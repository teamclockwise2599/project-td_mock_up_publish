// BPM 자동 계산. 모노 소리 샘플(Float32Array)에서 곡의 BPM을 추정한다. 에디터와 node 테스트가 같이 쓴다.
//
// 1) 온셋 곡선: 짧은 구간(약 46ms)을 약 11.6ms씩 옮기며 주파수별 세기를 재고, 앞 구간보다 커진 양만 더한다
//    (새 소리가 터지는 순간 높아진다). 곡 전체의 느린 세기 변화는 이동 평균을 빼서 없앤다.
// 2) 대략의 박 간격: 온셋 곡선의 자기상관(곡선을 밀어 겹쳤을 때 잘 맞는 간격)에서 55~240 BPM 사이 봉우리를 찾는다.
// 3) 다듬기: 후보 BPM마다 곡 전체의 온셋을 "박 안의 위치(위상)"로 모아 한 위치에 몰리는 정도(빗살 대비)를 잰다.
//    곡이 길수록 박 간격이 조금만 틀려도 위상이 흩어지므로, 0.005 BPM 단위까지 가려낼 수 있다(곡 BPM이 일정하다는 가정).
// 4) 자동 계산은 반·두 배 BPM으로 잘못 잡기 쉬워서, 반·두 배·2/3·3/2배 후보도 함께 점수를 매겨 돌려준다(사람이 고른다).
(function (root) {
  "use strict";

  var MIN_BPM = 55;
  var MAX_BPM = 240;

  // 제자리 FFT(길이는 2의 거듭제곱)
  function fft(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = (-2 * Math.PI) / len;
      var wr = Math.cos(ang);
      var wi = Math.sin(ang);
      for (var s = 0; s < n; s += len) {
        var cr = 1;
        var ci = 0;
        for (var k = 0; k < len / 2; k++) {
          var a = s + k;
          var b = a + len / 2;
          var xr = re[b] * cr - im[b] * ci;
          var xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  // 1) 온셋 곡선. 돌려주는 값: { env, fps(1초당 칸 수), t0(0번 칸의 시각, 초) }
  function onsetEnvelope(samples, sr) {
    var N = Math.pow(2, Math.round(Math.log(sr * 0.046) / Math.LN2));
    var H = N / 4;
    var frames = Math.max(0, Math.floor((samples.length - N) / H) + 1);
    var win = new Float32Array(N);
    for (var i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    var kMax = Math.min(N / 2, Math.floor((10000 / sr) * N)); // 10kHz까지
    var re = new Float64Array(N);
    var im = new Float64Array(N);
    var prev = new Float32Array(kMax);
    var cur = new Float32Array(kMax);
    var flux = new Float32Array(frames);
    for (var f = 0; f < frames; f++) {
      var off = f * H;
      for (var n = 0; n < N; n++) { re[n] = samples[off + n] * win[n]; im[n] = 0; }
      fft(re, im);
      var sum = 0;
      for (var k = 1; k < kMax; k++) {
        var mag = Math.log(1 + 100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        cur[k] = mag;
        var d = mag - prev[k];
        if (d > 0 && f > 0) sum += d;
      }
      flux[f] = sum;
      var tmp = prev; prev = cur; cur = tmp;
    }
    // 느린 세기 변화 빼기(약 0.4초 이동 평균), 음수는 0
    var fps = sr / H;
    var w = Math.max(1, Math.round(fps * 0.2));
    var env = new Float32Array(frames);
    var acc = 0;
    var cnt = 0;
    var lo = 0;
    var hi = -1;
    for (var t = 0; t < frames; t++) {
      while (hi < Math.min(frames - 1, t + w)) { hi++; acc += flux[hi]; cnt++; }
      while (lo < t - w) { acc -= flux[lo]; lo++; cnt--; }
      var v = flux[t] - acc / cnt;
      env[t] = v > 0 ? v : 0;
    }
    return { env: env, fps: fps, t0: N / 2 / sr };
  }

  // 2) 자기상관: 곡선을 L칸 밀어 겹쳤을 때 얼마나 잘 맞는가. 박 간격에서 크고, 박 사이가 비어 있으면 그 절반 간격에서는 작다.
  function computeAcf(env, fps) {
    var lagMin = Math.floor((fps * 60) / MAX_BPM);
    var lagMax = Math.ceil((fps * 60) / MIN_BPM);
    var n = env.length;
    var acf = new Float64Array(lagMax + 2);
    for (var L = lagMin - 1; L <= lagMax + 1; L++) {
      if (L < 1 || L >= n) continue;
      var s = 0;
      for (var i = 0; i + L < n; i++) s += env[i] * env[i + L];
      acf[L] = s / (n - L);
    }
    return { acf: acf, lagMin: lagMin, lagMax: lagMax };
  }
  // BPM 자리의 자기상관(칸 사이는 선형 보간)
  function acfAt(A, fps, bpm) {
    var lag = (fps * 60) / bpm;
    var l0 = Math.floor(lag);
    if (l0 < 1 || l0 + 1 >= A.acf.length) return 0;
    var f = lag - l0;
    return A.acf[l0] * (1 - f) + A.acf[l0 + 1] * f;
  }
  function acfPeaks(A, fps) {
    var acf = A.acf;
    var lagMin = A.lagMin;
    var lagMax = A.lagMax;
    var peaks = [];
    for (var l = lagMin; l <= lagMax; l++) {
      if (acf[l] > 0 && acf[l] >= acf[l - 1] && acf[l] >= acf[l + 1]) peaks.push({ bpm: (fps * 60) / l, score: acf[l] });
    }
    peaks.sort(function (a, b) { return b.score - a.score; });
    return peaks;
  }

  // 3) 빗살 대비: 온셋을 박 안의 위치(0~1)로 모았을 때 가장 많이 몰린 칸이 평균의 몇 배인가
  var BINS = 48;
  function combScore(env, fps, bpm) {
    var P = (fps * 60) / bpm;
    var hist = new Float64Array(BINS);
    for (var i = 0; i < env.length; i++) {
      var ph = i / P;
      ph -= Math.floor(ph);
      hist[Math.floor(ph * BINS) % BINS] += env[i];
    }
    var best = 0;
    var arg = 0;
    var total = 0;
    for (var b = 0; b < BINS; b++) {
      // 이웃 칸과 함께 본다(경계에 걸친 봉우리)
      var v = hist[(b + BINS - 1) % BINS] * 0.5 + hist[b] + hist[(b + 1) % BINS] * 0.5;
      total += hist[b];
      if (v > best) { best = v; arg = b; }
    }
    var mean = (total * 2) / BINS; // 이웃 포함 창(0.5+1+0.5)의 평균
    return { score: mean > 0 ? best / mean : 0, phase: (arg + 0.5) / BINS };
  }
  // 위상 정렬 세기(0~1): 모든 온셋을 박 안의 각도로 놓고 더한 화살표의 길이. 칸으로 나누지 않아 미세한 BPM 차이도 매끄럽게 가른다.
  function phaseStrength(env, fps, bpm) {
    var w = (2 * Math.PI * bpm) / (fps * 60);
    var c = 0;
    var s = 0;
    var tot = 0;
    for (var i = 0; i < env.length; i++) {
      var e = env[i];
      if (e === 0) continue;
      c += e * Math.cos(w * i);
      s += e * Math.sin(w * i);
      tot += e;
    }
    var ph = Math.atan2(s, c) / (2 * Math.PI);
    return { vs: tot > 0 ? Math.sqrt(c * c + s * s) / tot : 0, phase: ph - Math.floor(ph) };
  }
  function refine(env, fps, bpm, span, step) {
    var best = { bpm: bpm, vs: -1, phase: 0 };
    for (var b = bpm - span; b <= bpm + span + 1e-9; b += step) {
      if (b < MIN_BPM * 0.5 || b > MAX_BPM * 2) continue;
      var p = phaseStrength(env, fps, b);
      if (p.vs > best.vs) best = { bpm: b, vs: p.vs, phase: p.phase };
    }
    return best;
  }
  function sharpen(env, fps, bpm) {
    var r = refine(env, fps, bpm, bpm * 0.02, 0.05);
    r = refine(env, fps, r.bpm, 0.1, 0.005);
    // 정수 BPM이 거의 같은 세기면 정수로(대부분의 곡은 정수 BPM)
    var near = Math.round(r.bpm);
    if (Math.abs(near - r.bpm) <= 0.12) {
      var p = phaseStrength(env, fps, near);
      if (p.vs >= r.vs * 0.98) r = { bpm: near, vs: p.vs, phase: p.phase };
    }
    r.bpm = Math.round(r.bpm * 100) / 100;
    r.score = combScore(env, fps, r.bpm).score; // 반·두 배 후보 비교는 칸 모음 대비로
    return r;
  }

  // 전체: samples(모노), sr(샘플 수/초) → { bpm, candidates:[{bpm, score}], confidence: "높음"|"보통"|"낮음", offset(첫 박 추정, 초) }
  function detect(samples, sr) {
    var o = onsetEnvelope(samples, sr);
    if (o.env.length < o.fps * 5) return null; // 5초보다 짧으면 못 잰다
    var A = computeAcf(o.env, o.fps);
    var peaks = acfPeaks(A, o.fps);
    if (!peaks.length) return null;
    // 자기상관 상위 봉우리 몇 개와 그 반·두 배 등을 모아 다듬은 뒤 점수로 줄 세운다
    var seeds = [];
    peaks.slice(0, 4).forEach(function (p) {
      [1, 2, 0.5, 1.5, 2 / 3].forEach(function (m) {
        var b = p.bpm * m;
        if (b >= MIN_BPM && b <= MAX_BPM && !seeds.some(function (x) { return Math.abs(x - b) / b < 0.03; })) seeds.push(b);
      });
    });
    var cands = seeds.map(function (b) { return sharpen(o.env, o.fps, b); });
    // 같은 값으로 모인 후보 합치기
    var uniq = [];
    cands.forEach(function (c) {
      if (!uniq.some(function (u) { return Math.abs(u.bpm - c.bpm) < 0.5; })) uniq.push(c);
    });
    // 고르는 기준: 그 박 간격의 자기상관(너무 빠른 후보는 박 사이가 비어 작아진다) × 리듬게임 곡에 흔한 빠르기(약 140 BPM 근처) 가중.
    // 반·두 배가 비슷하게 나오면 이 가중이 둘 중 하나를 고른다(틀리면 후보에서 고친다).
    function weight(c) {
      var oct = Math.log(c.bpm / 140) / Math.LN2;
      return acfAt(A, o.fps, c.bpm) * Math.exp(-0.5 * oct * oct);
    }
    uniq.forEach(function (c) { c.w = weight(c); });
    uniq.sort(function (a, b) { return b.w - a.w; });
    var best = uniq[0];
    var second = uniq[1];
    // 신뢰도: 박에 맞춘 위상이 잘 모이고(vs), 반·두 배가 아닌 다른 후보보다 뚜렷이 앞설수록 높다
    var family = function (a, b) {
      var r = a > b ? a / b : b / a;
      return [2, 1.5, 3, 4].some(function (m) { return Math.abs(r - m) < 0.03; });
    };
    var rival = uniq.slice(1).filter(function (c) { return !family(c.bpm, best.bpm); })[0];
    var gap = rival && rival.w > 0 ? best.w / rival.w : 9;
    var conf = best.vs >= 0.3 && gap >= 1.3 ? "높음" : best.vs >= 0.15 ? "보통" : "낮음";
    // 첫 박(0박) 추정: 가장 많이 몰린 위상의 시각
    var P = 60 / best.bpm;
    var offset = o.t0 + best.phase * P;
    return {
      bpm: best.bpm,
      confidence: conf,
      offset: Math.round(offset * 1000) / 1000,
      vs: Math.round(best.vs * 1000) / 1000,
      candidates: withRounded(uniq.slice(0, 5).map(function (c) { return { bpm: c.bpm, weight: c.w }; })),
      second: second ? second.bpm : null
    };
  }

  // 추정값이 정수가 아니면 가장 가까운 정수도 바로 다음 후보로 넣는다(곡 BPM을 정수로 쓰고 싶을 때 한 번에 고르게)
  function withRounded(list) {
    var b = list[0].bpm;
    var r = Math.round(b);
    if (r === b || Math.abs(r - b) > 0.5 || list.some(function (c) { return c.bpm === r; })) return list;
    return [list[0], { bpm: r, weight: null, rounded: true }].concat(list.slice(1));
  }

  var api = { detect: detect, onsetEnvelope: onsetEnvelope, combScore: combScore, phaseStrength: phaseStrength, fft: fft };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TDBpm = api;
})(this);
