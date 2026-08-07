import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { openDb } from "./db.js";
import { fetchVersions, fetchThings } from "./bgg.js";
import { upsertGames } from "./import-bgg.js";
import { runCleanup } from "./cleanup.js";
import { translateToKorean } from "./translate.js";
import { login as bgaLogin, fetchAllPlays as bgaFetchAllPlays, fetchGameMap as bgaFetchGameMap } from "./bga.js";

const DB_PATH = process.env.DB_PATH || "data/app.db";
const PORT = process.env.PORT || 3001;
const BGG_API_KEY = process.env.BGG_API_KEY;

// 이미지 디스크 캐시. BGG를 매번 핫링크하지 않기 위한 프록시 저장 위치.
const IMAGE_CACHE_DIR = process.env.IMAGE_CACHE_DIR || "data/cache/images";
// 사용자 업로드 사진 저장 경로. 나중에 도커 볼륨을 따로 붙일 수 있게 상수만 빼둔다 (업로드 기능은 이번 범위 아님).
const PHOTO_DIR = process.env.PHOTO_DIR || "data/photos";
// 원본은 그대로 보관 (리사이즈는 외부 발행 때 처리 - 이번 범위 아님)
const PHOTO_ORIGINAL_DIR = join(PHOTO_DIR, "original");
// 승자 프로필 사진. 플레이 사진과 같은 raw-body 업로드 방식을 쓰되 폴더만 분리한다.
const AVATAR_DIR = join(PHOTO_DIR, "avatars");
const ALLOWED_PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
mkdirSync(PHOTO_ORIGINAL_DIR, { recursive: true });
mkdirSync(AVATAR_DIR, { recursive: true });

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
  const rows = db.prepare("SELECT id, name, bgg_username, bga_username, avatar, default_location FROM user").all();
  res.json(rows);
});

// 대표 장소만 수정한다 - 새 기록 화면에서 "대표로 지정"을 누르면 호출된다.
app.patch("/api/users/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!("default_location" in (req.body || {}))) {
    return res.status(400).json({ error: "default_location이 필요합니다" });
  }
  let loc = req.body.default_location;
  if (typeof loc === "string") loc = loc.trim();
  if (!loc) loc = null;

  const existing = db.prepare("SELECT id FROM user WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "사용자를 찾을 수 없습니다" });

  db.prepare("UPDATE user SET default_location = ? WHERE id = ?").run(loc, id);
  const row = db.prepare("SELECT id, name, bgg_username, bga_username, avatar, default_location FROM user WHERE id = ?").get(id);
  res.json(row);
});

// 승자 프로필 사진 업로드. /api/plays/:id/photos와 동일하게 raw body + X-Filename 헤더 방식.
app.post("/api/users/:id/avatar", express.raw({ type: () => true, limit: "20mb" }), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT * FROM user WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "찾을 수 없습니다" });

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

  const filename = `u${id}_${Date.now()}_${randomBytes(4).toString("hex")}${ext}`;
  writeFileSync(join(AVATAR_DIR, filename), req.body);
  db.prepare("UPDATE user SET avatar = ? WHERE id = ?").run(filename, id);

  const row = db.prepare("SELECT id, name, bgg_username, bga_username, avatar FROM user WHERE id = ?").get(id);
  res.status(201).json(row);
});

app.get("/api/avatars/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "잘못된 파일명입니다" });
  }
  const base = resolve(AVATAR_DIR);
  const filePath = resolve(join(AVATAR_DIR, filename));
  if (!filePath.startsWith(base + sep)) {
    return res.status(400).json({ error: "잘못된 경로입니다" });
  }
  if (!existsSync(filePath)) return res.status(404).json({ error: "찾을 수 없습니다" });
  res.set("Cache-Control", "public, max-age=31536000");
  res.sendFile(filePath);
});

// ---------- games ----------

app.get("/api/games", (req, res) => {
  const q = (req.query.q || "").trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  // 이 엔드포인트는 검색 드롭다운·목록용이다. SELECT *로 내리면 description(게임당 ~1.2KB)과
  // description_ko까지 실려 20건에 53KB가 나갔다. 목록에 필요한 컬럼만 고른다.
  // 상세 화면은 /api/games/:id가 따로 전부 내려준다.
  // aliases는 검색 조건(WHERE ... aliases LIKE)으로만 쓰고 응답에는 싣지 않는다.
  // 게임당 별칭이 10개 넘는 것도 있어 목록에서는 순수한 무게다. 상세(/api/games/:id)에는 들어간다.
  const LIST_COLS = `
    id, name_en, custom_name, custom_image, year_published,
    min_players, max_players, playing_time, weight, bgg_rating, bgg_rank,
    item_type, synced_at,
    COALESCE(custom_name, name) AS name,
    COALESCE(custom_image, thumbnail) AS thumbnail,
    COALESCE(custom_image, image) AS image
  `;

  let rows;
  if (q) {
    // aliases는 JSON 배열을 문자열째로 저장하므로 LIKE로 부분 일치만 확인해도 충분하다.
    // custom_name도 검색 대상에 포함해야 사용자가 지정한 한글 이름으로도 찾을 수 있다.
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT ${LIST_COLS}
      FROM game
      WHERE name LIKE ? OR name_en LIKE ? OR aliases LIKE ? OR custom_name LIKE ?
      ORDER BY COALESCE(custom_name, name)
      LIMIT ? OFFSET ?
    `).all(like, like, like, like, limit, offset);
  } else {
    rows = db.prepare(`
      SELECT ${LIST_COLS}
      FROM game
      ORDER BY COALESCE(custom_name, name) LIMIT ? OFFSET ?
    `).all(limit, offset);
  }
  res.json(rows);
});

app.get("/api/games/:id", (req, res) => {
  const id = Number(req.params.id);
  // name은 표시용(custom_name 우선), original_name은 BGG에서 온 원래 이름 - 편집 UI에서 같이 보여준다.
  const game = db.prepare(`
    SELECT *, name AS original_name, COALESCE(custom_name, name) AS name,
           COALESCE(custom_image, thumbnail) AS thumbnail, COALESCE(custom_image, image) AS image
    FROM game WHERE id = ?
  `).get(id);
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
    publishers: parseJsonArray(game.publishers),
    sub_ranks: parseJsonArray(game.sub_ranks),
    collectionHistory,
    playCount,
    my_rating: myRating,
    stats,
  });
});

// 앱에서 별점을 직접 매긴다(0.5 단위). rating_source='app'으로 표시해서 BGG 동기화가
// 이 값을 덮어쓰지 않게 한다(sync.js의 syncUserGameFlags 참고). rating=null이면 삭제.
app.patch("/api/games/:id/rating", (req, res) => {
  const gameId = Number(req.params.id);
  const userId = requireUser(req, res);
  if (!userId) return;

  const game = db.prepare("SELECT id FROM game WHERE id = ?").get(gameId);
  if (!game) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });

  const { rating } = req.body || {};
  if (rating !== null && (typeof rating !== "number" || rating < 0 || rating > 10)) {
    return res.status(400).json({ error: "rating은 0~10 사이 숫자이거나 null이어야 합니다" });
  }

  if (rating === null) {
    db.prepare(
      "UPDATE game_rating SET rating = NULL, rating_source = NULL WHERE user_id = ? AND game_id = ?"
    ).run(userId, gameId);
  } else {
    db.prepare(`
      INSERT INTO game_rating (user_id, game_id, rating, rating_source) VALUES (?, ?, ?, 'app')
      ON CONFLICT(user_id, game_id) DO UPDATE SET rating = excluded.rating, rating_source = 'app'
    `).run(userId, gameId, rating);
  }

  const row = db.prepare("SELECT rating FROM game_rating WHERE user_id = ? AND game_id = ?").get(userId, gameId);
  res.json({ my_rating: row ? row.rating : null });
});

// 플레이 희망은 평점과 마찬가지로 사람마다 다른 값이라 game_rating(사용자별)에 있다.
// 컬렉션 표에서 바로 켜고 끌 수 있어야 해서 별도 라우트로 뺐다.
app.patch("/api/games/:id/want-to-play", (req, res) => {
  const gameId = Number(req.params.id);
  const userId = requireUser(req, res);
  if (!userId) return;

  const game = db.prepare("SELECT id FROM game WHERE id = ?").get(gameId);
  if (!game) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });

  const { want_to_play } = req.body || {};
  if (typeof want_to_play !== "boolean") {
    return res.status(400).json({ error: "want_to_play는 true/false여야 합니다" });
  }

  db.prepare(`
    INSERT INTO game_rating (user_id, game_id, want_to_play) VALUES (?, ?, ?)
    ON CONFLICT(user_id, game_id) DO UPDATE SET want_to_play = excluded.want_to_play
  `).run(userId, gameId, want_to_play ? 1 : 0);

  const row = db.prepare(
    "SELECT want_to_play FROM game_rating WHERE user_id = ? AND game_id = ?"
  ).get(userId, gameId);
  res.json({ want_to_play: row ? row.want_to_play : 0 });
});

// 번역은 translate.js로 분리했다 - 일괄 채우기 스크립트와 같은 코드를 쓰기 위해서다.
// 설명 번역. 캐시(description_ko)가 있으면 재번역하지 않는다.
// 실패하면 하루 동안 재시도하지 않는다. 무료 번역 API가 며칠씩 막혀 있는 동안
// 미번역 게임 상세를 열 때마다 외부 요청을 다시 때리면 매번 느리고 429만 쌓인다.
const TRANSLATE_RETRY_MS = 24 * 60 * 60 * 1000;

app.post("/api/games/:id/translate", async (req, res) => {
  const id = Number(req.params.id);
  const game = db.prepare("SELECT id, description, description_ko, translate_failed_at FROM game WHERE id = ?").get(id);
  if (!game) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });
  if (game.description_ko) return res.json({ description_ko: game.description_ko });
  if (!game.description) return res.status(400).json({ error: "번역할 원문 설명이 없습니다" });

  if (game.translate_failed_at && Date.now() - new Date(game.translate_failed_at).getTime() < TRANSLATE_RETRY_MS) {
    return res.status(503).json({ error: "최근 번역에 실패해 잠시 쉬는 중입니다" });
  }

  try {
    const ko = await translateToKorean(game.description);
    db.prepare("UPDATE game SET description_ko = ?, translate_failed_at = NULL WHERE id = ?").run(ko, id);
    res.json({ description_ko: ko });
  } catch (err) {
    db.prepare("UPDATE game SET translate_failed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
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
      playCount: 0, winRate: null, avgDurationMin: null, firstPlayedAt: null, lastPlayedAt: null,
      score: { solo: null, multi: null }, winRateSplit: { solo: null, multi: null }, opponents: [],
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

  // 새 기록 화면 미리보기용: 점수 유무와 무관하게 1인/2인+ 승률만 따로 뽑는다
  // (점수 기록이 없는 게임도 승률은 보여줘야 해서 score 버킷과 별도로 낸다).
  let soloWins = 0, soloPlays = 0, multiWins = 0, multiPlays = 0;
  for (const [playId, win] of myWinByPlay) {
    if (isSoloPlay(playId)) { soloPlays++; if (win) soloWins++; }
    else { multiPlays++; if (win) multiWins++; }
  }
  const winRateSplit = {
    solo: soloPlays ? { rate: Math.round((soloWins / soloPlays) * 100), plays: soloPlays } : null,
    multi: multiPlays ? { rate: Math.round((multiWins / multiPlays) * 100), plays: multiPlays } : null,
  };

  const durations = playRows.map((p) => p.duration_min).filter((n) => n != null && n > 0);
  const avgDurationMin = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  const lastPlayedAt = playRows.reduce((max, p) => (p.played_at > max ? p.played_at : max), playRows[0].played_at);
  const firstPlayedAt = playRows.reduce((min, p) => (p.played_at < min ? p.played_at : min), playRows[0].played_at);

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
    firstPlayedAt,
    lastPlayedAt,
    score,
    winRateSplit,
    opponents,
  };
}

// custom_name/coop_default/win_condition/custom_image 중 보낸 필드만 수정한다.
// custom_name이 빈 문자열이면 NULL로 되돌려 원래(BGG) 이름으로 복귀시킨다.
// custom_image도 마찬가지로 null/빈 문자열이면 "기본으로 되돌리기" - BGG 원본 이미지로 복귀.
app.patch("/api/games/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM game WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });
  const body = req.body || {};
  const hasCustomName = "custom_name" in body;
  const hasCoopDefault = "coop_default" in body;
  const hasWinCondition = "win_condition" in body;
  const hasCustomImage = "custom_image" in body;
  if (!hasCustomName && !hasCoopDefault && !hasWinCondition && !hasCustomImage) {
    return res.status(400).json({ error: "custom_name, coop_default, win_condition, custom_image 중 하나가 필요합니다" });
  }

  if (hasCustomName) {
    let customName = body.custom_name;
    if (typeof customName === "string") customName = customName.trim();
    if (!customName) customName = null;
    db.prepare("UPDATE game SET custom_name = ? WHERE id = ?").run(customName, id);
  }
  if (hasCoopDefault) {
    db.prepare("UPDATE game SET coop_default = ? WHERE id = ?").run(body.coop_default ? 1 : 0, id);
  }
  if (hasWinCondition) {
    const wc = ["high", "low", "none"].includes(body.win_condition) ? body.win_condition : "high";
    db.prepare("UPDATE game SET win_condition = ? WHERE id = ?").run(wc, id);
  }
  if (hasCustomImage) {
    let customImage = body.custom_image;
    if (typeof customImage === "string") customImage = customImage.trim();
    if (!customImage) customImage = null;
    db.prepare("UPDATE game SET custom_image = ? WHERE id = ?").run(customImage, id);
  }

  const row = db.prepare(`
    SELECT *, name AS original_name, COALESCE(custom_name, name) AS name,
           COALESCE(custom_image, thumbnail) AS thumbnail, COALESCE(custom_image, image) AS image
    FROM game WHERE id = ?
  `).get(id);
  res.json({ ...row, aliases: parseJsonArray(row.aliases) });
});

// BGG 다른 버전(언어판 등) 이미지 목록 - 대체 이미지 선택 모달용.
// 같은 게임을 반복 호출하지 않게 메모리 캐시만으로 충분(재시작하면 비워짐, 서버 재기동이 잦지 않다).
const versionsCache = new Map(); // gameId -> versions[]

app.get("/api/games/:id/versions", async (req, res) => {
  const id = Number(req.params.id);
  const game = db.prepare("SELECT id FROM game WHERE id = ?").get(id);
  if (!game) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });

  if (versionsCache.has(id)) return res.json(versionsCache.get(id));

  try {
    const versions = await fetchVersions(id, BGG_API_KEY);
    versionsCache.set(id, versions);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- 점수 시트 템플릿 (게임에 속한 공유 값) ----------

app.get("/api/games/:id/score-template", (req, res) => {
  const gameId = Number(req.params.id);
  const row = db.prepare("SELECT * FROM score_template WHERE game_id = ?").get(gameId);
  if (!row) return res.json(null);
  res.json({ ...row, fields: parseJsonArray(row.fields) });
});

app.put("/api/games/:id/score-template", (req, res) => {
  const gameId = Number(req.params.id);
  const game = db.prepare("SELECT id FROM game WHERE id = ?").get(gameId);
  if (!game) return res.status(400).json({ error: "존재하지 않는 game_id입니다" });

  const fields = req.body?.fields;
  if (!Array.isArray(fields) || fields.length === 0 || fields.some((f) => typeof f !== "string" || !f.trim())) {
    return res.status(400).json({ error: "fields는 비어있지 않은 문자열 배열이어야 합니다" });
  }

  db.prepare(`
    INSERT INTO score_template (game_id, fields, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(game_id) DO UPDATE SET fields = excluded.fields, updated_at = excluded.updated_at
  `).run(gameId, JSON.stringify(fields.map((f) => f.trim())));

  const row = db.prepare("SELECT * FROM score_template WHERE game_id = ?").get(gameId);
  res.json({ ...row, fields: parseJsonArray(row.fields) });
});

app.delete("/api/games/:id/score-template", (req, res) => {
  const gameId = Number(req.params.id);
  db.prepare("DELETE FROM score_template WHERE game_id = ?").run(gameId);
  res.json({ ok: true });
});

// ---------- collection (공유) ----------

// 화면에 보일 때 "가장 현재에 가까운" 상태 하나만 고르는 우선순위. 취득 이력 전체는 게임 상세에서만 본다.
const STATUS_PRIORITY = ["보유", "선주문", "위시리스트", "방출 예정", "방출 완료"];

app.get("/api/collection", (req, res) => {
  const { status, tag, include_expansions } = req.query;
  const userId = currentUserId(req);

  // 취득 이력(팔았다 다시 사기도 함)을 전부 가져온 뒤 게임당 대표 행 하나로 줄인다.
  // c.want_to_play(공유 테이블)는 더 이상 쓰지 않는다 - 아래 gr.want_to_play(사용자별)로 덮어써서 무시한다.
  const rows = db.prepare(`
    SELECT c.*, COALESCE(g.custom_name, g.name) AS game_name, g.name_en AS game_name_en,
           COALESCE(g.custom_image, g.thumbnail, g.image) AS thumbnail,
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
           COALESCE(g.custom_image, g.thumbnail, g.image) AS thumbnail,
           g.year_published, g.min_players, g.max_players, g.playing_time,
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

// 컬렉션 전체에서 이미 쓰인 용도 태그와 사용 횟수. 태그 입력란 아래 칩 제안에 쓴다.
app.get("/api/tags", (req, res) => {
  const rows = db.prepare("SELECT tags FROM collection WHERE tags IS NOT NULL").all();
  const counts = new Map();
  for (const r of rows) {
    for (const t of parseJsonArray(r.tags)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
  res.json(tags);
});

// ---------- plays (계정별) ----------

function parseJsonObject(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function loadPlayers(playId) {
  return db.prepare("SELECT * FROM play_player WHERE play_id = ?").all(playId)
    .map((p) => ({ ...p, score_breakdown: parseJsonObject(p.score_breakdown) }));
}

function loadPhotos(playId) {
  return db.prepare("SELECT * FROM photo WHERE play_id = ? ORDER BY id").all(playId)
    .map((p) => ({ ...p, published: !!p.published }));
}

// 기록 입력에서 장소를 자유 입력 대신 목록에서 고르게 하기 위한 엔드포인트.
// name_alias(location)를 적용해 표기가 갈린 이름(Home/Home2/H. 등)을 합친 뒤 사용 횟수와 함께 반환한다.
// 장소는 계정별로 따로 관리한다. 두 사람이 가는 곳이 다르고(ㅇ은 Home/BGA, ㅃ는 B.),
// 섞어 보여주면 남의 장소가 내 선택지에 끼어든다. 플레이 기록이 계정별인 것과 같은 이유다.
// 온라인 장소는 판당 비용에서 뺀다 - 내 실물 제품으로 논 게 아니라서 그 판까지 나누면
// 값이 실제보다 싸게 나온다. 아래는 설정을 따로 안 건드렸을 때의 기본값이고,
// 사용자가 장소 관리에서 켜고 끄면 location_pref가 우선한다.
const DEFAULT_ONLINE_LOCATIONS = new Set(["BGA", "BoardGameArena", "TTS", "App"]);

// 이 계정의 "이 장소는 온라인인가" 판정기. pref에 값이 있으면 그걸, 없으면 기본값을 쓴다.
function onlineLocationChecker(userId) {
  const pref = new Map(
    db.prepare("SELECT name, online FROM location_pref WHERE user_id = ? AND online IS NOT NULL").all(userId)
      .map((r) => [r.name, !!r.online])
  );
  return (name) => (pref.has(name) ? pref.get(name) : DEFAULT_ONLINE_LOCATIONS.has(name));
}

app.get("/api/locations", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const rows = db.prepare(
    "SELECT location AS name, COUNT(*) AS count FROM play WHERE user_id = ? AND location IS NOT NULL AND location != '' GROUP BY location"
  ).all(userId);
  const aliasMap = loadAliasMap("location");
  const merged = new Map();
  for (const r of rows) {
    const canonical = applyAlias(aliasMap, r.name);
    const cur = merged.get(canonical) || { name: canonical, count: 0 };
    cur.count += r.count;
    merged.set(canonical, cur);
  }
  // 아직 한 판도 안 한 장소도 고를 수 있어야 하므로 pref에만 있는 이름을 0회로 붙인다.
  for (const r of db.prepare("SELECT name FROM location_pref WHERE user_id = ?").all(userId)) {
    if (!merged.has(r.name)) merged.set(r.name, { name: r.name, count: 0 });
  }
  const isOnline = onlineLocationChecker(userId);
  const list = [...merged.values()].map((l) => ({ ...l, online: isOnline(l.name) }));
  res.json(list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)));
});

// 장소 추가 / 설정 변경. 이름만 주면 빈 장소를 만들고, online을 주면 판당 비용 제외 여부를 바꾼다.
app.post("/api/locations", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name이 필요합니다" });
  const { online } = req.body || {};
  db.prepare("INSERT OR IGNORE INTO location_pref (user_id, name) VALUES (?, ?)").run(userId, name);
  if (online !== undefined) {
    db.prepare("UPDATE location_pref SET online = ? WHERE user_id = ? AND name = ?").run(online ? 1 : 0, userId, name);
  }
  res.json({ ok: true });
});

// 장소 삭제. 기록이 있는 장소면 그 판들의 장소 표시만 지운다(플레이 자체는 남는다).
// 프론트가 confirm으로 건수를 알려주고 물은 뒤에 부른다.
app.delete("/api/locations", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const name = (req.query.name || "").toString();
  if (!name) return res.status(400).json({ error: "name이 필요합니다" });
  const result = db.prepare("UPDATE play SET location = NULL WHERE user_id = ? AND location = ?").run(userId, name);
  db.prepare("DELETE FROM location_pref WHERE user_id = ? AND name = ?").run(userId, name);
  if (result.changes > 0) invalidateFeedCache();
  res.json({ ok: true, cleared: result.changes });
});

// 장소 이름 바꾸기. name_alias(병합 표시)와 달리 원본 play.location 값 자체를 고친다 -
// 오타·표기 통일처럼 "그냥 다른 이름으로 대체"하고 싶을 때 쓴다. 별칭 병합 기능은 그대로 둔다.
app.patch("/api/locations", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "from, to가 필요합니다" });
  if (from === to) return res.status(400).json({ error: "from과 to가 같습니다" });

  // 내 기록의 장소만 바꾼다. 상대 기록까지 건드리면 남의 데이터를 고치는 셈이다.
  const result = db.prepare("UPDATE play SET location = ? WHERE location = ? AND user_id = ?").run(to, from, userId);
  // 설정도 새 이름으로 따라간다. 합치는 경우(to가 이미 있음)엔 원래 to의 설정을 살린다.
  const target = db.prepare("SELECT name FROM location_pref WHERE user_id = ? AND name = ?").get(userId, to);
  if (target) db.prepare("DELETE FROM location_pref WHERE user_id = ? AND name = ?").run(userId, from);
  else db.prepare("UPDATE location_pref SET name = ? WHERE user_id = ? AND name = ?").run(to, userId, from);
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
    SELECT p.*, COALESCE(g.custom_name, g.name) AS game_name, g.thumbnail AS game_thumbnail, g.image AS game_image
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
    has_rule_error, rule_error_note,
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
                        incomplete, source, expansions, is_coop, has_rule_error, rule_error_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'app', ?, ?, ?, ?)
    `).run(userId, game_id, played_at, duration_min ?? null, location ?? null,
           comment ?? null, incomplete ? 1 : 0,
           expansions ? JSON.stringify(expansions) : null, is_coop ? 1 : 0,
           has_rule_error ? 1 : 0, rule_error_note ?? null);

    const playId = result.lastInsertRowid;
    const insertPlayer = db.prepare(`
      INSERT INTO play_player (play_id, name, score, win, role, team, is_new, start_position, is_automa, score_breakdown)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const pl of players || []) {
      insertPlayer.run(playId, pl.name || "?", pl.score ?? null, pl.win ? 1 : 0,
                        pl.role ?? null, pl.team ?? null, pl.is_new ? 1 : 0,
                        pl.start_position ?? null, pl.is_automa ? 1 : 0,
                        pl.score_breakdown ? JSON.stringify(pl.score_breakdown) : null);
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

  const fields = ["played_at", "duration_min", "location", "comment", "incomplete", "is_coop", "expansions", "has_rule_error", "rule_error_note"];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      let v = req.body[f];
      if (f === "expansions" && v != null) v = JSON.stringify(v);
      if ((f === "incomplete" || f === "is_coop" || f === "has_rule_error") && v != null) v = v ? 1 : 0;
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
        INSERT INTO play_player (play_id, name, score, win, role, team, is_new, start_position, is_automa, score_breakdown)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const pl of req.body.players) {
        insertPlayer.run(id, pl.name || "?", pl.score ?? null, pl.win ? 1 : 0,
                          pl.role ?? null, pl.team ?? null, pl.is_new ? 1 : 0,
                          pl.start_position ?? null, pl.is_automa ? 1 : 0,
                          pl.score_breakdown ? JSON.stringify(pl.score_breakdown) : null);
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

// 첫 플레이는 별도 이벤트로 처리하므로 마일스톤은 10회/100회만 남긴다 (3·20·50회는 잡음이 많아 제거)
const MILESTONES = [10, 100];

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
    SELECT p.*, COALESCE(g.custom_name, g.name) AS game_name, g.categories AS game_categories, g.thumbnail AS game_thumbnail
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
  // 피드에는 안 띄우고 월간 결산에만 넣을 사건(최고점 갱신).
  const monthOnlyEvents = [];
  // 사용자·게임별 진행 상태: 판수, 1인/2인+ 각각의 최고·최저점
  const progress = new Map(); // key `${user_id}:${game_id}`
  // 월별 결산 집계. 플레이 기록은 계정별로 따로 쌓이므로 결산도 사람별로 나눈다
  // (예전엔 키가 YYYY-MM뿐이라 두 사람 플레이가 한 덩어리로 합산됐다).
  const monthAgg = new Map(); // key `${user_id}:YYYY-MM`
  const firstPlayMonth = new Map(); // `${user_id}:${game_id}` -> YYYY-MM (그 사람이 처음 그 게임을 한 달)
  // 도전과제 달성일을 정확히 계산하기 어려워 사용자의 가장 최근 플레이 날짜로 근사한다
  const maxDateByUser = new Map();

  function getMonthAgg(userId, monthKey) {
    const key = `${userId}:${monthKey}`;
    let a = monthAgg.get(key);
    if (!a) {
      a = {
        userId, monthKey, totalPlays: 0, totalMinutes: 0, gameCounts: new Map(), newGames: [],
        bestUpdateCount: 0,
        // 제목 옆 "66회 · 20일 · 20개 게임"용. 이 루프를 도는 김에 같이 센다.
        playedDays: new Set(),
      };
      monthAgg.set(key, a);
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
    maxDateByUser.set(play.user_id, play.played_at);

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
          has_rule_error: !!play.has_rule_error,
          rule_error_note: play.rule_error_note || null,
        },
      });
    }

    // 에러플 이벤트 - 사진/코멘트 카드와 별개로, 에러플이면 피드에 한 줄 이벤트를 추가한다.
    if (play.has_rule_error) {
      items.push({
        type: "event", kind: "error", date: play.played_at, seq: play.id + 0.05,
        userId: play.user_id, author, game_id: play.game_id, game_name: play.game_name,
        note: play.rule_error_note || null,
      });
    }

    // 월간 결산 집계
    const magg = getMonthAgg(play.user_id, monthKey);
    magg.totalPlays++;
    if (play.duration_min) magg.totalMinutes += play.duration_min;
    const gc = magg.gameCounts.get(play.game_id) || {
      name: play.game_name, count: 0, gameId: play.game_id, thumbnail: play.game_thumbnail,
    };
    gc.count++;
    magg.gameCounts.set(play.game_id, gc);
    // "새 게임"도 그 사람 기준 첫 플레이여야 한다
    const firstKey = `${play.user_id}:${play.game_id}`;
    if (!firstPlayMonth.has(firstKey)) {
      firstPlayMonth.set(firstKey, monthKey);
      magg.newGames.push(play.game_name);
    }
    magg.playedDays.add(play.played_at);

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
      // 1~2판째의 "갱신"은 표본이 너무 적어 무의미하므로 3판 이상 쌓인 뒤부터만 친다.
      // 최고점은 피드에 낱개로 띄우지 않고 월간 결산에만 모아 보여준다 - 자주 나서 피드가 시끄러웠다.
      // 최저점은 아예 안 만든다. 못한 기록을 굳이 알려줄 이유가 없다.
      const enoughPlays = prog.count >= 3;
      if (enoughPlays && prog[bestKey] != null && myScore > prog[bestKey]) {
        monthOnlyEvents.push({
          kind: "best", date: play.played_at,
          userId: play.user_id, game_id: play.game_id, game_name: play.game_name, score: myScore,
        });
        magg.bestUpdateCount++;
      }
      if (prog[bestKey] == null || myScore > prog[bestKey]) prog[bestKey] = myScore;
      if (prog[worstKey] == null || myScore < prog[worstKey]) prog[worstKey] = myScore;
    }

    progress.set(key, prog);
  }

  // 도전과제 달성 이벤트 - 진행률이 저장되지 않고 매번 계산되는 값이라 달성 시각을 정확히 알 수 없다.
  // 대신 완료 여부만 보고, 날짜는 그 사용자의 가장 최근 플레이 날짜로 근사해서 표시한다.
  const challengeRows = db.prepare("SELECT * FROM challenge").all();
  for (const row of challengeRows) {
    let target = null;
    try { target = JSON.parse(row.target_json || "null"); } catch { target = null; }
    const progress = computeChallengeProgress(target, row.user_id);
    if (!progress || progress.percent !== 100) continue;
    const author = userName.get(row.user_id) || "?";
    const date = maxDateByUser.get(row.user_id) || currentMonthKey() + "-01";
    items.push({
      type: "event", kind: "challenge", date, seq: -0.5 - row.id * 0.001,
      userId: row.user_id, author, challenge_name: row.name,
    });
  }

  // 결산 카드에 넣을 그 달의 사건들. 이미 만들어 둔 이벤트 아이템을 사용자·월로 다시 묶는다
  // (그래서 이 블록이 도전과제 이벤트 생성 뒤에 있어야 한다).
  // 최저점·에러플은 뺀다 - 결산은 그 달의 성과를 훑어보는 자리라 못한 기록까지 넣을 이유가 없다.
  const DIGEST_KINDS = new Set(["first", "milestone", "challenge"]);
  const eventsByUserMonth = new Map();
  const digestSource = [
    ...items.filter((it) => it.type === "event" && DIGEST_KINDS.has(it.kind)),
    ...monthOnlyEvents,
  ];
  for (const it of digestSource) {
    const key = `${it.userId}:${it.date.slice(0, 7)}`;
    if (!eventsByUserMonth.has(key)) eventsByUserMonth.set(key, []);
    eventsByUserMonth.get(key).push({
      kind: it.kind,
      gameId: it.game_id ?? null,
      gameName: it.game_name ?? null,
      score: it.score ?? null,
      count: it.count ?? null,
      challengeName: it.challenge_name ?? null,
    });
  }

  // 월간 결산 카드 - 이미 끝난 달만(진행 중인 이번 달은 아직 결산할 수 없다), 다음 달 1일자로 삽입
  const curMonth = currentMonthKey();
  for (const agg of monthAgg.values()) {
    const monthKey = agg.monthKey;
    if (monthKey >= curMonth) continue;
    // BGStats 3x3 결산 이미지처럼 최다 플레이 9개까지 보여준다
    const topGames = [...agg.gameCounts.values()].sort((a, b) => b.count - a.count).slice(0, 9);
    const [y, m] = monthKey.split("-").map(Number);
    items.push({
      type: "month",
      date: `${nextMonthKey(monthKey)}-01`,
      // 같은 달 카드가 사람 수만큼 생기므로 순서를 갈라 준다
      seq: -1 - agg.userId * 0.001,
      userId: agg.userId,
      author: userName.get(agg.userId) || "?",
      month: monthKey,
      year: y,
      monthNum: m,
      totalPlays: agg.totalPlays,
      newGames: agg.newGames,
      newGameCount: agg.newGames.length,
      topGames,
      bestUpdateCount: agg.bestUpdateCount,
      totalMinutes: agg.totalMinutes,
      distinctGames: agg.gameCounts.size,
      playedDays: agg.playedDays.size,
      events: eventsByUserMonth.get(`${agg.userId}:${monthKey}`) || [],
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
  const { author, filter, limit, offset, game_id, category, q } = req.query;

  const lim = Math.min(Number(limit) || 20, 100);
  const off = Number(offset) || 0;

  const authorId = author ? Number(author) : null;
  const gameIdFilter = game_id ? Number(game_id) : null;
  let items = getFeedCache().items;

  // 검색어: 게임 이름·코멘트·태그(카테고리)·장소를 훑는다. 월간 결산은 특정 판이 아니라 제외한다.
  const query = (q || "").trim().toLowerCase();

  items = items.filter((it) => {
    if (authorId && it.userId !== authorId) return false;
    if (query) {
      if (it.type === "month") return false;
      const hay = it.type === "play"
        ? [it.play.game_name, it.play.comment, it.play.location, ...(it.play.categories || [])]
        : [it.game_name, it.challenge_name];
      if (!hay.filter(Boolean).some((v) => String(v).toLowerCase().includes(query))) return false;
    }
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

// 두 자리 0채움 (그래프 버킷 날짜/월 문자열 생성용)
function pad2(n) {
  return String(n).padStart(2, "0");
}

app.get("/api/insights", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const { from, to, player, location, player_count } = req.query;
  // bucket 미지정 시 from~to 길이로 자동 판단: 1년 초과=연도별, 1개월 초과~1년 이하=월별, 1개월 이하=일별.
  let bucket = req.query.bucket;
  if (bucket !== "day" && bucket !== "month" && bucket !== "year") {
    if (from && to) {
      const days = (new Date(to) - new Date(from)) / 86400000;
      bucket = days > 366 ? "year" : days > 31 ? "month" : "day";
    } else {
      // 기간 지정이 없으면 "전체"다. 일별로 쪼개면 수백 개 구간이 나와 쓸모없으니 연도별로 묶는다.
      bucket = "year";
    }
  }

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

  // 상대별 "내" 승률. 예전엔 각 사람의 자기 승률을 보여줬는데, 내 기록을 보는 화면에서
  // 상대의 승률이 나오면 "저 사람과 붙어서 내가 어땠나"를 알 수 없다.
  // 그래서 같이 한 판수와 그 중 내가 이긴 판수로 바꾼다.
  const meName = applyAlias(playerAlias, db.prepare("SELECT name FROM user WHERE id = ?").get(userId)?.name || "");
  const playerStats = new Map();
  if (playIds.length) {
    const placeholders = playIds.map(() => "?").join(",");
    const pps = db.prepare(
      `SELECT play_id, name, win FROM play_player WHERE play_id IN (${placeholders})`
    ).all(...playIds);

    const byPlay = new Map();
    for (const pp of pps) {
      if (!byPlay.has(pp.play_id)) byPlay.set(pp.play_id, []);
      byPlay.get(pp.play_id).push({ name: applyAlias(playerAlias, pp.name), win: !!pp.win });
    }

    for (const rows of byPlay.values()) {
      const me = rows.find((r) => r.name === meName);
      if (!me) continue; // 내가 안 낀 판(있을 리 없지만)은 셈에서 뺀다
      for (const other of rows) {
        if (other.name === meName) continue;
        const cur = playerStats.get(other.name) || { name: other.name, plays: 0, wins: 0 };
        cur.plays++;
        if (me.win) cur.wins++; // 이 판에서 "내가" 이겼는지
        playerStats.set(other.name, cur);
      }
    }
  }
  const winRates = [...playerStats.values()]
    .map((s) => ({ ...s, winRate: s.plays ? s.wins / s.plays : 0 }))
    .sort((a, b) => b.plays - a.plays);

  // 기간 그래프: bucket 단위(day/month/year)로 집계. 빈 구간도 0으로 채워서
  // BGStats처럼 축이 끊기지 않게 한다. from/to가 없으면(전체) 실제 플레이 데이터의
  // 최소~최대 날짜 범위를 사용한다.
  const sliceLen = bucket === "year" ? 4 : bucket === "month" ? 7 : 10;
  const bucketKey = (dateStr) => dateStr.slice(0, sliceLen);

  let rangeFrom = from, rangeTo = to;
  if (!rangeFrom || !rangeTo) {
    if (plays.length) {
      rangeFrom = rangeFrom || plays[0].played_at;
      rangeTo = rangeTo || plays[plays.length - 1].played_at;
    }
  }

  const playsCounts = new Map();
  for (const p of plays) {
    const key = bucketKey(p.played_at);
    playsCounts.set(key, (playsCounts.get(key) || 0) + 1);
  }

  const playsSeries = [];
  if (rangeFrom && rangeTo) {
    if (bucket === "year") {
      const y0 = Number(rangeFrom.slice(0, 4)), y1 = Number(rangeTo.slice(0, 4));
      for (let y = y0; y <= y1; y++) {
        const key = String(y);
        playsSeries.push({ label: key, count: playsCounts.get(key) || 0 });
      }
    } else if (bucket === "month") {
      let y = Number(rangeFrom.slice(0, 4)), m = Number(rangeFrom.slice(5, 7));
      const y1 = Number(rangeTo.slice(0, 4)), m1 = Number(rangeTo.slice(5, 7));
      while (y < y1 || (y === y1 && m <= m1)) {
        const key = `${y}-${pad2(m)}`;
        playsSeries.push({ label: key, count: playsCounts.get(key) || 0 });
        m++;
        if (m > 12) { m = 1; y++; }
      }
    } else {
      let d = new Date(`${rangeFrom}T00:00:00`);
      const dEnd = new Date(`${rangeTo}T00:00:00`);
      while (d <= dEnd) {
        const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        playsSeries.push({ label: key, count: playsCounts.get(key) || 0 });
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      }
    }
  }

  // 장소별 분포. 장소를 안 적은 판은 "기타"로 묶는다 - 미기록이라고 따로 티 낼 이유가 없다.
  const locationCounts = new Map();
  for (const p of plays) {
    const loc = p.location ? applyAlias(locationAlias, p.location) : "기타";
    locationCounts.set(loc, (locationCounts.get(loc) || 0) + 1);
  }
  const byLocation = [...locationCounts.entries()].sort(([, a], [, b]) => b - a)
    .map(([location, count]) => ({ location, count }));

  // 요일별 분포. played_at은 YYYY-MM-DD 문자열이라 Date로 파싱해 요일을 구한다.
  // 월요일 시작(0=월 ~ 6=일)으로 맞춘다 - JS의 getDay()는 0=일이라 하나씩 당긴다.
  const WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];
  const weekdayCounts = new Array(7).fill(0);
  for (const p of plays) {
    const d = new Date(`${p.played_at}T00:00:00`);
    if (Number.isNaN(d.getTime())) continue;
    const jsDay = d.getDay(); // 0=일 ... 6=토
    const idx = (jsDay + 6) % 7; // 0=월 ... 6=일
    weekdayCounts[idx]++;
  }
  const byWeekday = WEEKDAY_LABELS.map((label, i) => ({ weekday: label, count: weekdayCounts[i] }));

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

  // 판당 비용: collection.price_paid를 이 사용자의 해당 게임 플레이 수로 나눈다.
  // 단, 온라인으로 표시한 장소(기본값 BGA/TTS/App, 설정 → 장소에서 변경 가능)의 판은
  // 내 실물 제품으로 논 게 아니므로 제외한다(name_alias 병합 후 최종 이름 기준).
  const isOnlineLocation = onlineLocationChecker(userId);
  const offlineGameCounts = new Map();
  for (const p of plays) {
    const canonicalLoc = applyAlias(locationAlias, p.location || "");
    if (isOnlineLocation(canonicalLoc)) continue;
    const cur = offlineGameCounts.get(p.game_id) || { game_id: p.game_id, game_name: p.game_name, count: 0 };
    cur.count++;
    offlineGameCounts.set(p.game_id, cur);
  }
  const priceRows = db.prepare(`
    SELECT c.game_id, COALESCE(g.custom_name, g.name) AS game_name, SUM(c.price_paid) AS total_paid
    FROM collection c
    JOIN game g ON g.id = c.game_id
    WHERE c.price_paid IS NOT NULL
    GROUP BY c.game_id
    HAVING SUM(c.price_paid) > 0
  `).all();
  const costPerPlay = priceRows.map((r) => {
    const plays = offlineGameCounts.get(r.game_id)?.count || 0;
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
    bucket,
    plays: playsSeries,
    byLocation,
    byWeekday,
    hIndex,
    levels,
    bestStreak,
    ownedNotPlayed,
    costPerPlay: { cheapest, priciest },
    spending,
  });
});

// ---------- 도전 과제 (계정별) ----------
// 진행률은 저장하지 않고 조회 시 계산한다 - 플레이가 쌓이면 자동으로 반영되어야 하므로.

function gamePlayCount(userId, gameId, from, to) {
  let sql = "SELECT COUNT(*) AS c FROM play WHERE user_id = ? AND game_id = ?";
  const params = [userId, gameId];
  if (from) { sql += " AND played_at >= ?"; params.push(from); }
  if (to) { sql += " AND played_at <= ?"; params.push(to); }
  return db.prepare(sql).get(...params).c;
}

function totalPlaysCount(userId, from, to) {
  let sql = "SELECT COUNT(*) AS c FROM play WHERE user_id = ?";
  const params = [userId];
  if (from) { sql += " AND played_at >= ?"; params.push(from); }
  if (to) { sql += " AND played_at <= ?"; params.push(to); }
  return db.prepare(sql).get(...params).c;
}

// 이 사용자 기준 "새로 배운" 게임: 그 게임의 (이 사용자) 첫 플레이일이 기간 안에 드는 경우.
function newGamesCount(userId, from, to) {
  const rows = db.prepare(
    "SELECT MIN(played_at) AS first FROM play WHERE user_id = ? GROUP BY game_id"
  ).all(userId);
  let count = 0;
  for (const r of rows) {
    if (from && r.first < from) continue;
    if (to && r.first > to) continue;
    count++;
  }
  return count;
}

// insights의 hIndex와 같은 정의(x판 이상 플레이한 게임이 x개 이상인 최대 x), 이 사용자 전체 기간 기준.
function computeHIndexForUser(userId) {
  const rows = db.prepare(
    "SELECT COUNT(*) AS c FROM play WHERE user_id = ? GROUP BY game_id"
  ).all(userId);
  const counts = rows.map((r) => r.c).sort((a, b) => b - a);
  let hIndex = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] >= i + 1) hIndex = i + 1;
    else break;
  }
  return hIndex;
}

function gameDisplayName(gameId) {
  const row = db.prepare("SELECT COALESCE(custom_name, name) AS name FROM game WHERE id = ?").get(gameId);
  return row ? row.name : null;
}

function computeChallengeProgress(target, userId) {
  if (!target || !target.type) return null;

  switch (target.type) {
    case "NxM": {
      const gameIds = Array.isArray(target.gameIds) ? target.gameIds : [];
      const m = Number(target.m) || 0;
      const n = Number(target.n) || gameIds.length;
      const games = gameIds.map((gid) => {
        const plays = gamePlayCount(userId, gid, target.from, target.to);
        return { gameId: gid, name: gameDisplayName(gid), plays, target: m };
      });
      const completed = games.reduce((sum, g) => sum + Math.min(g.plays, m), 0);
      const denom = n * m;
      const percent = denom > 0 ? Math.min(100, Math.round((completed / denom) * 100)) : 0;
      return {
        type: "NxM", games, percent,
        completedGames: games.filter((g) => g.plays >= m).length,
        totalGames: n,
      };
    }
    case "totalPlays": {
      const current = totalPlaysCount(userId, target.from, target.to);
      const percent = target.target ? Math.min(100, Math.round((current / target.target) * 100)) : 0;
      return { type: "totalPlays", current, target: target.target, percent };
    }
    case "newGames": {
      const current = newGamesCount(userId, target.from, target.to);
      const percent = target.target ? Math.min(100, Math.round((current / target.target) * 100)) : 0;
      return { type: "newGames", current, target: target.target, percent };
    }
    case "shelfOfShame": {
      const gameIds = Array.isArray(target.gameIds) ? target.gameIds : [];
      const games = gameIds.map((gid) => {
        const plays = gamePlayCount(userId, gid, null, null);
        return { gameId: gid, name: gameDisplayName(gid), done: plays > 0, plays };
      });
      const doneCount = games.filter((g) => g.done).length;
      const percent = games.length ? Math.round((doneCount / games.length) * 100) : 0;
      return { type: "shelfOfShame", games, percent, doneCount, totalGames: games.length };
    }
    case "hIndex": {
      const current = computeHIndexForUser(userId);
      const percent = target.target ? Math.min(100, Math.round((current / target.target) * 100)) : 0;
      return { type: "hIndex", current, target: target.target, percent };
    }
    default:
      return null;
  }
}

function serializeChallenge(row, userId) {
  let target = null;
  try { target = JSON.parse(row.target_json || "null"); } catch { target = null; }
  return { ...row, target, progress: computeChallengeProgress(target, userId) };
}

app.get("/api/challenges", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const rows = db.prepare("SELECT * FROM challenge WHERE user_id = ? ORDER BY created_at DESC").all(userId);
  res.json(rows.map((r) => serializeChallenge(r, userId)));
});

app.post("/api/challenges", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { name, description, target } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name이 필요합니다" });
  if (!target || !target.type) return res.status(400).json({ error: "target이 필요합니다" });

  const result = db.prepare(
    "INSERT INTO challenge (user_id, name, description, target_json) VALUES (?, ?, ?, ?)"
  ).run(userId, String(name).trim(), description ?? null, JSON.stringify(target));

  const row = db.prepare("SELECT * FROM challenge WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(serializeChallenge(row, userId));
});

app.delete("/api/challenges/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);

  const existing = db.prepare("SELECT * FROM challenge WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "찾을 수 없습니다" });
  if (existing.user_id !== userId) return res.status(403).json({ error: "본인 도전 과제만 삭제할 수 있습니다" });

  db.prepare("DELETE FROM challenge WHERE id = ?").run(id);
  res.json({ ok: true });
});

// name_alias(플레이어/장소 별칭)는 통계 병합용으로 서버 내부(applyAlias)에서만 쓴다.
// 이걸 편집하는 HTTP API와 설정 UI를 만들었다가 뺐다 - 표기가 갈린 이름은 별칭으로
// 겹쳐 보이게 하는 것보다 원본을 한 번 고치는 쪽(2026-08-07 ㅇ.→ㅇ 525건)이 깔끔했다.

// ---------- 슬리브 재고 ----------
// 공유 값(user_id 없음) - 둘이 같이 관리하는 실물 재고라 컬렉션과 같은 성격.

app.get("/api/sleeves", (req, res) => {
  const rows = db.prepare("SELECT * FROM sleeve ORDER BY size").all();
  res.json(rows);
});

app.post("/api/sleeves", (req, res) => {
  const { size, maker, kind, thickness, quantity, note } = req.body || {};
  if (!size || !String(size).trim()) return res.status(400).json({ error: "size가 필요합니다" });

  const result = db
    .prepare(
      `INSERT INTO sleeve (size, maker, kind, thickness, quantity, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(String(size).trim(), maker ?? null, kind ?? null, thickness ?? null, Number(quantity) || 0, note ?? null);

  const row = db.prepare("SELECT * FROM sleeve WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(row);
});

app.patch("/api/sleeves/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM sleeve WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "찾을 수 없습니다" });

  const { size, maker, kind, thickness, quantity, note } = req.body || {};
  const next = {
    size: size !== undefined ? String(size).trim() : existing.size,
    maker: maker !== undefined ? maker : existing.maker,
    kind: kind !== undefined ? kind : existing.kind,
    thickness: thickness !== undefined ? thickness : existing.thickness,
    quantity: quantity !== undefined ? Number(quantity) || 0 : existing.quantity,
    note: note !== undefined ? note : existing.note,
  };
  if (!next.size) return res.status(400).json({ error: "size가 필요합니다" });

  db.prepare(
    `UPDATE sleeve SET size = ?, maker = ?, kind = ?, thickness = ?, quantity = ?, note = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(next.size, next.maker, next.kind, next.thickness, next.quantity, next.note, id);

  res.json(db.prepare("SELECT * FROM sleeve WHERE id = ?").get(id));
});

app.delete("/api/sleeves/:id", (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("DELETE FROM sleeve WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "찾을 수 없습니다" });
  res.json({ ok: true });
});

// ---------- 게임별 슬리브 필요치 ----------
// 공유 값(user_id 없음). 규격 문자열은 사람마다 "63.5x88"/"63.5 X 88" 처럼 표기가 갈릴 수 있어
// 재고(sleeve)와 대조할 때만 공백 제거 + x/X 통일로 정규화한다. 저장값 자체는 원문 그대로 둔다.
function normalizeSleeveSize(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

app.get("/api/games/:id/sleeves", (req, res) => {
  const gameId = Number(req.params.id);
  const needs = db.prepare("SELECT * FROM game_sleeve WHERE game_id = ? ORDER BY id").all(gameId);
  const stockRows = db.prepare("SELECT size, quantity FROM sleeve").all();

  const result = needs.map((n) => {
    const key = normalizeSleeveSize(n.size);
    const stock = stockRows
      .filter((r) => normalizeSleeveSize(r.size) === key)
      .reduce((sum, r) => sum + r.quantity, 0);
    return { ...n, stock, enough: stock >= n.count };
  });
  res.json(result);
});

app.post("/api/games/:id/sleeves", (req, res) => {
  const gameId = Number(req.params.id);
  const game = db.prepare("SELECT id FROM game WHERE id = ?").get(gameId);
  if (!game) return res.status(400).json({ error: "존재하지 않는 game_id입니다" });

  const { size, count, note } = req.body || {};
  if (!size || !String(size).trim()) return res.status(400).json({ error: "size가 필요합니다" });
  if (!Number.isFinite(Number(count)) || Number(count) <= 0) {
    return res.status(400).json({ error: "count는 1 이상의 숫자여야 합니다" });
  }

  const result = db
    .prepare("INSERT INTO game_sleeve (game_id, size, count, note) VALUES (?, ?, ?, ?)")
    .run(gameId, String(size).trim(), Number(count), note ?? null);

  const row = db.prepare("SELECT * FROM game_sleeve WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(row);
});

app.patch("/api/game-sleeves/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM game_sleeve WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "찾을 수 없습니다" });

  const { size, count, note } = req.body || {};
  const next = {
    size: size !== undefined ? String(size).trim() : existing.size,
    count: count !== undefined ? Number(count) : existing.count,
    note: note !== undefined ? note : existing.note,
  };
  if (!next.size) return res.status(400).json({ error: "size가 필요합니다" });
  if (!Number.isFinite(next.count) || next.count <= 0) {
    return res.status(400).json({ error: "count는 1 이상의 숫자여야 합니다" });
  }

  db.prepare("UPDATE game_sleeve SET size = ?, count = ?, note = ? WHERE id = ?")
    .run(next.size, next.count, next.note, id);

  res.json(db.prepare("SELECT * FROM game_sleeve WHERE id = ?").get(id));
});

app.delete("/api/game-sleeves/:id", (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("DELETE FROM game_sleeve WHERE id = ?").run(id);
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

// ---------- BGA 임포트 ----------
// BGA는 공식 API가 없지만 Cloudflare 차단도 로그인 CAPTCHA도 없어서 서버에서 직접 된다.
// 세션은 메모리에만 둔다(비밀번호는 저장하지 않는다). 서버를 껐다 켜면 다시 로그인해야 한다.
//
// 매칭을 고정하지 않는 이유: 두 사람이 아레나 계정을 바꿔 쓴다. 그래서 "brrbrrrr = 항상 ㅇ"이
// 성립하지 않는다. 지난 선택은 "제안"으로만 쓰고 가져올 때마다 다시 고르게 한다.
const bgaSessions = new Map(); // app user_id -> { session, at }
let bgaGameMapCache = null;    // BGA game id -> { bggId, name }. 공개 목록이라 한 번만 받으면 된다.

async function getBgaGameMap() {
  if (!bgaGameMapCache) bgaGameMapCache = await bgaFetchGameMap();
  return bgaGameMapCache;
}

// 중복 방지 키에 앱 계정을 넣는다. 같은 아레나 판을 ㅇ·ㅃ가 각자 자기 계정에 넣을 수 있어야 한다
// (플레이 기록은 계정별로 따로 쌓는다는 원칙).
function bgaImportKey(appUserId, tableId) {
  return `${appUserId}:${tableId}`;
}

app.post("/api/bga/login", async (req, res) => {
  const userId = Number(req.body?.user_id);
  const { username, password } = req.body || {};
  if (!userId || !username || !password) {
    return res.status(400).json({ error: "user_id, username, password가 필요합니다" });
  }
  try {
    const session = await bgaLogin(username, password);
    bgaSessions.set(userId, { session, at: new Date().toISOString() });
    // 다음에 다시 입력하지 않게 아이디만 저장한다(비밀번호는 저장하지 않는다).
    db.prepare("UPDATE user SET bga_username = ? WHERE id = ?").run(username, userId);
    res.json({ ok: true, playerId: session.playerId, playerName: session.playerName });
  } catch (err) {
    res.status(401).json({ error: String(err.message || err) });
  }
});

app.get("/api/bga/session", (req, res) => {
  const rows = db.prepare("SELECT id, name, bga_username FROM user").all();
  res.json(rows.map((u) => {
    const s = bgaSessions.get(u.id);
    return {
      user_id: u.id, name: u.name, bga_username: u.bga_username,
      loggedIn: !!s, playerId: s?.session?.playerId ?? null, at: s?.at ?? null,
    };
  }));
});

// 가져올 수 있는 판 목록. 실제로 넣지 않고 "무엇이 들어갈지"만 보여준다.
// player 파라미터로 다른 아레나 계정의 판도 볼 수 있다(계정을 바꿔 쓰는 경우).
app.get("/api/bga/plays", async (req, res) => {
  const userId = Number(req.query.user_id);
  const entry = bgaSessions.get(userId);
  if (!entry) return res.status(401).json({ error: "먼저 BGA에 로그인하세요" });

  const maxPages = Math.min(Number(req.query.pages) || 5, 30);
  const playerId = Number(req.query.player) || null;

  try {
    const [tables, gameMap] = await Promise.all([
      bgaFetchAllPlays(entry.session, { playerId, maxPages }),
      getBgaGameMap(),
    ]);
    // 방금 받은 목록을 세션에 들고 있는다. 가져오기에서 다시 받으면 그만큼 느려진다.
    entry.tables = tables;

    // 이 앱 계정으로 이미 가져온 판. 한 번 가져오면 다시 안 뜬다.
    const importedKeys = new Set(
      db.prepare("SELECT source_key FROM sync_match WHERE source = 'bga'").all().map((r) => r.source_key)
    );
    // 지난번에 고른 이름 매칭. 고정이 아니라 "제안"으로만 쓴다.
    const suggest = new Map(
      db.prepare("SELECT source_key, mapped_user_id FROM sync_match WHERE source = 'bga_player'").all()
        .map((r) => [r.source_key, r.mapped_user_id])
    );

    const items = tables.map((t) => {
      const mapped = gameMap.get(t.bgaGameId);
      const game = mapped
        ? db.prepare("SELECT id, COALESCE(custom_name, name) AS name FROM game WHERE id = ?").get(mapped.bggId)
        : null;

      // 같은 게임·같은 날짜 기록이 이미 있으면 중복일 수 있다고 표시한다.
      // 예전 BGStats -> BGG 경로로 들어온 판들은 테이블 id가 없어서 이 방법으로만 걸러진다.
      const dupe = game
        ? db.prepare("SELECT id FROM play WHERE user_id = ? AND game_id = ? AND played_at = ?")
            .get(userId, game.id, t.playedAt)
        : null;

      return {
        tableId: t.tableId,
        playedAt: t.playedAt,
        durationMin: t.durationMin,
        bgaGameId: t.bgaGameId,
        bgaGameName: t.bgaGameName,
        bggId: mapped?.bggId ?? null,
        gameName: game?.name ?? mapped?.name ?? t.bgaGameName,
        // 앱 DB에 게임이 없어도 BGG id만 알면 가져올 때 자동으로 받아온다.
        // 소유하지 않은 게임도 플레이 기록은 남을 수 있어야 한다.
        inCollection: !!game,
        needsFetch: !game && !!mapped,
        canImport: !!mapped,
        alreadyImported: importedKeys.has(bgaImportKey(userId, t.tableId)),
        maybeDuplicate: !!dupe,
        players: t.players.map((p) => ({ ...p, suggestUserId: suggest.get(p.name) ?? null })),
      };
    });

    res.json({ total: items.length, items });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 고른 판을 넣는다.
//   user_id  : 이 기록이 들어갈 앱 계정 (이번에 그 판을 한 사람)
//   mapping  : { "BGA이름": 앱계정id | null }  - 이번 가져오기에만 적용된다
//   remember : true면 다음 가져오기의 "제안"으로 저장한다(고정은 아니다)
app.post("/api/bga/import", async (req, res) => {
  const userId = Number(req.body?.user_id);
  const tableIds = (req.body?.table_ids || []).map(Number).filter(Boolean);
  const mapping = req.body?.mapping || {};
  const remember = !!req.body?.remember;

  const entry = bgaSessions.get(userId);
  if (!entry) return res.status(401).json({ error: "먼저 BGA에 로그인하세요" });
  if (tableIds.length === 0) return res.json({ ok: true, added: 0, results: [] });

  try {
    // 목록 조회 때 받아둔 것을 그대로 쓴다. 없을 때만 다시 받는다.
    const tables = entry.tables?.length
      ? entry.tables
      : await bgaFetchAllPlays(entry.session, { playerId: Number(req.body?.player) || null, maxPages: 30 });
    const gameMap = await getBgaGameMap();
    const wanted = new Map(tables.map((t) => [t.tableId, t]));
    const userById = new Map(db.prepare("SELECT id, name FROM user").all().map((u) => [u.id, u.name]));

    const insertPlay = db.prepare(`
      INSERT INTO play (user_id, game_id, played_at, duration_min, location, source)
      VALUES (?, ?, ?, ?, 'BGA', 'bga')
    `);
    const insertPlayer = db.prepare(`
      INSERT INTO play_player (play_id, name, score, win, is_automa) VALUES (?, ?, ?, ?, 0)
    `);
    const markDone = db.prepare(`
      INSERT INTO sync_match (source, source_key, game_id) VALUES ('bga', ?, ?)
      ON CONFLICT(source, source_key) DO UPDATE SET game_id = excluded.game_id
    `);
    const rememberName = db.prepare(`
      INSERT INTO sync_match (source, source_key, mapped_user_id) VALUES ('bga_player', ?, ?)
      ON CONFLICT(source, source_key) DO UPDATE SET mapped_user_id = excluded.mapped_user_id
    `);

    if (remember) {
      for (const [bgaName, appId] of Object.entries(mapping)) {
        if (appId) rememberName.run(bgaName, Number(appId));
      }
    }

    const results = [];
    const fetched = []; // 이번에 BGG에서 새로 받아온 게임 이름
    for (const id of tableIds) {
      const t = wanted.get(id);
      if (!t) { results.push({ tableId: id, ok: false, error: "목록에 없는 판" }); continue; }
      const mapped = gameMap.get(t.bgaGameId);
      if (!mapped) { results.push({ tableId: id, ok: false, error: "BGG id를 모르는 게임" }); continue; }
      // 앱에 없는 게임이면 BGG에서 받아 넣는다. 컬렉션에 추가하지는 않는다 -
      // 소유하지 않은 게임도 아레나에서 할 수 있고, 그 기록은 남아야 한다.
      let game = db.prepare("SELECT id FROM game WHERE id = ?").get(mapped.bggId);
      if (!game) {
        if (!BGG_API_KEY) { results.push({ tableId: id, ok: false, error: "BGG API 키가 없어 게임을 받아올 수 없음" }); continue; }
        try {
          const details = await fetchThings([mapped.bggId], BGG_API_KEY);
          const d = details.get(mapped.bggId);
          if (!d) throw new Error("BGG에 없는 게임");
          upsertGames(db, [{ id: mapped.bggId, ...d }]);
          game = db.prepare("SELECT id FROM game WHERE id = ?").get(mapped.bggId);
          fetched.push(mapped.name);
        } catch (e) {
          results.push({ tableId: id, ok: false, error: `게임 받아오기 실패 (BGG ${mapped.bggId}): ${e.message}` });
          continue;
        }
      }

      const info = insertPlay.run(userId, game.id, t.playedAt, t.durationMin);
      const playId = Number(info.lastInsertRowid);
      for (const p of t.players) {
        // 이번에 고른 매칭대로 이름을 바꿔 넣는다. 안 고른 이름은 아레나 이름 그대로.
        const appId = mapping[p.name];
        const name = appId ? (userById.get(Number(appId)) ?? p.name) : p.name;
        insertPlayer.run(playId, name, p.score, p.win ? 1 : 0);
      }
      markDone.run(bgaImportKey(userId, t.tableId), game.id);
      results.push({ tableId: id, ok: true, playId, game: mapped.name, date: t.playedAt });
    }

    res.json({ ok: true, added: results.filter((r) => r.ok).length, fetchedGames: fetched, results });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- 청소 ----------

const CLEANUP_PATHS = {
  imageCacheDir: IMAGE_CACHE_DIR,
  photoDir: PHOTO_ORIGINAL_DIR,
  avatarDir: AVATAR_DIR,
};

// 상태만 본다(dry run). 설정 화면에서 "얼마나 지울 수 있나"를 먼저 보여주기 위한 것.
app.get("/api/cleanup", (req, res) => {
  try {
    res.json(runCleanup(db, CLEANUP_PATHS, { dryRun: true }));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/cleanup", (req, res) => {
  try {
    const result = runCleanup(db, CLEANUP_PATHS);
    console.log(`청소 완료: ${(result.freedBytes / 1048576).toFixed(1)}MB 회수`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- 웹앱 정적 서빙 ----------
//
// 개발할 때는 Vite 개발서버가 5199에서 앱을 띄우고 /api만 여기로 프록시한다.
// 도커에 올릴 때는 그럴 게 없으므로 서버가 빌드 결과(web/dist)까지 직접 내보낸다.
// WEB_DIST가 없으면(개발 중) 이 블록 전체를 건너뛴다.
const WEB_DIST = process.env.WEB_DIST || "";
if (WEB_DIST && existsSync(WEB_DIST)) {
  // 해시가 박힌 에셋은 내용이 바뀌면 파일명이 바뀌므로 오래 캐시해도 안전하다.
  app.use("/assets", express.static(join(WEB_DIST, "assets"), { maxAge: "1y", immutable: true }));
  // index.html은 여기서 내보내지 않는다(index: false) - 아래에서 캐시를 끄고 직접 보낸다.
  app.use(express.static(WEB_DIST, { maxAge: "1h", index: false }));

  // 해시 라우터를 쓰지만, 새로고침이나 직접 진입에 대비해 나머지는 index.html로 보낸다.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    // 확장자가 붙은 요청이 여기까지 왔다면 없는 파일이다. 이때 index.html을 돌려주면
    // 브라우저가 JS 자리에서 HTML을 받아 MIME 오류로 앱 전체가 죽는다(빈 화면).
    // 404를 주면 최소한 그 파일만 실패하고 원인도 바로 보인다.
    if (extname(req.path)) return next();
    // 패치로 청크 파일명이 바뀌므로 index.html은 매번 확인해야 한다.
    // 캐시된 옛 index.html이 사라진 청크를 가리키면 앱이 안 뜬다.
    res.set("Cache-Control", "no-cache");
    res.sendFile(resolve(join(WEB_DIST, "index.html")));
  });
  console.log(`웹앱 서빙: ${WEB_DIST}`);
}

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});

// NAS 도커에 올려두고 몇 달씩 안 들여다볼 걸 전제로, 청소는 자동으로 돈다.
// 지우는 건 캐시와 고아 파일뿐이라(기록·컬렉션은 손대지 않는다) 실패해도 잃을 게 없다.
// 시작 직후 한 번 도는 건 재시작이 잦은 개발 중엔 성가시므로 1분 늦춘다.
const CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
function scheduledCleanup() {
  try {
    const r = runCleanup(db, CLEANUP_PATHS);
    console.log(`자동 청소: 이미지 ${r.images.removed}개 · ${(r.freedBytes / 1048576).toFixed(1)}MB 회수`);
  } catch (err) {
    console.error("자동 청소 실패:", err);
  }
}
if (process.env.AUTO_CLEANUP !== "0") {
  setTimeout(scheduledCleanup, 60 * 1000);
  setInterval(scheduledCleanup, CLEANUP_INTERVAL_MS);
}
