// =============================================================
// 포켓몬 계단 레이스 — 설정 파일
// Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)에서 값을 복사해 넣으세요.
// 이 파일의 값은 공개되어도 되는 "웹 앱 식별 정보"입니다.
// (서비스 계정 키 같은 비밀 키는 절대 여기에 넣지 마세요.)
// =============================================================
export const CONFIG = {
  firebase: {
    apiKey: "AIzaSyDn5vnWHXJrEFjFEzPW9oeK4_WJCu5nrH8",
  authDomain: "pokestair.firebaseapp.com",
  databaseURL: "https://pokestair-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pokestair",
  storageBucket: "pokestair.firebasestorage.app",
  messagingSenderId: "978944147870",
  appId: "1:978944147870:web:bb6552814038dfec6a568f"
},

  // 관리자 로그인 창에 미리 채워 둘 이메일 (편의용).
  // ⚠ 권한은 이 문자열이 아니라 DB의 stairRace/admins/{UID} = true 로만 결정됩니다.
  adminEmail: "pokepack1010@gmail.com",

  // DB 최상위 경로. database.rules.json 안의 "stairRace"와 반드시 같아야 합니다.
  dbRoot: "stairRace",

  game: {
    maxPlayers: 20,              // 보안 규칙의 슬롯 0~19와 일치 (20 초과 불가)
    gameDurationSeconds: 180,    // 관리자 화면의 기본 선택값
    countdownSeconds: 3,         // 시작 전 카운트다운
    idleTimeoutSeconds: 60,      // 무입력 탈락 시간 = 재접속 유예 시간 (5~120초)
    minInputIntervalMs: 80,      // 클라이언트 입력 간격 (규칙의 최소 40ms보다 커야 함)
    rankingUpdateIntervalMs: 250 // 순위표 갱신 주기
  },

  // (선택) 직접 준비한 합법적인 캐릭터 이미지로 교체하려면 경로를 지정하세요.
  // 키는 game.js의 CHARACTERS id 입니다. 이미지는 발밑이 아래쪽 가운데인 PNG 권장.
  // 예: sunny: "assets/sunny.png"
  characterSprites: {
  }
};
