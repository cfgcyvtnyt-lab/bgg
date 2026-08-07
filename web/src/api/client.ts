import type {
  BgaImportResult,
  BgaPlayItem,
  BgaSessionRow,
  BggSearchResult,
  Challenge,
  ChallengeTarget,
  CollectionEntry,
  CollectionListEntry,
  FeedResponse,
  Game,
  GameDetail,
  GameSleeve,
  GameVersion,
  Insights,
  LocationCount,
  Photo,
  Play,
  PlayDetail,
  PlayInput,
  ScoreTemplate,
  Sleeve,
  CleanupResult,
  TagCount,
  User,
} from "./types";
import { clearListCache } from "../utils/listCache";

const BASE = "/api";

// tags 필드는 엔드포인트에 따라 이미 배열이거나(파싱됨) JSON 문자열이거나(원본) 둘 다 온다.
function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// 사용자 ID는 localStorage에서 매 요청마다 읽는다.
// (설정에서 전환하면 다음 요청부터 바로 반영되어야 하므로 모듈 상단에 캐싱하지 않는다)
function getUserId(): string | null {
  return localStorage.getItem("bgg_user_id");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const userId = getUserId();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (userId) headers["X-User-Id"] = userId;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    let msg = `요청 실패 (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      // JSON이 아니면 기본 메시지 사용
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  // 뭔가를 바꾸는 요청이 성공했으면 화면들이 들고 있는 목록 캐시를 비운다.
  // 호출처마다 직접 비우게 하면(기록 저장, 컬렉션 수정, 평점, 임포트...) 하나씩 빠뜨리게 된다.
  // 번역·청소처럼 목록과 무관한 POST도 같이 비우지만, 다시 받는 비용이 몇십 ms라 문제없다.
  if ((options.method || "GET").toUpperCase() !== "GET") clearListCache();
  return res.json();
}

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  users: () => request<User[]>("/users"),
  updateUser: (id: number, body: { default_location: string | null }) =>
    request<User>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  games: (q?: string, limit = 50, offset = 0) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return request<Game[]>(`/games?${params}`);
  },
  game: async (id: number) => {
    const g = await request<GameDetail>(`/games/${id}`);
    // /api/games/:id 의 collectionHistory는 원본 row라 tags가 JSON 문자열째로 온다
    // (/api/collection과 다르게 서버가 파싱을 안 해줌). 여기서 배열로 맞춰준다.
    return {
      ...g,
      collectionHistory: g.collectionHistory.map((h) => ({
        ...h,
        tags: normalizeTags(h.tags),
      })),
    };
  },

  updateGame: (id: number, body: { custom_name?: string; coop_default?: boolean; win_condition?: "high" | "low" | "none"; custom_image?: string | null }) =>
    request<GameDetail>(`/games/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  gameVersions: (id: number) => request<GameVersion[]>(`/games/${id}/versions`),
  translateGame: (id: number) =>
    request<{ description_ko: string }>(`/games/${id}/translate`, { method: "POST" }),
  setRating: (id: number, rating: number | null) =>
    request<{ my_rating: number | null }>(`/games/${id}/rating`, { method: "PATCH", body: JSON.stringify({ rating }) }),
  setWantToPlay: (id: number, wantToPlay: boolean) =>
    request<{ want_to_play: number }>(`/games/${id}/want-to-play`, {
      method: "PATCH",
      body: JSON.stringify({ want_to_play: wantToPlay }),
    }),

  tags: () => request<TagCount[]>("/tags"),

  scoreTemplate: (gameId: number) =>
    request<ScoreTemplate | null>(`/games/${gameId}/score-template`),
  saveScoreTemplate: (gameId: number, fields: string[]) =>
    request<ScoreTemplate>(`/games/${gameId}/score-template`, { method: "PUT", body: JSON.stringify({ fields }) }),
  deleteScoreTemplate: (gameId: number) =>
    request<{ ok: boolean }>(`/games/${gameId}/score-template`, { method: "DELETE" }),

  collection: (status?: string, tag?: string, includeExpansions?: boolean) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (tag) params.set("tag", tag);
    if (includeExpansions) params.set("include_expansions", "1");
    return request<CollectionListEntry[]>(`/collection?${params}`);
  },
  addCollection: (body: Partial<CollectionEntry> & { game_id: number }) =>
    request<CollectionEntry>("/collection", { method: "POST", body: JSON.stringify(body) }),
  updateCollection: (id: number, body: Partial<CollectionEntry>) =>
    request<CollectionEntry>(`/collection/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCollection: (id: number) =>
    request<{ ok: boolean }>(`/collection/${id}`, { method: "DELETE" }),

  plays: (params: { game_id?: number; from?: string; to?: string; limit?: number; offset?: number } = {}) => {
    const sp = new URLSearchParams();
    if (params.game_id) sp.set("game_id", String(params.game_id));
    if (params.from) sp.set("from", params.from);
    if (params.to) sp.set("to", params.to);
    sp.set("limit", String(params.limit ?? 500));
    sp.set("offset", String(params.offset ?? 0));
    return request<Play[]>(`/plays?${sp}`);
  },
  play: (id: number) => request<PlayDetail>(`/plays/${id}`),
  addPlay: (body: PlayInput) =>
    request<Play>("/plays", { method: "POST", body: JSON.stringify(body) }),
  updatePlay: (id: number, body: PlayInput) =>
    request<Play>(`/plays/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deletePlay: (id: number) =>
    request<{ ok: boolean }>(`/plays/${id}`, { method: "DELETE" }),

  locations: () => request<LocationCount[]>("/locations"),
  renameLocation: (from: string, to: string) =>
    request<{ ok: boolean; changed: number }>("/locations", { method: "PATCH", body: JSON.stringify({ from, to }) }),
  saveLocation: (name: string, body: { online?: boolean } = {}) =>
    request<{ ok: boolean }>("/locations", { method: "POST", body: JSON.stringify({ name, ...body }) }),
  deleteLocation: (name: string) =>
    request<{ ok: boolean }>(`/locations?name=${encodeURIComponent(name)}`, { method: "DELETE" }),

  insights: (params: { from?: string; to?: string; bucket?: "day" | "month" | "year" } = {}) => {
    const sp = new URLSearchParams();
    if (params.from) sp.set("from", params.from);
    if (params.to) sp.set("to", params.to);
    if (params.bucket) sp.set("bucket", params.bucket);
    const qs = sp.toString();
    return request<Insights>(`/insights${qs ? `?${qs}` : ""}`);
  },

  // 설정 화면 "정리" 버튼용. GET은 dry run이라 무엇을 얼마나 지울지만 알려준다.
  cleanupStatus: () => request<CleanupResult>("/cleanup"),
  cleanup: () => request<CleanupResult>("/cleanup", { method: "POST" }),

  search: (q: string) => request<BggSearchResult[]>(`/search?${new URLSearchParams({ q })}`),

  // ---------- BGA 임포트 ----------
  // 비밀번호는 로그인 요청에만 실려 가고 서버는 세션만 메모리에 들고 있는다(저장 안 함).
  bgaLogin: (userId: number, username: string, password: string) =>
    request<{ ok: boolean; playerId: number; playerName: string }>("/bga/login", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, username, password }),
    }),
  bgaSession: () => request<BgaSessionRow[]>("/bga/session"),
  bgaPlays: (userId: number, opts: { pages?: number; player?: number } = {}) => {
    const sp = new URLSearchParams({ user_id: String(userId) });
    if (opts.pages) sp.set("pages", String(opts.pages));
    if (opts.player) sp.set("player", String(opts.player));
    return request<{ total: number; items: BgaPlayItem[] }>(`/bga/plays?${sp}`);
  },
  bgaImport: (body: {
    user_id: number;
    table_ids: number[];
    mapping: Record<string, number | null>;
    remember?: boolean;
    player?: number;
  }) =>
    request<{ ok: boolean; added: number; results: BgaImportResult[] }>("/bga/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ---------- 사진 ----------
  // multipart 대신 파일을 통째로 body로 보낸다 (의존성 추가 금지 - 서버도 raw body로 받는다).
  uploadPhoto: async (playId: number, file: File): Promise<Photo> => {
    const userId = getUserId();
    const headers: Record<string, string> = {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name || "photo.jpg"),
    };
    if (userId) headers["X-User-Id"] = userId;
    clearListCache(); // 사진은 피드 카드에 실린다
    const res = await fetch(`${BASE}/plays/${playId}/photos`, { method: "POST", headers, body: file });
    if (!res.ok) {
      let msg = `업로드 실패 (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {
        // JSON이 아니면 기본 메시지 사용
      }
      throw new Error(msg);
    }
    return res.json();
  },
  deletePhoto: (id: number) =>
    request<{ ok: boolean }>(`/photos/${id}`, { method: "DELETE" }),
  photoUrl: (filename: string) => `${BASE}/photos/${filename}`,

  // 승자 프로필 사진 (BGStats 스타일 표시용). 업로드 방식은 플레이 사진과 동일.
  uploadAvatar: async (userId: number, file: File): Promise<User> => {
    const requesterId = getUserId();
    const headers: Record<string, string> = {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name || "avatar.jpg"),
    };
    if (requesterId) headers["X-User-Id"] = requesterId;
    const res = await fetch(`${BASE}/users/${userId}/avatar`, { method: "POST", headers, body: file });
    if (!res.ok) {
      let msg = `업로드 실패 (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {
        // JSON이 아니면 기본 메시지 사용
      }
      throw new Error(msg);
    }
    return res.json();
  },
  avatarUrl: (filename: string) => `${BASE}/avatars/${filename}`,

  // ---------- 슬리브 재고 ----------
  sleeves: () => request<Sleeve[]>("/sleeves"),
  addSleeve: (body: Partial<Sleeve>) =>
    request<Sleeve>("/sleeves", { method: "POST", body: JSON.stringify(body) }),
  updateSleeve: (id: number, body: Partial<Sleeve>) =>
    request<Sleeve>(`/sleeves/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSleeve: (id: number) =>
    request<{ ok: boolean }>(`/sleeves/${id}`, { method: "DELETE" }),

  // ---------- 게임별 슬리브 필요치 ----------
  gameSleeves: (gameId: number) => request<GameSleeve[]>(`/games/${gameId}/sleeves`),
  addGameSleeve: (gameId: number, body: { size: string; count: number; note?: string | null }) =>
    request<GameSleeve>(`/games/${gameId}/sleeves`, { method: "POST", body: JSON.stringify(body) }),
  updateGameSleeve: (id: number, body: { size?: string; count?: number; note?: string | null }) =>
    request<GameSleeve>(`/game-sleeves/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteGameSleeve: (id: number) =>
    request<{ ok: boolean }>(`/game-sleeves/${id}`, { method: "DELETE" }),

  // ---------- 피드 ----------
  feed: (params: {
    author?: number; filter?: "photo" | "event"; game_id?: number; category?: string;
    q?: string; limit?: number; offset?: number;
  } = {}) => {
    const sp = new URLSearchParams();
    if (params.author) sp.set("author", String(params.author));
    if (params.filter) sp.set("filter", params.filter);
    if (params.game_id) sp.set("game_id", String(params.game_id));
    if (params.category) sp.set("category", params.category);
    if (params.q) sp.set("q", params.q);
    sp.set("limit", String(params.limit ?? 20));
    sp.set("offset", String(params.offset ?? 0));
    return request<FeedResponse>(`/feed?${sp}`);
  },

  // ---------- 도전 과제 ----------
  challenges: () => request<Challenge[]>("/challenges"),
  addChallenge: (body: { name: string; description?: string | null; target: ChallengeTarget }) =>
    request<Challenge>("/challenges", { method: "POST", body: JSON.stringify(body) }),
  deleteChallenge: (id: number) =>
    request<{ ok: boolean }>(`/challenges/${id}`, { method: "DELETE" }),
};

export { getUserId };
