/**
 * 컬렉션에 있는 게임의 영문 설명을 한 번에 번역해 description_ko에 채운다.
 *
 * 한 번 채워두면 앱에서 다시 번역하지 않는다(캐시). 이후 새로 추가되는 게임만
 * 게임 상세를 열 때 그때그때 번역돼 같은 자리에 쌓인다.
 *
 * 무료 API라 일일 한도가 있어서 중간에 막힐 수 있다. 그때는 지금까지 한 것까지만
 * 저장하고 깔끔하게 멈춘다 - 다음 날 다시 실행하면 남은 것부터 이어서 한다.
 *
 * 사용법: TRANSLATE_EMAIL=주소 node src/backfill-translations.js [최대개수]
 */
import { DatabaseSync } from "node:sqlite";
import { translateToKorean } from "./translate.js";

const DB_PATH = process.env.DB_PATH || "data/app.db";
const limit = Number(process.argv[2]) || Infinity;

async function main() {
  const db = new DatabaseSync(DB_PATH);

  // 컬렉션에 있고, 원문은 있는데 번역이 아직 없는 게임만.
  const rows = db.prepare(`
    SELECT g.id, g.name, g.description
    FROM collection c
    JOIN game g ON g.id = c.game_id
    WHERE g.description IS NOT NULL AND g.description != ''
      AND (g.description_ko IS NULL OR g.description_ko = '')
    ORDER BY LENGTH(g.description) ASC
  `).all();

  const targets = rows.slice(0, limit === Infinity ? rows.length : limit);
  console.log(`번역 대상 ${rows.length}개 중 ${targets.length}개 시도`);

  const save = db.prepare("UPDATE game SET description_ko = ? WHERE id = ?");
  let done = 0;
  let failed = 0;

  for (const g of targets) {
    // 게임 사이에도 쉬어간다. 붙여서 보내면 MyMemory가 429로 막는다.
    if (done + failed > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const ko = await translateToKorean(g.description);
      if (!ko || !ko.trim()) throw new Error("빈 결과");
      save.run(ko, g.id);
      done++;
      console.log(`  [${done}/${targets.length}] ${g.name}`);
    } catch (err) {
      if (err.quotaExhausted) {
        console.log(`\n일일 한도 소진 - 여기까지 저장하고 멈춥니다. 내일 다시 실행하면 이어서 합니다.`);
        break;
      }
      failed++;
      console.log(`  실패: ${g.name} - ${err.message || err}`);
      // 연달아 실패하면 서비스가 막힌 것이므로 그만둔다
      if (failed >= 5) {
        console.log("\n연속 실패가 잦아 중단합니다.");
        break;
      }
    }
  }

  const left = db.prepare(`
    SELECT COUNT(*) c FROM collection c
    JOIN game g ON g.id = c.game_id
    WHERE g.description IS NOT NULL AND g.description != ''
      AND (g.description_ko IS NULL OR g.description_ko = '')
  `).get().c;

  console.log(`\n번역 완료 ${done}개 · 실패 ${failed}개 · 남은 것 ${left}개`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
