// BGG 평점/웨이트 색 티어. GameDetailPage 헤더와 GameCard 양쪽에서 같은 기준을 쓴다.

// 평점: >=8 진초록, 7~8 연초록, 6~7 올리브, 4~6 주황, <4 빨강
export function ratingColor(rating: number | null | undefined): string {
  if (rating == null) return "var(--muted)";
  if (rating >= 8) return "#1d804c";
  if (rating >= 7) return "#5cb85c";
  if (rating >= 6) return "#a0a51f";
  if (rating >= 4) return "#d67d1e";
  return "#d9534f";
}

// 웨이트(난이도): <2 초록, 2~3 청록, 3~4 주황, >=4 빨강
export function weightColor(weight: number | null | undefined): string {
  if (weight == null) return "var(--muted)";
  if (weight < 2) return "#5cb85c";
  if (weight < 3) return "#22b8cf";
  if (weight < 4) return "#d67d1e";
  return "#d9534f";
}
