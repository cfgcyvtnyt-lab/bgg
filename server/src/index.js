import express from "express";
import { openDb } from "./db.js";
import { runSync } from "./sync.js";

const DB_PATH = process.env.DB_PATH || "data/app.db";
const PORT = process.env.PORT || 3001;
const BGG_API_KEY = process.env.BGG_API_KEY;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT * FROM game
      WHERE name LIKE ? OR name_en LIKE ? OR aliases LIKE ?
      ORDER BY name
      LIMIT ? OFFSET ?
    `).all(like, like, like, limit, offset);
  } else {
    rows = db.prepare("SELECT * FROM game ORDER BY name LIMIT ? OFFSET ?").all(limit, offset);
  }
  res.json(rows.map((g) => ({ ...g, aliases: parseJsonArray(g.aliases) })));
});

app.get("/api/games/:id", (req, res) => {
  const id = Number(req.params.id);
  const game = db.prepare("SELECT * FROM game WHERE id = ?").get(id);
  if (!game) return res.status(404).json({ error: "게임을 찾을 수 없습니다" });

  const collectionHistory = db.prepare(
    "SELECT * FROM collection WHERE game_id = ? ORDER BY created_at").all(id);

  const userId = currentUserId(req);
  let playCount = 0;
  let myRating = null;
  if (userId) {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM play WHERE game_id = ? AND user_id = ?").get(id, userId);
    playCount = row.c;
    const ratingRow = db.prepare(
      "SELECT rating FROM game_rating WHERE game_id = ? AND user_id = ?").get(id, userId);
    myRating = ratingRow ? ratingRow.rating : null;
  }

  res.json({
    ...game,
    aliases: parseJsonArray(game.aliases),
    collectionHistory,
    playCount,
    my_rating: myRating,
  });
});

// ---------- collection (공유) ----------

// 화면에 보일 때 "가장 현재에 가까운" 상태 하나만 고르는 우선순위. 취득 이력 전체는 게임 상세에서만 본다.
const STATUS_PRIORITY = ["보유", "선주문", "위시리스트", "방출 예정", "방출 확정", "방출 완료"];

app.get("/api/collection", (req, res) => {
  const { status, tag } = req.query;
  const userId = currentUserId(req);

  // 취득 이력(팔았다 다시 사기도 함)을 전부 가져온 뒤 게임당 대표 행 하나로 줄인다.
  const rows = db.prepare(`
    SELECT c.*, g.name AS game_name, g.name_en AS game_name_en, g.thumbnail, g.image,
           g.year_published, g.min_players, g.max_players, g.playing_time, g.weight,
           g.bgg_rating, g.bgg_rank,
           gr.rating AS my_rating
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
  if (status) entries = entries.filter((e) => e.status === status);
  if (tag) entries = entries.filter((e) => e.tags.includes(tag));
  entries.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

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
    SELECT p.*, g.name AS game_name
    FROM play p
    JOIN game g ON g.id = p.game_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY p.played_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, lim, off);

  const result = rows.map((r) => ({
    ...r,
    expansions: parseJsonArray(r.expansions),
    players: loadPlayers(r.id),
  }));
  res.json(result);
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
      INSERT INTO play_player (play_id, name, score, win, role, team, is_new, start_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const pl of players || []) {
      insertPlayer.run(playId, pl.name || "?", pl.score ?? null, pl.win ? 1 : 0,
                        pl.role ?? null, pl.team ?? null, pl.is_new ? 1 : 0,
                        pl.start_position ?? null);
    }
    db.exec("COMMIT");

    const row = db.prepare("SELECT * FROM play WHERE id = ?").get(playId);
    res.status(201).json({ ...row, expansions: parseJsonArray(row.expansions), players: loadPlayers(playId) });
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
        INSERT INTO play_player (play_id, name, score, win, role, team, is_new, start_position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const pl of req.body.players) {
        insertPlayer.run(id, pl.name || "?", pl.score ?? null, pl.win ? 1 : 0,
                          pl.role ?? null, pl.team ?? null, pl.is_new ? 1 : 0,
                          pl.start_position ?? null);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      return res.status(500).json({ error: String(err.message || err) });
    }
  }

  const row = db.prepare("SELECT * FROM play WHERE id = ?").get(id);
  res.json({ ...row, expansions: parseJsonArray(row.expansions), players: loadPlayers(id) });
});

app.delete("/api/plays/:id", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const id = Number(req.params.id);

  const existing = db.prepare("SELECT * FROM play WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "찾을 수 없습니다" });
  if (existing.user_id !== userId) return res.status(403).json({ error: "본인 기록만 삭제할 수 있습니다" });

  db.prepare("DELETE FROM play WHERE id = ?").run(id); // play_player는 ON DELETE CASCADE
  res.json({ ok: true });
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
    SELECT p.id, p.game_id, p.played_at, p.duration_min, p.location, g.name AS game_name
    FROM play p JOIN game g ON g.id = p.game_id
    WHERE ${where}
    ORDER BY p.played_at ASC, COALESCE(p.bgg_play_id, p.id) ASC
  `).all(...params);

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
      const cur = playerStats.get(pp.name) || { name: pp.name, plays: 0, wins: 0 };
      cur.plays++;
      if (pp.win) cur.wins++;
      playerStats.set(pp.name, cur);
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
    const loc = p.location || "(미기록)";
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
    SELECT DISTINCT g.id, g.name
    FROM collection c
    JOIN game g ON g.id = c.game_id
    WHERE c.status = '보유'
      AND NOT EXISTS (SELECT 1 FROM play p WHERE p.game_id = g.id AND p.user_id = ?)
    ORDER BY g.name
  `).all(userId);

  // 판당 비용: collection.price_paid를 이 사용자의 해당 게임 플레이 수로 나눈다
  const priceRows = db.prepare(`
    SELECT c.game_id, g.name AS game_name, SUM(c.price_paid) AS total_paid
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
  });
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
const syncState = { running: false, lastRunAt: null, lastResult: null, lastError: null };

async function runSyncSafe() {
  syncState.running = true;
  try {
    const result = await runSync(db, BGG_API_KEY);
    syncState.lastRunAt = new Date().toISOString();
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

app.post("/api/sync", async (req, res) => {
  if (syncState.running) {
    return res.status(409).json({ error: "이미 동기화가 진행 중입니다" });
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
