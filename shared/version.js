// 게임 버전 · 패치노트. 배포할 때마다 version을 올리고 notes 맨 앞에 새 항목을 더한다.
// 켜 둔 게임은 이 파일을 몇 분마다 다시 읽어, version이 바뀌었으면 "새 버전" 안내를 띄운다(shared/ui.js watchVersion).
// 그래서 값 부분은 JSON 모양으로 쓴다(키 · 문자열은 큰따옴표, 마지막 항목 뒤 쉼표 없음).
window.TD_VERSION = {
  "version": "0.1.0",
  "notes": []
};
