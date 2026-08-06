import type {
  User, Game, GameDetail, CollectionEntry, CollectionListEntry, Play, PlayInput, Insights, BggSearchResult,
  NameAlias, NameCount, LocationCount, PlayDetail, Photo, FeedResponse,
} from "./types";

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
  return res.json();
}

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  users: () => request<User[]>("/users"),

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

  updateGame: (id: number, body: { custom_name: string }) =>
    request<GameDetail>(`/games/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  translateGame: (id: number) =>
    request<{ description_ko: string }>(`/games/${id}/translate`, { method: "POST" }),

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

  insights: () => request<Insights>("/insights"),

  search: (q: string) => request<BggSearchResult[]>(`/search?${new URLSearchParams({ q })}`),

  names: (kind: "player" | "location") =>
    request<NameCount[]>(`/names?${new URLSearchParams({ kind })}`),
  aliases: (kind?: "player" | "location") =>
    request<NameAlias[]>(`/aliases${kind ? `?kind=${kind}` : ""}`),
  addAlias: (body: { kind: "player" | "location"; alias: string; canonical: string }) =>
    request<NameAlias>("/aliases", { method: "POST", body: JSON.stringify(body) }),
  deleteAlias: (id: number) =>
    request<{ ok: boolean }>(`/aliases/${id}`, { method: "DELETE" }),

  // ---------- 사진 ----------
  // multipart 대신 파일을 통째로 body로 보낸다 (의존성 추가 금지 - 서버도 raw body로 받는다).
  uploadPhoto: async (playId: number, file: File): Promise<Photo> => {
    const userId = getUserId();
    const headers: Record<string, string> = {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name || "photo.jpg"),
    };
    if (userId) headers["X-User-Id"] = userId;
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
  updatePhoto: (id: number, body: { published?: boolean; caption?: string | null }) =>
    request<Photo>(`/photos/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deletePhoto: (id: number) =>
    request<{ ok: boolean }>(`/photos/${id}`, { method: "DELETE" }),
  photoUrl: (filename: string) => `${BASE}/photos/${filename}`,

  // ---------- 피드 ----------
  feed: (params: {
    author?: number; filter?: "photo" | "event"; game_id?: number; category?: string;
    limit?: number; offset?: number;
  } = {}) => {
    const sp = new URLSearchParams();
    if (params.author) sp.set("author", String(params.author));
    if (params.filter) sp.set("filter", params.filter);
    if (params.game_id) sp.set("game_id", String(params.game_id));
    if (params.category) sp.set("category", params.category);
    sp.set("limit", String(params.limit ?? 20));
    sp.set("offset", String(params.offset ?? 0));
    return request<FeedResponse>(`/feed?${sp}`);
  },
};

export { getUserId };
