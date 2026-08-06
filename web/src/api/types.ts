// 서버 응답 타입. server/src/index.js 의 실제 응답 모양을 그대로 따른다.

export interface User {
  id: number;
  name: string;
}

export interface Game {
  id: number;
  name: string;
  name_en: string | null;
  custom_name?: string | null;
  aliases: string[];
  thumbnail: string | null;
  image: string | null;
  year_published: number | null;
  min_players: number | null;
  max_players: number | null;
  playing_time: number | null;
  weight: number | null;
  bgg_rating: number | null;
  bgg_rank: number | null;
  synced_at: string | null;
}

export interface GameOpponentRecord {
  name: string;
  games: number;
  myWins: number;
}

export interface GameStats {
  playCount: number;
  winRate: number | null; // 0~100 정수(%)
  avgDurationMin: number | null;
  lastPlayedAt: string | null;
  score: { best: number; worst: number; avg: number } | null;
  opponents: GameOpponentRecord[];
}

export interface CollectionEntry {
  id: number;
  game_id: number;
  status: string;
  price_paid: number | null;
  price_sold: number | null;
  tags: string[];
  note: string | null;
  acquired_at: string | null;
  created_at: string;
  // /api/collection 조인 결과에만 존재
  game_name?: string;
  game_name_en?: string | null;
  thumbnail?: string | null;
  image?: string | null;
  year_published?: number | null;
  min_players?: number | null;
  max_players?: number | null;
  playing_time?: number | null;
  weight?: number | null;
  bgg_rating?: number | null;
  bgg_rank?: number | null;
  // 요청 사용자(X-User-Id)의 개인 평점. 평가 안 했으면 null
  my_rating?: number | null;
}

export interface GameDetail extends Game {
  collectionHistory: CollectionEntry[];
  playCount: number;
  my_rating?: number | null;
  original_name?: string;
  stats?: GameStats | null;
}

export interface PlayPlayer {
  id?: number;
  play_id?: number;
  name: string;
  score: number | null;
  win: boolean | number;
  role?: string | null;
  team?: string | null;
  is_new?: boolean | number;
  start_position?: string | null;
}

export interface Play {
  id: number;
  user_id: number;
  game_id: number;
  game_name?: string;
  played_at: string;
  duration_min: number | null;
  location: string | null;
  comment: string | null;
  incomplete: number;
  is_coop: number;
  expansions: string[];
  players: PlayPlayer[];
}

export interface TopGame {
  game_id: number;
  game_name: string;
  count: number;
}

export interface WinRate {
  name: string;
  plays: number;
  wins: number;
  winRate: number;
}

export interface CostPerPlayRow {
  game_id: number;
  game_name: string;
  total_paid: number;
  plays: number;
  costPerPlay: number;
}

export interface Insights {
  totalPlays: number;
  distinctGames: number;
  totalMinutes: number;
  topGames: TopGame[];
  winRates: WinRate[];
  monthlyPlays: { month: string; count: number }[];
  byLocation: { location: string; count: number }[];
  hIndex: number;
  levels: { fives: number; dimes: number; quarters: number; centuries: number; thousands: number };
  bestStreak: number;
  ownedNotPlayed: { id: number; name: string }[];
  costPerPlay: { cheapest: CostPerPlayRow[]; priciest: CostPerPlayRow[] };
}

// POST/PATCH /api/plays 요청 바디. 서버는 is_coop/win 등을 truthy 값이면 다 받아준다.
export interface PlayInput {
  game_id?: number;
  played_at?: string;
  duration_min?: number | null;
  location?: string | null;
  comment?: string | null;
  is_coop?: boolean;
  expansions?: string[];
  players?: PlayPlayer[];
}

export interface NameAlias {
  id: number;
  kind: "player" | "location";
  alias: string;
  canonical: string;
}

export interface NameCount {
  name: string;
  count: number;
  canonical: string | null;
}

export interface BggSearchResult {
  id: number;
  name: string;
  yearPublished: number | null;
  inCollection: boolean;
}
