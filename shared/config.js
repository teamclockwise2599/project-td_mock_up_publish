// 목업 공용 설정. 바꾸고 싶은 값만 고치면 된다.
// 온라인 서버(Supabase)는 둘이다: 운영 서버(유저가 쓰는 GitHub Pages)와 시험 서버(로컬에서 고치고 시험하는 곳).
// 파일로 열거나 localhost(start.bat)면 시험 서버, 그 밖의 웹 주소면 운영 서버. 주소 뒤에 ?server=live 또는 ?server=test를 붙이면
// 그 탭은 그 서버를 쓴다(확정본을 로컬에서 운영 서버에 게시할 때 등, 탭을 닫을 때까지).
// 공개 키(publishable)는 브라우저에 드러나도 되는 키이고, 실제 보호는 서버의 권한 규칙(supabase/schema.sql)이 한다.
(function () {
  var SERVERS = {
    live: { name: "운영 서버", url: "https://guobhqxwsohhhknldohn.supabase.co", key: "sb_publishable_gfISBXapGiWHgYLSvbhFyw_UJhVz25o" },
    test: { name: "시험 서버", url: "https://udhyecncuqvdufbnjpgc.supabase.co", key: "sb_publishable__h8QbMoF9yKskfn5zlXpZw_huvrb99y" }
  };
  var local = location.protocol === "file:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var pick = local ? "test" : "live";
  try {
    var asked = new URLSearchParams(location.search).get("server");
    if (asked === "live" || asked === "test") sessionStorage.setItem("td-server", asked);
    var kept = sessionStorage.getItem("td-server");
    if (kept === "live" || kept === "test") pick = kept;
  } catch (e) { /* 저장소를 못 쓰면 주소로 정한 서버 */ }
  window.TD_CONFIG = {
    server: pick, // "live" | "test"
    serverName: SERVERS[pick].name,
    serverShown: pick === "test" || local, // 계정 줄 등에 서버 이름을 보일까(유저가 쓰는 운영 페이지에서는 숨긴다)
    supabaseUrl: SERVERS[pick].url,
    supabaseKey: SERVERS[pick].key
  };
})();
