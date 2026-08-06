/**
 * 일회성 스크립트: item_type/description/designers 등 "상세를 아예 받은 적 없는" 게임만 채운다.
 * sync.js는 DETAIL_TTL_DAYS(14일) 캐시 때문에 이미 최근에 상세를 받은 게임은 건너뛰는데,
 * 이번에 추가된 컬럼(item_type 등)은 과거에 받은 게임엔 전부 비어 있으므로 캐시를 무시하고
 * "item_type이 없거나 애초에 상세를 받은 적 없는(synced_at NULL)" 게임만 골라 다시 받는다.
 * 한 번만 실행하면 되고, 반복 실행하지 않는다. 레이트리밋은 bgg.js의 fetchThings(20개/1초)를 그대로 쓴다.
 */
import { openDb } from "./db.js";
import { fetchThings } from "./bgg.js";
import { upsertGames } from "./import-bgg.js";

const DB_PATH = process.env.DB_PATH || "data/app.db";
const API_KEY = process.env.BGG_API_KEY;

async function main() {
  if (!API_KEY) {
    console.error("BGG_API_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  const db = openDb(DB_PATH);
  const rows = db.prepare(
    "SELECT id FROM game WHERE item_type IS NULL OR synced_at IS NULL"
  ).all();
  const ids = rows.map((r) => r.id);
  console.log(`대상 게임 ${ids.length}개`);

  if (ids.length === 0) {
    console.log("채울 게임이 없습니다.");
    db.close();
    return;
  }

  const details = await fetchThings(ids, API_KEY);
  const games = ids
    .filter((id) => details.has(id))
    .map((id) => ({ id, ...details.get(id) }));

  const n = upsertGames(db, games);
  console.log(`${n}개 게임 정보 갱신 완료 (요청 ${ids.length}개 중 응답 ${games.length}개)`);

  const missing = ids.filter((id) => !details.has(id));
  if (missing.length) console.log(`BGG 응답에 없던 id: ${missing.join(", ")}`);

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
