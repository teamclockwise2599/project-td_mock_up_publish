// 두 목업이 같이 쓰는 화면: 계정(켤 때 안내문 · 로그인 · 승인 대기 · 계정 줄), 곡 선택, 기록 배지.
// 게임 흐름(언제 열고 닫는지)은 각 목업 game.js가 정하고, 여기서는 그리기와 고르기만 한다.
(function (root) {
  "use strict";
  var TDChart = root.TDChart;
  var TDSave = root.TDSave;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }

  // ---------- 배지 ----------
  // 보더 색: AP 진한 테마색(갈색 주황) · FC 파랑 · CLEAR 녹색 · FAIL 회색
  var MEDAL_CLASS = { "-1": "m-fail", 1: "m-clear", 2: "m-fc", 3: "m-ap" };
  function medalBadge(medal) {
    return medal ? '<span class="badge ' + MEDAL_CLASS[medal] + '" title="' + TDSave.MEDAL_LABEL[medal] + '">' + TDSave.MEDAL_SHORT[medal] + "</span>" : "";
  }
  // 배지 옆에 붙일 풀네임: 줄임말 배지(AP·FC)만. CLEAR·FAIL은 배지 글자가 곧 이름이라 붙이지 않는다
  function medalName(medal) {
    return TDSave.MEDAL_SHORT[medal] !== TDSave.MEDAL_LABEL[medal] ? " " + TDSave.MEDAL_LABEL[medal] : "";
  }
  function rankBadge(rank) {
    if (!rank) return "";
    var cls = rank === "S+" ? "r-sp" : "r-" + rank.toLowerCase();
    return '<span class="badge rank ' + cls + '">' + esc(rank) + "</span>";
  }
  // 최고 보더를 되돌리기 없이 얻었는지
  function rewindBadge(rec) {
    if (!rec || rec.medal <= 0) return "";
    return rec.medalNR >= rec.medal
      ? '<span class="badge nr" title="최고 보더를 되돌리기(리와인드) 없이 달성">리와인드 미사용</span>'
      : '<span class="badge rw" title="되돌리기(리와인드) 없이 얻은 보더: ' + (TDSave.MEDAL_LABEL[rec.medalNR] || "없음") + '">리와인드 사용</span>';
  }

  // ---------- 랭킹(곡 선택 왼쪽) ----------
  // 곡 + 난이도(채보)마다 하나. state: 게임이 준 이 채보의 랭킹 { status: "custom" | "loading" | "ok" | "error" | "none", entries, message }.
  // entries는 서버 get_ranking의 값(점수 높은 순). 아래 줄은 이 계정의 최고 기록(shared/save.js).
  var RANKING_TEXT = {
    custom: "커스텀 채보는 랭킹이 없습니다.", loading: "랭킹을 불러오는 중…", none: "로그인하면 랭킹이 보입니다.", empty: "아직 기록이 없습니다."
  };
  // 로컬(파일로 열기 · localhost)에서만: 「배포에 포함」(채보 deploy 칸)이 꺼진 커스텀 채보에 「미배포」를 붙인다. 배포본에는 켜진 채보만 들어간다.
  var LOCAL = typeof location !== "undefined" && (location.protocol === "file:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname));
  function officialBadge(c) {
    if (c.official) return '<span class="badge official" title="소유자가 게시한 공식 채보">공식 v' + c.official.version + "</span>";
    return '<span class="badge custom" title="이 기기에만 있는 채보(랭킹 없음)">커스텀</span>' +
      (LOCAL && !c.deploy ? '<span class="badge undeployed" title="배포본(GitHub Pages)에 넣지 않는 채보. 에디터 「배포에 포함」을 켜고 저장하면 넣습니다">미배포</span>' : "");
  }
  function rankingHtml(g, c, save, state) {
    var html = '<div class="rk-head"><h2>랭킹</h2>';
    if (!c) return html + "</div>";
    html += '<div class="rk-sub">' + esc(g.title) + " · " + esc(TDChart.difficultyLabel(c.difficulty)) + " " + TDChart.levelText(c.level) + " " + officialBadge(c) + "</div></div>";
    var st = state || { status: "none" };
    if (st.status === "ok" && st.entries.length) {
      html += '<ol class="rk-list">' + st.entries.map(function (e) {
        var rw = e.rewinds_used > 0 ? '<span class="rk-rw" title="그 판의 규칙: 되돌리기 감점">리와인드 ' + e.rewinds_used + "회 · 감점 " + fmt(e.rule_rewind_penalty) + "</span>" : "";
        // 첫 줄: 순위 · 이름 · 점수, 둘째 줄: 등급 · 보더 · 리와인드(쓴 판만)
        return '<li' + (e.is_me ? ' class="me"' : "") + '><span class="rk-no">' + e.place + '</span><span class="rk-name">' + esc(e.display_name) + '</span><span class="rk-score">' + fmt(e.score) + "</span>" +
          '<span class="rk-tags">' + rankBadge(e.grade) + medalBadge(e.medal) + rw + "</span></li>";
      }).join("") + "</ol>";
    } else {
      var text = st.status === "ok" ? RANKING_TEXT.empty : st.status === "error" ? "랭킹을 불러오지 못했습니다: " + (st.message || "") : RANKING_TEXT[st.status] || RANKING_TEXT.none;
      html += '<div class="rk-empty">' + esc(text) + "</div>";
    }
    var r = save.getRecord(c.id);
    html += '<div class="rk-mine"><span class="rk-k">내 최고 기록</span>' +
      (r.clears ? '<span class="rk-score">' + fmt(r.bestScore) + "</span>" + rankBadge(r.bestRank) + medalBadge(TDSave.borderOf(r)) : '<span class="rk-none">기록 없음</span>') + "</div>";
    return html;
  }

  // ---------- 곡 선택 ----------
  // opts: { charts, save, online, errors, onPlay(chart), onBack(), onLayout?(), onSettings?(), settingsOpen?(), diffSlots?, rankingEl?, ranking?(chart) }
  // diffSlots를 주면 난이도를 칸으로 나란히 두고 칸에 정보를 다 담는다(아래 상세 기록·보더 줄 없음). 주지 않으면 예전 목록형.
  // onSettings를 주면 「시작」 위에 「설정」 버튼을 그린다(settingsOpen()이 참이면 눌린 모양). 주지 않으면 버튼 없음.
  // onLayout을 주면 「설정」 위에 「UI 조정」(게임 화면 배치 편집) 버튼을 그린다.
  // rankingEl을 주면 고른 채보의 랭킹을 거기에 그린다. ranking(chart)은 그 채보의 랭킹 상태를 돌려준다(rankingHtml). 불러오기가 끝나면 refreshRanking().
  // 나눠 보기(전체 · 공식 · 커스텀): 곡 선택 위 탭 또는 Tab 키. 고른 값은 기기에 남긴다(td-select-filter, 두 목업 공통).
  // 돌려주는 값: { render(), handleKey(e) → 처리했으면 true, selected() }
  var FILTERS = [["all", "전체"], ["official", "공식"], ["custom", "커스텀"]];
  var FILTER_KEY = "td-select-filter";
  function songSelect(container, opts) {
    var state = { song: null, chart: null, filter: "all" };
    try {
      var kept = localStorage.getItem(FILTER_KEY);
      if (FILTERS.some(function (f) { return f[0] === kept; })) state.filter = kept;
    } catch (e) { /* 저장소를 못 쓰면 전체 */ }
    function setFilter(f) {
      state.filter = f;
      try { localStorage.setItem(FILTER_KEY, f); } catch (e) { /* 무시 */ }
    }
    function passes(c) {
      return state.filter === "all" || (state.filter === "official") === !!c.official;
    }
    function shown() { return opts.charts.filter(passes); }

    function groups() {
      var by = {};
      var list = [];
      shown().forEach(function (c) {
        if (!by[c.songId]) { by[c.songId] = { songId: c.songId, title: c.title, artist: c.artist, bpm: c.bpm, song: c.song, order: c.order, charts: [] }; list.push(by[c.songId]); }
        var g = by[c.songId];
        g.charts.push(c);
        g.order = Math.min(g.order, c.order);
      });
      list.forEach(function (g) {
        g.charts.sort(function (a, b) { return TDChart.difficultyIndex(a.difficulty) - TDChart.difficultyIndex(b.difficulty) || a.level - b.level; });
        g.unlocked = g.charts.some(function (c) { return opts.save.isUnlocked(c); });
        g.isNew = g.charts.some(function (c) { return opts.save.isNew(c); });
        g.bestMedal = Math.max.apply(null, g.charts.map(function (c) { return TDSave.borderOf(opts.save.getRecord(c.id)); }).concat([0]));
      });
      list.sort(function (a, b) { return (b.unlocked - a.unlocked) || a.order - b.order || a.title.localeCompare(b.title); });
      return list;
    }

    function pickDefaults(list) {
      if (!list.length) { state.song = null; state.chart = null; return; }
      var g = list.filter(function (x) { return x.songId === state.song; })[0] || list.filter(function (x) { return x.unlocked; })[0] || list[0];
      state.song = g.songId;
      var c = g.charts.filter(function (x) { return x.id === state.chart; })[0];
      if (!c) {
        // 열린 것 중 아직 클리어하지 않은 가장 쉬운 난이도, 없으면 열린 것 중 가장 어려운 난이도
        var open = g.charts.filter(function (x) { return opts.save.isUnlocked(x); });
        c = open.filter(function (x) { return opts.save.getRecord(x.id).clears === 0; })[0] || open[open.length - 1] || g.charts[0];
      }
      state.chart = c.id;
    }

    function diffState(c) {
      var rec = opts.save.getRecord(c.id);
      if (!opts.save.isUnlocked(c)) return "🔒 " + esc(opts.save.unlockText(c, opts.charts));
      if (rec.plays === 0) return "미플레이" + (opts.save.isNew(c) ? ' <span class="badge new">NEW</span>' : "");
      // 플레이 횟수 대신 클리어 횟수만 보인다
      if (rec.clears === 0) return '<span class="no">미클리어</span>';
      return '<span class="ok">클리어</span> · ' + rec.clears + "회";
    }

    // 난이도 칸 나란히(opts.diffSlots, 예: ["easy","normal","hard"]): 칸마다 그 난이도의 정보를 다 담는다.
    // 곡에 없는 난이도는 "채보 없음" 칸, 칸 목록에 없는 난이도가 곡에 있으면 순서에 맞춰 칸을 더한다.
    function diffColumns(g, c) {
      var keys = opts.diffSlots.slice();
      g.charts.forEach(function (ch) { if (keys.indexOf(ch.difficulty) < 0) keys.push(ch.difficulty); });
      keys.sort(function (a, b) { return TDChart.difficultyIndex(a) - TDChart.difficultyIndex(b); });
      var html = '<div class="ss-dcols" style="grid-template-columns:repeat(' + keys.length + ',1fr)">';
      keys.forEach(function (key) {
        var ch = g.charts.filter(function (x) { return x.difficulty === key; })[0];
        var name = esc(TDChart.difficultyLabel(key));
        if (!ch) {
          // 나눠 보기로 가려진 난이도는 어느 쪽 채보인지 알린다
          var hid = opts.charts.filter(function (x) { return x.songId === g.songId && x.difficulty === key; })[0];
          html += '<div class="ss-dcard empty"><div class="dc-head"><span class="dc-name">' + name + '</span></div><div class="dc-none">' +
            (hid ? (hid.official ? "공식" : "커스텀") + " 채보<br>(전체에서 보기)" : "채보 없음") + "</div></div>";
          return;
        }
        var r = opts.save.getRecord(ch.id);
        var chOpen = opts.save.isUnlocked(ch);
        var border = TDSave.borderOf(r);
        html += '<button class="ss-dcard' + (ch.id === c.id ? " on" : "") + (chOpen ? "" : " locked") + '" data-chart="' + esc(ch.id) + '">' +
          // 난이도 이름 옆: 최고 보더를 되돌리기 없이 얻었는지(보더가 있을 때만)
          '<div class="dc-head"><span class="dc-name">' + name + "</span>" + rewindBadge(r) + '<span class="dc-lv">' + TDChart.levelText(ch.level) + "</span></div>" +
          '<div class="dc-state">' + diffState(ch) + "</div>" +
          '<div class="dc-score">' + (r.clears ? fmt(r.bestScore) : "–") + "</div>" +
          '<div class="dc-badges">' + (r.clears ? rankBadge(r.bestRank) : "") + medalBadge(border) + medalName(border) + "</div>" +
          '<div class="dc-meta">노트 ' + ch.notes.length + (r.bestCombo ? " · 최대 콤보 " + r.bestCombo : "") + "</div></button>";
      });
      return html + "</div>";
    }

    function render() {
      var list = groups();
      pickDefaults(list);
      var g = list.filter(function (x) { return x.songId === state.song; })[0];
      var c = g && g.charts.filter(function (x) { return x.id === state.chart; })[0];
      var html = '<div class="ss-head"><h2>곡 선택</h2><span class="ss-count">' + list.length + "곡 · 채보 " + shown().length + "개</span>" +
        '<span class="ss-filter" title="Tab 키로 바꿉니다">' + FILTERS.map(function (f) {
          return '<button data-filter="' + f[0] + '"' + (state.filter === f[0] ? ' class="on"' : "") + ">" + f[1] + "</button>";
        }).join("") + "</span>" +
        '<span class="grow"></span><button class="btn small" data-act="back">처음 화면 (Esc)</button></div>';
      if (!list.length && opts.charts.length) {
        html += '<div class="ss-empty">' + (state.filter === "official" ? "공식" : "커스텀") + " 채보가 없습니다.<br>위에서 「전체」를 고르면 모든 채보가 보입니다.</div>";
      } else if (!list.length) {
        html += '<div class="ss-empty">불러온 채보가 없습니다.<br>' + (opts.online ? "charts 폴더에 채보 파일이 있는지 확인하세요." : "서버 없이 열었습니다. start.bat으로 실행하세요.") + "</div>";
      } else {
        html += '<div class="ss-body"><ul class="ss-songs">';
        list.forEach(function (x) {
          html += '<li class="ss-song' + (x.songId === state.song ? " on" : "") + (x.unlocked ? "" : " locked") + '" data-song="' + esc(x.songId) + '">' +
            '<div class="t">' + (x.unlocked ? "" : "🔒 ") + esc(x.title) + (x.isNew ? ' <span class="badge new">NEW</span>' : "") + "</div>" +
            '<div class="a">' + (x.artist ? esc(x.artist) + " · " : "") + "BPM " + x.bpm + (opts.diffSlots ? "" : " · 난이도 " + x.charts.length) + "</div>" +
            '<div class="b">' + x.charts.map(function (ch) {
              var rec = opts.save.getRecord(ch.id);
              var open = opts.save.isUnlocked(ch);
              var bd = TDSave.borderOf(rec);
              return '<span class="badge ' + (open ? (bd ? MEDAL_CLASS[bd] : "rank") : "lock") + '" title="' + esc(TDChart.difficultyLabel(ch.difficulty)) + '">' +
                TDChart.DIFFICULTIES[Math.max(0, TDChart.difficultyIndex(ch.difficulty))].short + " " + TDChart.levelText(ch.level) + "</span>";
            }).join("") + "</div></li>";
        });
        html += "</ul>";
        if (g && c) {
          var rec = opts.save.getRecord(c.id);
          var open = opts.save.isUnlocked(c);
          html += '<div class="ss-detail"><div><div class="ss-title">' + esc(g.title) + '</div><div class="ss-meta">' + (g.artist ? esc(g.artist) + " · " : "") +
            "BPM " + g.bpm + (opts.diffSlots ? "" : " · " + esc(g.song || "음원 없음")) + " " + officialBadge(c) + "</div></div>"; // 3칸 배치에서는 음원 파일 이름을 보이지 않는다
          if (opts.diffSlots) html += diffColumns(g, c);
          else {
            html += '<div class="ss-diffs">';
            g.charts.forEach(function (ch) {
              var r = opts.save.getRecord(ch.id);
              var chOpen = opts.save.isUnlocked(ch);
              html += '<button class="ss-diff' + (ch.id === c.id ? " on" : "") + (chOpen ? "" : " locked") + '" data-chart="' + esc(ch.id) + '">' +
                '<span class="d-name">' + esc(TDChart.difficultyLabel(ch.difficulty)) + '</span><span class="d-lv">' + TDChart.levelText(ch.level) + "</span>" +
                '<span class="d-state">' + diffState(ch) + "</span>" +
                '<span class="d-right">' + (r.clears ? '<span class="d-score">' + fmt(r.bestScore) + "</span>" + rankBadge(r.bestRank) : "") + medalBadge(TDSave.borderOf(r)) + "</span></button>";
            });
            html += "</div>";
            // 고른 난이도의 자세한 기록
            html += '<div class="ss-rec">' +
              '<div class="wide">최고 점수<b>' + (rec.clears ? fmt(rec.bestScore) : "–") + "</b></div>" +
              "<div>등급<b>" + (rec.bestRank || "–") + "</b></div>" +
              "<div>최대 콤보<b>" + (rec.bestCombo || "–") + "</b></div>" +
              "<div>클리어<b>" + rec.clears + "회</b></div>" +
              "<div>노트<b>" + c.notes.length + "</b></div>" +
              '<div class="wide">최고 점수 판 되돌리기<b>' + (rec.bestRewinds === null ? "–" : rec.bestRewinds + "회") + "</b></div></div>";
            var border = TDSave.borderOf(rec);
            html += '<div class="ss-borders">보더 ' + (border ? medalBadge(border) + medalName(border) + " " + rewindBadge(rec) : "<span>없음</span>") + "</div>";
          }
          html += '<div class="ss-foot"><span class="hint">' + (open ? (opts.diffSlots ? "↑↓ 곡 변경 · ←→ 난이도 변경 · Enter 시작" : "↑↓ 곡 · ←→ 난이도 · Enter 시작") : esc(opts.save.unlockText(c, opts.charts))) + "</span>" +
            '<div class="ss-actions">' +
            (opts.onLayout ? '<button class="btn small" data-act="layout">UI 조정</button>' : "") +
            (opts.onSettings ? '<button class="btn small ss-set-btn' + (opts.settingsOpen && opts.settingsOpen() ? " on" : "") + '" data-act="settings">설정</button>' : "") +
            '<button class="btn primary" data-act="play"' + (open ? "" : " disabled") + ">시작</button></div></div></div>";
        }
        html += "</div>";
      }
      // 파일을 더블클릭해 열었을 때만(공개 페이지 · 로컬 서버에서는 보이지 않는다)
      if (!opts.online && location.protocol === "file:") html += '<div class="ss-notice">서버 없이 열어서 저장해 둔 사본 채보만 보입니다. <b>start.bat</b>으로 실행하면 songs 폴더의 곡과 에디터에서 만든 채보가 모두 반영됩니다.</div>';
      (opts.errors || []).forEach(function (e) { html += '<div class="ss-notice err">읽지 못한 채보 파일: ' + esc(e.file) + " (" + esc(e.error) + ")</div>"; });
      container.innerHTML = html;
      drawRanking(g, c);
      // 보고 있는 채보는 NEW 표시를 끈다(다음에 그릴 때부터)
      if (c && opts.save.isUnlocked(c)) opts.save.markSeen(c.id);
    }

    function drawRanking(g, c) {
      if (opts.rankingEl) opts.rankingEl.innerHTML = rankingHtml(g, c, opts.save, c && opts.ranking ? opts.ranking(c) : null);
    }
    function current() {
      return shown().filter(function (x) { return x.id === state.chart; })[0] || null;
    }
    function play() {
      var c = current();
      if (c && opts.save.isUnlocked(c)) opts.onPlay(c);
    }

    container.addEventListener("click", function (e) {
      var el = e.target.closest("[data-song],[data-chart],[data-act],[data-filter]");
      if (!el) return;
      if (el.hasAttribute("data-filter")) { setFilter(el.getAttribute("data-filter")); render(); }
      else if (el.hasAttribute("data-song")) { state.song = el.getAttribute("data-song"); state.chart = null; render(); }
      else if (el.hasAttribute("data-chart")) {
        if (state.chart === el.getAttribute("data-chart")) return; // 두 번 누르면 아래 dblclick이 시작한다
        state.chart = el.getAttribute("data-chart");
        render();
      } else if (el.getAttribute("data-act") === "play") play();
      else if (el.getAttribute("data-act") === "back") opts.onBack();
      else if (el.getAttribute("data-act") === "settings" && opts.onSettings) opts.onSettings();
      else if (el.getAttribute("data-act") === "layout" && opts.onLayout) opts.onLayout();
    });
    container.addEventListener("dblclick", function (e) {
      if (e.target.closest("[data-chart]")) play();
    });

    function move(list, key, dir) {
      var i = -1;
      for (var k = 0; k < list.length; k++) if (list[k] === key) i = k;
      i = Math.max(0, Math.min(list.length - 1, i + dir));
      return list[i];
    }
    function handleKey(e) {
      if (e.code === "Tab") { // 나눠 보기: 전체 → 공식 → 커스텀 (Shift+Tab 거꾸로)
        var fi = FILTERS.map(function (f) { return f[0]; }).indexOf(state.filter);
        setFilter(FILTERS[(fi + (e.shiftKey ? FILTERS.length - 1 : 1)) % FILTERS.length][0]);
        render();
        return true;
      }
      var list = groups();
      if (!list.length) return false;
      var g = list.filter(function (x) { return x.songId === state.song; })[0] || list[0];
      if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        state.song = move(list.map(function (x) { return x.songId; }), state.song, e.code === "ArrowUp" ? -1 : 1);
        state.chart = null;
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        state.chart = move(g.charts.map(function (x) { return x.id; }), state.chart, e.code === "ArrowLeft" ? -1 : 1);
      } else if (e.code === "Enter") {
        play();
        return true;
      } else return false;
      render();
      return true;
    }

    return {
      render: render,
      // 랭킹 칸만 다시 그린다(랭킹을 다 불러왔을 때)
      refreshRanking: function () {
        var c = current();
        var g = c && groups().filter(function (x) { return x.songId === c.songId; })[0];
        drawRanking(g, g ? c : null);
      },
      handleKey: handleKey,
      selected: current,
      select: function (id) {
        var c = opts.charts.filter(function (x) { return x.id === id; })[0];
        if (c && !passes(c)) setFilter("all"); // 가려진 채보를 고르면 전체로
        if (c) { state.song = c.songId; state.chart = c.id; }
      },
      setCharts: function (charts, errors) { opts.charts = charts; opts.errors = errors || []; }
    };
  }

  // ---------- 계정: 안내문 → 로그인 · 가입 요청 → 승인 대기 (메인 화면 index.html) ----------
  // opts.notice가 참이면 안내문부터 띄운다. 플레이할 수 있는 계정(승인 · 관리자 · 소유자)으로 로그인하면 약속을 푼다(값: 내 계정).
  // 화면은 body에 붙인 창 하나(#screen-account)에 차례로 그리고, 끝나면 뗀다. 서버 일은 shared/account.js(TDAccount).
  function accountGate(opts) {
    var A = root.TDAccount;
    var withNotice = !opts || opts.notice !== false;
    return new Promise(function (resolve) {
      var screen = overlay("screen-account");
      function show(html, focusSel) {
        screen.innerHTML = html;
        var f = focusSel && screen.querySelector(focusSel);
        if (f) setTimeout(function () { f.focus(); }, 30);
      }
      function on(sel, fn) { screen.querySelector(sel).addEventListener("click", fn); }

      function notice() {
        show('<div class="panel acc-panel acc-notice">' +
          "<h2>비공개 테스트 안내</h2>" +
          "<p>이 게임은 승인된 분만 이용하는 비공개 테스트 버전입니다.</p>" +
          '<dl class="acc-rights"><dt>게임</dt><dd>게임의 저작권은 <b>Team Clockwise</b>에 있습니다.</dd>' +
          "<dt>음원</dt><dd>음원의 저작권은 각 곡의 작곡가에게 있습니다. 작곡가는 곡 선택 화면에 표시됩니다.</dd></dl>" +
          patchNotesHtml() +
          '<div class="row acc-actions"><button class="btn primary" data-act="ok">확인</button></div>' +
          '<p class="acc-copy">© 2026 Team Clockwise' + (root.TD_VERSION ? " · v" + esc(root.TD_VERSION.version) : "") +
          (root.TD_CONFIG && root.TD_CONFIG.serverShown ? " · " + esc(root.TD_CONFIG.serverName) : "") + "</p></div>", "[data-act=ok]");
        on("[data-act=ok]", check);
      }
      function check() {
        show('<div class="panel acc-panel"><h2>계정 확인 중…</h2></div>');
        A.current().then(route, function (e) { failed(A.errorText(e)); });
      }
      function route(acc) {
        if (!acc) login("in", "");
        else if (A.canPlay(acc)) { screen.remove(); resolve(acc); }
        else if (A.isBanned(acc)) banned(acc);
        else if (acc.role === "rejected") closed(acc);
        else waiting(acc);
      }
      function failed(msg) {
        show('<div class="panel acc-panel"><h2>서버에 연결하지 못했습니다</h2><p>' + esc(msg) + "</p>" +
          '<div class="row acc-actions"><button class="btn primary" data-act="retry">다시 시도</button></div></div>', "[data-act=retry]");
        on("[data-act=retry]", check);
      }
      function logout() { A.signOut().then(function () { login("in", ""); }, function () { login("in", ""); }); }
      function waiting(acc) {
        show('<div class="panel acc-panel"><h2>승인 대기</h2><p><b>' + esc(acc.name) + "</b> (" + esc(acc.email) + ") 계정의 가입 요청이 접수되었습니다.<br>관리자가 승인하면 플레이할 수 있습니다.</p>" +
          '<div class="row acc-actions"><button class="btn primary" data-act="again">다시 확인</button><button class="btn" data-act="out">로그아웃</button></div></div>', "[data-act=again]");
        on("[data-act=again]", check);
        on("[data-act=out]", logout);
      }
      function banned(acc) {
        show('<div class="panel acc-panel"><h2>밴된 계정입니다</h2><p><b>' + esc(acc.name) + "</b> (" + esc(acc.email) + ") 계정은 " +
          (acc.bannedUntil === "infinity" ? "플레이할 수 없습니다(영구)." : esc(A.banUntilText(acc.bannedUntil)) + " 플레이할 수 없습니다.") + "</p>" +
          (acc.banReason ? '<p class="acc-ban-reason">사유: ' + esc(acc.banReason) + "</p>" : "") +
          '<div class="row acc-actions"><button class="btn primary" data-act="again">다시 확인</button><button class="btn" data-act="out">로그아웃</button></div></div>', "[data-act=again]");
        on("[data-act=again]", check);
        on("[data-act=out]", logout);
      }
      function closed(acc) {
        show('<div class="panel acc-panel"><h2>가입이 승인되지 않았습니다</h2><p><b>' + esc(acc.name) + "</b> (" + esc(acc.email) + ") 계정은 이 테스트에 참여할 수 없습니다.</p>" +
          '<div class="row acc-actions"><button class="btn" data-act="out">로그아웃</button></div></div>', "[data-act=out]");
        on("[data-act=out]", logout);
      }

      // tab: "in" 로그인 · "up" 가입 요청. email: 탭을 바꿔도 적어 둔 메일을 남긴다.
      function login(tab, email) {
        var up = tab === "up";
        show('<div class="panel acc-panel">' +
          '<div class="acc-tabs"><button data-tab="in"' + (up ? "" : ' class="on"') + '>로그인</button><button data-tab="up"' + (up ? ' class="on"' : "") + ">가입 요청</button></div>" +
          '<form class="acc-form" novalidate>' +
          '<label>메일<input type="email" name="email" autocomplete="username" value="' + esc(email) + '"></label>' +
          "<label>비밀번호" + (up ? ' <span class="acc-note">' + A.PASSWORD_MIN + "자 이상</span>" : "") +
          '<input type="password" name="pw" autocomplete="' + (up ? "new-password" : "current-password") + '"></label>' +
          (up ? '<label>비밀번호 확인<input type="password" name="pw2" autocomplete="new-password"></label>' +
            '<label>닉네임 <span class="acc-note">' + A.NAME_MIN + "~" + A.NAME_MAX + '자, 다른 사람과 겹치지 않게 · 랭킹에 보입니다</span><input name="name" maxlength="' + A.NAME_MAX + '" autocomplete="nickname"></label>' : "") +
          '<label class="acc-check"><input type="checkbox" name="remember"' + (A.remembered() ? " checked" : "") + '> 로그인 상태 유지 <span class="acc-note">끄면 이 창을 닫을 때 로그아웃</span></label>' +
          '<div class="gate-msg acc-msg"></div>' +
          '<button class="btn primary" type="submit">' + (up ? "가입 요청" : "로그인") + "</button>" +
          (up ? '<p class="acc-hint">가입하면 관리자가 승인한 뒤부터 플레이할 수 있습니다. 비밀번호를 잊으면 메일로 찾을 수 없으니 관리자에게 문의하세요.</p>' : "") +
          "</form></div>", email ? "[name=pw]" : "[name=email]");
        var form = screen.querySelector("form");
        var msg = screen.querySelector(".acc-msg");
        Array.prototype.forEach.call(screen.querySelectorAll("[data-tab]"), function (b) {
          b.addEventListener("click", function () { login(b.getAttribute("data-tab"), form.email.value); });
        });
        function fail(text) {
          msg.textContent = text;
          var panel = screen.querySelector(".acc-panel");
          panel.classList.remove("shake");
          void panel.offsetWidth; // 흔들기를 다시 시작
          panel.classList.add("shake");
        }
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          var problem = A.checkEmail(form.email.value) || A.checkPassword(form.pw.value, up ? form.pw2.value : undefined) || (up ? A.checkName(form.name.value) : "");
          if (problem) { fail(problem); return; }
          var btn = form.querySelector("button[type=submit]");
          btn.disabled = true;
          msg.textContent = "";
          var remember = form.remember.checked;
          (up ? A.signUp(form.email.value, form.pw.value, form.name.value, remember) : A.signIn(form.email.value, form.pw.value, remember)).then(route, function (err) {
            btn.disabled = false;
            fail(A.errorText(err));
          });
        });
      }

      if (withNotice) notice();
      else check();
    });
  }

  // 각 파트(목업 · 에디터)가 켤 때: 플레이할 수 있는 계정으로 로그인해 있지 않으면(서버에 닿지 않을 때도) 메인 화면으로 보낸다.
  // 값: 내 계정. 보낼 때는 풀리지 않는 약속을 돌려준다(페이지가 바뀐다).
  function requireAccount(mainUrl) {
    var A = root.TDAccount;
    function toMain() { location.replace(mainUrl); return new Promise(function () { /* 멈춘다 */ }); }
    return A.current().then(function (acc) { return A.canPlay(acc) ? acc : toMain(); }, toMain);
  }

  // 계정 줄: 닉네임 · 권한 + 메인 화면에서는 관리자(관리자 이상, 계정 관리) · 닉네임 변경 · 비밀번호 변경 · 로그아웃(로그인 화면으로), 파트 처음 화면(opts.mainUrl)에서는 「메인 화면」.
  // 로그인하지 않았으면(점검 모드) 숨긴다.
  function accountBar(el, opts) {
    var A = root.TDAccount;
    var acc = A && A.me();
    el.hidden = !acc;
    if (!acc) { el.innerHTML = ""; return; }
    var cfg = root.TD_CONFIG || {};
    var head = '<span class="acc-name">' + esc(acc.name) + '</span><span class="acc-role">' + esc(A.ROLE_LABEL[acc.role] || acc.role) + "</span>" +
      (cfg.serverShown ? '<span class="acc-server ' + esc(cfg.server) + '" title="이 탭이 쓰는 서버. 로컬은 시험 서버, 주소 뒤 ?server=live로 운영 서버">' + esc(cfg.serverName) + "</span>" : "") + '<span class="grow"></span>';
    if (opts && opts.mainUrl) {
      el.innerHTML = head + '<button class="btn small" data-act="main">메인 화면</button>';
      el.querySelector("[data-act=main]").onclick = function () { location.href = opts.mainUrl; };
      return;
    }
    var admin = A.isAdmin(acc);
    el.innerHTML = head + (admin ? '<button class="btn small" data-act="admin">관리자</button>' : "") +
      '<button class="btn small" data-act="name">닉네임 변경</button><button class="btn small" data-act="pw">비밀번호 변경</button><button class="btn small" data-act="out">로그아웃</button>';
    el.querySelector("[data-act=pw]").onclick = passwordDialog;
    el.querySelector("[data-act=name]").onclick = function () { nameDialog(function () { accountBar(el, opts); }); };
    if (admin) {
      var ab = el.querySelector("[data-act=admin]");
      // 승인을 기다리는 가입 요청 수를 버튼에 붙인다
      var count = function () {
        A.listMembers().then(function (list) {
          var n = (list || []).filter(function (m) { return m.role === "pending"; }).length;
          ab.textContent = "관리자" + (n ? " (" + n + ")" : "");
        }, function () { /* 못 읽으면 숫자 없이 */ });
      };
      ab.onclick = function () { adminScreen(count); }; // 계정 관리(채보 관리는 각 유형 처음 화면)
      count();
    }
    el.querySelector("[data-act=out]").onclick = function () {
      function reload() { location.reload(); }
      A.signOut().then(reload, reload);
    };
  }

  // 닉네임 변경 창. 바꾸면 onDone(계정 줄 다시 그리기)
  function nameDialog(onDone) {
    var A = root.TDAccount;
    var screen = overlay("screen-name");
    screen.innerHTML = '<div class="panel acc-panel"><h2>닉네임 변경</h2><form class="acc-form" novalidate>' +
      '<label>닉네임 <span class="acc-note">' + A.NAME_MIN + "~" + A.NAME_MAX + '자, 다른 사람과 겹치지 않게 · 랭킹에 보입니다</span><input name="name" maxlength="' + A.NAME_MAX + '" autocomplete="nickname" value="' + esc(A.me().name) + '"></label>' +
      '<div class="gate-msg acc-msg"></div>' +
      '<div class="row acc-actions"><button class="btn primary" type="submit">바꾸기</button><button class="btn" type="button" data-act="cancel">취소</button></div></form></div>';
    var form = screen.querySelector("form");
    var msg = screen.querySelector(".acc-msg");
    function close() { closeOnEsc(); screen.remove(); }
    var closeOnEsc = escCloses(close);
    screen.querySelector("[data-act=cancel]").onclick = close;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = "gate-msg acc-msg";
      var problem = A.checkName(form.name.value);
      if (problem) { msg.textContent = problem; return; }
      var btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      A.changeName(form.name.value).then(function () {
        msg.className = "gate-msg acc-msg ok";
        msg.textContent = "닉네임을 바꿨습니다.";
        if (onDone) onDone();
        setTimeout(close, 1000);
      }, function (err) {
        btn.disabled = false;
        msg.textContent = A.errorText(err);
      });
    });
    setTimeout(function () { form.name.focus(); form.name.select(); }, 30);
  }

  function passwordDialog() {
    var A = root.TDAccount;
    var screen = overlay("screen-password");
    screen.innerHTML = '<div class="panel acc-panel"><h2>비밀번호 변경</h2><form class="acc-form" novalidate>' +
      '<label>새 비밀번호 <span class="acc-note">' + A.PASSWORD_MIN + '자 이상</span><input type="password" name="pw" autocomplete="new-password"></label>' +
      '<label>새 비밀번호 확인<input type="password" name="pw2" autocomplete="new-password"></label>' +
      '<div class="gate-msg acc-msg"></div>' +
      '<div class="row acc-actions"><button class="btn primary" type="submit">바꾸기</button><button class="btn" type="button" data-act="cancel">취소</button></div></form></div>';
    var form = screen.querySelector("form");
    var msg = screen.querySelector(".acc-msg");
    function close() { closeOnEsc(); screen.remove(); }
    var closeOnEsc = escCloses(close);
    screen.querySelector("[data-act=cancel]").onclick = close;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var problem = A.checkPassword(form.pw.value, form.pw2.value);
      msg.className = "gate-msg acc-msg";
      if (problem) { msg.textContent = problem; return; }
      var btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      A.changePassword(form.pw.value).then(function () {
        msg.className = "gate-msg acc-msg ok";
        msg.textContent = "비밀번호를 바꿨습니다.";
        setTimeout(close, 1200);
      }, function (err) {
        btn.disabled = false;
        msg.textContent = A.errorText(err);
      });
    });
    setTimeout(function () { form.pw.focus(); }, 30);
  }

  // ---------- 관리자 화면 ----------
  // 계정 관리(메인 화면 계정 줄의 「관리자」, 관리자 이상): 가입 요청(승인 대기 · 거절된 계정 → 승인 · 거절), 계정(소유자: 관리자 임명 · 해제 · 밴 · 밴 해제).
  // 채보 관리(각 유형 처음 화면 메뉴의 「관리자」, 소유자, opts.mode): 그 유형의 공식 채보(내려받기 · 랭킹 초기화 · 내리기 · 버전 기록에서 되돌리기 ·
  //   내린 채보 다시 게시), 그 유형으로 온 받은 채보 요청(내려받기 · 수락 · 거부 · 지우기).
  // 바꾸는 일은 모두 서버 함수가 권한을 다시 확인한다(supabase/schema.sql set_member_role · chart_requests 규칙).
  var ADMIN_MODE_LABEL = { core: "에임형", lanes: "건반형" };
  var REQUEST_STATUS_LABEL = { open: "대기", accepted: "수락", closed: "거부" }; // closed는 서버 값 그대로, 화면 이름만 거부
  function shortTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }
  function adminScreen(onChange, opts) {
    var A = root.TDAccount;
    var owner = A.isOwner(A.me());
    var chartMode = opts && opts.mode; // 있으면 그 유형의 채보 관리, 없으면 계정 관리
    var screen = overlay("screen-admin");
    var tab = chartMode ? "official" : "join";
    var members = null;
    var requests = [];
    var versions = []; // 공식 채보 모든 버전(소유자)
    var openHistory = {}; // "mode/chart_id" → 버전 기록을 펼쳤는가
    var banTarget = null; // 밴 창을 연 계정(계정 탭)
    var banDays = 1; // 고른 기간(일, "forever" = 영구)
    var note = "";
    function close() { closeOnEsc(); screen.remove(); if (onChange) onChange(); }
    var closeOnEsc = escCloses(close);
    function load() {
      var charts = chartMode && owner;
      Promise.all([A.listMembers(), charts ? A.listChartRequests() : Promise.resolve([]), charts ? A.listOfficialVersions() : Promise.resolve([])]).then(function (r) {
        members = r[0] || [];
        requests = (r[1] || []).filter(function (q) { return q.mode === chartMode; });
        versions = (r[2] || []).filter(function (v) { return v.mode === chartMode; });
        draw();
      }, function (e) { note = A.errorText(e); draw(); });
    }
    function act(p, done) {
      note = "처리하는 중…";
      draw();
      p.then(function () { note = done; load(); }, function (e) { note = A.errorText(e); draw(); });
    }
    function nameOf(id) {
      var m = (members || []).filter(function (x) { return x.id === id; })[0];
      return m ? m.display_name : "(지운 계정)";
    }
    // buttons: { label, role(권한 바꾸기) | act("ban" 밴 창 · "unban" 밴 해제), primary, ask(확인 창 문구) }
    function memberRow(m, buttons) {
      var ban = A.isBanned(m);
      return '<li class="adm-row"><span class="adm-main"><b>' + esc(m.display_name) + '</b> <span class="acc-role">' + esc(A.ROLE_LABEL[m.role] || m.role) + "</span>" +
        (ban ? '<span class="acc-role adm-banned">밴 ' + esc(A.banUntilText(m.banned_until)) + "</span>" : "") +
        '<span class="adm-sub">' + esc(m.email || "") + " · 가입 " + shortTime(m.created_at) + (ban && m.ban_reason ? " · 사유: " + esc(m.ban_reason) : "") + "</span></span>" +
        '<span class="adm-acts">' + buttons.map(function (b) {
          return '<button class="btn small' + (b.primary ? " primary" : "") + '" data-id="' + esc(m.id) + '"' + (b.role ? ' data-role="' + b.role + '"' : ' data-ban="' + b.act + '"') +
            (b.ask ? ' data-ask="' + esc(b.ask) + '"' : "") + ">" + esc(b.label) + "</button>";
        }).join("") + "</span></li>";
    }
    // 밴 창: 기간(1 · 3 · 7 · 30일 · 영구 또는 일수 직접) · 사유(선택, 본인에게 보인다)
    var BAN_CHOICES = [[1, "1일"], [3, "3일"], [7, "7일"], [30, "30일"], ["forever", "영구"]];
    function banFormHtml() {
      var m = banTarget;
      return '<div class="adm-ban"><p><b>' + esc(m.display_name) + "</b> (" + esc(m.email || "") + ") 계정을 밴합니다. 기간 동안 플레이할 수 없고, 랭킹에서도 숨겨집니다.</p>" +
        '<div class="adm-ban-days">' + BAN_CHOICES.map(function (c) {
          return '<button class="btn small' + (banDays === c[0] ? " primary" : "") + '" data-days="' + c[0] + '">' + c[1] + "</button>";
        }).join("") + '<span class="adm-ban-or">또는</span><input type="number" min="1" max="3650" name="ban-days" placeholder="일수"' +
        (typeof banDays === "number" && BAN_CHOICES.every(function (c) { return c[0] !== banDays; }) ? ' value="' + banDays + '"' : "") + ">일</div>" +
        '<input class="adm-ban-reason" name="ban-reason" maxlength="200" placeholder="사유(선택, 본인에게 보입니다)">' +
        '<div class="row"><button class="btn small primary" data-act="ban-ok">밴</button><button class="btn small" data-act="ban-cancel">취소</button></div></div>';
    }
    // 공식 채보 탭: 유형 → 채보 id별로 묶어 지금 버전(없으면 내림)과 버전 기록을 보인다
    function chartName(d) {
      var C = root.TDChart;
      return (d.title || "") + " [" + (C ? C.difficultyLabel(d.difficulty) + " " + C.levelText(d.level) : d.difficulty || "") + "]";
    }
    function officialGroups() {
      var by = {};
      var list = [];
      versions.forEach(function (v) {
        var key = v.mode + "/" + v.chart_id;
        if (!by[key]) { by[key] = { key: key, mode: v.mode, chartId: v.chart_id, current: null, all: [] }; list.push(by[key]); }
        by[key].all.push(v);
        if (v.is_current) by[key].current = v;
      });
      return list;
    }
    function officialHtml() {
      var groups = officialGroups();
      if (!groups.length) return '<ul class="adm-list"><li class="adm-empty">게시한 공식 채보가 없습니다. 에디터의 「공식 게시」로 올립니다.</li></ul>';
      var html = "";
      [chartMode].forEach(function (mode) {
        var gs = groups.filter(function (g) { return g.mode === mode; });
        if (!gs.length) return;
        html += '<ul class="adm-list">' + gs.map(function (g) {
          var cur = g.current;
          var latest = g.all[0];
          var row = '<li class="adm-row adm-chart"><span class="adm-main"><b>' + esc(chartName(latest.data)) + "</b> " +
            (cur ? '<span class="badge official">공식 v' + cur.version + "</span>" : '<span class="acc-role">내림</span>') +
            '<span class="adm-sub">' + esc(g.chartId) + ".json · " + (cur ? "게시 " + shortTime(cur.published_at) : "마지막 v" + latest.version + " · 게시 " + shortTime(latest.published_at)) + " · 버전 " + g.all.length + "개</span></span>" +
            '<span class="adm-acts"><button class="btn small" data-ofdl="' + latest.id + '">내려받기</button>' +
            (cur ? '<button class="btn small" data-reset="' + esc(g.key) + '">랭킹 초기화</button><button class="btn small" data-retire="' + esc(g.key) + '">내리기</button>'
              : '<button class="btn small primary" data-repub="' + latest.id + '">다시 게시</button>') +
            '<button class="btn small" data-hist="' + esc(g.key) + '">버전 기록 ' + (openHistory[g.key] ? "▴" : "▾") + "</button></span>";
          if (openHistory[g.key]) {
            row += '<ol class="adm-versions">' + g.all.map(function (v) {
              return "<li><b>v" + v.version + "</b> · 게시 " + shortTime(v.published_at) + (v.is_current ? ' <span class="acc-role">지금</span>' : "") +
                '<span class="grow"></span><button class="btn small" data-ofdl="' + v.id + '">내려받기</button>' +
                (v.is_current ? "" : '<button class="btn small" data-repub="' + v.id + '">이 버전으로 되돌리기</button>') + "</li>";
            }).join("") + "</ol>";
          }
          return row + "</li>";
        }).join("") + "</ul>";
      });
      return html;
    }
    function versionById(id) { return versions.filter(function (v) { return String(v.id) === String(id); })[0]; }
    function currentOf(key) { return versions.filter(function (v) { return v.mode + "/" + v.chart_id === key && v.is_current; })[0]; }
    function download(name, data) {
      var blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    function draw() {
      var tabs = chartMode ? [["official", "공식 채보"], ["requests", "받은 채보 요청"]] : [["join", "가입 요청"]];
      if (!chartMode && owner) tabs.push(["members", "계정"]);
      var head = chartMode ? "관리자 · " + (ADMIN_MODE_LABEL[chartMode] || chartMode) + " 채보" : "관리자 · 계정";
      var html = '<div class="panel acc-panel adm-panel"><div class="adm-head"><h2>' + esc(head) + '</h2><span class="grow"></span><button class="btn small" data-act="close">닫기</button></div>' +
        '<div class="acc-tabs">' + tabs.map(function (t) {
          var n = t[0] === "join" && members ? members.filter(function (m) { return m.role === "pending"; }).length : t[0] === "requests" ? requests.filter(function (q) { return q.status === "open"; }).length : 0;
          return '<button data-tab="' + t[0] + '"' + (t[0] === tab ? ' class="on"' : "") + ">" + t[1] + (n ? " (" + n + ")" : "") + "</button>";
        }).join("") + "</div>";
      if (!members) html += '<p class="adm-empty">' + esc(note || "불러오는 중…") + "</p>";
      else if (tab === "join") {
        var waiting = members.filter(function (m) { return m.role === "pending"; });
        var rejected = members.filter(function (m) { return m.role === "rejected"; });
        html += '<ul class="adm-list">' + (waiting.length ? waiting.map(function (m) {
          return memberRow(m, [{ label: "승인", role: "player", primary: true }, { label: "거절", role: "rejected" }]);
        }).join("") : '<li class="adm-empty">승인을 기다리는 가입 요청이 없습니다.</li>') + "</ul>";
        if (rejected.length) html += '<h3 class="adm-h3">거절한 계정</h3><ul class="adm-list">' + rejected.map(function (m) {
          return memberRow(m, [{ label: "승인", role: "player" }]);
        }).join("") + "</ul>";
      } else if (tab === "members" && banTarget) {
        html += banFormHtml();
      } else if (tab === "members") {
        var active = members.filter(function (m) { return m.role === "owner" || m.role === "admin" || m.role === "player"; });
        html += '<ul class="adm-list">' + active.map(function (m) {
          if (m.role === "owner") return memberRow(m, []);
          var ban = A.isBanned(m) ? { label: "밴 해제", act: "unban", ask: m.display_name + " 계정의 밴을 풉니다." } : { label: "밴", act: "ban" };
          return memberRow(m, m.role === "admin" ? [{ label: "관리자 해제", role: "player" }, ban] : [{ label: "관리자 임명", role: "admin" }, ban]);
        }).join("") + "</ul>";
      } else if (tab === "official") {
        html += officialHtml();
      } else {
        html += '<ul class="adm-list">' + (requests.length ? requests.map(function (q) {
          return '<li class="adm-row"><span class="adm-main"><b>' + esc(q.title) + '</b> <span class="acc-role">' + esc(ADMIN_MODE_LABEL[q.mode] || q.mode) + '</span> <span class="acc-role">' + esc(REQUEST_STATUS_LABEL[q.status] || q.status) + "</span>" +
            '<span class="adm-sub">' + esc(nameOf(q.from_user)) + " · " + shortTime(q.created_at) + " · " + esc(q.chart_id) + ".json</span>" +
            (q.note ? '<span class="adm-note">' + esc(q.note) + "</span>" : "") + "</span>" +
            '<span class="adm-acts"><button class="btn small" data-dl="' + q.id + '">내려받기</button>' +
            (q.status === "open" ? '<button class="btn small primary" data-req="' + q.id + '" data-status="accepted">수락</button><button class="btn small" data-req="' + q.id + '" data-status="closed">거부</button>' : "") +
            '<button class="btn small" data-del="' + q.id + '">지우기</button></span></li>';
        }).join("") : '<li class="adm-empty">받은 채보 요청이 없습니다.</li>') + "</ul>";
      }
      if (members && note) html += '<div class="gate-msg acc-msg adm-msg">' + esc(note) + "</div>";
      html += "</div>";
      screen.innerHTML = html;
    }
    screen.addEventListener("click", function (e) {
      var el = e.target.closest("button");
      if (!el) return;
      if (el.getAttribute("data-act") === "close") { close(); return; }
      if (el.hasAttribute("data-tab")) { tab = el.getAttribute("data-tab"); note = ""; banTarget = null; draw(); return; }
      if (el.hasAttribute("data-ban")) {
        var bm = (members || []).filter(function (x) { return x.id === el.getAttribute("data-id"); })[0];
        if (!bm) return;
        if (el.getAttribute("data-ban") === "unban") {
          if (!confirm(el.getAttribute("data-ask"))) return;
          act(A.setBan(bm.id, null, null), "밴을 풀었습니다.");
        } else { banTarget = bm; banDays = 1; note = ""; draw(); }
        return;
      }
      if (el.hasAttribute("data-days")) {
        var dv = el.getAttribute("data-days");
        banDays = dv === "forever" ? "forever" : Number(dv);
        var keep = screen.querySelector("[name=ban-reason]").value;
        draw();
        screen.querySelector("[name=ban-reason]").value = keep;
        return;
      }
      if (el.getAttribute("data-act") === "ban-cancel") { banTarget = null; draw(); return; }
      if (el.getAttribute("data-act") === "ban-ok") {
        var typed = parseInt(screen.querySelector("[name=ban-days]").value, 10);
        var days = typed >= 1 ? Math.min(typed, 3650) : banDays;
        var until = days === "forever" ? "infinity" : new Date(Date.now() + days * 86400000).toISOString();
        var reason = screen.querySelector("[name=ban-reason]").value.trim();
        var who = banTarget;
        banTarget = null;
        act(A.setBan(who.id, until, reason), who.display_name + " 계정을 " + (days === "forever" ? "영구" : days + "일") + " 밴했습니다.");
        return;
      }
      if (el.hasAttribute("data-role")) {
        if (el.hasAttribute("data-ask") && !confirm(el.getAttribute("data-ask"))) return;
        act(A.setMemberRole(el.getAttribute("data-id"), el.getAttribute("data-role")), "바꿨습니다.");
        return;
      }
      if (el.hasAttribute("data-req")) {
        act(A.setRequestStatus(Number(el.getAttribute("data-req")), el.getAttribute("data-status")), "처리했습니다.");
        return;
      }
      if (el.hasAttribute("data-hist")) { var hk = el.getAttribute("data-hist"); openHistory[hk] = !openHistory[hk]; draw(); return; }
      if (el.hasAttribute("data-ofdl")) {
        var dv = versionById(el.getAttribute("data-ofdl"));
        if (dv) download(dv.chart_id + (dv.is_current ? "" : "_v" + dv.version) + ".json", dv.data);
        return;
      }
      if (el.hasAttribute("data-reset")) {
        var rc = currentOf(el.getAttribute("data-reset"));
        if (!rc || !confirm(chartName(rc.data) + "의 랭킹을 초기화합니다. 지금까지의 기록은 남지만 랭킹에서 빠집니다.")) return;
        act(A.resetRanking(rc.mode, rc.chart_id), "랭킹을 초기화했습니다.");
        return;
      }
      if (el.hasAttribute("data-retire")) {
        var tc = currentOf(el.getAttribute("data-retire"));
        if (!tc || !confirm(chartName(tc.data) + "을(를) 공식에서 내립니다. 게임의 공식 목록에서 빠지고, 기록은 남습니다. 버전 기록에서 다시 게시할 수 있습니다.")) return;
        act(A.retireChart(tc.mode, tc.chart_id), "내렸습니다.");
        return;
      }
      if (el.hasAttribute("data-repub")) {
        var pv = versionById(el.getAttribute("data-repub"));
        if (!pv) return;
        var latestV = versions.filter(function (v) { return v.mode === pv.mode && v.chart_id === pv.chart_id; })[0];
        if (!confirm(chartName(pv.data) + " v" + pv.version + " 내용을 새 버전(v" + (latestV.version + 1) + ")으로 게시합니다. 랭킹은 이어집니다.")) return;
        act(A.publishChart(pv.mode, pv.data, false), "게시했습니다.");
        return;
      }
      if (el.hasAttribute("data-del")) {
        var dq = requests.filter(function (x) { return String(x.id) === el.getAttribute("data-del"); })[0];
        if (!dq || !confirm("「" + dq.title + "」 요청을 지웁니다. 되돌릴 수 없습니다.")) return;
        act(A.deleteChartRequest(dq.id), "지웠습니다.");
        return;
      }
      if (el.hasAttribute("data-dl")) {
        var q = requests.filter(function (x) { return String(x.id) === el.getAttribute("data-dl"); })[0];
        if (!q) return;
        // 채보 파일로 내려받는다. rhythm-<목업>/charts/에 넣으면 에디터에서 열 수 있다.
        var blob = new Blob([JSON.stringify(q.data, null, 2) + "\n"], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = q.chart_id + ".json";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }
    });
    draw();
    load();
  }

  // ---------- 버전 · 패치노트(shared/version.js) ----------
  // 안내문 창 아래에 최신 패치노트, 그 전 것은 접어 둔다.
  function patchNotesHtml() {
    var V = root.TD_VERSION;
    if (!V || !V.notes || !V.notes.length) return "";
    function entry(n) {
      return '<div class="pn-head">v' + esc(n.version) + (n.date ? " · " + esc(n.date) : "") + "</div><ul>" +
        (n.items || []).map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>";
    }
    var html = '<div class="pn"><div class="pn-title">패치노트</div>' + entry(V.notes[0]);
    if (V.notes.length > 1) html += "<details><summary>지난 패치노트</summary>" + V.notes.slice(1).map(entry).join("") + "</details>";
    return html + "</div>";
  }

  // 켜 둔 동안 몇 분마다 version.js를 다시 읽어, 배포된 버전이 지금 돌고 있는 것과 다르면 화면 위에 안내를 띄운다.
  // opts.isBusy(): 참이면(연주 중 등) 안내를 미룬다. 파일로 연 경우(file://)는 확인하지 않는다.
  var VERSION_POLL_MS = 5 * 60 * 1000;
  function watchVersion(opts) {
    var running = root.TD_VERSION && root.TD_VERSION.version;
    var tag = document.querySelector('script[src*="shared/version.js"]');
    if (!running || !tag || !/^https?:$/.test(location.protocol)) return;
    var url = tag.src.split("?")[0];
    var latest = null;
    var lastFetch = 0;
    var banner = null;
    function busy() { return !!(opts && opts.isBusy && opts.isBusy()); }
    function fetchLatest() {
      lastFetch = Date.now();
      fetch(url + "?t=" + lastFetch, { cache: "no-store" }).then(function (r) { return r.ok ? r.text() : ""; }).then(function (text) {
        var i = text.indexOf("{", text.indexOf("TD_VERSION")), j = text.lastIndexOf("}"); // 주석을 건너뛰고 값 부분만
        if (i >= 0 && j > i) latest = JSON.parse(text.slice(i, j + 1));
        check();
      }).catch(function () { /* 못 읽으면 다음에 */ });
    }
    function check() {
      if (!latest || latest.version === running || banner || busy()) return;
      banner = document.createElement("div");
      banner.className = "ver-banner";
      var first = latest.notes && latest.notes[0];
      banner.innerHTML = "<span>새 버전 <b>v" + esc(latest.version) + "</b>이 나왔습니다." + (first && first.items && first.items[0] ? " " + esc(first.items[0]) + (first.items.length > 1 ? " 외" : "") : "") + "</span>" +
        '<button class="btn small primary" data-act="reload">새로 고침</button><button class="btn small" data-act="later">나중에</button>';
      banner.querySelector("[data-act=reload]").onclick = refreshNow;
      banner.querySelector("[data-act=later]").onclick = function () { banner.remove(); banner = null; running = latest.version; }; // 이번 버전은 다시 묻지 않는다
      document.body.appendChild(banner);
    }
    setInterval(function () {
      if (Date.now() - lastFetch >= VERSION_POLL_MS) fetchLatest();
      else check(); // 연주가 끝나면 미뤄 둔 안내를 띄운다
    }, 20000);
    setTimeout(fetchLatest, 30000);
  }
  // 새로 고침: 이 페이지가 쓰는 파일(스크립트 · 스타일)을 브라우저 보관본 대신 새로 받아 둔 뒤 다시 연다(GitHub Pages는 10분 보관).
  function refreshNow() {
    var urls = [location.href.split("#")[0]];
    Array.prototype.forEach.call(document.querySelectorAll("script[src], link[rel=stylesheet][href]"), function (el) {
      var u = el.src || el.href;
      if (u && u.indexOf(location.origin) === 0) urls.push(u);
    });
    Promise.all(urls.map(function (u) { return fetch(u, { cache: "reload" }).catch(function () {}); })).then(function () { location.reload(); });
  }

  // 창이 떠 있는 동안 Esc를 페이지 전체에서 먼저 받아 onClose를 부른다(포커스가 창 밖이어도, 게임의 Esc 처리로는 넘기지 않는다).
  // 돌려주는 함수를 부르면 그만 받는다.
  function escCloses(onClose) {
    function onKey(e) {
      if (e.code !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return function () { window.removeEventListener("keydown", onKey, true); };
  }

  // 다른 화면 위에 덮는 창(.screen)을 body에 붙인다
  function overlay(id) {
    var screen = document.createElement("section");
    screen.className = "screen show acc-screen";
    screen.id = id;
    document.body.appendChild(screen);
    return screen;
  }

  root.TDUI = { songSelect: songSelect, watchVersion: watchVersion, accountGate: accountGate, requireAccount: requireAccount, accountBar: accountBar, adminScreen: adminScreen, medalBadge: medalBadge, medalName: medalName, rankBadge: rankBadge, rewindBadge: rewindBadge, esc: esc, fmt: fmt };
})(this);
