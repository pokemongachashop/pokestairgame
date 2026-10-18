// =============================================================
// 포켓몬 계단 레이스 — game.js
// 2D Canvas 렌더링 + Firebase Auth / Realtime Database
// 별도 서버 없이, 이동 판정은 database.rules.json(보안 규칙)이 검증합니다.
// =============================================================
import { CONFIG } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, onValue, update, get, push, serverTimestamp, onDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

/* ---------------- 설정 ---------------- */
const ROOT = CONFIG.dbRoot || "stairRace";
const GC = Object.assign({
  maxPlayers: 20, gameDurationSeconds: 180, countdownSeconds: 3,
  idleTimeoutSeconds: 60, minInputIntervalMs: 80, rankingUpdateIntervalMs: 250
}, CONFIG.game || {});
const MAX_PLAYERS = Math.max(1, Math.min(20, GC.maxPlayers | 0 || 20)); // 규칙 슬롯 0~19
const INPUT_GAP = Math.max(60, GC.minInputIntervalMs | 0);             // 규칙 최소 40ms보다 여유
const STEP_H = 0.62;   // 계단 1칸의 세로 높이 (가로 1칸 = 1)
const PATH = {
  current: `${ROOT}/game/current`,
  players: `${ROOT}/game/players`,
  slots: `${ROOT}/game/slots`,
  runs: (gid) => `${ROOT}/game/runs/${gid}`,
  history: `${ROOT}/game/history`,
  stats: `${ROOT}/playerStats`,
  admins: `${ROOT}/admins`
};

/* ---------------- 캐릭터 (오리지널 테스트 캐릭터) ----------------
   공식 포켓몬 이미지는 포함하지 않습니다. 합법적으로 확보한 스프라이트가 있으면
   config.js 의 characterSprites 로 교체하세요. 능력치는 모두 동일합니다. */
export const CHARACTERS = [
  { id: "sunny",  name: "해님냥",     body: "#FFD54A", belly: "#FFF3C4", acc: "#F2B705", ear: "tri",   tail: "thin",   cheek: "#FF8A80" },
  { id: "mint",   name: "민트토끼",   body: "#9BE7CF", belly: "#E9FFF7", acc: "#62C9AA", ear: "long",  tail: "nub",    cheek: "#FFB3C7" },
  { id: "coral",  name: "산호여우",   body: "#FF9466", belly: "#FFE6D8", acc: "#F26B3A", ear: "tri",   tail: "fluffy", cheek: null },
  { id: "sky",    name: "하늘곰",     body: "#86C8F5", belly: "#E3F3FF", acc: "#5AA6DD", ear: "round", tail: "nub",    cheek: "#FFB0B0" },
  { id: "lav",    name: "라벤더부엉", body: "#B9A3E3", belly: "#F1EAFF", acc: "#8F75C9", ear: "tuft",  tail: "none",   beak: true },
  { id: "choco",  name: "초코다람",   body: "#B07D5B", belly: "#F3DCC6", acc: "#8A5A3C", ear: "round", tail: "fluffy", cheek: "#FF9E9E" },
  { id: "cherry", name: "체리병아리", body: "#FFB3C1", belly: "#FFE8EE", acc: "#FF7F9C", ear: "crest", tail: "none",   beak: true },
  { id: "cloud",  name: "구름양",     body: "#F7F4EE", belly: "#FFFFFF", acc: "#BDB4A6", ear: "wool",  tail: "none",   cheek: "#FFC1C1" },
  { id: "lime",   name: "라임개굴",   body: "#A9DC6E", belly: "#EEFAD9", acc: "#7DBB3E", ear: "bumps", tail: "none",   cheek: "#FF9E9E" },
  { id: "night",  name: "밤하늘펭",   body: "#3E4C82", belly: "#F4F6FF", acc: "#2B3663", ear: "none",  tail: "none",   beak: true }
];
const charById = (id) => CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
const spriteCache = {};
function spriteFor(id) {
  const src = CONFIG.characterSprites && CONFIG.characterSprites[id];
  if (!src) return null;
  if (!spriteCache[id]) { const img = new Image(); img.src = src; spriteCache[id] = img; }
  const img = spriteCache[id];
  return img.complete && img.naturalWidth ? img : null;
}

/* ---------------- 공통 계단 코스 ----------------
   ⚠ database.rules.json 의 방향 검증 식과 반드시 같은 수식이어야 합니다.
   계단 s(1부터)에서 방향이 바뀌는지: ((s*s*7919 + s*seed + seed*31) % 10007) % 3 === 0
   계단 0은 시작 발판, 처음 방향은 "R". */
export function isTurn(s, seed) {
  return ((s * s * 7919 + s * seed + seed * 31) % 10007) % 3 === 0;
}
export class Course {
  constructor(seed) { this.seed = seed; this.dir = ["R"]; this.x = [0]; }
  ensure(n) {
    for (let s = this.x.length; s <= n; s++) {
      const p = this.dir[s - 1];
      const d = isTurn(s, this.seed) ? (p === "L" ? "R" : "L") : p;
      this.dir.push(d);
      this.x.push(this.x[s - 1] + (d === "R" ? 1 : -1));
    }
  }
  dirAt(s) { this.ensure(s); return this.dir[s]; }
  xAt(s) { if (s <= 0) return 0; this.ensure(s); return this.x[s]; }
}

/* ---------------- 유틸 ---------------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const fmtTime = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } }
};
function toast(msg, ms = 2200) {
  const el = $("toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

/* ---------------- 상태 ---------------- */
let app, auth, db;
const configured = !String(CONFIG.firebase?.apiKey || "").startsWith("YOUR_");

const S = {
  uid: null, user: null, isAdmin: false, admins: {},
  offset: 0, connected: false,
  current: null, players: {}, runs: {}, runsGid: null, runsLoaded: false,
  course: null,
  local: { has: false, s: 0, d: "R", a: true, t: 0, pending: 0, lastInputAt: 0, fallReason: null },
  inputQ: [], pumpTimer: null,
  screen: null, lastPhase: null,
  presenceSet: false, creatingRun: false, runFail: null,
  finalizing: false, finalizeTried: null, finalResult: null, histFetching: null, dismissedGid: null,
  follow: null,
  myChar: store.get("sr_char", "sunny"), myName: store.get("sr_name", ""),
  ents: new Map(), cam: null,
  unsubs: [], unsubRuns: null,
  rankEls: new Map(), rankCollapsed: window.innerWidth <= 720,
  goFlashUntil: 0, lastFrame: 0
};
const now = () => Date.now() + S.offset;

/* ---------------- 게임 시간 / 단계 ---------------- */
function gameTimes() {
  const c = S.current;
  if (!c || typeof c.startedAt !== "number") return null;
  const go = c.startedAt + (c.countdownMs || 0);
  let end = go + (c.durationMs || 0);
  if (c.status === "ended" && typeof c.endedAt === "number") end = Math.min(end, Math.max(c.endedAt, c.startedAt));
  return { go, end };
}
function phase() {
  const c = S.current;
  if (!c || c.status === "lobby" || !c.gid) return "lobby";
  const t = gameTimes(); if (!t) return "lobby";
  const n = now();
  if (c.status === "ended" || n >= t.end) return "ended";
  if (n < t.go) return "countdown";
  return "running";
}
// 규칙과 동일한 생존 판정: 추락(a=false)했거나, 마지막 이동 후 무입력 시간이 초과되면 탈락
function effAlive(r, at) {
  const t = gameTimes(); if (!t || !r) return false;
  return !!r.a && (at - Math.max(r.t || 0, t.go) <= (S.current.idleMs || 60000));
}
function computeRanking() {
  const t = gameTimes(); if (!t) return [];
  const at = Math.min(now(), t.end);
  return Object.entries(S.runs || {}).map(([uid, r]) => ({
    uid, name: r.n, ch: r.c, steps: r.s | 0, t: r.t || 0,
    alive: effAlive(r, at), online: !!(S.players[uid] && S.players[uid].on)
  })).sort((a, b) => (b.steps - a.steps) || (a.t - b.t) || (a.uid < b.uid ? -1 : 1))
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

/* =============================================================
   부팅 / 인증
============================================================= */
function boot() {
  $("inp-name").value = S.myName;
  buildCharGrid($("char-grid"), true);
  buildCharGrid($("lobby-char-grid"), false);
  $("lobby-max").textContent = MAX_PLAYERS;
  $("adm-email").value = CONFIG.adminEmail || "";
  const dSel = $("adm-duration");
  if (![...dSel.options].some((o) => +o.value === GC.gameDurationSeconds)) dSel.add(new Option(`${GC.gameDurationSeconds}초`, GC.gameDurationSeconds));
  dSel.value = String(GC.gameDurationSeconds);
  const iSel = $("adm-idle");
  if (![...iSel.options].some((o) => +o.value === GC.idleTimeoutSeconds)) iSel.add(new Option(`${GC.idleTimeoutSeconds}초`, GC.idleTimeoutSeconds));
  iSel.value = String(GC.idleTimeoutSeconds);
  bindUI();
  show("start");
  if (!configured) {
    setMsg("start-msg", "config.js에 Firebase 설정값을 입력해야 게임이 실행됩니다.");
    $("btn-join").disabled = true;
    renderConn();
    return;
  }
  app = initializeApp(CONFIG.firebase);
  auth = getAuth(app);
  db = getDatabase(app);
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      signInAnonymously(auth).catch((e) => {
        console.error(e);
        setMsg("start-msg", "익명 로그인 실패: Firebase 콘솔에서 '익명' 로그인 제공업체를 켜 주세요.");
      });
      return;
    }
    setUser(user);
  });
  setInterval(tick, 100);
  setInterval(renderRank, Math.max(100, GC.rankingUpdateIntervalMs));
  requestAnimationFrame(frame);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { tick(); route(); } });
}

function setUser(user) {
  if (S.uid === user.uid) return;
  S.unsubs.forEach((u) => u()); S.unsubs = [];
  if (S.unsubRuns) { S.unsubRuns(); S.unsubRuns = null; }
  Object.assign(S, {
    uid: user.uid, user, isAdmin: false, admins: {}, players: {}, runs: {}, runsGid: null, runsLoaded: false,
    presenceSet: false, creatingRun: false, finalResult: null, follow: null
  });
  S.ents.clear(); resetLocal();
  subscribeBase();
  renderAdminModal();
}

function subscribeBase() {
  const sub = (path, fn) => S.unsubs.push(onValue(ref(db, path), fn, (err) => console.warn(path, err.message)));
  sub(".info/serverTimeOffset", (s) => { S.offset = s.val() || 0; });
  sub(".info/connected", (s) => {
    const was = S.connected;
    S.connected = !!s.val();
    if (S.connected && !was) S.presenceSet = false; // 재연결 시에만 접속 표시 다시 등록
    ensurePresence(); renderConn();
  });
  sub(PATH.admins, (s) => {
    S.admins = s.val() || {};
    S.isAdmin = S.admins[S.uid] === true;
    document.body.classList.toggle("is-admin", S.isAdmin);
    renderAdminModal(); renderLobby();
  });
  sub(PATH.current, (s) => { S.current = s.val(); onCurrentChanged(); });
  sub(PATH.players, (s) => { S.players = s.val() || {}; ensurePresence(); route(); renderLobby(); });
}

function onCurrentChanged() {
  const c = S.current;
  const gid = c && c.gid ? c.gid : null;
  if (gid !== S.runsGid) {
    if (S.unsubRuns) { S.unsubRuns(); S.unsubRuns = null; }
    S.runs = {}; S.runsLoaded = false; S.runsGid = gid;
    S.ents.clear(); S.cam = null; S.follow = null; resetLocal();
    S.finalizing = false;
    if (gid) {
      S.unsubRuns = onValue(ref(db, PATH.runs(gid)), (s) => {
        S.runs = s.val() || {}; S.runsLoaded = true; onRunsChanged();
      }, (err) => console.warn("runs", err.message));
    }
  }
  if (c && typeof c.seed === "number" && (!S.course || S.course.seed !== c.seed)) S.course = new Course(c.seed);
  S.lastPhase = null; // tick에서 다시 판정
  tick(); route(); renderLobby();
}

function resetLocal() {
  S.local = { has: false, s: 0, d: "R", a: true, t: 0, pending: 0, lastInputAt: 0, fallReason: null };
  S.inputQ.length = 0;
}

function onRunsChanged() {
  const r = S.runs[S.uid];
  // 전송 중인 이동이 없을 때만 서버(규칙 통과) 상태를 그대로 채택 → 새로고침 복구 / 거부 시 재동기화
  if (r && S.local.pending === 0) {
    const wasAlive = S.local.has ? S.local.a : true;
    S.local.has = true; S.local.s = r.s | 0; S.local.d = r.d; S.local.t = r.t || 0;
    S.local.a = !!r.a;
    if (wasAlive && !r.a && !S.local.fallReason) S.local.fallReason = "wrong";
  }
  if (!r && S.local.has && S.local.pending === 0) resetLocal();
  ensureRun();
}

/* ---------------- 접속 상태 (presence) ---------------- */
function ensurePresence() {
  if (!S.connected || !S.uid || !S.players[S.uid] || S.presenceSet) return;
  S.presenceSet = true;
  const r = ref(db, `${PATH.players}/${S.uid}`);
  onDisconnect(r).update({ on: false, seen: serverTimestamp() })
    .then(() => update(r, { on: true, seen: serverTimestamp() }))
    .catch((e) => { console.warn(e); S.presenceSet = false; });
}

/* =============================================================
   참가 / 퇴장
============================================================= */
function cleanName(v) { return String(v || "").replace(/\s+/g, " ").trim().slice(0, 12); }

async function join() {
  if (!S.uid) return setMsg("start-msg", "서버에 연결하는 중입니다. 잠시 후 다시 시도하세요.");
  const name = cleanName($("inp-name").value);
  if (!name) return setMsg("start-msg", "닉네임을 입력해 주세요.");
  S.myName = name; store.set("sr_name", name);
  if (S.players[S.uid]) { route(); return; }
  $("btn-join").disabled = true; setMsg("start-msg", "");
  try {
    const slots = (await get(ref(db, PATH.slots))).val() || {};
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const owner = slots[i];
      if (owner && S.players[owner]) continue;
      try {
        if (owner) await update(ref(db, PATH.slots), { [i]: null }); // 주인 없는 슬롯 정리
        await update(ref(db, `${ROOT}/game`), {
          [`slots/${i}`]: S.uid,
          [`players/${S.uid}`]: {
            name, ch: S.myChar, slot: String(i), joinedAt: serverTimestamp(),
            on: true, seen: serverTimestamp(), ready: false
          }
        });
        S.presenceSet = false; ensurePresence();
        return;
      } catch (e) { /* 다른 사람이 먼저 가져간 슬롯 → 다음 슬롯 */ }
    }
    setMsg("start-msg", `정원(${MAX_PLAYERS}명)이 가득 찼습니다.`);
  } catch (e) {
    console.error(e); setMsg("start-msg", "참가에 실패했습니다. 연결 상태와 보안 규칙을 확인하세요.");
  } finally { $("btn-join").disabled = false; }
}

async function leave() {
  const me = S.players[S.uid]; if (!me) return;
  const r = ref(db, `${PATH.players}/${S.uid}`);
  try { await onDisconnect(r).cancel(); } catch { /* 무시 */ }
  try {
    await update(ref(db, `${ROOT}/game`), { [`players/${S.uid}`]: null, [`slots/${me.slot}`]: null });
  } catch (e) { console.warn(e); toast("나가기에 실패했습니다."); }
  S.presenceSet = false;
}

/* =============================================================
   경기 참여 기록(run) 생성 / 이동 / 추락
============================================================= */
function runRef() { return ref(db, `${PATH.runs(S.current.gid)}/${S.uid}`); }

function ensureRun() {
  const c = S.current, me = S.players[S.uid], ph = phase();
  if (!c || !me || !S.runsLoaded || S.creatingRun) return;
  if (ph !== "countdown" && ph !== "running") return;
  if (S.runs[S.uid]) return;
  if (S.runFail && S.runFail.gid === c.gid && performance.now() - S.runFail.at < 3000) return;
  if (!(typeof me.joinedAt === "number" && me.joinedAt < c.startedAt)) return; // 시작 후 들어온 사람은 관전
  S.creatingRun = true;
  update(runRef(), { s: 0, d: "R", a: true, t: serverTimestamp(), n: me.name, c: me.ch })
    .catch((e) => { console.warn("run 생성 실패", e.message); S.runFail = { gid: c.gid, at: performance.now() }; })
    .finally(() => { S.creatingRun = false; });
}

function canPlay() {
  return S.screen === "game" && phase() === "running" && S.course &&
    S.local.has && S.local.a && !!S.runs[S.uid];
}

function pushInput(dir) {
  if (!canPlay()) return;
  if (S.inputQ.length < 2) S.inputQ.push(dir);
  pumpInput();
}
function pumpInput() {
  if (S.pumpTimer) return;
  const wait = S.local.lastInputAt + INPUT_GAP - performance.now();
  if (wait > 0) { S.pumpTimer = setTimeout(() => { S.pumpTimer = null; pumpInput(); }, wait); return; }
  const d = S.inputQ.shift();
  if (!d) return;
  doMove(d);
  if (S.inputQ.length) pumpInput();
}

function doMove(dir) {
  if (!canPlay()) { S.inputQ.length = 0; return; }
  S.local.lastInputAt = performance.now();
  const next = S.local.s + 1;
  const need = S.course.dirAt(next);
  if (dir !== need) { S.inputQ.length = 0; doFall("wrong", dir); return; }
  S.local.s = next; S.local.d = dir; S.local.t = now(); S.local.pending++;
  bump($("hud-steps"));
  update(runRef(), { s: next, d: dir, t: serverTimestamp() })
    .catch((e) => { console.warn("이동 거부", e.message); })
    .finally(() => { S.local.pending--; if (S.local.pending === 0) onRunsChanged(); });
}

function doFall(reason, wrongDir) {
  if (!S.local.has || !S.local.a) return;
  S.local.a = false; S.local.fallReason = reason; S.local.fallDir = wrongDir || null;
  S.inputQ.length = 0;
  const e = S.ents.get(S.uid);
  if (e && wrongDir) e.fallFace = wrongDir === "R" ? 1 : -1;
  if (navigator.vibrate) { try { navigator.vibrate(120); } catch { /* 무시 */ } }
  toast(reason === "idle" ? "입력이 없어 탈락했어요" : "방향을 틀려 추락했어요!");
  S.local.pending++;
  update(runRef(), { a: false })
    .catch((e2) => console.warn("추락 기록 실패", e2.message))
    .finally(() => { S.local.pending--; if (S.local.pending === 0) onRunsChanged(); });
}

function checkIdle() {
  if (!S.local.has || !S.local.a || S.local.pending > 0 || !S.current) return;
  const t = gameTimes(); if (!t) return;
  if (now() - Math.max(S.local.t, t.go) > (S.current.idleMs || 60000) - 100) doFall("idle");
}

/* =============================================================
   관리자 기능 (권한은 보안 규칙이 admins/{uid}로 검증)
============================================================= */
async function adminStart() {
  if (!S.isAdmin) return;
  const c = S.current, ph = phase();
  if (ph === "countdown" || ph === "running") return setMsg("admin-msg", "이미 경기가 진행 중입니다.");
  if (c && c.gid && c.finalizedGid !== c.gid && Object.keys(S.runs).length &&
    !confirm("이전 경기 결과가 아직 저장되지 않았습니다. 저장하지 않고 새 경기를 시작할까요?")) return;
  const n = Object.keys(S.players).length;
  if (n < 1) return setMsg("admin-msg", "참가자가 없습니다.");
  const gid = push(ref(db, PATH.history)).key; // 고유 ID 생성만 (쓰기 없음)
  const seed = 1 + Math.floor(Math.random() * 999998);
  try {
    await update(ref(db, PATH.current), {
      gid, status: "running", seed, startedAt: serverTimestamp(),
      countdownMs: Math.round(GC.countdownSeconds * 1000),
      durationMs: (+$("adm-duration").value || 180) * 1000,
      idleMs: (+$("adm-idle").value || 60) * 1000,
      endedAt: null, finalizedGid: null
    });
    setMsg("admin-msg", "");
  } catch (e) {
    console.error(e); setMsg("admin-msg", "시작 실패: 관리자 권한(admins/UID)과 보안 규칙을 확인하세요.");
  }
}

async function adminForceEnd() {
  if (!S.isAdmin) return;
  if (!confirm("경기를 지금 종료할까요? 현재 계단 수로 순위가 확정됩니다.")) return;
  try { await update(ref(db, PATH.current), { status: "ended", endedAt: serverTimestamp() }); }
  catch (e) { toast("강제 종료 실패: 권한을 확인하세요."); }
}

async function adminFinalize(manual = false) {
  const c = S.current;
  if (!S.isAdmin || !c || !c.gid || phase() !== "ended" || c.finalizedGid === c.gid) return;
  if (S.finalizing || !S.runsLoaded) return;
  if (!manual && S.finalizeTried === c.gid) return;
  S.finalizing = true; S.finalizeTried = c.gid; renderResultAdmin();
  try {
    const rows = computeRanking();
    const t = gameTimes();
    const stats = (await get(ref(db, PATH.stats))).val() || {};
    const upd = {
      "game/current/status": "ended",
      "game/current/finalizedGid": c.gid,
      [`game/history/${c.gid}`]: {
        startedAt: c.startedAt, go: t.go, endedAt: t.end, durationMs: c.durationMs,
        playerCount: rows.length,
        winnerUid: rows[0] ? rows[0].uid : null, winnerName: rows[0] ? rows[0].name : null,
        finalLeaderboard: rows.map((r) => ({ uid: r.uid, name: r.name, ch: r.ch, steps: r.steps, alive: r.alive, rank: r.rank }))
      }
    };
    if (typeof c.endedAt !== "number") upd["game/current/endedAt"] = t.end;
    rows.forEach((r) => {
      const o = stats[r.uid] || {};
      const gp = (o.gamesPlayed || 0) + 1;
      const tot = (o.totalSteps || 0) + r.steps;
      const recent = [{ gid: c.gid, steps: r.steps, rank: r.rank, players: rows.length, alive: r.alive, at: t.end }]
        .concat(Array.isArray(o.recent) ? o.recent : []).slice(0, 5);
      upd[`playerStats/${r.uid}`] = {
        nickname: r.name, gamesPlayed: gp,
        wins: (o.wins || 0) + (r.rank === 1 && r.steps > 0 ? 1 : 0),
        survived: (o.survived || 0) + (r.alive ? 1 : 0),
        bestStepCount: Math.max(o.bestStepCount || 0, r.steps),
        totalSteps: tot, averageStepCount: Math.round((tot / gp) * 10) / 10,
        recent, lastGid: c.gid, updatedAt: serverTimestamp()
      };
    });
    await update(ref(db, ROOT), upd); // 한 번에 원자적으로 저장 (중복 저장은 규칙이 거부)
  } catch (e) {
    console.error(e); toast("결과 저장 실패. '결과 다시 저장'을 눌러 주세요.");
  } finally { S.finalizing = false; renderResultAdmin(); }
}

async function adminNextRound() {
  const c = S.current; if (!S.isAdmin || !c) return;
  if (c.gid && c.finalizedGid !== c.gid && !confirm("결과가 저장되지 않았습니다. 그래도 대기실로 돌아갈까요?")) return;
  const upd = { "game/current/status": "lobby" };
  if (c.gid) upd[`game/runs/${c.gid}`] = null;
  Object.keys(S.players).forEach((uid) => { upd[`game/players/${uid}/ready`] = false; });
  try { await update(ref(db, ROOT), upd); } catch (e) { console.error(e); toast("다음 경기 준비 실패: 권한을 확인하세요."); }
}

async function adminCleanup() {
  if (!S.isAdmin) return;
  const upd = {}; let n = 0; const t = now();
  for (const [uid, p] of Object.entries(S.players)) {
    if (!p.on && t - (p.seen || 0) > 60000 && uid !== S.uid) {
      upd[`players/${uid}`] = null; upd[`slots/${p.slot}`] = null; n++;
    }
  }
  if (!n) return setMsg("admin-msg", "정리할 오프라인 참가자가 없습니다 (60초 이상 끊긴 사람만 정리).");
  try { await update(ref(db, `${ROOT}/game`), upd); setMsg("admin-msg", `${n}명을 정리했습니다.`, true); }
  catch (e) { setMsg("admin-msg", "정리 실패: 권한을 확인하세요."); }
}

async function adminLogin(e) {
  e.preventDefault();
  const email = $("adm-email").value.trim(), pw = $("adm-pw").value;
  if (!email || !pw) return setMsg("admin-login-msg", "이메일과 비밀번호를 입력하세요.");
  setMsg("admin-login-msg", "로그인 중…", true);
  try {
    if (S.players[S.uid] && S.user && S.user.isAnonymous) await leave(); // 익명 참가 기록 정리
    await signInWithEmailAndPassword(auth, email, pw);
    $("adm-pw").value = "";
    setMsg("admin-login-msg", "로그인했습니다. 권한 확인 중…", true);
  } catch (err) {
    console.warn(err); setMsg("admin-login-msg", "로그인 실패: 이메일/비밀번호를 확인하세요.");
  }
}
async function adminLogout() {
  try { await leave(); await signOut(auth); setMsg("admin-login-msg", "로그아웃했습니다.", true); }
  catch (e) { console.warn(e); }
}

/* =============================================================
   화면 전환
============================================================= */
function show(name) {
  if (S.screen === name) return;
  S.screen = name;
  document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === `screen-${name}`));
  if (name === "game") { S.rankEls.clear(); $("rank-list").innerHTML = ""; applyRankCollapse(); resizeCanvas(); }
  if (name === "result") renderResult();
  if (name === "lobby") renderLobby();
}

function route() {
  if (!S.uid || !S.players[S.uid]) { show("start"); return; }
  const ph = phase();
  if (ph === "lobby") show("lobby");
  else if (ph === "ended") show(S.current && S.dismissedGid === S.current.gid ? "lobby" : "result");
  else show("game");
}

/* ---------------- 메인 틱 (requestAnimationFrame과 무관하게 동작) ---------------- */
function tick() {
  if (!S.uid) return;
  const ph = phase();
  if (ph !== S.lastPhase) {
    if (ph === "running" && S.lastPhase === "countdown") S.goFlashUntil = performance.now() + 800;
    S.lastPhase = ph; route(); renderLobby();
  }
  ensureRun();
  if (ph === "running") checkIdle();
  if (ph === "ended") { captureFinal(); adminFinalize(); }
  updateHud(ph);
}

/* =============================================================
   UI 렌더링 (DOM)
============================================================= */
function setMsg(id, text, ok = false) { const el = $(id); el.textContent = text; el.classList.toggle("ok", ok); }
function bump(el) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }

function renderConn() {
  const st = !configured ? "" : S.connected ? "on" : "off";
  const txt = !configured ? "설정 필요" : S.connected ? "서버 연결됨" : "재연결 중…";
  ["start-conn", "lobby-conn", "hud-conn"].forEach((id) => { const el = $(id); el.classList.remove("on", "off"); if (st) el.classList.add(st); });
  $("start-conn-text").textContent = txt; $("lobby-conn-text").textContent = txt;
}

function critterCanvas(ch, px, dead = false) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = document.createElement("canvas");
  cv.width = px * dpr; cv.height = px * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  drawCritter(g, charById(ch), px / 2, px * 0.95, px * 0.78, 1, { dead });
  return cv;
}

function buildCharGrid(el, isStart) {
  el.innerHTML = "";
  CHARACTERS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "char-btn"; b.dataset.id = c.id; b.title = c.name;
    b.appendChild(critterCanvas(c.id, 46));
    const sp = document.createElement("span"); sp.textContent = c.name; b.appendChild(sp);
    b.addEventListener("click", () => selectChar(c.id, isStart));
    el.appendChild(b);
  });
  markChar();
}
function markChar() {
  document.querySelectorAll(".char-btn").forEach((b) => b.classList.toggle("sel", b.dataset.id === S.myChar));
  $("char-name").textContent = charById(S.myChar).name;
}
function selectChar(id, isStart) {
  S.myChar = id; store.set("sr_char", id); markChar();
  if (!isStart && S.players[S.uid]) {
    update(ref(db, `${PATH.players}/${S.uid}`), { ch: id }).catch(() => toast("캐릭터 변경 실패"));
  }
}

function renderLobby() {
  if (S.screen !== "lobby") return;
  const entries = Object.entries(S.players).sort((a, b) => (+a[1].slot) - (+b[1].slot));
  $("lobby-count").textContent = entries.length;
  const ph = phase();
  $("lobby-status").textContent =
    ph === "lobby" ? "관리자가 게임을 시작하기를 기다리는 중" :
    ph === "ended" ? "경기 종료 — 관리자가 다음 경기를 준비 중" : "경기 진행 중 (시작 후 참가자는 관전)";
  const ul = $("lobby-list"); ul.innerHTML = "";
  if (!entries.length) ul.innerHTML = `<li class="empty">아직 참가자가 없습니다</li>`;
  entries.forEach(([uid, p]) => {
    const li = document.createElement("li");
    if (uid === S.uid) li.classList.add("me");
    li.appendChild(critterCanvas(p.ch, 36));
    li.insertAdjacentHTML("beforeend",
      `<span class="nm">${esc(p.name)}${uid === S.uid ? " (나)" : ""}</span>` +
      (S.admins[uid] === true ? `<span class="badge admin">관리자</span>` : "") +
      (p.ready ? `<span class="badge ready">준비 완료</span>` : `<span class="badge">대기</span>`) +
      (p.on ? "" : `<span class="badge offline">오프라인</span>`) +
      `<span class="conn-dot ${p.on ? "on" : ""}"></span>`);
    ul.appendChild(li);
  });
  const me = S.players[S.uid];
  if (me) {
    $("btn-ready").textContent = me.ready ? "준비 취소" : "준비 완료";
    if (me.ch && me.ch !== S.myChar) { S.myChar = me.ch; markChar(); }
  }
  const startBtn = $("btn-start");
  startBtn.disabled = !(ph === "lobby" || ph === "ended");
}

function updateHud(ph) {
  if (S.screen !== "game") return;
  const t = gameTimes(); const n = now();
  const remain = !t ? 0 : ph === "countdown" ? t.end - t.go : ph === "running" ? t.end - n : 0;
  $("hud-time").textContent = fmtTime(remain);
  const followUid = cameraUid();
  const myRun = S.runs[S.uid];
  const steps = S.local.has ? S.local.s : (followUid && S.runs[followUid] ? S.runs[followUid].s : 0);
  if ($("hud-steps").textContent !== String(steps)) $("hud-steps").textContent = steps;

  // 카운트다운
  const cd = $("countdown");
  if (ph === "countdown" && t) { cd.textContent = Math.ceil((t.go - n) / 1000); cd.classList.remove("small"); }
  else if (performance.now() < S.goFlashUntil) { cd.textContent = "출발!"; cd.classList.add("small"); }
  else cd.textContent = "";

  // 무입력 게이지
  const iw = $("idle-wrap");
  if (ph === "running" && S.local.has && S.local.a && t) {
    const idle = S.current.idleMs || 60000;
    const frac = clamp(1 - (n - Math.max(S.local.t, t.go)) / idle, 0, 1);
    iw.hidden = !(idle <= 15000 || frac < 0.4);
    $("idle-bar").style.width = `${frac * 100}%`;
  } else iw.hidden = true;

  // 안내 배너
  const bn = $("banner"); let msg = "";
  if (!myRun && (ph === "countdown" || ph === "running")) {
    msg = S.players[S.uid] && S.current && S.players[S.uid].joinedAt >= S.current.startedAt
      ? "경기 시작 후 입장해 관전 중입니다. 순위표를 눌러 다른 참가자를 볼 수 있어요."
      : "경기에 입장하는 중…";
  } else if (S.local.has && !S.local.a) {
    msg = `${S.local.fallReason === "idle" ? "무입력으로 탈락" : "추락"} — 기록 ${S.local.s}계단. 순위표를 눌러 관전할 수 있어요.`;
  } else if (S.local.has && !S.connected) msg = "연결이 끊겼습니다. 재연결 중…";
  bn.hidden = !msg; if (msg) bn.textContent = msg;

  $("btn-left").disabled = $("btn-right").disabled = !canPlay();
  $("btn-force-end").hidden = !(S.isAdmin && (ph === "countdown" || ph === "running"));
}

function applyRankCollapse() { $("rank-panel").classList.toggle("collapsed", S.rankCollapsed); }

function renderRank() {
  if (S.screen !== "game") return;
  const rows = computeRanking();
  const list = $("rank-list"); const H = 28;
  const myIdx = rows.findIndex((r) => r.uid === S.uid);
  $("hud-rank").textContent = myIdx >= 0 ? `${myIdx + 1}/${rows.length}` : "-";
  $("rank-summary").textContent = myIdx >= 0 ? `${myIdx + 1}위 / ${rows.length}명` : `${rows.length}명`;
  if (S.rankCollapsed) return;
  const alive = new Set();
  const followUid = cameraUid();
  rows.forEach((r, i) => {
    alive.add(r.uid);
    let el = S.rankEls.get(r.uid);
    if (!el) {
      el = document.createElement("div"); el.className = "rank-row";
      el.innerHTML = `<span class="rk"></span><span class="dot"></span><span class="nm"></span><span class="st"></span><span class="ss"></span>`;
      el.addEventListener("click", () => { S.follow = r.uid; });
      list.appendChild(el); S.rankEls.set(r.uid, el);
      el.style.transform = `translateY(${i * H}px)`;
    }
    el.style.transform = `translateY(${i * H}px)`;
    el.classList.toggle("me", r.uid === S.uid);
    el.classList.toggle("dead", !r.alive);
    el.classList.toggle("following", r.uid === followUid && r.uid !== S.uid);
    el.children[0].textContent = r.rank;
    el.children[1].style.background = charById(r.ch).body;
    el.children[2].textContent = r.name + (r.online ? "" : " (끊김)");
    el.children[3].textContent = r.steps;
    el.children[4].textContent = r.alive ? "생존" : "탈락";
  });
  for (const [uid, el] of S.rankEls) if (!alive.has(uid)) { el.remove(); S.rankEls.delete(uid); }
  list.style.height = `${rows.length * H}px`;
}

/* ---------------- 결과 ---------------- */
function captureFinal() {
  const c = S.current; if (!c || !c.gid || !S.runsLoaded) return;
  const locked = c.finalizedGid === c.gid;
  if (S.finalResult && S.finalResult.gid === c.gid && S.finalResult.locked) return;
  const t = gameTimes();
  if (Object.keys(S.runs).length) {
    S.finalResult = { gid: c.gid, rows: computeRanking(), durationSec: Math.round((t.end - t.go) / 1000), locked };
    if (S.screen === "result") renderResult();
    return;
  }
  if (S.histFetching === c.gid) return;
  S.histFetching = c.gid;
  get(ref(db, `${PATH.history}/${c.gid}`)).then((s) => {
    const h = s.val();
    S.finalResult = h
      ? { gid: c.gid, rows: h.finalLeaderboard || [], durationSec: Math.round((h.endedAt - (h.go || h.startedAt)) / 1000), locked: true }
      : { gid: c.gid, rows: [], durationSec: 0, locked: true };
    if (S.screen === "result") renderResult();
  }).catch(() => { S.histFetching = null; });
}

function renderResult() {
  if (S.screen !== "result") return;
  renderResultAdmin();
  const fr = S.finalResult;
  if (!fr || (S.current && fr.gid !== S.current.gid)) {
    $("result-winner").innerHTML = "결과를 불러오는 중…"; $("result-me").innerHTML = ""; $("result-list").innerHTML = "";
    return;
  }
  const rows = fr.rows || [];
  const w = rows[0];
  $("result-winner").innerHTML = w
    ? `<small>1위 · 경기 시간 ${fr.durationSec}초</small>${esc(w.name)} · ${w.steps}계단`
    : `<small>결과 · 경기 시간 ${fr.durationSec}초</small>참가 기록이 없습니다`;
  const me = rows.find((r) => r.uid === S.uid);
  $("result-me").innerHTML = me
    ? `<div>내 순위<b>${me.rank}위</b></div><div>최종 계단<b>${me.steps}</b></div><div>내 상태<b>${me.alive ? "생존" : "탈락"}</b></div>`
    : `<div>내 순위<b>-</b></div><div>최종 계단<b>-</b></div><div>내 상태<b>관전</b></div>`;
  $("result-list").innerHTML = rows.map((r) =>
    `<li class="${r.uid === S.uid ? "me" : ""}"><span class="rk">${r.rank}</span>` +
    `<span class="dot" style="width:12px;height:12px;border-radius:50%;background:${charById(r.ch).body}"></span>` +
    `<span class="nm">${esc(r.name)}</span><span class="badge ${r.alive ? "ready" : ""}">${r.alive ? "생존" : "탈락"}</span>` +
    `<span class="st">${r.steps}</span></li>`).join("");
}

function renderResultAdmin() {
  if (!S.isAdmin || !S.current) return;
  const c = S.current; const saved = c.finalizedGid === c.gid;
  setMsg("result-admin-msg", saved ? "결과와 개인 기록이 저장되었습니다." : S.finalizing ? "결과 저장 중…" : "결과가 아직 저장되지 않았습니다.", saved);
  $("btn-save-result").hidden = saved || S.finalizing;
  $("btn-next-round").disabled = S.finalizing;
}

/* ---------------- 개인 기록 ---------------- */
async function openRecords() {
  $("modal-records").hidden = false;
  const body = $("records-body");
  if (!S.uid) { body.textContent = "서버에 연결된 뒤 확인할 수 있습니다."; return; }
  body.textContent = "불러오는 중…";
  try {
    const st = (await get(ref(db, `${PATH.stats}/${S.uid}`))).val();
    if (!st) { body.innerHTML = `<p class="muted">아직 기록이 없습니다. 경기에 참가해 보세요!</p><p class="muted small-note">기록은 같은 브라우저(같은 계정)에서만 이어집니다.</p>`; return; }
    body.innerHTML =
      `<div class="stat-grid">
        <div>참가<b>${st.gamesPlayed || 0}</b></div><div>최고 계단<b>${st.bestStepCount || 0}</b></div><div>평균 계단<b>${st.averageStepCount || 0}</b></div>
        <div>우승<b>${st.wins || 0}</b></div><div>생존<b>${st.survived || 0}</b></div><div>닉네임<b style="font-size:15px">${esc(st.nickname)}</b></div>
      </div>
      <ul class="recent">${(st.recent || []).map((r) =>
        `<li><span>${new Date(r.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>` +
        `<span>${r.rank}위 / ${r.players}명 · ${r.steps}계단 · ${r.alive ? "생존" : "탈락"}</span></li>`).join("")}</ul>`;
  } catch (e) { body.textContent = "기록을 불러오지 못했습니다."; }
}

function renderAdminModal() {
  const u = S.user;
  const isEmail = u && !u.isAnonymous;
  $("admin-form").hidden = !!isEmail;
  $("btn-admin-logout").hidden = !isEmail;
  $("admin-status").innerHTML = !u ? "" : isEmail
    ? `로그인: ${esc(u.email)}<br>권한: <b>${S.isAdmin ? "관리자 확인됨" : "관리자 아님"}</b><br>UID: <code>${esc(u.uid)}</code>` +
      (S.isAdmin ? "" : `<br>DB의 <code>${esc(ROOT)}/admins/${esc(u.uid)}</code> 에 <code>true</code>를 넣어야 관리자가 됩니다.`)
    : `관리자 계정으로 로그인하면 이 기기의 기존 참가 기록은 정리됩니다. 관리자도 로그인 후 다시 참가해 함께 플레이합니다.`;
  $("btn-admin-open").textContent = S.isAdmin ? "관리자 메뉴" : "관리자";
}

/* ---------------- 입력 바인딩 ---------------- */
function bindUI() {
  $("btn-join").addEventListener("click", join);
  $("inp-name").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
  ["btn-records", "btn-records2", "btn-records3"].forEach((id) => $(id).addEventListener("click", openRecords));
  $("btn-admin-open").addEventListener("click", () => { renderAdminModal(); $("modal-admin").hidden = false; });
  $("admin-form").addEventListener("submit", adminLogin);
  $("btn-admin-logout").addEventListener("click", adminLogout);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { b.closest(".modal").hidden = true; }));
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));

  $("btn-ready").addEventListener("click", () => {
    const me = S.players[S.uid]; if (!me) return;
    update(ref(db, `${PATH.players}/${S.uid}`), { ready: !me.ready }).catch(() => toast("변경 실패"));
  });
  $("btn-leave").addEventListener("click", async () => { if (confirm("대기실에서 나갈까요?")) await leave(); });
  $("btn-start").addEventListener("click", adminStart);
  $("btn-cleanup").addEventListener("click", adminCleanup);
  $("btn-force-end").addEventListener("click", adminForceEnd);
  $("btn-save-result").addEventListener("click", () => adminFinalize(true));
  $("btn-next-round").addEventListener("click", adminNextRound);
  $("btn-back-lobby").addEventListener("click", () => { if (S.current) S.dismissedGid = S.current.gid; route(); });
  $("rank-toggle").addEventListener("click", () => { S.rankCollapsed = !S.rankCollapsed; applyRankCollapse(); S.rankEls.clear(); $("rank-list").innerHTML = ""; renderRank(); });

  const bindBtn = (el, dir) => {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault(); pushInput(dir);
      el.classList.add("pressed"); setTimeout(() => el.classList.remove("pressed"), 90);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  };
  bindBtn($("btn-left"), "L"); bindBtn($("btn-right"), "R");
  // 캔버스 좌/우 절반 터치도 입력으로 사용
  $("cv").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const r = $("cv").getBoundingClientRect();
    pushInput(e.clientX - r.left < r.width / 2 ? "L" : "R");
  });
  window.addEventListener("keydown", (e) => {
    if (S.screen !== "game") return;
    const k = e.key.toLowerCase();
    const dir = (k === "arrowleft" || k === "a") ? "L" : (k === "arrowright" || k === "d") ? "R" : null;
    if (!dir) return;
    e.preventDefault();
    if (e.repeat) return; // 길게 눌러도 한 번만
    pushInput(dir);
    const b = $(dir === "L" ? "btn-left" : "btn-right");
    b.classList.add("pressed"); setTimeout(() => b.classList.remove("pressed"), 90);
  });
  window.addEventListener("resize", resizeCanvas);
}

/* =============================================================
   2D 렌더링 (Canvas)
============================================================= */
let cv, g, W = 0, H = 0, DPR = 1;
function resizeCanvas() {
  cv = $("cv"); if (!cv) return;
  g = cv.getContext("2d");
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
}

function cameraUid() {
  if (S.local.has && S.local.a) return S.uid;
  if (S.follow && S.runs[S.follow]) return S.follow;
  if (S.local.has) return S.uid;
  const rows = computeRanking();
  return rows[0] ? rows[0].uid : null;
}

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (ts - (S.lastFrame || ts)) / 1000); S.lastFrame = ts;
  if (S.screen !== "game" || !S.course) return;
  if (!g || cv.clientWidth !== W || cv.clientHeight !== H) resizeCanvas();
  draw(dt, ts);
}

const STAIR_BANDS = [
  { top: "#e1f8cf", front: "#6cbf43", side: "#4f9a2f" },
  { top: "#ffe9c9", front: "#f4a259", side: "#d07f35" },
  { top: "#d7e5ff", front: "#5b8def", side: "#3f6cc8" },
  { top: "#eedcff", front: "#a57be3", side: "#825cc0" },
  { top: "#ffdbe4", front: "#ec6f8e", side: "#c94f6e" },
  { top: "#d3f5ee", front: "#3fb59e", side: "#2b927e" }
];
const SKY_STOPS = [
  [0, [124, 200, 255], [226, 244, 255]],
  [350, [255, 178, 136], [255, 233, 206]],
  [700, [134, 118, 232], [247, 184, 212]],
  [1000, [30, 36, 90], [80, 86, 160]],
  [1500, [6, 8, 28], [32, 22, 72]]
];
function mixRgb(a, b, k) { return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], k))).join(",")})`; }
function skyAt(alt) {
  let a = SKY_STOPS[SKY_STOPS.length - 1], b = a;
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    if (alt < SKY_STOPS[i + 1][0]) { a = SKY_STOPS[i]; b = SKY_STOPS[i + 1]; break; }
  }
  const k = a === b ? 0 : clamp((alt - a[0]) / (b[0] - a[0]), 0, 1);
  return [mixRgb(a[1], b[1], k), mixRgb(a[2], b[2], k)];
}

function draw(dt, ts) {
  const t = gameTimes(); const nowMs = now();
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  const U = Math.min(W / 7.5, H / 11.5);
  const course = S.course;

  /* --- 엔티티 갱신 --- */
  const at = t ? Math.min(nowMs, t.end) : nowMs;
  const seen = new Set();
  for (const [uid, r] of Object.entries(S.runs)) {
    seen.add(uid);
    const mine = uid === S.uid && S.local.has;
    const s = mine ? S.local.s : (r.s | 0);
    const alive = mine ? (S.local.a && effAlive({ ...r, a: true, t: Math.max(r.t || 0, S.local.t) }, at)) : effAlive(r, at);
    const face = (mine ? S.local.d : r.d) === "L" ? -1 : 1;
    const tx = course.xAt(s), ty = -s * STEP_H;
    let e = S.ents.get(uid);
    if (!e) {
      e = { s, x: tx, y: ty, fx: tx, fy: ty, tx, ty, hop: 1, hopDur: 0.11, alpha: 1, ov: false, dead: !alive, fallAt: alive ? 0 : -1, face, fallFace: face };
      S.ents.set(uid, e);
    }
    if (s !== e.s) {
      e.fx = e.x; e.fy = e.y; e.tx = tx; e.ty = ty; e.hop = 0;
      e.hopDur = Math.abs(s - e.s) > 2 ? 0.2 : 0.11; e.s = s;
    }
    e.face = face; e.ch = r.c; e.name = r.n; e.mine = uid === S.uid;
    if (alive) e.fallFace = face;
    if (!alive && !e.dead) { e.dead = true; e.fallAt = ts; }
    if (alive && e.dead) { e.dead = false; e.fallAt = 0; }
    e.hop = Math.min(1, e.hop + dt / e.hopDur);
    const k = 1 - Math.pow(1 - e.hop, 2);
    e.x = lerp(e.fx, e.tx, k); e.y = lerp(e.fy, e.ty, k);
    e.arc = e.hop < 1 ? Math.sin(Math.PI * e.hop) * 0.32 : 0;
  }
  for (const uid of [...S.ents.keys()]) if (!seen.has(uid)) S.ents.delete(uid);

  /* --- 카메라 --- */
  const cu = cameraUid(); const ce = cu ? S.ents.get(cu) : null;
  let tx = 0, ty = 0;
  if (ce) {
    const look = (course.xAt(ce.s + 4) - course.xAt(ce.s)) * 0.45;
    tx = ce.x + (ce.dead ? 0 : look); ty = ce.y - 0.6;
  }
  if (!S.cam) S.cam = { x: tx, y: ty };
  const ck = Math.min(1, dt * 7);
  S.cam.x += (tx - S.cam.x) * ck; S.cam.y += (ty - S.cam.y) * ck;
  const camX = S.cam.x, camY = S.cam.y;
  const SX = (wx) => W / 2 + (wx - camX) * U;
  const SY = (wy) => H * 0.6 + (wy - camY) * U;
  const alt = Math.max(0, -camY / STEP_H);

  /* --- 배경 --- */
  const [skyTop, skyBot] = skyAt(alt);
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, skyTop); grd.addColorStop(1, skyBot);
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const camPx = -camY * U;
  const starA = clamp((alt - 750) / 350, 0, 1);
  if (starA > 0) {
    g.fillStyle = "#fff";
    for (let i = 0; i < 70; i++) {
      const sx = hash(i) * W, sy = ((hash(i + 91) * H * 2 + camPx * 0.04) % H + H) % H;
      g.globalAlpha = starA * (0.4 + 0.6 * Math.abs(Math.sin(ts / 700 + i)));
      g.fillRect(sx, sy, 2, 2);
    }
    g.globalAlpha = 1;
  }
  drawIslands(camPx, alt);
  drawClouds(camPx, alt);

  /* --- 시작 지면 --- */
  const gy = SY(0) + U * 0.34;
  if (gy < H + 20) {
    g.fillStyle = "#8fd36a";
    g.beginPath(); g.moveTo(0, gy + U * 0.6);
    for (let x = 0; x <= W; x += 20) g.lineTo(x, gy + U * 0.35 + Math.sin((x + camX * U) / 90) * U * 0.18);
    g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fill();
    g.fillStyle = "#6cbb4a"; g.fillRect(0, gy + U * 0.9, W, H);
    const t0 = Math.floor(camX / 2.3);
    for (let i = -5; i <= 5; i++) { // 나무 (월드 좌표 고정)
      const ti = t0 + i, wx = ti * 2.3 + 0.7;
      if (Math.abs(wx) < 1.6) continue;
      drawTree(SX(wx), gy + U * 0.45, U * (0.7 + hash(ti * 3) * 0.4));
    }
  }

  /* --- 계단 --- */
  const base = Math.round(-camY / STEP_H);
  const lo = Math.max(0, base - Math.ceil((H * 0.45) / (U * STEP_H)) - 2);
  const hi = base + Math.ceil((H * 0.65) / (U * STEP_H)) + 2;
  course.ensure(hi + 8);
  const sw = U * 0.94, sh = U * 0.36;
  for (let i = lo; i <= hi; i++) {
    const sx = SX(course.x[i]), sy = SY(-i * STEP_H);
    if (sx < -sw || sx > W + sw) continue;
    if (i === 0) {
      g.fillStyle = "#c98c5a"; rr(sx - sw * 1.4, sy, sw * 2.8, sh * 1.4, 8); g.fill();
      g.fillStyle = "#f5e3b8"; rr(sx - sw * 1.4, sy, sw * 2.8, sh * 0.45, 8); g.fill();
      g.fillStyle = "#7a4f2e"; g.font = `700 ${Math.max(10, U * 0.2)}px "Noto Sans KR"`; g.textAlign = "center";
      g.fillText("START", sx, sy + sh * 1.1);
      continue;
    }
    const milestone = i % 100 === 0;
    const band = milestone ? { top: "#fff4b8", front: "#ffcb2f", side: "#e0a400" } : STAIR_BANDS[Math.floor(i / 50) % STAIR_BANDS.length];
    g.fillStyle = "rgba(0,0,0,.12)"; rr(sx - sw / 2 + 3, sy + 4, sw, sh, 7); g.fill();
    g.fillStyle = band.front; rr(sx - sw / 2, sy, sw, sh, 7); g.fill();
    g.fillStyle = band.side; g.fillRect(sx - sw / 2 + 4, sy + sh * 0.78, sw - 8, sh * 0.16);
    g.fillStyle = band.top; rr(sx - sw / 2, sy, sw, sh * 0.34, 7); g.fill();
    if (i % 10 === 0) {
      g.fillStyle = milestone ? "#7a5200" : "rgba(255,255,255,.95)";
      g.font = `700 ${Math.max(9, U * (milestone ? 0.2 : 0.16))}px "Noto Sans KR"`; g.textAlign = "center";
      g.fillText(String(i), sx, sy + sh * 0.76);
    }
  }

  /* --- 겹침 판정 (게임 좌표 기준, 시각 효과만) --- */
  const ents = [...S.ents.entries()];
  for (const [, e] of ents) e._ov = false;
  for (let a = 0; a < ents.length; a++) {
    const ea = ents[a][1]; if (ea.dead) continue;
    for (let b = a + 1; b < ents.length; b++) {
      const eb = ents[b][1]; if (eb.dead) continue;
      const thx = (ea.ov || eb.ov) ? 0.75 : 0.55, thy = (ea.ov || eb.ov) ? 0.42 : 0.3; // 히스테리시스로 깜빡임 방지
      if (Math.abs(ea.x - eb.x) < thx && Math.abs(ea.y - eb.y) < thy) { ea._ov = true; eb._ov = true; }
    }
  }
  for (const [, e] of ents) {
    e.ov = e._ov;
    const target = e.dead ? 0.38 : e.ov ? 0.48 : 1;
    e.alpha += (target - e.alpha) * Math.min(1, dt * 10);
  }

  /* --- 캐릭터 --- */
  ents.sort((p, q) => (p[1].mine - q[1].mine) || (p[1].s - q[1].s));
  const csz = U * 0.95;
  // 같은 계단에 여러 명이 있으면 이름표는 하나만 (나 > 관전 대상 > 나머지 순) + "+N"
  const labelOwner = new Map(), labelCount = new Map();
  for (const [uid, e] of ents) {
    if (e.dead) continue;
    labelCount.set(e.s, (labelCount.get(e.s) || 0) + 1);
    const cur = labelOwner.get(e.s);
    const pri = (x) => (x === S.uid ? 2 : x === cu ? 1 : 0);
    if (cur === undefined || pri(uid) > pri(cur)) labelOwner.set(e.s, uid);
  }
  for (const [uid, e] of ents) {
    let wx = e.x, wy = e.y - e.arc, rot = 0, a = e.alpha;
    if (e.dead && e.fallAt > 0) {
      const p = clamp((ts - e.fallAt) / 800, 0, 1);
      if (p < 1) { wx += e.fallFace * 0.7 * p; wy += p * p * 2.6; rot = e.fallFace * p * 5; a = lerp(1, 0.38, p); }
    }
    const sx = SX(wx), sy = SY(wy);
    if (sx < -U * 2 || sx > W + U * 2 || sy < -U * 2 || sy > H + U * 2) continue;
    if (!e.dead || e.fallAt <= 0 || ts - e.fallAt > 800) {
      g.globalAlpha = 0.18 * e.alpha; g.fillStyle = "#000";
      g.beginPath(); g.ellipse(SX(e.x), SY(e.y) + 2, csz * 0.32, csz * 0.08, 0, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    }
    if (e.mine && !e.dead) {
      g.strokeStyle = "rgba(255,203,47,.9)"; g.lineWidth = 3;
      g.beginPath(); g.ellipse(SX(e.x), SY(e.y) + 2, csz * 0.42, csz * 0.12, 0, 0, Math.PI * 2); g.stroke();
    }
    drawCritter(g, charById(e.ch), sx, sy, csz, e.face, { alpha: a, dead: e.dead, rot });
    if (e.dead || labelOwner.get(e.s) === uid) {
      drawLabel(sx, sy - csz * 0.98, e, uid === cu && !e.mine, e.dead ? 0 : (labelCount.get(e.s) || 1) - 1);
    }
  }
  g.globalAlpha = 1;

  /* --- 화면 밖 계단 방향 표시 --- */
  if (ce && !ce.dead) {
    for (let k = 1; k <= 8; k++) {
      const sx = SX(course.xAt(ce.s + k));
      if (sx < 12 || sx > W - 12) {
        const left = sx < 12, ay = clamp(SY(-(ce.s + k) * STEP_H), 90, H - 140);
        const ax = left ? 16 : W - 16;
        g.fillStyle = "rgba(35,48,94,.75)";
        g.beginPath();
        if (left) { g.moveTo(ax - 6, ay); g.lineTo(ax + 10, ay - 12); g.lineTo(ax + 10, ay + 12); }
        else { g.moveTo(ax + 6, ay); g.lineTo(ax - 10, ay - 12); g.lineTo(ax - 10, ay + 12); }
        g.closePath(); g.fill();
        break;
      }
    }
  }
}

function drawLabel(x, y, e, following, extra = 0) {
  const fs = Math.max(10, Math.min(14, W / 34));
  g.font = `700 ${fs}px "Noto Sans KR"`; g.textAlign = "center";
  const txt = `${e.name || "?"} · ${e.s}${extra > 0 ? `  +${extra}` : ""}`;
  const w = g.measureText(txt).width + 12, h = fs + 8;
  g.globalAlpha = e.dead ? 0.55 : Math.max(0.65, e.alpha);
  g.fillStyle = e.mine ? "#ffcb2f" : following ? "#3d7bf2" : "rgba(35,48,94,.78)";
  rr(x - w / 2, y - h, w, h, h / 2); g.fill();
  g.fillStyle = e.mine ? "#23305e" : "#fff";
  g.fillText(txt, x, y - h / 2 + fs * 0.36);
  if (e.mine && !e.dead) {
    g.fillStyle = "#ffcb2f"; g.beginPath();
    g.moveTo(x - 6, y - h - 4); g.lineTo(x + 6, y - h - 4); g.lineTo(x, y - h + 3); g.closePath(); g.fill();
  }
  g.globalAlpha = 1;
}

function drawClouds(camPx, alt) {
  const night = clamp((alt - 800) / 400, 0, 1);
  const layers = [[0.15, 0.6, 320, 1], [0.32, 0.85, 240, 2], [0.55, 1.1, 200, 3]];
  for (const [p, scale, cell, li] of layers) {
    const off = camPx * p;
    const k0 = Math.floor((-off - cell) / cell), k1 = Math.ceil((H - off) / cell);
    for (let k = k0; k <= k1; k++) {
      const hsh = hash(k * 13 + li * 101);
      if (hsh < 0.35) continue;
      const y = k * cell + off;
      const x = ((hash(k * 7 + li) * 1.4 - 0.2) * W);
      const s = (34 + hash(k + li * 9) * 30) * scale;
      g.globalAlpha = (0.55 + 0.35 * (li / 3)) * (1 - night * 0.7);
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(x, y, s, 0, Math.PI * 2); g.arc(x + s * 0.9, y + s * 0.15, s * 0.75, 0, Math.PI * 2);
      g.arc(x - s * 0.9, y + s * 0.2, s * 0.65, 0, Math.PI * 2); g.arc(x + s * 0.2, y - s * 0.45, s * 0.6, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}

function drawIslands(camPx, alt) {
  const cell = 560, off = camPx * 0.08;
  const k0 = Math.floor((-off - cell) / cell), k1 = Math.ceil((H - off) / cell);
  for (let k = k0; k <= k1; k++) {
    if (k > -1 || hash(k * 3.3) < 0.4) continue; // 지면 위 하늘에만
    const y = k * cell + off + cell * 0.5, x = hash(k * 5.1) * W, s = 40 + hash(k * 2.2) * 34;
    g.globalAlpha = alt > 900 ? 0.55 : 0.85;
    g.fillStyle = "#9b7653";
    g.beginPath(); g.moveTo(x - s, y); g.quadraticCurveTo(x, y + s * 1.3, x + s, y); g.closePath(); g.fill();
    g.fillStyle = "#86cf5c"; g.beginPath(); g.ellipse(x, y, s, s * 0.28, 0, 0, Math.PI * 2); g.fill();
    drawTree(x + s * 0.3, y - 2, s * 0.6);
  }
  g.globalAlpha = 1;
}

function drawTree(x, y, s) {
  g.fillStyle = "#8a5a3c"; g.fillRect(x - s * 0.06, y - s * 0.5, s * 0.12, s * 0.5);
  g.fillStyle = "#4fae4a";
  g.beginPath(); g.arc(x, y - s * 0.62, s * 0.3, 0, Math.PI * 2); g.arc(x - s * 0.2, y - s * 0.48, s * 0.22, 0, Math.PI * 2);
  g.arc(x + s * 0.2, y - s * 0.48, s * 0.22, 0, Math.PI * 2); g.fill();
}

function rr(x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) { g.roundRect(x, y, w, h, r); return; }
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/* ---------------- 캐릭터 그리기 (발밑 중앙 = x,y) ---------------- */
function drawCritter(c2, c, x, y, sz, face, o = {}) {
  const alpha = o.alpha ?? 1;
  c2.save(); c2.globalAlpha = alpha; c2.translate(x, y);
  if (o.rot) { c2.translate(0, -sz * 0.4); c2.rotate(o.rot); c2.translate(0, sz * 0.4); }
  c2.scale(face < 0 ? -1 : 1, 1);
  const img = spriteFor(c.id);
  if (img) {
    const h = sz * 1.15, w = h * img.naturalWidth / img.naturalHeight;
    if (o.dead) c2.filter = "grayscale(1)";
    c2.drawImage(img, -w / 2, -h, w, h); c2.restore(); return;
  }
  const r = sz * 0.4, cy = -r * 1.02, lw = Math.max(1.2, sz * 0.045);
  const line = o.dead ? "rgba(70,74,92,.6)" : "rgba(38,42,70,.78)";
  const body = o.dead ? "#c9ccd6" : c.body, belly = o.dead ? "#e7e9ef" : c.belly, acc = o.dead ? "#9aa0ad" : c.acc;
  c2.lineWidth = lw; c2.strokeStyle = line; c2.lineJoin = "round"; c2.lineCap = "round";
  const ell = (ex, ey, rx, ry, rot = 0, fill = true, stroke = true) => {
    c2.beginPath(); c2.ellipse(ex, ey, rx, ry, rot, 0, Math.PI * 2); if (fill) c2.fill(); if (stroke) c2.stroke();
  };
  const tri = (pts) => { c2.beginPath(); c2.moveTo(pts[0], pts[1]); c2.lineTo(pts[2], pts[3]); c2.lineTo(pts[4], pts[5]); c2.closePath(); c2.fill(); c2.stroke(); };

  // 꼬리
  if (c.tail === "fluffy") { c2.fillStyle = acc; ell(-r * 0.98, cy - r * 0.35, r * 0.48, r * 0.82, -0.45); }
  else if (c.tail === "thin") {
    c2.strokeStyle = acc; c2.lineWidth = lw * 2.4;
    c2.beginPath(); c2.moveTo(-r * 0.8, cy + r * 0.35); c2.quadraticCurveTo(-r * 1.55, cy + r * 0.1, -r * 1.25, cy - r * 0.65); c2.stroke();
    c2.strokeStyle = line; c2.lineWidth = lw;
  } else if (c.tail === "nub") { c2.fillStyle = belly; ell(-r * 0.95, cy + r * 0.35, r * 0.22, r * 0.2); }

  // 귀 / 머리 장식 (몸 뒤)
  c2.fillStyle = acc;
  switch (c.ear) {
    case "tri":
      tri([-r * 0.68, cy - r * 0.5, -r * 0.55, cy - r * 1.38, -r * 0.08, cy - r * 0.86]);
      tri([r * 0.12, cy - r * 0.86, r * 0.55, cy - r * 1.4, r * 0.7, cy - r * 0.48]);
      break;
    case "long":
      ell(-r * 0.32, cy - r * 1.2, r * 0.19, r * 0.6, -0.2); ell(r * 0.28, cy - r * 1.24, r * 0.19, r * 0.6, 0.2);
      c2.fillStyle = "#ffc6d6"; ell(-r * 0.32, cy - r * 1.2, r * 0.08, r * 0.4, -0.2, true, false); ell(r * 0.28, cy - r * 1.24, r * 0.08, r * 0.4, 0.2, true, false);
      break;
    case "round":
      ell(-r * 0.62, cy - r * 0.72, r * 0.3, r * 0.3); ell(r * 0.55, cy - r * 0.76, r * 0.3, r * 0.3);
      c2.fillStyle = belly; ell(-r * 0.62, cy - r * 0.72, r * 0.15, r * 0.15, 0, true, false); ell(r * 0.55, cy - r * 0.76, r * 0.15, r * 0.15, 0, true, false);
      break;
    case "tuft":
      tri([-r * 0.75, cy - r * 0.55, -r * 0.7, cy - r * 1.15, -r * 0.35, cy - r * 0.85]);
      tri([r * 0.35, cy - r * 0.85, r * 0.72, cy - r * 1.15, r * 0.78, cy - r * 0.55]);
      break;
    case "crest":
      ell(-r * 0.05, cy - r * 1.05, r * 0.12, r * 0.3, -0.4); ell(r * 0.15, cy - r * 1.1, r * 0.12, r * 0.32, 0.1); ell(r * 0.33, cy - r * 1.0, r * 0.11, r * 0.26, 0.6);
      break;
    case "bumps":
      c2.fillStyle = body; ell(-r * 0.08, cy - r * 0.78, r * 0.3, r * 0.28); ell(r * 0.52, cy - r * 0.78, r * 0.3, r * 0.28);
      break;
    case "wool":
      c2.fillStyle = "#ffffff";
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; ell(Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.88, r * 0.32, r * 0.3); }
      break;
    default: break;
  }

  // 몸통
  c2.fillStyle = body; ell(0, cy, r, r * 0.96);
  if (c.ear === "none") { c2.fillStyle = acc; c2.beginPath(); c2.ellipse(-r * 0.12, cy - r * 0.05, r * 0.88, r * 0.9, 0, Math.PI * 0.62, Math.PI * 1.62); c2.fill(); }
  c2.fillStyle = belly; ell(r * 0.12, cy + r * 0.3, r * 0.58, r * 0.5, 0, true, false);
  // 발
  c2.fillStyle = acc; ell(-r * 0.36, -r * 0.08, r * 0.27, r * 0.13); ell(r * 0.4, -r * 0.08, r * 0.27, r * 0.13);

  // 눈
  const ey = c.ear === "bumps" ? cy - r * 0.78 : cy - r * 0.18;
  const ex = [r * (c.ear === "bumps" ? -0.08 : 0.04), r * 0.52];
  if (o.dead) {
    c2.strokeStyle = "#4a4f63"; c2.lineWidth = lw * 1.2;
    for (const x0 of ex) { const d = r * 0.11; c2.beginPath(); c2.moveTo(x0 - d, ey - d); c2.lineTo(x0 + d, ey + d); c2.moveTo(x0 + d, ey - d); c2.lineTo(x0 - d, ey + d); c2.stroke(); }
  } else {
    for (const x0 of ex) {
      c2.fillStyle = "#23263a"; ell(x0, ey, r * 0.1, r * 0.14, 0, true, false);
      c2.fillStyle = "#fff"; ell(x0 + r * 0.03, ey - r * 0.05, r * 0.035, r * 0.045, 0, true, false);
    }
  }
  // 볼 / 부리 / 입
  if (c.cheek && !o.dead) { c2.globalAlpha = alpha * 0.75; c2.fillStyle = c.cheek; ell(-r * 0.22, cy + r * 0.1, r * 0.13, r * 0.09, 0, true, false); ell(r * 0.8, cy + r * 0.08, r * 0.1, r * 0.08, 0, true, false); c2.globalAlpha = alpha; }
  if (c.beak) { c2.fillStyle = o.dead ? "#b0b4c0" : "#ffb02e"; c2.strokeStyle = line; c2.lineWidth = lw; tri([r * 0.18, cy + r * 0.02, r * 0.42, cy + r * 0.02, r * 0.3, cy + r * 0.22]); }
  else {
    c2.strokeStyle = line; c2.lineWidth = lw;
    c2.beginPath(); c2.arc(r * 0.22, cy + r * 0.06, r * 0.08, 0.15 * Math.PI, 0.85 * Math.PI); c2.stroke();
  }
  c2.restore();
}

boot();
