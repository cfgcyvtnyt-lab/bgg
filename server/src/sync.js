/**
 * 서버가 직접 BGG를 호출해 SQLite를 갱신한다 (파이썬 스크립트 2단계 방식을 1단계로 통합).
 * bgg_username이 있는 모든 user에 대해 컬렉션/상세정보/플레이 기록을 동기화한다.
 */
import { fetchCollection, fetchThings, fetchPlays } from "./bgg.js";
import { upsertGames, importPlays } from "./import-bgg.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(g) {
  if (g.own) return "보유";
  if (g.preordered) return "선주문";
  if (g.wishlist) return "위시리스트";
  if (g.prevOwned) return "방출 완료";
  return null;
}

// collection.price_paid/tags/note는 앱에서 사용자가 입력한 값이라 절대 덮어쓰지 않는다.
// BGG에서 오는 정보는 status뿐이라 그것만 반영: 기존 행이 있으면 status만 갱신, 없으면 새로 만든다.
// BGG는 "방출 예정/확정"을 표현하지 못한다. 팔기로 정했어도 아직 손에 있으면 own=1이라,
// BGG 상태를 그대로 내려받으면 사용자가 앱에서 정한 세분화된 상태가 '보유'로 뭉개진다.
// 그래서 이미 있는 행의 status는 건드리지 않고, BGG에 새로 나타난 게임만 추가한다.
// 앱에서 바꾼 상태를 BGG로 올리는 건 반대 방향(3단계 양방향 동기화)에서 처리한다.
function syncCollectionStatuses(db, games) {
  const exists = db.prepare("SELECT 1 FROM collection WHERE game_id = ? LIMIT 1");
  const insert = db.prepare("INSERT INTO collection (game_id, status) VALUES (?, ?)");

  let added = 0;
  for (const g of games) {
    const status = statusOf(g);
    if (!status || exists.get(g.id)) continue;
    insert.run(g.id, status);
    added++;
  }
  return { updated: 0, added };
}

async function syncUser(db, user, apiKey) {
  const collection = await fetchCollection(user.bgg_username, apiKey);
  await sleep(1000); // 레이트리밋(초당 2회) 여유

  const ids = collection.map((g) => g.id);
  const details = await fetchThings(ids, apiKey);
  const games = collection.map((g) => ({ ...g, ...(details.get(g.id) || {}) }));

  const gamesUpserted = upsertGames(db, games);
  const { updated: statusUpdated, added: statusAdded } = syncCollectionStatuses(db, games);

  await sleep(1000);
  const plays = await fetchPlays(user.bgg_username, apiKey);

  const knownGames = new Set(db.prepare("SELECT id FROM game").all().map((r) => r.id));
  const { added: playsAdded, stubbed } = importPlays(db, user.id, plays, knownGames);

  return {
    user: user.name,
    gamesUpserted,
    collectionStatusUpdated: statusUpdated,
    collectionStatusAdded: statusAdded,
    playsAdded,
    stubbedGames: stubbed,
  };
}

/** 모든 사용자를 순회하며 동기화한다. BGG_API_KEY가 없으면 건너뛴다. */
export async function runSync(db, apiKey) {
  if (!apiKey) {
    console.log("BGG_API_KEY가 없어 동기화를 건너뜁니다.");
    return { skipped: true, reason: "BGG_API_KEY 없음", users: [] };
  }

  const users = db
    .prepare("SELECT id, name, bgg_username FROM user WHERE bgg_username IS NOT NULL AND bgg_username != ''")
    .all();

  if (users.length === 0) {
    console.log("bgg_username이 등록된 사용자가 없어 동기화를 건너뜁니다.");
    return { skipped: true, reason: "동기화 대상 사용자 없음", users: [] };
  }

  const results = [];
  for (const user of users) {
    console.log(`BGG 동기화 시작: ${user.name} (${user.bgg_username})`);
    const result = await syncUser(db, user, apiKey);
    console.log(`BGG 동기화 완료: ${user.name} — ${JSON.stringify(result)}`);
    results.push(result);
    await sleep(1000);
  }

  return { skipped: false, users: results };
}
