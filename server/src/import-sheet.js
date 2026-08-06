// 구글시트에서 뽑은 개인 소장 데이터(sheet.json)를 collection 테이블에 적재한다.
// BGG 동기화(import-bgg.js)가 만든 collection 행은 price_paid/tags/note가 전부 NULL이라
// "빈 행"으로 간주하고 그 자리를 채우며, 같은 게임을 여러 번 사고판 이력은 별도 행으로 추가한다.
//
// 사용법: node src/import-sheet.js [sheet.json 경로]
import { openDb } from "./db.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DB_PATH = process.env.DB_PATH || "data/app.db";

function main() {
  const sheetPath = resolve(process.argv[2] || "../data/sheet.json");

  const raw = JSON.parse(readFileSync(sheetPath, "utf8"));
  const entries = raw.entries || [];

  const withId = entries.filter((e) => e.bggId != null);
  const skipped = entries.length - withId.length;

  const db = openDb(DB_PATH);

  // 게임별로 "빈 행"(BGG 동기화만 되고 개인 데이터가 없는 행)을 미리 모아둔다.
  // 여러 취득 이력을 채워야 하므로 하나 쓸 때마다 pool에서 제거한다.
  const blankPool = new Map(); // game_id -> [row, ...]
  for (const row of db
    .prepare(
      `SELECT id, game_id FROM collection
       WHERE price_paid IS NULL AND tags IS NULL AND note IS NULL`
    )
    .all()) {
    if (!blankPool.has(row.game_id)) blankPool.set(row.game_id, []);
    blankPool.get(row.game_id).push(row);
  }

  // status/price_paid만 비교하면 "빈 행"(price_paid/tags/note 전부 NULL)이 우연히
  // status와 price_paid(NULL)만 같아도 "이미 있음"으로 오판해 tags/note를 못 채우게 된다.
  // 그래서 tags/note/price_sold까지 전부 같아야 "이미 이 스크립트로 반영됨"으로 본다.
  const existsStmt = db.prepare(
    `SELECT id FROM collection
     WHERE game_id = ? AND status = ? AND price_paid IS ?
       AND price_sold IS ? AND tags IS ? AND note IS ?`
  );
  const updateStmt = db.prepare(
    `UPDATE collection SET status = ?, price_paid = ?, price_sold = ?, tags = ?, note = ?
     WHERE id = ?`
  );
  const insertStmt = db.prepare(
    `INSERT INTO collection (game_id, status, price_paid, price_sold, tags, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let updated = 0;
  let inserted = 0;
  let alreadyDone = 0;

  for (const e of withId) {
    const gameId = e.bggId;
    const status = e.status;
    const pricePaid = e.pricePaid ?? null;
    const priceSold = e.priceSold ?? null;
    const tags = e.tags && e.tags.length ? JSON.stringify(e.tags) : null;
    const note = e.note ?? null;

    // idempotent 처리: 같은 내용의 행이 이미 있으면 건너뛴다.
    const dup = existsStmt.get(gameId, status, pricePaid, priceSold, tags, note);
    if (dup) {
      alreadyDone++;
      continue;
    }

    const pool = blankPool.get(gameId);
    if (pool && pool.length > 0) {
      const row = pool.shift();
      updateStmt.run(status, pricePaid, priceSold, tags, note, row.id);
      updated++;
    } else {
      insertStmt.run(gameId, status, pricePaid, priceSold, tags, note);
      inserted++;
    }
  }

  console.log(
    `[import-sheet] entries=${entries.length} withBggId=${withId.length} skipped(noBggId)=${skipped}`
  );
  console.log(
    `[import-sheet] updated=${updated} inserted=${inserted} alreadySynced=${alreadyDone}`
  );

  const sum = db
    .prepare(
      `SELECT SUM(price_paid) paid, SUM(price_sold) sold FROM collection`
    )
    .get();
  console.log(`[import-sheet] total price_paid=${sum.paid} price_sold=${sum.sold}`);
}

main();
