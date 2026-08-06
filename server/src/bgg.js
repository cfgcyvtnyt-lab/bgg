/**
 * BGG XML API2 클라이언트. 의존성 추가가 금지라 XML은 정규식으로 직접 파싱한다
 * (index.js의 /api/search가 이미 같은 방식을 쓰고 있음).
 *
 * scripts/fetch_bgg.py, scripts/fetch_plays.py의 로직을 그대로 옮긴 것 —
 * 필드 의미와 재시도/레이트리밋 규칙은 그쪽 주석을 참고.
 */
const BASE = "https://boardgamegeek.com/xmlapi2";
const BATCH = 20; // thing 엔드포인트가 한 번에 받는 최대 id 수
const RATE_DELAY_MS = 1000; // BGG 권장 레이트리밋(초당 2회)보다 여유 있게
const HANGUL = /[가-힣]/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXmlEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function parseAttrs(s) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = decodeXmlEntities(m[2]);
  return attrs;
}

// 자기 닫힘(<tag .../>) 또는 여는 태그(<tag ...>)의 속성만 필요할 때 사용
function firstTagAttrs(xml, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, "i");
  const m = xml.match(re);
  return m ? parseAttrs(m[1]) : null;
}

function tagText(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

function toNum(v, cast) {
  if (v === undefined || v === null || v === "") return null;
  const n = cast === parseInt ? parseInt(v, 10) : parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * 202(준비 중)를 폴링하고, 401/403은 즉시 중단한다.
 * fetch_bgg.py의 fetch_xml()과 동일한 재시도 정책.
 */
async function fetchXml(url, apiKey, tries = 10) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (resp.status === 200) return resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`BGG 인증 실패(HTTP ${resp.status})`);
    }
    console.log(`  HTTP ${resp.status} — ${attempt}/${tries}, 10초 후 재시도`);
    await sleep(10000);
  }
  throw new Error(`최종 실패: ${url}`);
}

function extractItems(xml) {
  const items = [];
  const re = /<item\b([^>]*)>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) items.push({ attrs: parseAttrs(m[1]), body: m[2] });
  return items;
}

/** 소장/위시리스트 등 개인 상태와 내 평점을 가져온다. */
export async function fetchCollection(username, apiKey) {
  const url = `${BASE}/collection?username=${encodeURIComponent(username)}&subtype=boardgame&stats=1`;
  const xml = await fetchXml(url, apiKey);

  const games = [];
  for (const { attrs, body } of extractItems(xml)) {
    const id = toNum(attrs.objectid, parseInt);
    if (id === null) continue;

    const ratingAttrs = firstTagAttrs(body, "rating");
    const myRating = ratingAttrs ? toNum(ratingAttrs.value, parseFloat) : null;
    const status = firstTagAttrs(body, "status") || {};

    games.push({
      id,
      name: tagText(body, "name") || "",
      yearPublished: toNum(tagText(body, "yearpublished"), parseInt),
      myRating,
      numPlays: toNum(tagText(body, "numplays"), parseInt) || 0,
      own: status.own === "1",
      prevOwned: status.prevowned === "1",
      wishlist: status.wishlist === "1",
      preordered: status.preordered === "1",
      wantToPlay: status.wanttoplay === "1",
    });
  }
  return games;
}

/** 썸네일·인원수·플레이시간·무게·순위·다국어 이름을 가져온다. 20개씩 배치 호출. */
export async function fetchThings(ids, apiKey) {
  const details = new Map();
  for (let start = 0; start < ids.length; start += BATCH) {
    const chunk = ids.slice(start, start + BATCH);
    const url = `${BASE}/thing?id=${chunk.join(",")}&stats=1`;
    const xml = await fetchXml(url, apiKey);

    for (const { attrs, body } of extractItems(xml)) {
      const id = toNum(attrs.id, parseInt);
      if (id === null) continue;

      const names = [];
      const nameRe = /<name\b([^>]*)\/>/g;
      let nm;
      while ((nm = nameRe.exec(body))) names.push(parseAttrs(nm[1]));

      let primaryName = null;
      const alternateNames = [];
      const koreanNames = [];
      for (const n of names) {
        if (n.type === "primary") primaryName = n.value;
        else if (n.value) alternateNames.push(n.value);
        if (n.value && HANGUL.test(n.value)) koreanNames.push(n.value);
      }

      const ratingsBody = tagText(body, "ratings") ?? body;
      const average = toNum(firstTagAttrs(ratingsBody, "average")?.value, parseFloat);
      const weight = toNum(firstTagAttrs(ratingsBody, "averageweight")?.value, parseFloat);

      let bggRank = null;
      const rankRe = /<rank\b([^>]*)\/>/g;
      let rm;
      while ((rm = rankRe.exec(ratingsBody))) {
        const r = parseAttrs(rm[1]);
        if (r.name === "boardgame") bggRank = toNum(r.value, parseInt);
      }

      details.set(id, {
        primaryName,
        koreanNames,
        alternateNames,
        thumbnail: tagText(body, "thumbnail"),
        image: tagText(body, "image"),
        minPlayers: toNum(firstTagAttrs(body, "minplayers")?.value, parseInt),
        maxPlayers: toNum(firstTagAttrs(body, "maxplayers")?.value, parseInt),
        playingTime: toNum(firstTagAttrs(body, "playingtime")?.value, parseInt),
        weight: weight ? Math.round(weight * 100) / 100 : null,
        bggRating: average ? Math.round(average * 100) / 100 : null,
        bggRank,
      });
    }

    if (start + BATCH < ids.length) await sleep(RATE_DELAY_MS);
  }
  return details;
}

function parsePlay(attrs, body) {
  const itemAttrs = firstTagAttrs(body, "item") || {};
  const players = [];
  const playerRe = /<player\b([^>]*)\/>/g;
  let pm;
  while ((pm = playerRe.exec(body))) {
    const p = parseAttrs(pm[1]);
    players.push({
      name: p.name || null,
      username: p.username || null,
      score: toNum(p.score, parseFloat),
      win: p.win === "1",
      new: p.new === "1",
    });
  }

  return {
    id: toNum(attrs.id, parseInt),
    date: attrs.date || null,
    quantity: toNum(attrs.quantity, parseInt) ?? 1,
    length: toNum(attrs.length, parseInt) ?? 0,
    incomplete: attrs.incomplete === "1",
    location: attrs.location || null,
    gameId: toNum(itemAttrs.objectid, parseInt),
    gameName: itemAttrs.name || null,
    comment: tagText(body, "comments"),
    players,
  };
}

/** 플레이 기록 전체를 페이지 단위(100건/페이지)로 순회한다. */
export async function fetchPlays(username, apiKey) {
  const playRe = /<play\b([^>]*?)(?:\/>|>([\s\S]*?)<\/play>)/g;

  function parsePage(xml) {
    const totalMatch = xml.match(/<plays\b[^>]*\btotal="(\d+)"/);
    const total = totalMatch ? Number(totalMatch[1]) : 0;
    const plays = [];
    let m;
    playRe.lastIndex = 0;
    while ((m = playRe.exec(xml))) plays.push(parsePlay(parseAttrs(m[1]), m[2] || ""));
    return { total, plays };
  }

  const firstUrl = `${BASE}/plays?username=${encodeURIComponent(username)}&page=1`;
  const firstXml = await fetchXml(firstUrl, apiKey);
  const { total, plays } = parsePage(firstXml);
  const pages = Math.ceil(total / 100);

  for (let page = 2; page <= pages; page++) {
    await sleep(RATE_DELAY_MS);
    const url = `${BASE}/plays?username=${encodeURIComponent(username)}&page=${page}`;
    const xml = await fetchXml(url, apiKey);
    plays.push(...parsePage(xml).plays);
  }
  return plays;
}

export const __internal = { sleep, RATE_DELAY_MS };
