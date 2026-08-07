/**
 * Board Game Arena 클라이언트.
 *
 * BGA는 공식 API가 없어서 사이트가 쓰는 경로를 그대로 이용한다. 다행히 BGG 쓰기와 달리
 * Cloudflare 봇 차단도, 로그인 CAPTCHA도 없다(가입 폼에만 있다).
 *
 * 로그인 규칙(확인함):
 *   1) 아무 페이지나 받아 세션 쿠키(PHPSESSID)와 requestToken을 얻는다
 *   2) POST /account/auth/loginUserWithPassword.html
 *      - 토큰을 헤더 X-Request-Token 과 본문 request_token 에 "둘 다" 넣어야 한다.
 *        한쪽만 넣으면 InvalidTokenException(806)이 난다.
 *
 * 비밀번호는 로그인 요청에만 쓰이고 어디에도 저장하지 않는다. 남는 건 세션 쿠키뿐이고
 * 그것도 서버 메모리에만 둔다.
 */
const ORIGIN = "https://boardgamearena.com";
const UA = "bgg-collection-manager/0.1 (+https://github.com/cfgcyvtnyt-lab/bgg)";

function mergeCookies(jar, resp) {
  const raw = typeof resp.headers.getSetCookie === "function"
    ? resp.headers.getSetCookie()
    : (resp.headers.get("set-cookie") || "").split(/,(?=[^;]+=)/);
  for (const line of raw) {
    if (!line) continue;
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value && value !== "deleted") jar.set(name, value);
  }
  return jar;
}

function jarHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 세션 하나. 로그인 뒤 쿠키·토큰·플레이어 id를 들고 다닌다. */
export class BgaSession {
  constructor() {
    this.jar = new Map();
    this.token = null;
    this.playerId = null;
    this.playerName = null;
  }

  get cookie() {
    return jarHeader(this.jar);
  }

  async request(path, { method = "GET", form = null, json = true } = {}) {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const headers = {
      "User-Agent": UA,
      Cookie: this.cookie,
      Referer: `${ORIGIN}/`,
      "X-Requested-With": "XMLHttpRequest",
    };
    if (this.token) headers["X-Request-Token"] = this.token;

    let body;
    if (form) {
      const p = new URLSearchParams(form);
      // 토큰은 헤더와 본문 양쪽에 필요하다(둘 중 하나만 있으면 806).
      if (this.token && !p.has("request_token")) p.set("request_token", this.token);
      body = p.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const resp = await fetch(url, { method, headers, body, redirect: "manual" });
    mergeCookies(this.jar, resp);

    // 로그인이 안 된 상태면 /account로 302를 준다.
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(`BGA 로그인이 필요합니다 (${path})`);
    }
    const text = await resp.text();
    if (!json) return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`BGA 응답을 해석할 수 없습니다 (${path}): ${text.slice(0, 150)}`);
    }
  }
}

/** 세션 쿠키와 요청 토큰을 준비한다. 로그인 전에 반드시 거쳐야 한다. */
async function primeSession(session) {
  const resp = await fetch(`${ORIGIN}/account`, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  mergeCookies(session.jar, resp);
  const html = await resp.text();
  const m = html.match(/requestToken\s*[:=]\s*["']([^"']+)["']/);
  if (!m) throw new Error("BGA 요청 토큰을 찾지 못했습니다. 사이트 구조가 바뀌었을 수 있습니다.");
  session.token = m[1];
  return session;
}

/** 아이디·비밀번호로 로그인. 성공하면 세션을 돌려준다. */
export async function login(username, password) {
  const session = new BgaSession();
  await primeSession(session);

  const data = await session.request("/account/auth/loginUserWithPassword.html", {
    method: "POST",
    form: { username, password, remember_me: "false" },
  });

  // 실패 사유를 BGA가 준 그대로 보여준다. 뭉뚱그리면 원인을 알 수 없다.
  if (data.status !== 1 && data.status !== "1") {
    throw new Error(`BGA 로그인 실패: ${data.error || data.exception || JSON.stringify(data)}`);
  }
  if (data.data && data.data.success === false) {
    const d = data.data;
    // BGA는 아이디/비밀번호가 틀리면 message 없이 failed:true만 준다.
    // 여러 번 틀리면 일정 시간 잠그기도 한다(사이트에도 "Please wait…"가 뜬다).
    let why = d.message || "";
    if (!why && d.failed) {
      why = "아이디 또는 비밀번호가 맞지 않습니다. (여러 번 틀리면 아레나가 몇 분간 로그인을 막습니다)";
    }
    throw new Error(`BGA 로그인 실패: ${why || JSON.stringify(d)}`);
  }

  // 로그인 뒤 내 플레이어 id를 확인해둔다 - 플레이 목록 조회에 필요하다.
  const info = await session.request("/account/account/getInfo.html");
  const infos = info?.data?.infos || info?.data || {};
  session.playerId = Number(infos.id ?? infos.player_id ?? 0) || null;
  session.playerName = infos.name ?? infos.player_name ?? username;
  if (!session.playerId) {
    throw new Error("BGA 플레이어 id를 확인하지 못했습니다.");
  }
  return session;
}

/**
 * 끝난 판 목록. 한 페이지에 10건씩 준다.
 *
 * 실제 응답(확인함):
 *   { table_id, game_id, game_name, start, end, players, player_names, scores, ranks, ... }
 *   - start/end 는 유닉스 초
 *   - players/player_names/scores/ranks 는 쉼표로 이어붙인 문자열이고 순서가 서로 맞는다
 *   - rank 1 이 승리
 */
function parseTable(t) {
  const names = String(t.player_names || "").split(",").filter(Boolean);
  const ids = String(t.players || "").split(",").filter(Boolean);
  const scores = String(t.scores || "").split(",");
  const ranks = String(t.ranks || "").split(",");
  const start = Number(t.start) || null;
  const end = Number(t.end) || null;

  return {
    tableId: Number(t.table_id),
    bgaGameId: Number(t.game_id),
    bgaGameName: t.game_name || "",
    // 아레나 시각은 유닉스 초. 앱은 날짜만 쓰므로 로컬 날짜로 자른다.
    playedAt: start ? localDate(start) : null,
    durationMin: start && end ? Math.max(1, Math.round((end - start) / 60)) : null,
    players: names.map((name, i) => {
      const rank = Number(ranks[i]);
      const score = scores[i] === "" || scores[i] === undefined ? null : Number(scores[i]);
      return {
        bgaId: Number(ids[i]) || null,
        name,
        score: Number.isFinite(score) ? score : null,
        rank: Number.isFinite(rank) ? rank : null,
        win: rank === 1,
      };
    }),
  };
}

function localDate(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export async function fetchPlays(session, { playerId = null, page = 1 } = {}) {
  const params = new URLSearchParams({
    player: String(playerId || session.playerId),
    opponent_id: "0",
    finished: "0",
    updateStats: "1",
    page: String(page),
  });
  const data = await session.request(`/gamestats/gamestats/getGames.html?${params}`);
  const tables = data?.data?.tables || [];
  return tables.map(parseTable);
}

/** 여러 페이지를 이어서 받는다. 아레나에 부담 주지 않게 사이를 띄운다. */
export async function fetchAllPlays(session, { playerId = null, maxPages = 30 } = {}) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const rows = await fetchPlays(session, { playerId, page });
    if (rows.length === 0) break;
    let added = 0;
    for (const r of rows) {
      if (seen.has(r.tableId)) continue;
      seen.add(r.tableId);
      all.push(r);
      added++;
    }
    // 같은 페이지가 반복되면(페이지 파라미터가 안 먹는 경우) 무한 루프를 막는다
    if (added === 0) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  return all;
}

/**
 * BGA 게임 id -> BGG id 표. 공개 목록이라 로그인 없이 받을 수 있다.
 * BGA가 bgg_id를 직접 주기 때문에 게임 이름으로 헤맬 필요가 없다.
 */
export async function fetchGameMap() {
  const resp = await fetch(`${ORIGIN}/gamelist`, { headers: { "User-Agent": UA }, redirect: "follow" });
  const html = await resp.text();

  // 페이지에 "game_list":[ ... ] 배열이 통째로 박혀 있다. 게임 객체 안에 중첩 객체가 많아
  // 정규식으로는 짝을 못 맞추므로 괄호 깊이를 세어 배열 끝을 찾은 뒤 JSON으로 판다.
  const key = '"game_list":';
  const at = html.indexOf(key);
  if (at < 0) throw new Error("BGA 게임 목록을 찾지 못했습니다.");
  const start = html.indexOf("[", at);
  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error("BGA 게임 목록이 잘려 있습니다.");

  const list = JSON.parse(html.slice(start, end));
  const map = new Map(); // BGA game id -> { bggId, name }
  for (const g of list) {
    const bgaId = Number(g.id);
    const bggId = Number(g.bgg_id);
    if (bgaId && bggId) map.set(bgaId, { bggId, name: g.display_name_en || g.name });
  }
  return map;
}
