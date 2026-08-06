/**
 * scripts/fetch_bgg.py, fetch_plays.py가 만든 JSON을 SQLite로 적재한다.
 *
 * 게임 정보와 컬렉션은 공유이고, 플레이 기록은 계정별로 들어간다.
 * 같은 판을 두 사람이 각각 기록했더라도 합치지 않는다 — 각자 자기 기록을 본다.
 *
 * 사용법: node src/import-bgg.js <bgg.json> [plays.json:사용자이름] ...
 * 예:    node src/import-bgg.js ../data/bgg.json ../data/plays.json:ㅇ ../data/plays_bbossing.json:ㅃ
 */
import { readFileSync } from "node:fs";
import { openDb } from "./db.js";

const DB_PATH = process.env.DB_PATH || "data/app.db";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function upsertGames(db, games) {
  const stmt = db.prepare(`
    INSERT INTO game (id, name, name_en, aliases, thumbnail, image, year_published,
                      min_players, max_players, playing_time, weight, bgg_rating,
                      bgg_rank, item_type, description, designers, artists, categories,
                      mechanics, min_playtime, max_playtime, min_age, publishers,
                      users_rated, sub_ranks, best_players, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, name_en = excluded.name_en, aliases = excluded.aliases,
      thumbnail = excluded.thumbnail, image = excluded.image,
      year_published = excluded.year_published, min_players = excluded.min_players,
      max_players = excluded.max_players, playing_time = excluded.playing_time,
      weight = excluded.weight, bgg_rating = excluded.bgg_rating,
      bgg_rank = excluded.bgg_rank, item_type = excluded.item_type,
      description = excluded.description, designers = excluded.designers,
      artists = excluded.artists, categories = excluded.categories,
      mechanics = excluded.mechanics, min_playtime = excluded.min_playtime,
      max_playtime = excluded.max_playtime, min_age = excluded.min_age,
      publishers = excluded.publishers, users_rated = excluded.users_rated,
      sub_ranks = excluded.sub_ranks, best_players = excluded.best_players,
      synced_at = datetime('now')
  `);
  // description_ko(번역 캐시)는 여기서 절대 건드리지 않는다 - 동기화 때마다 다시 번역하지 않기 위해서다.

  for (const g of games) {
    const korean = g.koreanNames || [];
    const display = korean[0] || g.primaryName || g.name;
    const aliases = [...new Set([g.primaryName, g.name, ...korean,
                                 ...(g.alternateNames || [])].filter(Boolean))];
    stmt.run(g.id, display, g.primaryName ?? null, JSON.stringify(aliases),
             g.thumbnail ?? null, g.image ?? null, g.yearPublished ?? null,
             g.minPlayers ?? null, g.maxPlayers ?? null, g.playingTime ?? null,
             g.weight ?? null, g.bggRating ?? null, g.bggRank ?? null,
             g.itemType ?? null, g.description ?? null,
             JSON.stringify(g.designers || []), JSON.stringify(g.artists || []),
             JSON.stringify(g.categories || []), JSON.stringify(g.mechanics || []),
             g.minPlaytime ?? null, g.maxPlaytime ?? null, g.minAge ?? null,
             JSON.stringify(g.publishers || []), g.usersRated ?? null,
             JSON.stringify(g.subRanks || []), g.bestPlayers ?? null);
  }
  return games.length;
}

function seedCollection(db, games) {
  // BGG에서 보유/위시로 잡힌 것만 초기 등록한다. 구매가 등은 앱에서 채운다.
  const exists = db.prepare("SELECT 1 FROM collection WHERE game_id = ?");
  const insert = db.prepare(
    "INSERT INTO collection (game_id, status) VALUES (?, ?)");

  let added = 0;
  for (const g of games) {
    const status = g.own ? "보유" : g.preordered ? "선주문"
                 : g.wishlist ? "위시리스트" : g.prevOwned ? "방출 완료" : null;
    if (!status || exists.get(g.id)) continue;
    insert.run(g.id, status);
    added++;
  }
  return added;
}

export function ensureUser(db, name, bggUsername) {
  const found = db.prepare("SELECT id FROM user WHERE name = ?").get(name);
  if (found) return found.id;
  db.prepare("INSERT INTO user (name, bgg_username) VALUES (?, ?)")
    .run(name, bggUsername ?? null);
  return db.prepare("SELECT id FROM user WHERE name = ?").get(name).id;
}

export function importPlays(db, userId, plays, knownGames) {
  const insertPlay = db.prepare(`
    INSERT INTO play (user_id, game_id, played_at, duration_min, location,
                      comment, incomplete, bgg_play_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bgg')
    ON CONFLICT(bgg_play_id) DO NOTHING
  `);
  const insertPlayer = db.prepare(
    "INSERT INTO play_player (play_id, name, score, win) VALUES (?, ?, ?, ?)");
  const findPlay = db.prepare("SELECT id FROM play WHERE bgg_play_id = ?");

  // 컬렉션에 없는 게임(빌려서 한 판, 상대방만 소장한 게임 등)도 기록은 남겨야 하므로
  // 이름만 채운 임시 행을 만든다. synced_at이 비어 있어 다음 동기화 때 상세가 채워진다.
  const insertStub = db.prepare(
    "INSERT INTO game (id, name, name_en) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING");

  let added = 0, stubbed = 0;
  for (const p of plays) {
    if (!p.gameId) continue;
    if (!knownGames.has(p.gameId)) {
      insertStub.run(p.gameId, p.gameName || `게임 ${p.gameId}`, p.gameName ?? null);
      knownGames.add(p.gameId);
      stubbed++;
    }
    if (findPlay.get(p.id)) continue;

    insertPlay.run(userId, p.gameId, p.date, p.length || null, p.location ?? null,
                   p.comment ?? null, p.incomplete ? 1 : 0, p.id);
    const row = findPlay.get(p.id);
    if (!row) continue;
    for (const pl of p.players || []) {
      insertPlayer.run(row.id, pl.name || "?", pl.score ?? null, pl.win ? 1 : 0);
    }
    added++;
  }
  return { added, stubbed };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("사용법: node src/import-bgg.js <bgg.json> [plays.json:사용자이름] ...");
    process.exit(1);
  }

  const db = openDb(DB_PATH);
  const [bggPath, ...playArgs] = args;

  const bgg = readJson(bggPath);
  console.log(`게임 ${upsertGames(db, bgg.games)}개 적재`);
  console.log(`컬렉션 ${seedCollection(db, bgg.games)}건 신규 등록`);

  const knownGames = new Set(
    db.prepare("SELECT id FROM game").all().map((r) => r.id));

  for (const arg of playArgs) {
    const idx = arg.lastIndexOf(":");
    if (idx < 2) {
      console.error(`형식이 잘못됨: ${arg} (plays.json:사용자이름)`);
      continue;
    }
    const path = arg.slice(0, idx);
    const name = arg.slice(idx + 1);
    const data = readJson(path);
    const userId = ensureUser(db, name, data.username);
    const { added, stubbed } = importPlays(db, userId, data.plays, knownGames);
    console.log(`${name}: 플레이 ${added}건 적재` +
                (stubbed ? ` (컬렉션에 없는 게임 ${stubbed}개는 이름만 등록)` : ""));
  }

  db.close();
  console.log(`저장: ${DB_PATH}`);
}

// sync.js가 upsertGames/ensureUser/importPlays만 가져다 쓸 때는 CLI를 실행하면 안 된다.
if (process.argv[1] && process.argv[1].endsWith("import-bgg.js")) {
  main();
}
