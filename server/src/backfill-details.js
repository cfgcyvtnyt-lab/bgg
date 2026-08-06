/**
 * 일회성 스크립트: min_playtime/max_playtime/min_age/publishers/users_rated/sub_ranks/best_players
 * 컬럼을 새로 추가했는데(db.js) 기존에 상세를 받아둔 게임들은 이 필드가 전부 비어 있다.
 * sync.js의 DETAIL_TTL_DAYS(14일) 캐시를 무시하고 이 필드들이 비어 있는 게임만 골라 다시 받는다.
 *
 * 주의: 전체(409개) 백필은 여기서 실행하지 않는다 - 사람이 마지막에 직접 돌린다.
 * 이 스크립트는 --ids=1,2,3 처럼 대상을 좁혀서 샘플 검증용으로만 쓴다.
 * 인자 없이 실행하면 대상 목록 개수만 출력하고 끝낸다(실수로 전체 호출 방지).
 *
 * 사용법: node src/backfill-details.js --ids=285774        (샘플 1개 검증)
 *         node src/backfill-details.js --sample=20          (앞 20개만)
 *         node src/backfill-details.js --all --confirm       (전체 - 사람이 실행)
 */
import { openDb } from "./db.js";
import { fetchThings } from "./bgg.js";
import { upsertGames } from "./import-bgg.js";

const DB_PATH = process.env.DB_PATH || "data/app.db";
const API_KEY = process.env.BGG_API_KEY;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === "--all") out.all = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a.startsWith("--ids=")) out.ids = a.slice(6).split(",").map(Number).filter(Boolean);
    else if (a.startsWith("--sample=")) out.sample = Number(a.slice(9));
  }
  return out;
}

async function main() {
  if (!API_KEY) {
    console.error("BGG_API_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const db = openDb(DB_PATH);

  const targetRows = db.prepare(
    "SELECT id FROM game WHERE min_playtime IS NULL AND max_playtime IS NULL AND best_players IS NULL"
  ).all();
  const allTargetIds = targetRows.map((r) => r.id);
  console.log(`백필 대상(신규 필드 미채움) 게임 ${allTargetIds.length}개`);

  let ids;
  if (args.ids && args.ids.length) {
    ids = args.ids;
  } else if (args.sample) {
    ids = allTargetIds.slice(0, args.sample);
  } else if (args.all && args.confirm) {
    ids = allTargetIds;
  } else {
    console.log("대상만 출력하고 종료합니다. 실행하려면 --ids=<id,...> 또는 --sample=<n> 또는 --all --confirm 을 지정하세요.");
    db.close();
    return;
  }

  if (ids.length === 0) {
    console.log("채울 게임이 없습니다.");
    db.close();
    return;
  }

  console.log(`요청 대상 ${ids.length}개: ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? " ..." : ""}`);
  const details = await fetchThings(ids, API_KEY);
  const games = ids.filter((id) => details.has(id)).map((id) => ({ id, ...details.get(id) }));

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
