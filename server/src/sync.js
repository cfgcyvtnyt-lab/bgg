/**
 * 서버가 직접 BGG를 호출해 SQLite를 갱신한다 (파이썬 스크립트 2단계 방식을 1단계로 통합).
 * bgg_username이 있는 모든 user에 대해 컬렉션/상세정보/플레이 기록을 동기화한다.
 */
import { fetchCollection, fetchThings, fetchPlays } from "./bgg.js";
import { upsertGames, importPlays } from "./import-bgg.js";

// 이 기간 안에 상세를 받아온 게임은 다시 요청하지 않는다. BGG 호출량을 줄이는 핵심 장치.
const DETAIL_TTL_DAYS = 14;

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

// 평점과 "플레이 희망"은 둘 다 사람마다 다른 값이라(각자 BGG 계정 기준) 공유 테이블인 collection이 아니라
// 사용자별 game_rating에 upsert한다. 예전에는 want_to_play를 collection에 썼는데, 공유 테이블이다 보니
// 나중에 동기화되는 사용자가 먼저 동기화된 사용자의 값을 밀어써버리는 버그가 있었다.
// - rating: myRating이 없는(평가 안 한) 게임은 건드리지 않는다(기존 값 유지).
// - want_to_play: BGG가 매 동기화마다 명확한 true/false를 주므로 항상 그대로 반영한다(꺼진 것도 0으로 갱신).
// 평점만 있고 want_to_play가 없던 행, 혹은 그 반대인 행도 같은 (user_id, game_id) 행에 합쳐 저장한다.
function syncUserGameFlags(db, userId, games) {
  const upsert = db.prepare(`
    INSERT INTO game_rating (user_id, game_id, rating, want_to_play) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, game_id) DO UPDATE SET
      want_to_play = excluded.want_to_play,
      rating = CASE WHEN excluded.rating IS NOT NULL THEN excluded.rating ELSE rating END
  `);
  let wantToPlayUpdated = 0;
  let ratingsUpdated = 0;
  for (const g of games) {
    const wantToPlay = g.wantToPlay ? 1 : 0;
    upsert.run(userId, g.id, g.myRating ?? null, wantToPlay);
    if (wantToPlay) wantToPlayUpdated++;
    if (g.myRating != null) ratingsUpdated++;
  }
  return { wantToPlayUpdated, ratingsUpdated };
}

async function syncUser(db, user, apiKey) {
  const collection = await fetchCollection(user.bgg_username, apiKey);
  await sleep(1000); // 레이트리밋(초당 2회) 여유

  // 게임 메타데이터(이름·썸네일·인원수 등)는 거의 바뀌지 않는데 매번 401개를 다시 받으면
  // 동기화 한 번에 thing 호출만 21회다. BGG는 초당 2회 권장에 넘치면 IP를 막으므로,
  // 최근에 받아온 게임은 건너뛰고 새 게임과 오래된 것만 갱신한다.
  const ids = collection.map((g) => g.id);
  const fresh = new Set(
    db.prepare(`
      SELECT id FROM game
      WHERE synced_at IS NOT NULL
        AND synced_at > datetime('now', '-${DETAIL_TTL_DAYS} days')
    `).all().map((r) => r.id)
  );
  const staleIds = ids.filter((id) => !fresh.has(id));
  const details = staleIds.length ? await fetchThings(staleIds, apiKey) : new Map();
  const games = collection.map((g) => ({ ...g, ...(details.get(g.id) || {}) }));

  // 상세를 새로 받지 않은 게임은 기존 값을 덮어쓰지 않도록 제외한다.
  const gamesUpserted = upsertGames(db, games.filter((g) => details.has(g.id)));
  const { updated: statusUpdated, added: statusAdded } = syncCollectionStatuses(db, games);
  const { wantToPlayUpdated, ratingsUpdated } = syncUserGameFlags(db, user.id, games);

  await sleep(1000);
  const plays = await fetchPlays(user.bgg_username, apiKey);

  const knownGames = new Set(db.prepare("SELECT id FROM game").all().map((r) => r.id));
  const { added: playsAdded, stubbed } = importPlays(db, user.id, plays, knownGames);

  return {
    user: user.name,
    gamesUpserted,
    collectionStatusUpdated: statusUpdated,
    collectionStatusAdded: statusAdded,
    wantToPlayUpdated,
    ratingsUpdated,
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
