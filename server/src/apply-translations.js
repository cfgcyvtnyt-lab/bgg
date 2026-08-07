/**
 * 직접 번역한 설명을 description_ko에 넣는다.
 *
 * 무료 번역 API(구글 gtx·MyMemory)가 둘 다 막혀 있어서, 이미 컬렉션에 있는 게임은
 * 번역문을 직접 만들어 캐시에 채워 넣는다. 이후 새로 추가되는 게임만 앱에서
 * 열 때 자동 번역돼 같은 자리에 쌓인다.
 *
 * 사용법: node src/apply-translations.js <번역 JSON 경로>
 *   JSON 형식: { "게임id": "한국어 설명", ... }
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "data/app.db";
const jsonPath = process.argv[2];

if (!jsonPath) {
  console.error("사용법: node src/apply-translations.js <번역 JSON 경로>");
  process.exit(1);
}

const map = JSON.parse(readFileSync(jsonPath, "utf-8"));
const db = new DatabaseSync(DB_PATH);
const save = db.prepare("UPDATE game SET description_ko = ? WHERE id = ?");
const get = db.prepare("SELECT name FROM game WHERE id = ?");

let done = 0;
let missing = 0;
for (const [idStr, ko] of Object.entries(map)) {
  const id = Number(idStr);
  const row = get.get(id);
  if (!row) {
    console.log(`  없는 게임 id: ${id}`);
    missing++;
    continue;
  }
  save.run(ko, id);
  done++;
  console.log(`  ${row.name}`);
}

const left = db.prepare(`
  SELECT COUNT(*) c FROM collection c
  JOIN game g ON g.id = c.game_id
  WHERE g.description IS NOT NULL AND g.description != ''
    AND (g.description_ko IS NULL OR g.description_ko = '')
`).get().c;

console.log(`\n적용 ${done}개 · 없는 id ${missing}개 · 컬렉션에서 남은 것 ${left}개`);
db.close();
