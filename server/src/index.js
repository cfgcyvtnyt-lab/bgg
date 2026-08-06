import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { openDb } from "./db.js";
import { runSync } from "./sync.js";

const DB_PATH = process.env.DB_PATH || "data/app.db";
const PORT = process.env.PORT || 3001;
const BGG_API_KEY = process.env.BGG_API_KEY;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 이미지 디스크 캐시. BGG를 매번 핫링크하지 않기 위한 프록시 저장 위치.
const IMAGE_CACHE_DIR = process.env.IMAGE_CACHE_DIR || "data/cache/images";
// 사용자 업로드 사진 저장 경로. 나중에 도커 볼륨을 따로 붙일 수 있게 상수만 빼둔다 (업로드 기능은 이번 범위 아님).
const PHOTO_DIR = process.env.PHOTO_DIR || "data/photos";
// 원본은 그대로 보관 (리사이즈는 외부 발행 때 처리 - 이번 범위 아님)
const PHOTO_ORIGINAL_DIR = join(PHOTO_DIR, "original");
const ALLOWED_PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
mkdirSync(PHOTO_ORIGINAL_DIR, { recursive: true });

const db = openDb(DB_PATH);
const app = express();
app.use(express.json());

// X-User-Id 헤더로 요청자를 식별한다. 플레이 기록은 계정별로 완전히 분리되므로
// 이 값이 없으면 플레이/인사이트 관련 엔드포인트는 동작할 수 없다.
function currentUserId(req) {
  const raw = req.header("X-User-Id");
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

function requireUser(req, res) {
  const userId = currentUserId(req);
  if (!userId) {
    res.status(400).json({ error: "X-User-Id 헤더가 필요합니다" });
    return null;
  }
  return userId;
}

function parseJsonArray(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// BGStats가 BGG에 올릴 때 코멘트 끝에 붙이는 태그. 원본 DB는 보존하고 응답에서만 걷어낸다.
function stripBgStatsTag(comment) {
  if (comment == null) return null;
  const stripped = comment.replace(/\s*#bgstats\s*$/i, "").trim();
  return stripped === "" ? null : stripped;
}

// 플레이어/장소 별칭 맵. { kind: Map<alias, canonical> } 형태로 매 요청마다 새로 읽는다
// (설정에서 바꾸면 바로 반영돼야 하므로 캐싱하지 않는다).
function loadAliasMap(kind) {
  const rows = db.prepare("SELECT alias, canonical FROM name_alias WHERE kind = ?").all(kind);
  return new Map(rows.map((r) => [r.alias, r.canonical]));
}

function applyAlias(map, name) {
  return map.get(name) || name;
}

// ---------- health / users ----------

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/users", (req, res) => {
  const rows = db.prepare("SELECT id, name, bgg_username, bga_username FROM user").all();
  res.json(rows);
});

// ---------- games ----------

app.get("/api/games", (req, res) => {
  const q = (req.query.q || "").trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  let rows;
  if (q) {
    // aliases는 JSON 배열을 문자열째로 저장하므로 LIKE로 부분 일치만 확인해도 충분하다.
    // custom_name도 검색 대상에 포함해야 사용자가 지정한 한글 이름으로도 찾을 수 있다.
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT *, COALESCE(custom_name, name) AS name FROM game
      WHERE name LIKE ? OR name_en LIKE ? OR aliases LIKE ? OR custom_name LIKE ?
      ORDER BY COALESCE(custom_name, name)
      LIMIT ? OFFSET ?
    `).all(like, like, like, like, limit, offset);
  } else {
    rows = db.prepare(`
      SELECT *, COALESCE(custom_name, name) AS name FROM game
      ORDER BY COALESCE(custom_name, name) LIMIT ? OFFSET ?
    `).all(limit, offset);
  }
  res.json(rows.map((g) => ({ ...g, aliases: parseJsonArray(g.aliases) })));
});

app.get("/api/games/:id", (req, res) => {
  const id = Number(req.params.id);
  // name은 표시용(custom_name 우선), original_name은 BGG에서 온 원래 이름 - 편집 UI에서 같이 보여준다.
  const game = db.prepare(
    "SELECT *, name AS original_name, COALESCE(custom_name, name) AS name FROM game WHERE id = ?"
  ).get(id);
  if (!game) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });

  const collectionHistory = db.prepare(
    "SELECT * FROM collection WHERE game_id = ? ORDER BY created_at").all(id);

  const userId = currentUserId(req);
  let playCount = 0;
  let myRating = null;
  let stats = null;
  if (userId) {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM play WHERE game_id = ? AND user_id = ?").get(id, userId);
    playCount = row.c;
    const ratingRow = db.prepare(
      "SELECT rating FROM game_rating WHERE game_id = ? AND user_id = ?").get(id, userId);
    myRating = ratingRow ? ratingRow.rating : null;

    stats = computeGameStats(id, userId, playCount);
  }

  res.json({
    ...game,
    aliases: parseJsonArray(game.aliases),
    designers: parseJsonArray(game.designers),
    artists: parseJsonArray(game.artists),
    categories: parseJsonArray(game.categories),
    mechanics: parseJsonArray(game.mechanics),
    collectionHistory,
    playCount,
    my_rating: myRating,
    stats,
  });
});

// 무료 구글 gtx 엔드포인트로 번역. 공식 API 키가 필요 없는 대신 한 번에 보낼 수 있는 길이가
// 제한적이라 문장 단위로 잘라 여러 번 호출한 뒤 이어붙인다.
async function translateToKorean(text) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > 1500) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? " " : "") + s;
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) return "";

  const parts = [];
  for (const chunk of chunks) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gt&sl=en&tl=ko&dt=t&q=${encodeURIComponent(chunk)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`번역 요청 실패 (HTTP ${resp.status})`);
    const data = await resp.json();
    parts.push((data[0] || []).map((piece) => piece[0]).join(""));
  }
  return parts.join(" ");
}

// 설명 번역. 캐시(description_ko)가 있으면 재번역하지 않는다.
app.post("/api/games/:id/translate", async (req, res) => {
  const id = Number(req.params.id);
  const game = db.prepare("SELECT id, description, description_ko FROM game WHERE id = ?").get(id);
  if (!game) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });
  if (game.description_ko) return res.json({ description_ko: game.description_ko });
  if (!game.description) return res.status(400).json({ error: "번역할 원문 설명이 없습니다" });

  try {
    const ko = await translateToKorean(game.description);
    db.prepare("UPDATE game SET description_ko = ? WHERE id = ?").run(ko, id);
    res.json({ description_ko: ko });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 게임 상세 화면용 요청 사용자 기준 통계: 승률, 점수, 평균 소요시간, 마지막 플레이, 상대 전적.
// 점수(최고/최저/평균)는 1인 판과 2인+ 판을 섞으면 의미가 없어서 solo/multi로 나눠서 낸다.
// 솔로 판정은 "사람 플레이어(is_automa=0)가 1명 이하"인 판 - 오토마만 상대인 판도 솔로로 본다.
function computeGameStats(gameId, userId, playCount) {
  const user = db.prepare("SELECT name FROM user WHERE id = ?").get(userId);
  if (!user) return null;

  const playerAlias = loadAliasMap("player");
  const myCanonical = applyAlias(playerAlias, user.name);

  const playRows = db.prepare(
    "SELECT id, played_at, duration_min FROM play WHERE game_id = ? AND user_id = ?"
  ).all(gameId, userId);
  if (playRows.length === 0) {
    return {
      playCount: 0, winRate: null, avgDurationMin: null, lastPlayedAt: null,
      score: { solo: null, multi: null }, opponents: [],
    };
  }

  const playIds = playRows.map((p) => p.id);
  const placeholders = playIds.map(() => "?").join(",");
  const allPlayers = db.prepare(
    `SELECT play_id, name, score, win, is_automa FROM play_player WHERE play_id IN (${placeholders})`
  ).all(...playIds);

  // 판별 사람 플레이어 수 (오토마 제외) - 1명 이하면 솔로.
  const humanCountByPlay = new Map();
  for (const pp of allPlayers) {
    if (pp.is_automa) continue;
    humanCountByPlay.set(pp.play_id, (humanCountByPlay.get(pp.play_id) || 0) + 1);
  }
  const isSoloPlay = (playId) => (humanCountByPlay.get(playId) || 0) <= 1;

  // 각 판에서 "나"의 win 여부를 먼저 뽑아둔다 - 상대 전적 계산에 필요하다.
  const myWinByPlay = new Map();
  const soloScores = [];
  const multiScores = [];
  let myWins = 0;
  for (const pp of allPlayers) {
    if (applyAlias(playerAlias, pp.name) !== myCanonical) continue;
    myWinByPlay.set(pp.play_id, pp.win ? 1 : 0);
    if (pp.win) myWins++;
    if (pp.score != null) {
      (isSoloPlay(pp.play_id) ? soloScores : multiScores).push(pp.score);
    }
  }

  const scoreBucket = (scores) => scores.length === 0 ? null : {
    best: Math.round(Math.max(...scores)),
    worst: Math.round(Math.min(...scores)),
    avg: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    count: scores.length,
  };
  const score = { solo: scoreBucket(soloScores), multi: scoreBucket(multiScores) };

  const durations = playRows.map((p) => p.duration_min).filter((n) => n != null && n > 0);
  const avgDurationMin = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  const lastPlayedAt = playRows.reduce((max, p) => (p.played_at > max ? p.played_at : max), playRows[0].played_at);

  // 상대별 전적: 나를 제외한 "사람" 참가자를 별칭 기준으로 합쳐서 판수/내 승수를 집계한다. 오토마는 상대가 아니다.
  const opponentMap = new Map();
  for (const pp of allPlayers) {
    if (pp.is_automa) continue;
    const canonical = applyAlias(playerAlias, pp.name);
    if (canonical === myCanonical) continue;
    const cur = opponentMap.get(canonical) || { name: canonical, games: new Set(), myWins: 0 };
    if (!cur.games.has(pp.play_id)) {
      cur.games.add(pp.play_id);
      if (myWinByPlay.get(pp.play_id)) cur.myWins++;
    }
    opponentMap.set(canonical, cur);
  }
  const opponents = [...opponentMap.values()]
    .map((o) => ({ name: o.name, games: o.games.size, myWins: o.myWins }))
    .sort((a, b) => b.games - a.games);

  return {
    playCount,
    winRate: playCount ? Math.round((myWins / playCount) * 100) : null,
    avgDurationMin,
    lastPlayedAt,
    score,
    opponents,
  };
}

// custom_name만 수정 가능. 빈 문자열이면 NULL로 되돌려 원래(BGG) 이름으로 복귀시킨다.
app.patch("/api/games/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM game WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });
  if (!("custom_name" in (req.body || {}))) {
    return res.status(400).json({ error: "custom_name이 필요합니다" });
  }

  let customName = req.body.custom_name;
  if (typeof customName === "string") customName = customName.trim();
  if (!customName) customName = null;

  db.prepare("UPDATE game SET custom_name = ? WHERE id = ?").run(customName, id);
  const row = db.prepare(
    "SELECT *, name AS original_name, COALESCE(custom_name, name) AS name FROM game WHERE id = ?"
  ).get(id);
  res.json({ ...row, aliases: parseJsonArray(row.aliases) });
});

// ---------- collection (공유) ----------

// 화면에 보일 때 "가장 현재에 가까운" 상태 하나만 고르는 우선순위. 취득 이력 전체는 게임 상세에서만 본다.
const STATUS_PRIORITY = ["보유", "선주문", "위시리스트", "방출 예정", "방출 확정", "방출 완료"];

app.get("/api/collection", (req, res) => {
  const { status, tag, include_expansions } = req.query;
  const userId = currentUserId(req);

  // 취득 이력(팔았다 다시 사기도 함)을 전부 가져온 뒤 게임당 대표 행 하나로 줄인다.
  // c.want_to_play(공유 테이블)는 더 이상 쓰지 않는다 - 아래 gr.want_to_play(사용자별)로 덮어써서 무시한다.
  const rows = db.prepare(`
    SELECT c.*, COALESCE(g.custom_name, g.name) AS game_name, g.name_en AS game_name_en, g.thumbnail, g.image,
           g.year_published, g.min_players, g.max_players, g.playing_time, g.weight,
           g.bgg_rating, g.bgg_rank, g.item_type,
           gr.rating AS my_rating,
           COALESCE(gr.want_to_play, 0) AS want_to_play
    FROM collection c
    JOIN game g ON g.id = c.game_id
    LEFT JOIN game_rating gr ON gr.game_id = c.game_id AND gr.user_id = ?
    ORDER BY c.created_at DESC
  `).all(userId ?? -1);

  const byGame = new Map();
  for (const r of rows) {
    const cur = byGame.get(r.game_id);
    if (!cur) { byGame.set(r.game_id, r); continue; }
    const curP = STATUS_PRIORITY.indexOf(cur.status);
    const newP = STATUS_PRIORITY.indexOf(r.status);
    if (newP !== -1 && (curP === -1 || newP < curP)) byGame.set(r.game_id, r);
  }

  let entries = [...byGame.values()].map((r) => ({ ...r, tags: parseJsonArray(r.tags) }));

  // 플레이 기록은 있지만 collection 행이 없는 게임(빌려서 한 판 등)도 컬렉션 화면에서 보여야 한다.
  // collection 행을 새로 만들면 소유 개수(보유 95 등)가 오염되므로 조회에서만 합친다.
  const unownedRows = db.prepare(`
    SELECT g.id AS game_id, COALESCE(g.custom_name, g.name) AS game_name, g.name_en AS game_name_en,
           g.thumbnail, g.image, g.year_published, g.min_players, g.max_players, g.playing_time,
           g.weight, g.bgg_rating, g.bgg_rank, g.item_type, gr.rating AS my_rating,
           COALESCE(gr.want_to_play, 0) AS want_to_play
    FROM game g
    LEFT JOIN game_rating gr ON gr.game_id = g.id AND gr.user_id = ?
    WHERE EXISTS (SELECT 1 FROM play p WHERE p.game_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM collection c WHERE c.game_id = g.id)
  `).all(userId ?? -1);
  for (const r of unownedRows) {
    entries.push({
      id: null, game_id: r.game_id, status: null, want_to_play: r.want_to_play,
      price_paid: null, price_sold: null, tags: [], note: null, acquired_at: null, created_at: null,
      game_name: r.game_name, game_name_en: r.game_name_en, thumbnail: r.thumbnail, image: r.image,
      year_published: r.year_published, min_players: r.min_players, max_players: r.max_players,
      playing_time: r.playing_time, weight: r.weight, bgg_rating: r.bgg_rating, bgg_rank: r.bgg_rank,
      item_type: r.item_type, my_rating: r.my_rating,
    });
  }

  // 기본적으로 확장(boardgameexpansion)은 목록에서 숨긴다. include_expansions=1이면 그대로 둔다.
  // item_type이 아직 비어 있는(백필 전) 게임은 확장인지 알 수 없으니 숨기지 않는다.
  if (!include_expansions) {
    entries = entries.filter((e) => e.item_type !== "boardgameexpansion");
  }

  // 요청 사용자 기준 플레이 횟수/최근 플레이일 - BGStats 스타일 정렬·뷰 필터에 쓴다.
  // 플레이 기록은 계정별로 분리되므로 X-User-Id가 없으면(userId=-1) 전부 0건으로 처리한다.
  const playAgg = new Map(
    db.prepare("SELECT game_id, COUNT(*) AS cnt, MAX(played_at) AS last FROM play WHERE user_id = ? GROUP BY game_id")
      .all(userId ?? -1)
      .map((r) => [r.game_id, { count: r.cnt, last: r.last }])
  );
  entries = entries.map((e) => ({
    ...e,
    play_count: playAgg.get(e.game_id)?.count || 0,
    last_played_at: playAgg.get(e.game_id)?.last || null,
  }));

  if (status) entries = entries.filter((e) => e.status === status);
  if (tag) entries = entries.filter((e) => e.tags.includes(tag));
  entries.sort((a, b) => ((a.created_at || "") < (b.created_at || "") ? 1 : (a.created_at || "") > (b.created_at || "") ? -1 : 0));

  res.json(entries);
});

app.post("/api/collection", (req, res) => {
  const { game_id, status, price_paid, tags, note, acquired_at } = req.body || {};
  if (!game_id) return res.status(400).json({ error: "game_id가 필요합니다" });
  const game = db.prepare("SELECT id FROM game WHERE id = ?").get(game_id);
  if (!game) return res.status(400).json({ error: "존재하지 않는 game_id입니다" });

  const result = db.prepare(`
    INSERT INTO collection (game_id, status, price_paid, tags, note, acquired_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(game_id, status || "보유", price_paid ?? null,
         tags ? JSON.stringify(tags) : null, note ?? null, acquired_at ?? null);

  const row = db.prepare("SELECT * FROM collection WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ ...row, tags: parseJsonArray(row.tags) });
});

app.patch("/api/collection/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM collection WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "찾을 수 없습니다" });

  const fields = ["status", "price_paid", "price_sold", "tags", "note", "acquired_at"];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      const v = req.body[f];
      params.push(f === "tags" && v != null ? JSON.stringify(v) : v);
    }
  }
  if (updates.length === 0) return res.json({ ...existing, tags: parseJsonArray(existing.tags) });

  params.push(id);
  db.prepare(`UPDATE collection SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  const row = db.prepare("SELECT * FROM collection WHERE id = ?").get(id);
  res.json({ ...row, tags: parseJsonArray(row.tags) });
});

app.delete("/api/collection/:id", (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("DELETE FROM collection WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "찾을 수 없습니다" });
  res.json({ ok: true });
});

// ---------- plays (계정별) ----------

function loadPlayers(playId) {
  return db.prepare("SELECT * FROM play_player WHERE play_id = ?").all(playId);
}

function loadPhotos(playId) {
  return db.prepare("SELECT * FROM photo WHERE play_id = ? ORDER BY id").all(playId)
    .map((p) => ({ ...p, published: !!p.published }));
}

// 기록 입력에서 장소를 자유 입력 대신 목록에서 고르게 하기 위한 엔드포인트.
// name_alias(location)를 적용해 표기가 갈린 이름(Home/Home2/H. 등)을 합친 뒤 사용 횟수와 함께 반환한다.
app.get("/api/locations", (req, res) => {
  const rows = db.prepare(
    "SELECT location AS name, COUNT(*) AS count FROM play WHERE location IS NOT NULL AND location != '' GROUP BY location"
  ).all();
  const aliasMap = loadAliasMap("location");
  const merged = new Map();
  for (const r of rows) {
    const canonical = applyAlias(aliasMap, r.name);
    const cur = merged.get(canonical) || { name: canonical, count: 0 };
    cur.count += r.count;
    merged.set(canonical, cur);
  }
  res.json([...merged.values()].sort((a, b) => b.count - a.count));
});

// 장소 이름 바꾸기. name_alias(병합 표시)와 달리 원본 play.location 값 자체를 고친다 -
// 오타·표기 통일처럼 "그냥 다른 이름으로 대체"하고 싶을 때 쓴다. 별칭 병합 기능은 그대로 둔다.
app.patch("/api/locations", (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "from, to가 필요합니다" });
  if (from === to) return res.status(400).json({ error: "from과 to가 같습니다" });

  const result = db.prepare("UPDATE play SET location = ? WHERE location = ?").run(to, from);
  invalidateFeedCache();
  res.json({ ok: true, changed: result.changes });
});

app.get("/api/plays", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const { game_id, from, to, limit, offset } = req.query;
  const clauses = ["p.user_id = ?"];
  const params = [userId];
  if (game_id) { clauses.push("p.game_id = ?"); params.push(Number(game_id)); }
  if (from) { clauses.push("p.played_at >= ?"); params.push(from); }
  if (to) { clauses.push("p.played_at <= ?"); params.push(to); }

  const lim = Math.min(Number(limit) || 50, 500);
  const off = Number(offset) || 0;

  const rows = db.prepare(`
    SELECT p.*, COALESCE(g.custom_name, g.name) AS game_name
    FROM play p
    JOIN game g ON g.id = p.game_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY p.played_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, lim, off);

  const result = rows.map((r) => ({
    ...r,
    comment: stripBgStatsTag(r.comment),
    expansions: parseJsonArray(r.expansions),
    players: loadPlayers(r.id),
    photos: loadPhotos(r.id),
  }));
  res.json(result);
});

// 플레이 상세: 같은 게임 · 같은 플레이어 조합(오토마 포함, 별칭 적용)의 누적 통계를 함께 낸다.
// "조합"은 이번 판 참가자 이름 집합과 정확히 같은 다른 판들만 - 인원이 다르면 다른 대전으로 본다.
app.get("/api/plays/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);

  const play = db.prepare(`
    SELECT p.*, COALESCE(g.custom_name, g.name) AS game_name
    FROM play p JOIN game g ON g.id = p.game_id WHERE p.id = ?
  `).get(id);
  if (!play) return res.status(404).json({ error: "찾을 수 없습니다" });
  if (play.user_id !== userId) return res.status(403).json({ error: "본인 기록만 볼 수 있습니다" });

  const players = loadPlayers(id);
  const playerAlias = loadAliasMap("player");
  const comboNames = [...players.map((p) => applyAlias(playerAlias, p.name))].sort();

  // 같은 게임의 이 사용자 판들 중 참가자 조합(정렬된 별칭 이름 집합)이 완전히 같은 판만 추린다.
  const sameGamePlays = db.prepare("SELECT id, played_at FROM play WHERE user_id = ? AND game_id = ?")
    .all(userId, play.game_id);
  const matched = [];
  for (const sp of sameGamePlays) {
    const pls = loadPlayers(sp.id);
    const names = pls.map((p) => applyAlias(playerAlias, p.name)).sort();
    if (names.length === comboNames.length && names.every((n, i) => n === comboNames[i])) {
      matched.push({ id: sp.id, played_at: sp.played_at, players: pls });
    }
  }
  matched.sort((a, b) => (a.played_at < b.played_at ? -1 : a.played_at > b.played_at ? 1 : a.id - b.id));

  // 이름별 누적치 + 연승(현재 판까지 거슬러 올라가며 승리가 끊기지 않은 판수)
  const statsByName = new Map();
  for (const m of matched) {
    for (const p of m.players) {
      const canon = applyAlias(playerAlias, p.name);
      const cur = statsByName.get(canon) || { name: canon, plays: 0, wins: 0, scores: [] };
      cur.plays++;
      if (p.win) cur.wins++;
      if (p.score != null) cur.scores.push(p.score);
      statsByName.set(canon, cur);
    }
  }
  const currentIndex = matched.findIndex((m) => m.id === id);
  function streakFor(canon) {
    let streak = 0;
    for (let i = currentIndex; i >= 0; i--) {
      const pp = matched[i].players.find((p) => applyAlias(playerAlias, p.name) === canon);
      if (pp && pp.win) streak++;
      else break;
    }
    return streak;
  }

  const comboPlayers = [...statsByName.values()].map((s) => ({
    name: s.name,
    plays: s.plays,
    wins: s.wins,
    winRate: s.plays ? Math.round((s.wins / s.plays) * 100) : null,
    avgScore: s.scores.length ? Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) : null,
    bestScore: s.scores.length ? Math.round(Math.max(...s.scores)) : null,
    currentStreak: streakFor(s.name),
  }));

  // 이번 판 참가자별로 "이번 점수 = 이 조합에서의 최고점" 여부 배지용 플래그를 붙인다.
  const bestByName = new Map(comboPlayers.map((c) => [c.name, c.bestScore]));
  const playersWithFlags = players.map((p) => {
    const canon = applyAlias(playerAlias, p.name);
    const best = bestByName.get(canon);
    return {
      ...p,
      isBestScore: p.score != null && best != null && Math.round(p.score) === best,
    };
  });

  res.json({
    ...play,
    comment: stripBgStatsTag(play.comment),
    expansions: parseJsonArray(play.expansions),
    players: playersWithFlags,
    photos: loadPhotos(id),
    comboStats: { matchCount: matched.length, players: comboPlayers },
  });
});

app.post("/api/plays", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const {
    game_id, played_at, duration_min, location, comment,
    is_coop, expansions, incomplete, players,
  } = req.body || {};

  if (!game_id || !played_at) {
    return res.status(400).json({ error: "game_id, played_at이 필요합니다" });
  }
  const game = db.prepare("SELECT id FROM game WHERE id = ?").get(game_id);
  if (!game) return res.status(400).json({ error: "존재하지 않는 game_id입니다" });

  // play + play_player를 하나의 트랜잭션으로 묶어서 플레이어 삽입 중 실패해도 반쪽짜리 기록이 안 남게 한다.
  db.exec("BEGIN");
  try {
    const result = db.prepare(`
      INSERT INTO play (user_id, game_id, played_at, duration_min, location, comment,
                        incomplete, source, expansions, is_coop)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'app', ?, ?)
    `).run(userId, game_id, played_at, duration_min ?? null, location ?? null,
           comment ?? null, incomplete ? 1 : 0,
           expansions ? JSON.stringify(expansions) : null, is_coop ? 1 : 0);

    const playId = result.lastInsertRowid;
    const insertPlayer = db.prepare(`
      INSERT INTO play_player (play_id, name, score, win, role, team, is_new, start_position, is_automa)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const pl of players || []) {
      insertPlayer.run(playId, pl.name || "?", pl.score ?? null, pl.win ? 1 : 0,
                        pl.role ?? null, pl.team ?? null, pl.is_new ? 1 : 0,
                        pl.start_position ?? null, pl.is_automa ? 1 : 0);
    }
    db.exec("COMMIT");
    invalidateFeedCache();

    const row = db.prepare("SELECT * FROM play WHERE id = ?").get(playId);
    res.status(201).json({
      ...row, comment: stripBgStatsTag(row.comment),
      expansions: parseJsonArray(row.expansions), players: loadPlayers(playId), photos: [],
    });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.patch("/api/plays/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);

  const existing = db.prepare("SELECT * FROM play WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "찾을 수 없습니다" });
  if (existing.user_id !== userId) return res.status(403).json({ error: "본인 기록만 수정할 수 있습니다" });

  const fields = ["played_at", "duration_min", "location", "comment", "incomplete", "is_coop", "expansions"];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      let v = req.body[f];
      if (f === "expansions" && v != null) v = JSON.stringify(v);
      if ((f === "incomplete" || f === "is_coop") && v != null) v = v ? 1 : 0;
      params.push(v);
    }
  }
  if (updates.length) {
    params.push(id);
    db.prepare(`UPDATE play SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }

  if (Array.isArray(req.body?.players)) {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM play_player WHERE play_id = ?").run(id);
      const insertPlayer = db.prepare(`
        INSERT INTO play_player (play_id, name, score, win, role, team, is_new, start_position, is_automa)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const pl of req.body.players) {
        insertPlayer.run(id, pl.name || "?", pl.score ?? null, pl.win ? 1 : 0,
                          pl.role ?? null, pl.team ?? null, pl.is_new ? 1 : 0,
                          pl.start_position ?? null, pl.is_automa ? 1 : 0);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      return res.status(500).json({ error: String(err.message || err) });
    }
  }

  invalidateFeedCache();
  const row = db.prepare("SELECT * FROM play WHERE id = ?").get(id);
  res.json({
    ...row, comment: stripBgStatsTag(row.comment),
    expansions: parseJsonArray(row.expansions), players: loadPlayers(id), photos: loadPhotos(id),
  });
});

app.delete("/api/plays/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);

  const existing = db.prepare("SELECT * FROM play WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "찾을 수 없습니다" });
  if (existing.user_id !== userId) return res.status(403).json({ error: "본인 기록만 삭제할 수 있습니다" });

  // 사진 파일도 같이 지워야 고아 파일이 안 남는다.
  for (const ph of loadPhotos(id)) {
    try { unlinkSync(join(PHOTO_ORIGINAL_DIR, ph.filename)); } catch { /* 이미 없으면 무시 */ }
  }
  db.prepare("DELETE FROM play WHERE id = ?").run(id); // play_player/photo는 ON DELETE CASCADE
  invalidateFeedCache();
  res.json({ ok: true });
});

// ---------- 사진 ----------
// 의존성 추가 금지라 multer 대신, 파일을 통째로 body로 받는 방식(raw)을 쓴다.
// 프론트는 FormData가 아니라 fetch(url, {body: file, headers:{'Content-Type': file.type, 'X-Filename': ...}})로 보낸다.

app.post("/api/plays/:id/photos", express.raw({ type: () => true, limit: "20mb" }), (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const playId = Number(req.params.id);

  const play = db.prepare("SELECT * FROM play WHERE id = ?").get(playId);
  if (!play) return res.status(404).json({ error: "찾을 수 없습니다" });
  if (play.user_id !== userId) return res.status(403).json({ error: "본인 플레이에만 업로드할 수 있습니다" });

  // 한글 파일명은 HTTP 헤더에 그대로 못 실으므로 프론트에서 encodeURIComponent해 보낸다.
  let originalName = "";
  try {
    originalName = decodeURIComponent(req.header("X-Filename") || "");
  } catch {
    originalName = req.header("X-Filename") || "";
  }
  const ext = extname(originalName).toLowerCase();
  if (!ALLOWED_PHOTO_EXT.has(ext)) {
    return res.status(400).json({ error: "허용되지 않는 확장자입니다 (jpg/jpeg/png/webp/heic만 가능)" });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "파일이 비어 있습니다" });
  }
  if (req.body.length > MAX_PHOTO_BYTES) {
    return res.status(400).json({ error: "파일이 너무 큽니다 (최대 20MB)" });
  }

  const filename = `${playId}_${Date.now()}_${randomBytes(4).toString("hex")}${ext}`;
  writeFileSync(join(PHOTO_ORIGINAL_DIR, filename), req.body);

  let caption = null;
  const capHeader = req.header("X-Caption");
  if (capHeader) {
    try { caption = decodeURIComponent(capHeader); } catch { caption = capHeader; }
  }

  const result = db.prepare(
    "INSERT INTO photo (play_id, filename, caption) VALUES (?, ?, ?)"
  ).run(playId, filename, caption);
  invalidateFeedCache();

  const row = db.prepare("SELECT * FROM photo WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ ...row, published: !!row.published });
});

app.get("/api/photos/:filename", (req, res) => {
  const filename = req.params.filename;
  // 경로 탈출 차단 - 슬래시/역슬래시/.. 는 파일명에 있을 이유가 없다.
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "잘못된 파일명입니다" });
  }
  const base = resolve(PHOTO_ORIGINAL_DIR);
  const filePath = resolve(join(PHOTO_ORIGINAL_DIR, filename));
  if (!filePath.startsWith(base + sep)) {
    return res.status(400).json({ error: "잘못된 경로입니다" });
  }
  if (!existsSync(filePath)) return res.status(404).json({ error: "찾을 수 없습니다" });
  res.set("Cache-Control", "public, max-age=31536000");
  res.sendFile(filePath);
});

app.patch("/api/photos/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);

  const photo = db.prepare(
    "SELECT ph.*, pl.user_id AS owner_id FROM photo ph JOIN play pl ON pl.id = ph.play_id WHERE ph.id = ?"
  ).get(id);
  if (!photo) return res.status(404).json({ error: "찾을 수 없습니다" });
  if (photo.owner_id !== userId) return res.status(403).json({ error: "본인 사진만 수정할 수 있습니다" });

  const updates = [];
  const params = [];
  if ("published" in (req.body || {})) { updates.push("published = ?"); params.push(req.body.published ? 1 : 0); }
  if ("caption" in (req.body || {})) { updates.push("caption = ?"); params.push(req.body.caption ?? null); }
  if (updates.length) {
    params.push(id);
    db.prepare(`UPDATE photo SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }
  invalidateFeedCache();

  const row = db.prepare("SELECT * FROM photo WHERE id = ?").get(id);
  res.json({ ...row, published: !!row.published });
});

app.delete("/api/photos/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);

  const photo = db.prepare(
    "SELECT ph.*, pl.user_id AS owner_id FROM photo ph JOIN play pl ON pl.id = ph.play_id WHERE ph.id = ?"
  ).get(id);
  if (!photo) return res.status(404).json({ error: "찾을 수 없습니다" });
  if (photo.owner_id !== userId) return res.status(403).json({ error: "본인 사진만 삭제할 수 있습니다" });

  db.prepare("DELETE FROM photo WHERE id = ?").run(id);
  try { unlinkSync(join(PHOTO_ORIGINAL_DIR, photo.filename)); } catch { /* 이미 없으면 무시 */ }
  invalidateFeedCache();
  res.json({ ok: true });
});

// ---------- 피드 ----------
// 이벤트(첫 플레이/N회 달성/최고·최저점 갱신)와 월간 결산은 저장하지 않고 조회 시 계산한다.
// 전체 플레이를 날짜순으로 한 번 훑으면 결정적으로 나오기 때문. 다만 1,906판 전체를 매 요청마다
// 훑으면 느리므로 결과를 메모리에 캐시하고, 플레이/사진이 바뀔 때만 무효화한다.
let feedCache = null; // { items: [...] } - 전체(필터 전) 피드 아이템, 최신순 정렬

function invalidateFeedCache() {
  feedCache = null;
}

const MILESTONES = [3, 10, 20, 50, 100];

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function nextMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function buildFeedItems() {
  const users = db.prepare("SELECT id, name FROM user").all();
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const playerAlias = loadAliasMap("player");

  const plays = db.prepare(`
    SELECT p.*, COALESCE(g.custom_name, g.name) AS game_name, g.categories AS game_categories
    FROM play p JOIN game g ON g.id = p.game_id
    ORDER BY p.played_at ASC, p.id ASC
  `).all();

  const photosByPlay = new Map();
  for (const row of db.prepare("SELECT * FROM photo ORDER BY id").all()) {
    if (!photosByPlay.has(row.play_id)) photosByPlay.set(row.play_id, []);
    photosByPlay.get(row.play_id).push({ ...row, published: !!row.published });
  }
  const playersByPlay = new Map();
  for (const row of db.prepare("SELECT * FROM play_player").all()) {
    if (!playersByPlay.has(row.play_id)) playersByPlay.set(row.play_id, []);
    playersByPlay.get(row.play_id).push(row);
  }

  const items = [];
  // 사용자·게임별 진행 상태: 판수, 1인/2인+ 각각의 최고·최저점
  const progress = new Map(); // key `${user_id}:${game_id}`
  // 월별 결산 집계
  const monthAgg = new Map(); // key YYYY-MM
  const globalFirstPlayMonth = new Map(); // game_id -> YYYY-MM (그 게임이 처음 기록된 달)

  function getMonthAgg(monthKey) {
    let a = monthAgg.get(monthKey);
    if (!a) {
      a = { totalPlays: 0, totalMinutes: 0, gameCounts: new Map(), newGames: [], bestUpdateCount: 0 };
      monthAgg.set(monthKey, a);
    }
    return a;
  }

  for (const play of plays) {
    const players = playersByPlay.get(play.id) || [];
    const photos = photosByPlay.get(play.id) || [];
    const comment = stripBgStatsTag(play.comment);
    const humanCount = players.filter((p) => !p.is_automa).length;
    const isSolo = humanCount <= 1;
    const monthKey = play.played_at.slice(0, 7);
    const author = userName.get(play.user_id) || "?";

    // 카드: 사진이나 코멘트가 있는 플레이만
    if (photos.length > 0 || (comment && comment.trim())) {
      items.push({
        type: "play",
        date: play.played_at,
        seq: play.id,
        userId: play.user_id,
        play: {
          id: play.id,
          user_id: play.user_id,
          author,
          game_id: play.game_id,
          game_name: play.game_name,
          categories: parseJsonArray(play.game_categories).slice(0, 2),
          played_at: play.played_at,
          duration_min: play.duration_min,
          location: play.location,
          comment,
          is_coop: !!play.is_coop,
          players: players.map((p) => ({ name: p.name, score: p.score, win: !!p.win, is_automa: !!p.is_automa })),
          photos,
        },
      });
    }

    // 월간 결산 집계
    const magg = getMonthAgg(monthKey);
    magg.totalPlays++;
    if (play.duration_min) magg.totalMinutes += play.duration_min;
    const gc = magg.gameCounts.get(play.game_id) || { name: play.game_name, count: 0 };
    gc.count++;
    magg.gameCounts.set(play.game_id, gc);
    if (!globalFirstPlayMonth.has(play.game_id)) {
      globalFirstPlayMonth.set(play.game_id, monthKey);
      magg.newGames.push(play.game_name);
    }

    // 이벤트 판정 (그 사용자 기준)
    const key = `${play.user_id}:${play.game_id}`;
    const prog = progress.get(key) || { count: 0, bestSolo: null, worstSolo: null, bestMulti: null, worstMulti: null };
    prog.count++;

    if (prog.count === 1) {
      items.push({
        type: "event", kind: "first", date: play.played_at, seq: play.id + 0.1,
        userId: play.user_id, author, game_id: play.game_id, game_name: play.game_name,
      });
    }
    if (MILESTONES.includes(prog.count)) {
      items.push({
        type: "event", kind: "milestone", count: prog.count, date: play.played_at, seq: play.id + 0.2,
        userId: play.user_id, author, game_id: play.game_id, game_name: play.game_name,
      });
    }

    // "나"의 점수: 기록 소유자 이름(별칭 적용)과 일치하는 참가자를 본인으로 본다
    const myCanonical = applyAlias(playerAlias, author);
    const myPlayer = players.find((p) => applyAlias(playerAlias, p.name) === myCanonical);
    const myScore = myPlayer && myPlayer.score != null ? myPlayer.score : null;

    if (myScore != null) {
      const bestKey = isSolo ? "bestSolo" : "bestMulti";
      const worstKey = isSolo ? "worstSolo" : "worstMulti";
      if (prog[bestKey] != null && myScore > prog[bestKey]) {
        items.push({
          type: "event", kind: "best", date: play.played_at, seq: play.id + 0.3,
          userId: play.user_id, author, game_id: play.game_id, game_name: play.game_name,
          score: myScore, solo: isSolo,
        });
        magg.bestUpdateCount++;
      }
      if (prog[worstKey] != null && myScore < prog[worstKey]) {
        items.push({
          type: "event", kind: "worst", date: play.played_at, seq: play.id + 0.4,
          userId: play.user_id, author, game_id: play.game_id, game_name: play.game_name,
          score: myScore, solo: isSolo,
        });
      }
      if (prog[bestKey] == null || myScore > prog[bestKey]) prog[bestKey] = myScore;
      if (prog[worstKey] == null || myScore < prog[worstKey]) prog[worstKey] = myScore;
    }

    progress.set(key, prog);
  }

  // 월간 결산 카드 - 이미 끝난 달만(진행 중인 이번 달은 아직 결산할 수 없다), 다음 달 1일자로 삽입
  const curMonth = currentMonthKey();
  for (const [monthKey, agg] of monthAgg) {
    if (monthKey >= curMonth) continue;
    const topGames = [...agg.gameCounts.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    const [y, m] = monthKey.split("-").map(Number);
    items.push({
      type: "month",
      date: `${nextMonthKey(monthKey)}-01`,
      seq: -1,
      month: monthKey,
      year: y,
      monthNum: m,
      totalPlays: agg.totalPlays,
      newGames: agg.newGames,
      newGameCount: agg.newGames.length,
      topGames,
      bestUpdateCount: agg.bestUpdateCount,
      totalMinutes: agg.totalMinutes,
    });
  }

  items.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.seq - a.seq;
  });

  return items;
}

function getFeedCache() {
  if (!feedCache) feedCache = { items: buildFeedItems() };
  return feedCache;
}

app.get("/api/feed", (req, res) => {
  const requesterId = currentUserId(req);
  const { author, filter, limit, offset, game_id, category } = req.query;

  const lim = Math.min(Number(limit) || 20, 100);
  const off = Number(offset) || 0;

  const authorId = author ? Number(author) : null;
  const gameIdFilter = game_id ? Number(game_id) : null;
  let items = getFeedCache().items;

  items = items.filter((it) => {
    if (authorId && (it.type === "play" || it.type === "event") && it.userId !== authorId) return false;
    // 태그(게임/카테고리) 탭 필터 - 월간 결산은 특정 게임에 속하지 않으므로 제외한다.
    if (gameIdFilter) {
      if (it.type === "month") return false;
      if (it.game_id !== gameIdFilter && it.play?.game_id !== gameIdFilter) return false;
    }
    if (category) {
      if (it.type !== "play") return false;
      if (!it.play.categories.includes(category)) return false;
    }
    if (filter === "photo") {
      return it.type === "play" && it.play.photos.length > 0;
    }
    if (filter === "event") {
      return it.type === "event" || it.type === "month";
    }
    return true;
  });

  const page = items.slice(off, off + lim).map((it) => {
    if (it.type === "play") {
      return { ...it, own: requesterId != null && it.userId === requesterId };
    }
    return it;
  });

  res.json({ items: page, hasMore: off + lim < items.length, total: items.length });
});

// ---------- insights (요청 사용자 기준) ----------

app.get("/api/insights", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const { from, to, player, location, player_count } = req.query;

  // player, location, player_count 필터는 play_player/play 조인이 필요해서
  // 먼저 조건에 맞는 play id 목록을 뽑아두고 이후 통계는 전부 이 집합 기준으로 계산한다.
  const clauses = ["p.user_id = ?"];
  const params = [userId];
  if (from) { clauses.push("p.played_at >= ?"); params.push(from); }
  if (to) { clauses.push("p.played_at <= ?"); params.push(to); }
  if (location) { clauses.push("p.location = ?"); params.push(location); }
  if (player) {
    clauses.push("EXISTS (SELECT 1 FROM play_player pp WHERE pp.play_id = p.id AND pp.name = ?)");
    params.push(player);
  }
  if (player_count) {
    clauses.push("(SELECT COUNT(*) FROM play_player pp WHERE pp.play_id = p.id) = ?");
    params.push(Number(player_count));
  }
  const where = clauses.join(" AND ");

  const plays = db.prepare(`
    SELECT p.id, p.game_id, p.played_at, p.duration_min, p.location,
           COALESCE(g.custom_name, g.name) AS game_name
    FROM play p JOIN game g ON g.id = p.game_id
    WHERE ${where}
    ORDER BY p.played_at ASC, COALESCE(p.bgg_play_id, p.id) ASC
  `).all(...params);

  const playerAlias = loadAliasMap("player");
  const locationAlias = loadAliasMap("location");

  const playIds = plays.map((p) => p.id);

  const totalPlays = plays.length;
  const distinctGames = new Set(plays.map((p) => p.game_id)).size;
  const totalMinutes = plays.reduce((sum, p) => sum + (p.duration_min || 0), 0);

  // 최다 플레이 게임 TOP N
  const gameCounts = new Map();
  for (const p of plays) {
    const key = p.game_id;
    const cur = gameCounts.get(key) || { game_id: key, game_name: p.game_name, count: 0 };
    cur.count++;
    gameCounts.set(key, cur);
  }
  const topGames = [...gameCounts.values()].sort((a, b) => b.count - a.count);

  // 플레이어별 승률: 이 사용자가 기록한 판들의 play_player 기준
  const playerStats = new Map();
  if (playIds.length) {
    const placeholders = playIds.map(() => "?").join(",");
    const pps = db.prepare(
      `SELECT play_id, name, win FROM play_player WHERE play_id IN (${placeholders})`
    ).all(...playIds);
    for (const pp of pps) {
      const name = applyAlias(playerAlias, pp.name);
      const cur = playerStats.get(name) || { name, plays: 0, wins: 0 };
      cur.plays++;
      if (pp.win) cur.wins++;
      playerStats.set(name, cur);
    }
  }
  const winRates = [...playerStats.values()]
    .map((s) => ({ ...s, winRate: s.plays ? s.wins / s.plays : 0 }))
    .sort((a, b) => b.plays - a.plays);

  // 월별 플레이 수
  const monthly = new Map();
  for (const p of plays) {
    const month = p.played_at.slice(0, 7); // YYYY-MM
    monthly.set(month, (monthly.get(month) || 0) + 1);
  }
  const monthlyPlays = [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ month, count }));

  // 장소별 분포
  const locationCounts = new Map();
  for (const p of plays) {
    const loc = p.location ? applyAlias(locationAlias, p.location) : "(미기록)";
    locationCounts.set(loc, (locationCounts.get(loc) || 0) + 1);
  }
  const byLocation = [...locationCounts.entries()].sort(([, a], [, b]) => b - a)
    .map(([location, count]) => ({ location, count }));

  // H-index: x판 이상 플레이한 게임이 x개 이상인 최대 x
  const counts = topGames.map((g) => g.count).sort((a, b) => b - a);
  let hIndex = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] >= i + 1) hIndex = i + 1;
    else break;
  }

  // 달성 레벨: N판 이상 플레이한 게임 수
  const levels = { fives: 0, dimes: 0, quarters: 0, centuries: 0, thousands: 0 };
  for (const c of counts) {
    if (c >= 5) levels.fives++;
    if (c >= 10) levels.dimes++;
    if (c >= 25) levels.quarters++;
    if (c >= 100) levels.centuries++;
    if (c >= 1000) levels.thousands++;
  }

  // 최다 연승: 날짜순(이미 정렬됨)으로 이 사용자가 win인 연속 판. 승패가 안 갈리는(누구도 win 아닌) 판은 건너뛴다.
  let curStreak = 0, bestStreak = 0;
  if (playIds.length) {
    const placeholders = playIds.map(() => "?").join(",");
    // 이 사용자 본인의 행만 봐야 한다. MAX(win)으로 뭉뚱그리면 "누군가 이긴 판"이 전부
    // 본인 승리로 잡혀 연승이 터무니없이 길어진다.
    const myWins = new Map(
      db.prepare(`
        SELECT pp.play_id, MAX(pp.win) AS won
        FROM play_player pp
        WHERE pp.play_id IN (${placeholders})
          AND pp.name = (SELECT name FROM user WHERE id = ?)
        GROUP BY pp.play_id
      `).all(...playIds, userId).map((r) => [r.play_id, r.won])
    );
    for (const p of plays) {
      const won = myWins.get(p.id);
      if (won === undefined) continue;
      if (won) {
        curStreak++;
        bestStreak = Math.max(bestStreak, curStreak);
      } else {
        curStreak = 0;
      }
    }
  }

  // 안 해본 보유 게임: collection.status='보유'인데 이 사용자 플레이 0건
  const ownedNotPlayed = db.prepare(`
    SELECT DISTINCT g.id, COALESCE(g.custom_name, g.name) AS name
    FROM collection c
    JOIN game g ON g.id = c.game_id
    WHERE c.status = '보유'
      AND NOT EXISTS (SELECT 1 FROM play p WHERE p.game_id = g.id AND p.user_id = ?)
    ORDER BY COALESCE(g.custom_name, g.name)
  `).all(userId);

  // 판당 비용: collection.price_paid를 이 사용자의 해당 게임 플레이 수로 나눈다
  const priceRows = db.prepare(`
    SELECT c.game_id, COALESCE(g.custom_name, g.name) AS game_name, SUM(c.price_paid) AS total_paid
    FROM collection c
    JOIN game g ON g.id = c.game_id
    WHERE c.price_paid IS NOT NULL
    GROUP BY c.game_id
    HAVING SUM(c.price_paid) > 0
  `).all();
  const costPerPlay = priceRows.map((r) => {
    const plays = gameCounts.get(r.game_id)?.count || 0;
    return {
      game_id: r.game_id,
      game_name: r.game_name,
      total_paid: r.total_paid,
      plays,
      costPerPlay: plays ? r.total_paid / plays : null,
    };
  }).filter((r) => r.costPerPlay != null);
  const cheapest = [...costPerPlay].sort((a, b) => a.costPerPlay - b.costPerPlay);
  const priciest = [...costPerPlay].sort((a, b) => b.costPerPlay - a.costPerPlay);

  // 지출 요약: 컬렉션 전체(취득 이력 전부) 합계 - 공유 값이라 사용자 필터와 무관하다.
  const spendingRow = db.prepare(
    "SELECT COALESCE(SUM(price_paid), 0) AS totalPaid, COALESCE(SUM(price_sold), 0) AS totalSold FROM collection"
  ).get();
  const spending = {
    totalPaid: spendingRow.totalPaid,
    totalSold: spendingRow.totalSold,
    net: spendingRow.totalPaid - spendingRow.totalSold,
  };

  res.json({
    totalPlays,
    distinctGames,
    totalMinutes,
    topGames,
    winRates,
    monthlyPlays,
    byLocation,
    hIndex,
    levels,
    bestStreak,
    ownedNotPlayed,
    costPerPlay: { cheapest, priciest },
    spending,
  });
});

// ---------- 이름 정리 (플레이어/장소 별칭) ----------

// 설정 화면에서 "현재 이렇게 기록되고 있다"를 보여주기 위한 원본 이름 + 판수 목록.
// 원본 데이터는 건드리지 않으므로 여기 나오는 값은 항상 실제 저장된 값 그대로다.
app.get("/api/names", (req, res) => {
  const kind = req.query.kind;
  if (kind !== "player" && kind !== "location") {
    return res.status(400).json({ error: "kind는 player 또는 location이어야 합니다" });
  }
  const rows = kind === "player"
    ? db.prepare("SELECT name, COUNT(*) AS count FROM play_player GROUP BY name ORDER BY count DESC").all()
    : db.prepare(
        "SELECT location AS name, COUNT(*) AS count FROM play WHERE location IS NOT NULL GROUP BY location ORDER BY count DESC"
      ).all();

  const aliasRows = db.prepare("SELECT alias, canonical FROM name_alias WHERE kind = ?").all(kind);
  const aliasMap = new Map(aliasRows.map((r) => [r.alias, r.canonical]));

  res.json(rows.map((r) => ({ ...r, canonical: aliasMap.get(r.name) || null })));
});

app.get("/api/aliases", (req, res) => {
  const { kind } = req.query;
  const rows = kind
    ? db.prepare("SELECT * FROM name_alias WHERE kind = ? ORDER BY canonical, alias").all(kind)
    : db.prepare("SELECT * FROM name_alias ORDER BY kind, canonical, alias").all();
  res.json(rows);
});

app.post("/api/aliases", (req, res) => {
  const { kind, alias, canonical } = req.body || {};
  if (kind !== "player" && kind !== "location") {
    return res.status(400).json({ error: "kind는 player 또는 location이어야 합니다" });
  }
  if (!alias || !canonical) return res.status(400).json({ error: "alias, canonical이 필요합니다" });
  if (alias === canonical) return res.status(400).json({ error: "alias와 canonical이 같을 수 없습니다" });

  db.prepare(`
    INSERT INTO name_alias (kind, alias, canonical) VALUES (?, ?, ?)
    ON CONFLICT(kind, alias) DO UPDATE SET canonical = excluded.canonical
  `).run(kind, alias, canonical);

  const row = db.prepare("SELECT * FROM name_alias WHERE kind = ? AND alias = ?").get(kind, alias);
  res.status(201).json(row);
});

app.delete("/api/aliases/:id", (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("DELETE FROM name_alias WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "찾을 수 없습니다" });
  res.json({ ok: true });
});

// ---------- 이미지 디스크 캐시 프록시 ----------

// 허용 호스트를 BGG 이미지 CDN 하나로 제한한다. 임의 URL을 받아 서버가 아무 데나
// 요청하게 두면 SSRF로 이어질 수 있어서다.
const ALLOWED_IMAGE_HOSTS = new Set(["cf.geekdo-images.com"]);

app.get("/api/image", async (req, res) => {
  const src = req.query.url;
  if (!src || typeof src !== "string") return res.status(400).json({ error: "url이 필요합니다" });

  let parsed;
  try {
    parsed = new URL(src);
  } catch {
    return res.status(400).json({ error: "잘못된 URL입니다" });
  }
  if (!ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) {
    return res.status(400).json({ error: "허용되지 않은 이미지 호스트입니다" });
  }

  const hash = createHash("sha256").update(src).digest("hex");
  const ext = extname(parsed.pathname) || ".img";
  const filePath = resolve(join(IMAGE_CACHE_DIR, hash + ext));

  try {
    if (!existsSync(filePath)) {
      const resp = await fetch(src, {
        headers: { "User-Agent": "bgg-collection-manager/0.1 (personal use; image cache)" },
      });
      if (!resp.ok) return res.status(resp.status).json({ error: "원본 이미지를 가져오지 못했습니다" });
      writeFileSync(filePath, Buffer.from(await resp.arrayBuffer()));
    }
    res.set("Cache-Control", "public, max-age=31536000");
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- BGG 검색 프록시 ----------

function decodeXmlEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function parseSearchXml(xml) {
  const items = [];
  const itemRe = /<item\s+type="boardgame"\s+id="(\d+)"[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const [, id, body] = m;
    const nameMatch = body.match(/<name[^>]*value="([^"]*)"[^>]*\/?>/);
    const yearMatch = body.match(/<yearpublished[^>]*value="([^"]*)"/);
    items.push({
      id: Number(id),
      name: nameMatch ? decodeXmlEntities(nameMatch[1]) : "",
      yearPublished: yearMatch ? Number(yearMatch[1]) : null,
    });
  }
  return items;
}

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q가 필요합니다" });

  try {
    const url = `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(q)}&type=boardgame`;
    const headers = {};
    if (BGG_API_KEY) headers.Authorization = `Bearer ${BGG_API_KEY}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: `BGG 요청 실패: ${resp.status}` });
    }
    const xml = await resp.text();
    const items = parseSearchXml(xml);

    const collectionIds = new Set(
      db.prepare("SELECT DISTINCT game_id FROM collection").all().map((r) => r.game_id));
    res.json(items.map((it) => ({ ...it, inCollection: collectionIds.has(it.id) })));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- BGG 동기화 ----------

// 동시 실행 방지용 상태. running 중엔 /api/sync가 409를 반환한다.
// lastSuccessAt: 마지막 "성공" 동기화 시각만 따로 둔다 - 하루 1회 제한은 성공 기준이어야
// 실패가 반복돼도 계속 재시도할 수 있다(BGG는 "하루 1회"를 요청했지 "하루 1회 시도"가 아니다).
const syncState = { running: false, lastRunAt: null, lastSuccessAt: null, lastResult: null, lastError: null };

async function runSyncSafe() {
  syncState.running = true;
  try {
    const result = await runSync(db, BGG_API_KEY);
    syncState.lastRunAt = new Date().toISOString();
    syncState.lastSuccessAt = syncState.lastRunAt;
    syncState.lastResult = result;
    syncState.lastError = null;
    return result;
  } catch (err) {
    syncState.lastRunAt = new Date().toISOString();
    syncState.lastError = String(err.message || err);
    throw err;
  } finally {
    syncState.running = false;
  }
}

// BGG 신고 조건이 "하루 1회"라 서버가 스스로 지킨다. force=1은 설정 화면 "지금 동기화"
// 버튼에서 사용자가 확인 다이얼로그를 거친 뒤에만 붙는다.
app.post("/api/sync", async (req, res) => {
  if (syncState.running) {
    return res.status(409).json({ error: "이미 동기화가 진행 중입니다" });
  }
  const force = req.query.force === "1";
  if (!force && syncState.lastSuccessAt) {
    const elapsedMs = Date.now() - new Date(syncState.lastSuccessAt).getTime();
    const remainingMs = SYNC_INTERVAL_MS - elapsedMs;
    if (remainingMs > 0) {
      return res.status(429).json({
        error: "오늘 이미 동기화했습니다",
        remainingMs,
        lastSuccessAt: syncState.lastSuccessAt,
      });
    }
  }
  try {
    const result = await runSyncSafe();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/sync/status", (req, res) => {
  res.json(syncState);
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});

// 하루 한 번 자동 동기화. NAS에 파이썬을 두지 않기 위해 서버가 직접 스케줄을 갖는다.
if (BGG_API_KEY) {
  setInterval(() => {
    if (syncState.running) return;
    runSyncSafe().catch((err) => console.error("자동 동기화 실패:", err));
  }, SYNC_INTERVAL_MS);

  if (process.env.SYNC_ON_START === "1") {
    runSyncSafe().catch((err) => console.error("시작 시 동기화 실패:", err));
  }
} else {
  console.log("BGG_API_KEY가 없어 자동 동기화 스케줄을 등록하지 않습니다.");
}
