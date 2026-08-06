// BGG 게임 URL. 슬러그가 없으면 BGG가 뒤에 붙인 경로(/sleeves 등)를 슬러그로 착각해
// 게임 페이지로 리다이렉트해버린다. 그래서 하위 페이지로 갈 때는 슬러그가 반드시 필요하다.
// 슬러그는 영문 원제를 소문자·하이픈으로 바꾼 것이다.
// 예: "SETI: Search for Extraterrestrial Intelligence" -> seti-search-for-extraterrestrial-intelligence
function slugify(nameEn: string | null | undefined) {
  return (nameEn || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function bggGameUrl(id: number, nameEn?: string | null) {
  const slug = slugify(nameEn);
  return slug
    ? `https://boardgamegeek.com/boardgame/${id}/${slug}`
    : `https://boardgamegeek.com/boardgame/${id}`;
}

export function bggSleevesUrl(id: number, nameEn?: string | null) {
  const slug = slugify(nameEn);
  // 슬러그를 못 만들면 /sleeves를 붙여봐야 게임 페이지로 튕기므로 그냥 게임 페이지로 보낸다.
  return slug
    ? `https://boardgamegeek.com/boardgame/${id}/${slug}/sleeves`
    : `https://boardgamegeek.com/boardgame/${id}`;
}
