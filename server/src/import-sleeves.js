// 구글시트 내보내기 HTML(슬리브.html)을 파싱해 sleeve 테이블에 적재하는 일회성 스크립트.
// 표 구조(2행이 헤더): 번호 | 사이즈 | 제조사 | 종류 | 두께(mm) | 수량(장) | 내용 | (빈칸) | 업데이트날짜
// 재실행해도 중복되지 않도록 매번 전체 삭제 후 재삽입한다(공유 테이블이라 idempotent 여부가 중요).
//
// 사용법: node src/import-sleeves.js [슬리브.html 경로]
import { openDb } from "./db.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DB_PATH = process.env.DB_PATH || "data/app.db";

// 태그 제거 + HTML 엔티티 디코딩 + 공백 정리. 제조사 셀은 <span> 뱃지로 감싸져 있어 태그만 벗기면 텍스트가 남는다.
function cellText(html) {
  const text = html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/​/g, "") // zero-width space (빈 셀에 섞여 나옴)
    .trim();
  return text;
}

function parseRows(html) {
  const trMatches = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const rows = [];
  for (const tr of trMatches) {
    const tdMatches = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tdMatches.length < 6) continue; // 헤더/빈 행 등
    const cells = tdMatches.map(cellText);
    rows.push(cells);
  }
  return rows;
}

function main() {
  const htmlPath = resolve(
    process.argv[2] || "../asset/보드게임 콜렉션/슬리브.html"
  );
  const html = readFileSync(htmlPath, "utf8");
  const allRows = parseRows(html);

  // 앞 두 행(빈 행, 헤더 행)을 건너뛰고 데이터 행만 취급.
  // 컬럼: [0]번호 [1]사이즈 [2]제조사 [3]종류 [4]두께 [5]수량 [6]내용 [7]?  [8]업데이트날짜
  const dataRows = allRows.slice(2);

  const parsed = [];
  for (const cells of dataRows) {
    const size = cells[1];
    if (!size) continue; // 사이즈 없는 행은 메모용 잡담 행이라 건너뜀 (예: "백로성듀얼44x68 ? 남은거개수확인")
    const maker = cells[2] || null;
    const kind = cells[3] || null;
    const thickness = cells[4] || null;
    const quantity = parseInt(cells[5], 10) || 0;
    const note = cells[6] || null;
    const updatedAt = cells[8] || null;
    parsed.push({ size, maker, kind, thickness, quantity, note, updatedAt });
  }

  const db = openDb(DB_PATH);
  db.exec("DELETE FROM sleeve");
  const insert = db.prepare(
    `INSERT INTO sleeve (size, maker, kind, thickness, quantity, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of parsed) {
    insert.run(r.size, r.maker, r.kind, r.thickness, r.quantity, r.note, r.updatedAt);
  }

  console.log(`[import-sleeves] parsedRows=${dataRows.length} inserted=${parsed.length}`);
  const count = db.prepare("SELECT COUNT(*) c FROM sleeve").get().c;
  console.log(`[import-sleeves] sleeve table count=${count}`);
}

main();
