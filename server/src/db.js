import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 컬렉션은 두 사람이 공유하고, 플레이 기록은 계정별로 따로 쌓인다.
// 그래서 collection에는 user_id가 없고 play에는 있다.
// game_rating: 사용자별 게임 속성(평점·플레이 희망)을 담는 테이블. 이름은 rating 전용처럼 보이지만
// want_to_play도 같은 이유(사람마다 다름)로 여기 얹었다 - 새 테이블 대신 기존 테이블을 확장했다.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS user (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,      -- 화면에 보이는 이름 (ㅇ, ㅃ)
  bgg_username  TEXT,                      -- 과거 기록 가져올 때만 사용
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- BGG에서 받아오는 게임 정보. 앱이 고치지 않고 동기화로 덮어쓴다.
CREATE TABLE IF NOT EXISTS game (
  id             INTEGER PRIMARY KEY,      -- BGG objectid
  name           TEXT NOT NULL,            -- 표시용 (한글 우선)
  name_en        TEXT,
  aliases        TEXT,                     -- JSON 배열, 검색용
  thumbnail      TEXT,
  image          TEXT,
  year_published INTEGER,
  min_players    INTEGER,
  max_players    INTEGER,
  playing_time   INTEGER,
  weight         REAL,
  bgg_rating     REAL,
  bgg_rank       INTEGER,
  synced_at      TEXT
);

-- 공유 컬렉션. 한 게임을 팔았다 다시 사기도 하므로 취득 이력을 여러 건 허용한다.
CREATE TABLE IF NOT EXISTS collection (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL REFERENCES game(id),
  status      TEXT NOT NULL DEFAULT '보유',   -- 보유/선주문/위시리스트/방출 예정/방출 확정/방출 완료
  price_paid  INTEGER,
  price_sold  INTEGER,
  tags        TEXT,                           -- JSON 배열 (전략, 필러 …)
  note        TEXT,
  acquired_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collection_game ON collection(game_id);

-- 플레이 기록. 계정별로 따로 보관하며 합산하지 않는다.
CREATE TABLE IF NOT EXISTS play (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES user(id),
  game_id      INTEGER NOT NULL REFERENCES game(id),
  played_at    TEXT NOT NULL,               -- YYYY-MM-DD
  duration_min INTEGER,
  location     TEXT,
  comment      TEXT,
  incomplete   INTEGER NOT NULL DEFAULT 0,
  bgg_play_id  INTEGER UNIQUE,              -- BGG에서 가져온 기록이면 채워진다
  source       TEXT NOT NULL DEFAULT 'app', -- app | bgg
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_play_user ON play(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_game ON play(game_id);

CREATE TABLE IF NOT EXISTS play_player (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  play_id  INTEGER NOT NULL REFERENCES play(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  score    REAL,
  win      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_play_player ON play_player(play_id);

-- 피드에 올릴 사진. published가 1인 것만 공개 사이트로 나간다.
CREATE TABLE IF NOT EXISTS photo (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  play_id    INTEGER NOT NULL REFERENCES play(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  caption    TEXT,
  published  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photo_play ON photo(play_id);
`;

// 이미 데이터가 쌓인 뒤 추가된 컬럼들. ALTER TABLE은 실패해도(이미 있으면) 무시한다.
const ALTER_COLUMNS = [
  "ALTER TABLE user ADD COLUMN bga_username TEXT",
  "ALTER TABLE play ADD COLUMN expansions TEXT",
  "ALTER TABLE play ADD COLUMN is_coop INTEGER DEFAULT 0",
  "ALTER TABLE play_player ADD COLUMN role TEXT",
  "ALTER TABLE play_player ADD COLUMN team TEXT",
  "ALTER TABLE play_player ADD COLUMN is_new INTEGER DEFAULT 0",
  "ALTER TABLE play_player ADD COLUMN start_position TEXT",
  // BGG에서 오는 이름이 영문뿐인 게임이 있어 사용자가 직접 표시 이름을 지정할 수 있게 한다.
  // 동기화는 이 컬럼을 절대 건드리지 않는다(upsertGames 참고).
  "ALTER TABLE game ADD COLUMN custom_name TEXT",
  // BGG 컬렉션의 "want to play" 플래그. 위시리스트와 별개 개념이라 status가 아닌 독립 플래그로 둔다.
  // 주의: 이 컬럼은 공유 테이블(collection)에 있어 두 사용자가 값을 덮어쓰는 버그가 있었다.
  // game_rating.want_to_play로 이전했으니 이 컬럼은 더 이상 읽지도 쓰지도 않는다(삭제는 SQLite에서 위험해 컬럼만 방치).
  "ALTER TABLE collection ADD COLUMN want_to_play INTEGER DEFAULT 0",
  // rating과 마찬가지로 사용자마다 다른 값이라 공유 테이블이 아닌 game_rating에 사용자별로 저장한다.
  "ALTER TABLE game_rating ADD COLUMN want_to_play INTEGER NOT NULL DEFAULT 0",
  // 오토마/봇 플레이어 표시. "사람 플레이어 1명 이하"를 솔로로 판정할 때 이 플래그로 사람 수를 센다.
  "ALTER TABLE play_player ADD COLUMN is_automa INTEGER DEFAULT 0",
];

// 챌린지(목표)와 BGA 동기화 매칭 기록. 기존 테이블과 무관한 신규 기능이라 CREATE IF NOT EXISTS로 충분.
const EXTRA_SCHEMA = `
CREATE TABLE IF NOT EXISTS challenge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES user(id),
  name        TEXT NOT NULL,
  description TEXT,
  target_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- BGA 동기화 때 게임명 -> game_id 매칭을 기억해서 매번 다시 물어보지 않게 한다.
CREATE TABLE IF NOT EXISTS sync_match (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,             -- 'bga'
  source_key  TEXT NOT NULL,             -- BGA 쪽 게임명 등 식별자
  game_id     INTEGER REFERENCES game(id),
  excluded    INTEGER NOT NULL DEFAULT 0, -- 1이면 "가져오지 않음"으로 확정
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_match_key ON sync_match(source, source_key);

-- 평점/플레이 희망은 사람마다 다르다(각자 BGG 계정 기준). 컬렉션은 공유지만 이 값들은 계정별로 따로 저장한다.
-- want_to_play는 ALTER_COLUMNS에서 뒤늦게 추가됨(위 주석 참고).
CREATE TABLE IF NOT EXISTS game_rating (
  user_id INTEGER NOT NULL REFERENCES user(id),
  game_id INTEGER NOT NULL REFERENCES game(id),
  rating  REAL,
  UNIQUE(user_id, game_id)
);

-- 같은 사람/장소가 다른 이름으로 기록돼 통계가 갈라지는 걸 조회 시점에만 합쳐 보여준다.
-- 원본(play_player.name, play.location)은 절대 고치지 않는다 - 사용자가 직접 지정한 매핑만 신뢰한다.
CREATE TABLE IF NOT EXISTS name_alias (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,      -- 'player' | 'location'
  alias     TEXT NOT NULL,      -- 실제 기록된 값
  canonical TEXT NOT NULL,      -- 대표로 쓸 이름
  UNIQUE(kind, alias)
);
`;

export function openDb(path = "data/app.db") {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  for (const stmt of ALTER_COLUMNS) {
    try {
      db.exec(stmt);
    } catch {
      // 컬럼이 이미 존재하면 여기로 온다 - 무시
    }
  }
  db.exec(EXTRA_SCHEMA);
  return db;
}
