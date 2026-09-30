// 음원 암호화 · 풀기(서버 음원, 09-30 설계 Docs/23 1절 "음원 보호"). 브라우저와 node 테스트에서 같게 돈다(WebCrypto).
// 서버 저장소에는 곡마다 다른 열쇠로 암호화한 파일만 두고, 열쇠는 승인 이상만 읽는 표(song_keys)에 둔다.
// 게임은 받아서 메모리에서 풀어 바로 재생한다. 소리 녹음 · 코드 분석으로 빼내는 것은 막지 못한다.
// 파일 모양: "TDS1"(4바이트) + 초기값(iv, 12바이트) + AES-GCM 암호문. 열쇠: 256비트, base64 글.
(function (root) {
  "use strict";
  var MAGIC = [0x54, 0x44, 0x53, 0x31]; // "TDS1"
  var IV_LEN = 12;

  function cryptoObj() {
    var c = (typeof globalThis !== "undefined" && globalThis.crypto) || root.crypto;
    if (!c || !c.subtle) throw new Error("이 브라우저에서는 음원 암호를 풀 수 없습니다(https · localhost 주소로 여세요)");
    return c;
  }
  function toB64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function fromB64(b64) {
    var bin = atob(b64);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function importKey(raw, use) {
    return cryptoObj().subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [use]);
  }

  // 음원(ArrayBuffer · Uint8Array) → { data: 암호화한 파일(Uint8Array), key: 새 열쇠(base64) }
  function encrypt(plain) {
    return Promise.resolve().then(function () {
      var c = cryptoObj();
      var raw = c.getRandomValues(new Uint8Array(32));
      var iv = c.getRandomValues(new Uint8Array(IV_LEN));
      return importKey(raw, "encrypt").then(function (k) {
        return c.subtle.encrypt({ name: "AES-GCM", iv: iv }, k, plain);
      }).then(function (ct) {
        var out = new Uint8Array(MAGIC.length + IV_LEN + ct.byteLength);
        out.set(MAGIC, 0);
        out.set(iv, MAGIC.length);
        out.set(new Uint8Array(ct), MAGIC.length + IV_LEN);
        return { data: out, key: toB64(raw) };
      });
    });
  }

  // 암호화한 파일 + 열쇠(base64) → 음원(ArrayBuffer). 열쇠가 틀리거나 파일이 깨졌으면 거절한다.
  function decrypt(data, keyB64) {
    return Promise.resolve().then(function () {
      var u = data instanceof Uint8Array ? data : new Uint8Array(data);
      for (var i = 0; i < MAGIC.length; i++) if (u[i] !== MAGIC[i]) throw new Error("음원 파일 모양이 아닙니다");
      var iv = u.subarray(MAGIC.length, MAGIC.length + IV_LEN);
      var ct = u.subarray(MAGIC.length + IV_LEN);
      return importKey(fromB64(keyB64), "decrypt").then(function (k) {
        return cryptoObj().subtle.decrypt({ name: "AES-GCM", iv: iv }, k, ct);
      }).catch(function (e) {
        throw new Error("음원 암호를 풀지 못했습니다(열쇠가 맞지 않거나 파일이 깨졌습니다)" + (e && e.message ? ": " + e.message : ""));
      });
    });
  }

  var api = { encrypt: encrypt, decrypt: decrypt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TDSongCrypt = api;
})(this);
