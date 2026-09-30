// 온라인 계정(Supabase): 로그인 · 가입 요청 · 로그아웃 · 비밀번호 변경 · 내 계정(이름 · 권한) · 게임 규칙 · 계정에 묶은 플레이 데이터.
// 서버 주소 · 공개 키는 shared/config.js, 서버의 표 · 권한 규칙은 supabase/schema.sql.
// 서버 연결 라이브러리(supabase-js)는 각 index.html이 CDN에서 불러온다(window.supabase). 화면은 shared/ui.js의 accountGate · accountBar.
(function (root) {
  "use strict";

  var NAME_MIN = 2;
  var NAME_MAX = 16;
  var PASSWORD_MIN = 6;
  // 권한(profiles.role) 이름. player 이상이 플레이할 수 있다.
  var ROLE_LABEL = { pending: "승인 대기", player: "플레이어", admin: "관리자", owner: "소유자", rejected: "거절됨" };
  var PLAYABLE = ["player", "admin", "owner"];
  var ADMIN = ["admin", "owner"]; // 가입 승인 · 게임 규칙 · 에디터

  function chars(s) { return Array.from(String(s)).length; } // 서버(char_length)와 같은 글자 수

  // ---------- 입력 검사: 문제가 있으면 안내 문구, 없으면 "" ----------
  function checkEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim()) ? "" : "메일 주소 형식이 아닙니다.";
  }
  function checkName(name) {
    var n = chars(String(name || "").trim());
    return n >= NAME_MIN && n <= NAME_MAX ? "" : "닉네임은 " + NAME_MIN + "~" + NAME_MAX + "자로 정해 주세요.";
  }
  function checkPassword(pw, again) {
    if (chars(pw || "") < PASSWORD_MIN) return "비밀번호는 " + PASSWORD_MIN + "자 이상이어야 합니다.";
    if (again !== undefined && pw !== again) return "비밀번호 확인이 맞지 않습니다.";
    return "";
  }

  // 밴: banned_until이 지금보다 뒤면 밴 기간('infinity' = 영구). 기간이 지나면 저절로 풀린다(서버도 같은 기준).
  function isBanned(acc) {
    var u = acc && (acc.bannedUntil !== undefined ? acc.bannedUntil : acc.banned_until);
    if (!u) return false;
    return u === "infinity" || new Date(u).getTime() > Date.now();
  }
  function banUntilText(u) {
    if (u === "infinity") return "영구";
    var d = new Date(u);
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes()) + "까지";
  }

  // 서버가 돌려준 오류를 화면 문구로. 서버 함수가 직접 쓴 한국어 문구는 그대로 둔다.
  function errorText(err) {
    var code = (err && (err.code || err.error_code)) || "";
    var msg = (err && err.message) || String(err || "");
    if (code === "invalid_credentials" || /Invalid login credentials/i.test(msg)) return "메일 또는 비밀번호가 맞지 않습니다.";
    if (code === "user_already_exists" || /already registered/i.test(msg)) return "이미 가입된 메일입니다.";
    if (code === "weak_password" || /Password should be/i.test(msg)) return "비밀번호는 " + PASSWORD_MIN + "자 이상이어야 합니다.";
    if (code === "same_password") return "지금 비밀번호와 같습니다.";
    if (code === "email_not_confirmed") return "메일 확인이 끝나지 않은 계정입니다. 관리자에게 문의하세요.";
    if (/rate limit/i.test(code + " " + msg)) return "요청이 너무 잦습니다. 잠시 뒤 다시 해 주세요.";
    if (/Database error saving new user/i.test(msg)) return "가입하지 못했습니다. 닉네임이 이미 쓰이고 있을 수 있습니다.";
    if (code === "23505" || /duplicate key/i.test(msg)) return "이미 쓰이는 닉네임입니다.";
    if (code === "23514" && /display_name/.test(msg)) return "닉네임은 " + NAME_MIN + "~" + NAME_MAX + "자로 정해 주세요.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.";
    return msg || "알 수 없는 오류가 났습니다.";
  }

  // ---------- 서버 ----------
  var client = null;
  var me = null; // 마지막으로 확인한 내 계정: { id, email, name, role }

  // 로그인 상태 유지(로그인 창의 체크 칸): 켜면 로그인 정보를 브라우저 저장소(localStorage)에 두어 다시 켜도 이어지고,
  // 끄면 이 탭의 저장소(sessionStorage)에만 두어 창 · 탭을 닫으면 로그아웃된다. 고른 값은 td-auth-remember에 남긴다(기본 켜짐).
  var REMEMBER_KEY = "td-auth-remember";
  function remembered() {
    try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch (e) { return true; }
  }
  function setRemember(on) {
    try { localStorage.setItem(REMEMBER_KEY, on ? "1" : "0"); } catch (e) { /* 무시 */ }
  }
  var authStorage = {
    getItem: function (k) {
      try { return (remembered() ? localStorage : sessionStorage).getItem(k); } catch (e) { return null; }
    },
    setItem: function (k, v) {
      try {
        var keep = remembered();
        (keep ? localStorage : sessionStorage).setItem(k, v);
        (keep ? sessionStorage : localStorage).removeItem(k); // 다른 쪽에 남은 예전 로그인은 지운다
      } catch (e) { /* 무시 */ }
    },
    removeItem: function (k) {
      try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* 무시 */ }
    }
  };

  function getClient() {
    if (client) return client;
    var cfg = root.TD_CONFIG || {};
    if (!root.supabase || !root.supabase.createClient) throw new Error("서버 연결 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.");
    // 로그인 정보는 authStorage(위)에 서버마다 따로 둔다(운영 td-auth · 시험 td-auth-test). 같은 주소의 메인 화면 · 두 목업 · 에디터가 함께 쓴다.
    var storageKey = cfg.server === "test" ? "td-auth-test" : "td-auth";
    client = root.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: storageKey, storage: authStorage } });
    return client;
  }
  function unwrap(res) {
    if (res.error) throw res.error;
    return res.data;
  }
  // 동기 오류(라이브러리 없음 등)도 거절된 약속으로 돌려준다
  function attempt(fn) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }

  // 지금 로그인한 계정. 로그인하지 않았으면 null.
  function current() {
    return attempt(function () {
      var c = getClient();
      return c.auth.getSession().then(unwrap).then(function (d) {
        if (!d.session) { me = null; return null; }
        var user = d.session.user;
        // 밴 칸이 아직 없는 서버(schema.sql을 새로 실행하기 전)면 밴 칸 없이 다시 읽는다(순서가 어긋나도 로그인은 되게)
        function read(cols) { return c.from("profiles").select(cols).eq("id", user.id).maybeSingle().then(unwrap); }
        return read("display_name, role, banned_until, ban_reason").catch(function (e) {
          if (e && e.code === "42703") return read("display_name, role");
          throw e;
        }).then(function (p) {
          me = { id: user.id, email: user.email, name: p ? p.display_name : "", role: p ? p.role : "pending", bannedUntil: p ? p.banned_until : null, banReason: p ? p.ban_reason : null };
          return me;
        });
      });
    });
  }

  // remember: 로그인 상태 유지(생략하면 켜짐)
  function signIn(email, password, remember) {
    setRemember(remember !== false);
    return attempt(function () {
      return getClient().auth.signInWithPassword({ email: String(email).trim(), password: password }).then(unwrap).then(current);
    });
  }

  function nameTaken(name) {
    return attempt(function () { return getClient().rpc("name_taken", { p_name: String(name).trim() }).then(unwrap); });
  }

  // 가입 요청: 이름 중복을 먼저 확인하고 가입한다. 가입하면 서버가 승인 대기 계정을 만든다.
  function signUp(email, password, name, remember) {
    var n = String(name).trim();
    setRemember(remember !== false);
    return nameTaken(n).then(function (taken) {
      if (taken) throw new Error("이미 쓰이는 닉네임입니다.");
      return getClient().auth.signUp({ email: String(email).trim(), password: password, options: { data: { display_name: n } } }).then(unwrap);
    }).then(function (d) {
      if (!d.session) throw new Error("가입은 됐지만 메일 확인이 필요한 설정입니다. 관리자에게 문의하세요.");
      return current();
    });
  }

  function signOut() {
    return attempt(function () {
      return getClient().auth.signOut().then(unwrap).then(function () { me = null; });
    });
  }

  // 닉네임(profiles.display_name, 랭킹에 보이는 이름) 바꾸기: 본인 것만(서버 규칙). 겹치는지 먼저 확인한다(대소문자 무시).
  function changeName(name) {
    var n = String(name).trim();
    if (!me) return Promise.reject(new Error("로그인하지 않았습니다."));
    if (n === me.name) return Promise.resolve(me);
    var same = n.toLowerCase() === String(me.name).toLowerCase(); // 대소문자만 바꾸는 것은 본인 이름과 겹쳐도 된다
    return (same ? Promise.resolve(false) : nameTaken(n)).then(function (taken) {
      if (taken) throw new Error("이미 쓰이는 닉네임입니다.");
      return getClient().from("profiles").update({ display_name: n }).eq("id", me.id).select("display_name").then(unwrap);
    }).then(function (rows) {
      if (!rows || !rows.length) throw new Error("닉네임을 바꾸지 못했습니다.");
      me.name = rows[0].display_name;
      return me;
    });
  }

  function changePassword(password) {
    return attempt(function () { return getClient().auth.updateUser({ password: password }).then(unwrap); });
  }

  // 게임 규칙(목업별 되돌리기 횟수 · 감점): { rewind_limit, rewind_penalty }. 승인 이상이 읽는다.
  function loadRules(mode) {
    return attempt(function () {
      return getClient().from("game_rules").select("rewind_limit, rewind_penalty").eq("mode", mode).maybeSingle().then(unwrap);
    });
  }
  // 관리자 이상이 바꾼다. 권한이 없으면 서버가 아무 줄도 바꾸지 않으므로 그것을 오류로 돌려준다.
  function saveRules(mode, rules) {
    return attempt(function () {
      return getClient().from("game_rules").update(rules).eq("mode", mode).select("rewind_limit, rewind_penalty").then(unwrap).then(function (rows) {
        if (!rows || !rows.length) throw new Error("관리자 이상만 게임 규칙을 바꿀 수 있습니다.");
        return rows[0];
      });
    });
  }

  // ---------- 플레이 데이터(튜토리얼 · 기록 · 해금, shared/save.js) ----------
  function loadProgress(mode) {
    return attempt(function () { return getClient().rpc("load_progress", { p_mode: mode }).then(unwrap); });
  }
  function saveProgress(mode, data) {
    return attempt(function () { return getClient().rpc("save_progress", { p_mode: mode, p_data: data }).then(unwrap); });
  }

  // 플레이 데이터(save: TDSave.create의 값)를 로그인한 계정에 묶는다. 켤 때 서버 것을 받아 합치고, 이후 바뀔 때마다 서버에 올린다.
  // 이 브라우저의 데이터가 이 계정 것이거나 계정 연결 전 것(owner 없음)이면 서버 것과 합치고, 다른 계정 것이면 버린다.
  // onError(문구): 받기 · 올리기에 실패했을 때(올리기 실패는 한 번만). 받기에 실패하면 이번 실행의 진행은 계정에 올리지 않는다.
  function bindProgress(save, mode, onError) {
    var S = root.TDSave;
    var acc = me;
    if (!acc) return Promise.resolve();
    return loadProgress(mode).then(function (remote) {
      var local = save.data;
      var keepLocal = !local.owner || local.owner === acc.id;
      var merged = S.merge(keepLocal ? local : null, remote);
      merged.owner = acc.id;
      save.adopt(merged);
      var busy = false;
      var dirty = false;
      var warned = false;
      function push() {
        if (busy) { dirty = true; return; }
        busy = true;
        dirty = false;
        var copy = JSON.parse(JSON.stringify(save.data));
        delete copy.owner; // 서버는 계정별 줄이라 필요 없다
        saveProgress(mode, copy).then(done, function (e) {
          if (!warned) { warned = true; onError("플레이 데이터를 계정에 저장하지 못했습니다: " + errorText(e)); }
          done();
        });
        function done() { busy = false; if (dirty) push(); }
      }
      save.onChange = push;
      push();
    }, function (e) {
      if (save.data.owner && save.data.owner !== acc.id) { // 다른 계정 데이터는 보이지 않게
        var fresh = S.fresh();
        fresh.owner = acc.id;
        save.adopt(fresh);
      }
      onError("플레이 데이터를 계정에서 불러오지 못했습니다. 이번 실행의 진행은 계정에 저장되지 않습니다: " + errorText(e));
    });
  }

  // ---------- 공식 채보 · 기록 · 랭킹 · 관리(서버 함수는 supabase/schema.sql) ----------
  function rpc(name, args) {
    return attempt(function () { return getClient().rpc(name, args || {}).then(unwrap); });
  }
  // 지금 버전 공식 채보(승인 이상): [{ id(줄 번호), chart_id, version, rank_epoch, data(채보 파일 내용), song_file, published_at }]
  function loadOfficialCharts(mode) {
    return attempt(function () {
      return getClient().from("official_charts").select("id, chart_id, version, rank_epoch, data, song_file, published_at")
        .eq("mode", mode).eq("is_current", true).then(unwrap);
    });
  }
  // 공식 채보 게시(소유자). chart: 채보 파일 내용. 돌려주는 값: 새 줄 번호
  function publishChart(mode, chart, resetRanking) {
    return rpc("publish_chart", { p_mode: mode, p_chart_id: chart.id, p_data: chart, p_song_file: chart.song || null, p_reset_ranking: !!resetRanking });
  }
  // 기록 올리기(승인 이상). r: { row, cleared, score, grade, medal, maxCombo, rewindsUsed, rewindLimit, rewindPenalty }
  function submitScore(r) {
    return rpc("submit_score", {
      p_chart_row: r.row, p_cleared: !!r.cleared, p_score: r.score, p_grade: r.grade || null, p_medal: r.medal,
      p_max_combo: r.maxCombo || 0, p_rewinds_used: r.rewindsUsed || 0, p_rule_rewind_limit: r.rewindLimit, p_rule_rewind_penalty: r.rewindPenalty
    });
  }
  // 랭킹(곡 + 난이도): [{ place, display_name, score, grade, medal, rewinds_used, rule_rewind_limit, rule_rewind_penalty, played_at, is_me }]
  function getRanking(mode, chartId, limit) {
    return rpc("get_ranking", { p_mode: mode, p_chart_id: chartId, p_limit: limit || 50 });
  }
  // 관리자 이상: 계정 목록 · 권한 바꾸기(승인 · 거절 · 관리자 임명 · 해제)
  function listMembers() { return rpc("list_members"); }
  // 밴(소유자): until = 끝 시각(ISO 글) 또는 "infinity"(영구), null이면 풀기
  function setBan(id, until, reason) { return rpc("set_ban", { p_target: id, p_until: until, p_reason: reason || null }); }
  function setMemberRole(id, role) { return rpc("set_member_role", { p_target: id, p_role: role }); }
  // 채보 요청: 관리자가 커스텀 채보를 소유자에게 보낸다. 소유자는 받은 목록을 보고 처리 상태를 바꾼다.
  function sendChartRequest(mode, chart, title, note) {
    return attempt(function () {
      return getClient().from("chart_requests").insert({ mode: mode, chart_id: chart.id, title: title, note: note || "", data: chart }).then(unwrap);
    });
  }
  function listChartRequests() {
    return attempt(function () {
      return getClient().from("chart_requests").select("id, from_user, mode, chart_id, title, note, data, status, created_at, handled_at")
        .order("created_at", { ascending: false }).then(unwrap);
    });
  }
  function setRequestStatus(id, status) {
    return attempt(function () {
      return getClient().from("chart_requests").update({ status: status, handled_at: new Date().toISOString() }).eq("id", id).select("id").then(unwrap).then(function (rows) {
        if (!rows || !rows.length) throw new Error("소유자만 채보 요청을 처리할 수 있습니다.");
      });
    });
  }

  // 공식 채보 관리(소유자): 모든 버전 목록 · 내리기 · 랭킹만 초기화. 되돌리기 · 다시 게시는 publishChart로 그 버전 내용을 새 버전으로 올린다.
  function listOfficialVersions() {
    return attempt(function () {
      return getClient().from("official_charts").select("id, mode, chart_id, version, is_current, rank_epoch, data, published_at")
        .order("mode").order("chart_id").order("version", { ascending: false }).then(unwrap);
    });
  }
  function retireChart(mode, chartId) { return rpc("retire_chart", { p_mode: mode, p_chart_id: chartId }); }
  function resetRanking(mode, chartId) { return rpc("reset_ranking", { p_mode: mode, p_chart_id: chartId }); }

  // 채보 요청 지우기(소유자). 권한이 없으면 서버가 아무 줄도 지우지 않으므로 그것을 오류로 돌려준다.
  function deleteChartRequest(id) {
    return attempt(function () {
      return getClient().from("chart_requests").delete().eq("id", id).select("id").then(unwrap).then(function (rows) {
        if (!rows || !rows.length) throw new Error("소유자만 채보 요청을 지울 수 있습니다.");
      });
    });
  }

  var api = {
    NAME_MIN: NAME_MIN, NAME_MAX: NAME_MAX, PASSWORD_MIN: PASSWORD_MIN, ROLE_LABEL: ROLE_LABEL, remembered: remembered,
    checkEmail: checkEmail, checkName: checkName, checkPassword: checkPassword, errorText: errorText,
    canPlay: function (acc) { return !!acc && PLAYABLE.indexOf(acc.role) >= 0 && !isBanned(acc); },
    isAdmin: function (acc) { return !!acc && ADMIN.indexOf(acc.role) >= 0 && !isBanned(acc); },
    isBanned: isBanned, banUntilText: banUntilText,
    me: function () { return me; },
    client: getClient,
    current: current, signIn: signIn, signUp: signUp, signOut: signOut, changePassword: changePassword, changeName: changeName, nameTaken: nameTaken,
    loadRules: loadRules, saveRules: saveRules, bindProgress: bindProgress,
    isOwner: function (acc) { return !!acc && acc.role === "owner"; },
    loadOfficialCharts: loadOfficialCharts, publishChart: publishChart, submitScore: submitScore, getRanking: getRanking,
    listMembers: listMembers, setMemberRole: setMemberRole, setBan: setBan, sendChartRequest: sendChartRequest, listChartRequests: listChartRequests, setRequestStatus: setRequestStatus, deleteChartRequest: deleteChartRequest,
    listOfficialVersions: listOfficialVersions, retireChart: retireChart, resetRanking: resetRanking
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TDAccount = api;
})(this);
