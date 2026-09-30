// 곡·채보 불러오기. 게임 두 종과 에디터가 같이 쓴다.
//
// 서버로 연 경우(http://localhost:8190/…, start.bat → server.ps1): songs/ 폴더 음원과 <목업>/charts/*.json을 서버에서 읽고, 에디터는 서버로 저장한다.
// 서버는 받은 글을 그대로 파일에 쓰므로, 채보 정리(normalizeChart)와 파일 모양(stringifyChart)은 여기서 한다.
// 파일을 더블클릭해 연 경우(file://)와 공개 페이지(localhost 밖의 웹 주소): <목업>/charts/bundle.js(채보 사본)와 shared/offline-songs.js(음원 사본)를 쓴다.
//   음원 사본은 node tools/build-offline.js 로 만든다. 예전 song-data.js(enchanted love 하나)도 읽는다.
(function (root) {
  "use strict";
  var TDChart = root.TDChart;
  // 로컬 서버(server.ps1)는 localhost에서만 열린다. 그 밖의 웹 주소(GitHub Pages 등)는 서버 없이 연 것과 같게 사본을 쓴다.
  var ONLINE = /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  function b64ToBuf(b64) {
    var bin = atob(b64);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
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

  function getJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : "HTTP " + r.status);
        return body;
      });
    });
  }

  var offlineSongsTried = null;
  function offlineSongs() {
    if (!offlineSongsTried) {
      offlineSongsTried = root.TD_OFFLINE_SONGS ? Promise.resolve(true) : loadScript("../shared/offline-songs.js").then(function (ok) {
        return ok || root.TD_SONG_B64 ? ok : loadScript("song-data.js"); // 예전 방식(목업 폴더 안 song-data.js)
      });
    }
    return offlineSongsTried.then(function () {
      var map = {};
      var src = root.TD_OFFLINE_SONGS || {};
      Object.keys(src).forEach(function (k) { map[k] = src[k]; });
      if (!map["linear ring - Enchanted love.mp3"] && root.TD_SONG_B64) map["linear ring - Enchanted love.mp3"] = root.TD_SONG_B64; // 예전 song-data.js
      return map;
    });
  }

  // mode: "core" | "lanes". 돌려주는 값: { online, charts: [정리된 채보], songs: [파일 이름], errors: [{file, error}] }
  function load(mode) {
    if (ONLINE) {
      return Promise.all([getJson("/api/charts?mode=" + mode), getJson("/api/songs")]).then(function (res) {
        return {
          online: true,
          charts: res[0].charts.map(function (c) { return TDChart.normalizeChart(c, c.id); }),
          songs: res[1].songs.map(function (s) { return s.file; }),
          errors: res[0].errors || []
        };
      });
    }
    var charts = (root.TD_CHART_BUNDLE || []).map(function (c) { return TDChart.normalizeChart(c, c.id); });
    return offlineSongs().then(function (map) {
      return { online: false, charts: charts, songs: Object.keys(map), errors: [] };
    });
  }

  // 음원 파일 → ArrayBuffer
  function loadAudio(file) {
    if (ONLINE) {
      return fetch("/songs/" + encodeURIComponent(file)).then(function (r) {
        if (!r.ok) throw new Error("songs 폴더에 " + file + " 파일이 없습니다");
        return r.arrayBuffer();
      });
    }
    return offlineSongs().then(function (map) {
      if (!map[file]) throw new Error("서버 없이 열면 사본이 있는 곡만 재생됩니다(" + file + "). start.bat으로 실행하세요");
      return b64ToBuf(map[file]);
    });
  }

  // 채보 파일에 쓸 글: 정리한 채보(파일 이름이 id, 목업 표시)를 한 노트 한 줄 모양으로
  function chartFileText(mode, chart) {
    var c = TDChart.normalizeChart(chart, chart.id);
    c.id = chart.id;
    c.mode = mode;
    return TDChart.stringifyChart(c);
  }
  function saveChart(mode, chart) {
    if (!ONLINE) return Promise.reject(new Error("서버 없이 열어서 저장할 수 없습니다. start.bat으로 실행하세요"));
    return fetch("/api/charts?mode=" + mode + "&id=" + encodeURIComponent(chart.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: chartFileText(mode, chart)
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : "HTTP " + r.status);
        return true;
      });
    });
  }

  function deleteChart(mode, id) {
    if (!ONLINE) return Promise.reject(new Error("서버 없이 열어서 지울 수 없습니다"));
    return fetch("/api/charts?mode=" + mode + "&id=" + encodeURIComponent(id), { method: "DELETE" }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : "HTTP " + r.status);
        return true;
      });
    });
  }

  // 에디터 자동 저장 백업. 서버로 열면 <목업>/charts/_autosave/<id>.json, 서버 없이 열면 브라우저 저장소.
  // 백업 하나 = { id, savedAt(ISO 시각), chart }
  function backupKey(mode, id) { return "td-editor-backup-" + mode + "-" + id; }
  function sendBackup(method, mode, id, body) {
    return fetch("/api/autosave?mode=" + mode + "&id=" + encodeURIComponent(id), {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (res) {
        if (!r.ok) throw new Error(res && res.error ? res.error : "HTTP " + r.status);
        return res;
      });
    });
  }
  function listBackups(mode) {
    if (ONLINE) return getJson("/api/autosave?mode=" + mode).then(function (res) { return res.backups || []; });
    var list = [];
    try {
      var prefix = backupKey(mode, "");
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf(prefix) !== 0) continue;
        var b = JSON.parse(localStorage.getItem(k));
        if (b && b.chart && b.id) list.push(b);
      }
    } catch (e) { /* 저장소를 못 쓰면 백업 없음 */ }
    list.sort(function (a, b) { return String(a.savedAt).localeCompare(String(b.savedAt)); });
    return Promise.resolve(list);
  }
  function saveBackup(mode, chart) {
    if (ONLINE) return sendBackup("PUT", mode, chart.id, JSON.parse(chartFileText(mode, chart))).then(function (res) { return res.savedAt; });
    try {
      var savedAt = new Date().toISOString();
      localStorage.setItem(backupKey(mode, chart.id), JSON.stringify({ id: chart.id, savedAt: savedAt, chart: chart }));
      return Promise.resolve(savedAt);
    } catch (e) { return Promise.reject(e); }
  }
  function deleteBackup(mode, id) {
    if (ONLINE) return sendBackup("DELETE", mode, id).then(function () { return true; });
    try { localStorage.removeItem(backupKey(mode, id)); } catch (e) { /* 무시 */ }
    return Promise.resolve(true);
  }

  root.TDLibrary = {
    online: ONLINE, load: load, loadAudio: loadAudio, saveChart: saveChart, deleteChart: deleteChart, b64ToBuf: b64ToBuf,
    listBackups: listBackups, saveBackup: saveBackup, deleteBackup: deleteBackup
  };
})(this);
