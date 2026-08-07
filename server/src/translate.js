/**
 * 영문 게임 설명을 한국어로 옮긴다.
 *
 * 서버(주문형 번역)와 backfill-translations.js(일괄 채우기)가 같이 쓴다.
 * 무료 엔드포인트 두 개를 순서대로 시도한다 - 구글 gtx가 먼저, 막히면 MyMemory.
 */

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 문장 단위로 잘라 chunkChars 이내로 뭉친다. 구글/MyMemory 둘 다 한 번에 보낼 수 있는
// 길이가 제한적이라 공통으로 쓴다.
function splitIntoChunks(text, chunkChars) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > chunkChars) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? " " : "") + s;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// 구글 무료 gtx 엔드포인트. 공식 API 키가 필요 없는 대신 요즘 429로 자주 막힌다.
async function translateViaGoogle(text) {
  const chunks = splitIntoChunks(text, 1500);
  if (chunks.length === 0) return "";
  const parts = [];
  for (const chunk of chunks) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gt&sl=en&tl=ko&dt=t&q=${encodeURIComponent(chunk)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`구글 번역 요청 실패 (HTTP ${resp.status})`);
    const data = await resp.json();
    parts.push((data[0] || []).map((piece) => piece[0]).join(""));
  }
  return parts.join(" ");
}

// MyMemory API (키 불필요). 구글 gtx가 429로 막혔을 때 쓰는 폴백 - 한 번에 보낼 수 있는
// 길이가 500자 안팎으로 더 짧아서 청크를 작게 쪼개고, 요청 사이 300ms씩 쉬어 과호출을 피한다.
// de(이메일)를 같이 보내면 일일 한도가 1,000단어에서 10,000단어로 늘어난다.
// 공개 저장소라 주소는 코드에 두지 않고 환경변수(TRANSLATE_EMAIL)로 받는다.
async function translateViaMyMemory(text) {
  const email = process.env.TRANSLATE_EMAIL || "";
  const chunks = splitIntoChunks(text, 480);
  if (chunks.length === 0) return "";
  const parts = [];
  const de = email ? `&de=${encodeURIComponent(email)}` : "";
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleepMs(1200);
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunks[i])}&langpair=en|ko${de}`;

    // MyMemory는 짧은 시간에 몰아 보내면 HTTP 429로 막는다(일일 한도와는 다른 제한).
    // 몇 초 쉬면 풀리므로 점점 늘려가며 다시 시도한다.
    let resp = null;
    let wait = 3000;
    for (let attempt = 1; attempt <= 5; attempt++) {
      resp = await fetch(url);
      if (resp.status !== 429) break;
      if (attempt === 5) throw new Error("MyMemory 요청 속도 제한 (429)");
      await sleepMs(wait);
      wait = Math.min(wait * 2, 30000);
    }
    if (!resp.ok) throw new Error(`MyMemory 번역 요청 실패 (HTTP ${resp.status})`);
    const data = await resp.json();
    const translated = data?.responseData?.translatedText;
    // 한도를 다 쓰면 HTTP는 200이면서 본문 responseStatus가 429로 오고,
    // translatedText 자리에 경고 문구가 들어온다. 그대로 저장되지 않게 여기서 걸러낸다.
    if (data?.responseStatus !== 200 || !translated) {
      const msg = String(translated || "");
      if (/ALL AVAILABLE FREE TRANSLATIONS/i.test(msg)) {
        const err = new Error("MyMemory 일일 한도 소진");
        err.quotaExhausted = true;
        throw err;
      }
      throw new Error(`MyMemory 번역 실패 (${data?.responseStatus})`);
    }
    parts.push(translated);
  }
  return parts.join(" ");
}

// 구글 gtx 먼저 시도하고, 429 등으로 막히면 MyMemory로 폴백한다. 둘 다 실패하면 그대로 던져서
// 호출부가 조용히 실패 처리(영문 표시)하게 둔다.
export async function translateToKorean(text) {
  try {
    return await translateViaGoogle(text);
  } catch (err) {
    console.log(`구글 번역 실패, MyMemory로 폴백: ${err.message || err}`);
    return await translateViaMyMemory(text);
  }
}
