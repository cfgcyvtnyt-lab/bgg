// 컬렉션 화면의 뷰/상태 필터, 정렬, 초성 인덱스 계산을 모아둔 순수 함수들.
// 컴포넌트에서 로직을 걷어내 테스트하기 쉽게 하려고 분리했다.
import type { CollectionListEntry } from "../api/types";

export type ViewKey = "all" | "unplayed_owned" | "played" | "played_or_owned" | "played_not_owned";
export type StatusKey = "보유" | "위시리스트" | "want_to_play" | "선주문" | "방출 예정" | "방출 확정" | "방출 완료";
export type FilterState = { kind: "view"; key: ViewKey } | { kind: "status"; key: StatusKey };

export const VIEW_DEFS: { key: ViewKey; label: string }[] = [
  { key: "all", label: "모든 게임" },
  { key: "unplayed_owned", label: "플레이하지 않은 소유 게임" },
  { key: "played", label: "플레이한 게임" },
  { key: "played_or_owned", label: "플레이했거나 소유함" },
  { key: "played_not_owned", label: "플레이했지만 미소유 게임" },
];

export const STATUS_DEFS: { key: StatusKey; label: string }[] = [
  { key: "보유", label: "소유한 게임" },
  { key: "위시리스트", label: "위시리스트" },
  { key: "want_to_play", label: "플레이 희망" },
  { key: "선주문", label: "선주문" },
  { key: "방출 예정", label: "방출 예정" },
  { key: "방출 확정", label: "방출 확정" },
  { key: "방출 완료", label: "방출 완료" },
];

export function filterLabel(f: FilterState): string {
  if (f.kind === "view") return VIEW_DEFS.find((v) => v.key === f.key)?.label ?? "모든 게임";
  return STATUS_DEFS.find((s) => s.key === f.key)?.label ?? f.key;
}

export function matchesFilter(e: CollectionListEntry, f: FilterState): boolean {
  if (f.kind === "status") {
    if (f.key === "want_to_play") return e.want_to_play === 1;
    return e.status === f.key;
  }
  switch (f.key) {
    case "all":
      return true;
    case "unplayed_owned":
      return e.status === "보유" && e.play_count === 0;
    case "played":
      return e.play_count > 0;
    case "played_or_owned":
      return e.status === "보유" || e.play_count > 0;
    case "played_not_owned":
      return e.play_count > 0 && e.status === null;
    default:
      return true;
  }
}

export type SortField =
  | "name" | "last_played" | "play_count"
  | "year" | "price_paid" | "playing_time" | "max_players"
  | "weight" | "my_rating" | "bgg_rating" | "bgg_rank";

export const PRIMARY_SORTS: { key: SortField; label: string }[] = [
  { key: "name", label: "알파벳순" },
  // 내림차순=최근 플레이한 순, 오름차순=가장 오래 안 한 순이 되므로 라벨에 방향 의미를 명시한다.
  { key: "last_played", label: "최근 플레이한 순" },
  { key: "play_count", label: "가장 많은 플레이" },
];

export const MORE_SORTS: { key: SortField; label: string }[] = [
  { key: "year", label: "출시연도" },
  { key: "price_paid", label: "구매 가격" },
  { key: "playing_time", label: "플레이 시간" },
  { key: "max_players", label: "공식 인원 수" },
  { key: "weight", label: "웨이트" },
  { key: "my_rating", label: "내 평점" },
  { key: "bgg_rating", label: "긱 평점" },
  { key: "bgg_rank", label: "긱 순위" },
];

export function sortFieldLabel(key: SortField): string {
  return [...PRIMARY_SORTS, ...MORE_SORTS].find((s) => s.key === key)?.label ?? key;
}

// 격자/목록 카드에 현재 정렬 기준 값을 보여주기 위한 표시용 포맷터.
// 이름순(기본)일 때는 null을 반환해서 카드가 기존처럼 플레이 수만 보여주게 한다.
export function sortDisplayValue(e: CollectionListEntry, field: SortField): string | null {
  switch (field) {
    case "name":
      return null;
    case "last_played":
      if (!e.last_played_at) return null;
      return new Date(e.last_played_at).toLocaleDateString("ko-KR");
    case "play_count":
      return `${e.play_count}회`;
    case "year":
      return e.year_published != null ? `${e.year_published}년` : null;
    case "price_paid":
      return e.price_paid != null ? `${e.price_paid.toLocaleString()}원` : null;
    case "playing_time":
      return e.playing_time != null ? `${e.playing_time}분` : null;
    case "max_players":
      return e.max_players != null ? `${e.max_players}인` : null;
    case "weight":
      return e.weight != null ? `웨이트 ${e.weight}` : null;
    case "my_rating":
      return e.my_rating != null ? `내 평점 ${e.my_rating}` : null;
    case "bgg_rating":
      return e.bgg_rating != null ? `긱 평점 ${e.bgg_rating}` : null;
    case "bgg_rank":
      return e.bgg_rank != null ? `긱 순위 ${e.bgg_rank}` : null;
    default:
      return null;
  }
}

function sortValue(e: CollectionListEntry, field: SortField): string | number | null {
  switch (field) {
    case "name": return e.game_name || "";
    case "last_played": return e.last_played_at;
    case "play_count": return e.play_count;
    case "year": return e.year_published ?? null;
    case "price_paid": return e.price_paid ?? null;
    case "playing_time": return e.playing_time ?? null;
    case "max_players": return e.max_players ?? null;
    case "weight": return e.weight ?? null;
    case "my_rating": return e.my_rating ?? null;
    case "bgg_rating": return e.bgg_rating ?? null;
    case "bgg_rank": return e.bgg_rank ?? null;
    default: return null;
  }
}

// 값이 없는 항목은 오름/내림 어느 쪽이든 항상 맨 뒤로 보낸다 (정렬 기준이 없다는 뜻이므로).
export function compareEntries(a: CollectionListEntry, b: CollectionListEntry, field: SortField, dir: "asc" | "desc"): number {
  if (field === "name") {
    const cmp = (a.game_name || "").localeCompare(b.game_name || "", "ko");
    return dir === "asc" ? cmp : -cmp;
  }
  const av = sortValue(a, field);
  const bv = sortValue(b, field);
  const aNull = av === null || av === undefined || av === "";
  const bNull = bv === null || bv === undefined || bv === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const cmp = av < bv ? -1 : av > bv ? 1 : 0;
  return dir === "asc" ? cmp : -cmp;
}

// 초성 기준 14그룹(쌍자음은 홑자음에 합침) + 영문 A-Z + 그 외 '#'.
const CHOSUNG = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
const CHOSUNG_TO_GROUP: Record<string, string> = {
  "ㄱ": "가", "ㄲ": "가", "ㄴ": "나", "ㄷ": "다", "ㄸ": "다", "ㄹ": "라", "ㅁ": "마",
  "ㅂ": "바", "ㅃ": "바", "ㅅ": "사", "ㅆ": "사", "ㅇ": "아", "ㅈ": "자", "ㅉ": "자",
  "ㅊ": "차", "ㅋ": "카", "ㅌ": "타", "ㅍ": "파", "ㅎ": "하",
};

export const INDEX_GROUPS = ["#", "가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];

export function groupOf(name: string | null | undefined): string {
  const ch = (name || "").trim()[0];
  if (!ch) return "#";
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const chosungIdx = Math.floor((code - 0xac00) / 588);
    return CHOSUNG_TO_GROUP[CHOSUNG[chosungIdx]] || "#";
  }
  const upper = ch.toUpperCase();
  if (upper >= "A" && upper <= "Z") return upper;
  return "#";
}
