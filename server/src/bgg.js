/**
 * BGG XML API2 클라이언트. 의존성 추가가 금지라 XML은 정규식으로 직접 파싱한다
 * (index.js의 /api/search가 이미 같은 방식을 쓰고 있음).
 *
 * 여기서 받아오는 건 "게임 정보"뿐이다 - 게임을 새로 추가할 때 썸네일·인원수·순위 등을
 * 채우고, 대체 이미지 후보를 보여주는 용도. 계정 동기화(내 컬렉션·평점·플레이 받아오기)는
 * 없앴다. 기록은 전부 이 앱에서 하므로 BGG 쪽 내 정보는 앱보다 낡았을 뿐이고,
 * 받아오면 앱에서 정한 값을 덮을 위험만 있었다.
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

// <link type="boardgamedesigner" id="..." value="..."/> 처럼 반복되는 link 태그 중
// 특정 type의 value만 모은다. 디자이너/아티스트/카테고리/메커니즘이 전부 이 형태다.
function collectLinkValues(body, linkType) {
  const values = [];
  const re = /<link\b([^>]*)\/>/g;
  let m;
  while ((m = re.exec(body))) {
    const attrs = parseAttrs(m[1]);
    if (attrs.type === linkType && attrs.value) values.push(attrs.value);
  }
  return values;
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
 *
 * BGG는 초당 2회를 권장하며 넘기면 429를 주고, 계속 두드리면 IP를 막는다.
 * 그래서 429는 다른 오류와 달리 Retry-After를 따르고 지수 백오프로 물러난다.
 * 403은 인증 실패일 수도 있지만 IP 차단일 수도 있어 어느 쪽이든 즉시 멈춘다.
 */
async function fetchXml(url, apiKey, tries = 10) {
  let backoff = 5000;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // 누가 부르는지 밝혀둔다. 익명 요청은 봇으로 간주되기 쉽다.
        "User-Agent": "bgg-collection-manager/0.1 (+https://github.com/cfgcyvtnyt-lab/bgg)",
      },
    });
    if (resp.status === 200) return resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`BGG 접근 거부(HTTP ${resp.status}). 키가 잘못됐거나 IP가 차단됐을 수 있다.`);
    }

    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoff;
      console.log(`  429 레이트리밋 — ${Math.round(wait / 1000)}초 대기 (${attempt}/${tries})`);
      await sleep(wait);
      backoff = Math.min(backoff * 2, 120000);
      continue;
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
      const usersRated = toNum(firstTagAttrs(ratingsBody, "usersrated")?.value, parseInt);

      // <rank type="subtype" name="..." friendlyname="..." value="..."/> 전부 모은다.
      // name="boardgame"(전체 순위)은 bggRank에 이미 있으니 sub_ranks에서는 제외한다.
      let bggRank = null;
      const subRanks = [];
      const rankRe = /<rank\b([^>]*)\/>/g;
      let rm;
      while ((rm = rankRe.exec(ratingsBody))) {
        const r = parseAttrs(rm[1]);
        if (r.name === "boardgame") { bggRank = toNum(r.value, parseInt); continue; }
        const v = toNum(r.value, parseInt);
        if (v != null) subRanks.push({ name: r.friendlyname || r.name, value: v });
      }

      // 커뮤니티 추천 인원수 투표: numplayers마다 Best/Recommended/Not Recommended 세 표 중
      // Best가 최다인(=BGG가 "bestwith"로 치는) 인원수들을 모아 "1-2" 형태로 만든다.
      // (전체 numplayers 중 Best 득표수 최댓값만 보면 안 된다 - 예: 마블 챔피언스는 2인의 Best 표가
      // 1인보다 많지만 1인도 Best가 플루럴리티라 둘 다 "베스트"에 포함되어야 "1-2"가 나온다.)
      let bestPlayers = null;
      const pollMatch = body.match(/<poll\b[^>]*name="suggested_numplayers"[^>]*>([\s\S]*?)<\/poll>/);
      if (pollMatch) {
        const resultsRe = /<results\b([^>]*)>([\s\S]*?)<\/results>/g;
        const bestNums = [];
        let pm;
        while ((pm = resultsRe.exec(pollMatch[1]))) {
          const numplayers = parseAttrs(pm[1]).numplayers;
          const votes = {};
          const resultRe = /<result\b([^>]*)\/>/g;
          let rr;
          while ((rr = resultRe.exec(pm[2]))) {
            const ra = parseAttrs(rr[1]);
            votes[ra.value] = toNum(ra.numvotes, parseInt) || 0;
          }
          const best = votes.Best || 0;
          const rec = votes.Recommended || 0;
          const notRec = votes["Not Recommended"] || 0;
          if (best > 0 && best >= rec && best >= notRec) bestNums.push(numplayers);
        }
        if (bestNums.length) {
          const nums = bestNums.map((n) => n.replace(/\+$/, "")).sort((a, b) => Number(a) - Number(b));
          bestPlayers = nums.length === 1 ? nums[0] : `${nums[0]}-${nums[nums.length - 1]}`;
        }
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
        minPlaytime: toNum(firstTagAttrs(body, "minplaytime")?.value, parseInt),
        maxPlaytime: toNum(firstTagAttrs(body, "maxplaytime")?.value, parseInt),
        minAge: toNum(firstTagAttrs(body, "minage")?.value, parseInt),
        weight: weight ? Math.round(weight * 100) / 100 : null,
        bggRating: average ? Math.round(average * 100) / 100 : null,
        bggRank,
        usersRated,
        subRanks,
        bestPlayers,
        publishers: collectLinkValues(body, "boardgamepublisher").slice(0, 3),
        // <item type="boardgame|boardgameexpansion" ...> - 컬렉션에서 확장 숨기기에 쓴다.
        itemType: attrs.type || null,
        description: tagText(body, "description"),
        designers: collectLinkValues(body, "boardgamedesigner"),
        artists: collectLinkValues(body, "boardgameartist"),
        categories: collectLinkValues(body, "boardgamecategory"),
        mechanics: collectLinkValues(body, "boardgamemechanic"),
      });
    }

    if (start + BATCH < ids.length) await sleep(RATE_DELAY_MS);
  }
  return details;
}

/**
 * thing?versions=1 응답의 <versions> 안에서 각 버전(언어판 등)의 이름·썸네일·이미지를 뽑는다.
 * 대체 이미지 선택 기능(게임 상세)용 - custom_image에 저장할 URL 후보를 준다.
 */
export async function fetchVersions(id, apiKey) {
  const url = `${BASE}/thing?id=${id}&versions=1`;
  const xml = await fetchXml(url, apiKey);

  const versionsMatch = xml.match(/<versions>([\s\S]*?)<\/versions>/);
  if (!versionsMatch) return [];

  const versions = [];
  for (const { attrs, body } of extractItems(versionsMatch[1])) {
    if (attrs.type && attrs.type !== "boardgameversion") continue;
    const nameAttrs = firstTagAttrs(body, "name");
    const image = tagText(body, "image");
    const thumbnail = tagText(body, "thumbnail");
    if (!image && !thumbnail) continue; // 이미지가 없는 버전은 고를 이유가 없다
    versions.push({
      id: toNum(attrs.id, parseInt),
      name: nameAttrs?.value || null,
      thumbnail,
      image,
    });
  }
  return versions;
}

export const __internal = { sleep, RATE_DELAY_MS };
