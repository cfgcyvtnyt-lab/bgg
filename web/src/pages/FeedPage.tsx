import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import type { FeedItem, FeedItemEvent, FeedItemMonth, FeedItemPlay, MonthEvent } from "../api/types";
import PhotoSlider from "../components/PhotoSlider";
import { TAB_RESET_EVENT } from "../components/BottomNav";
import { imgUrl } from "../utils/imgUrl";
import { getCached, setCached } from "../utils/listCache";
import "../styles/Feed.css";

// 사용자별 이니셜 원 색 고정 - PlaysPage와 동일한 방식(이름 해시)으로 항상 같은 색이 나오게 한다.

// 무한 스크롤은 이제 창이 아니라 이 화면이 들어 있는 스크롤 상자를 봐야 한다.
// 탭을 살려두려고 화면마다 자기 상자를 갖게 했기 때문이다(App.tsx 참고).
function paneOf(el: Element | null): HTMLElement | null {
  return (el?.closest(".app-pane") as HTMLElement) ?? null;
}

const INITIAL_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)", "var(--c9)", "var(--c10)"];
function colorForName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return INITIAL_COLORS[hash % INITIAL_COLORS.length];
}

// 피드 이벤트와 결산 사건이 같은 아이콘을 쓴다. best는 피드엔 안 뜨고 결산에만 나온다.
const EVENT_EMOJI: Record<FeedItemEvent["kind"] | MonthEvent["kind"], string> = {
  first: "\u{1F389}", // 🎉
  milestone: "\u{1F525}", // 🔥
  best: "\u{1F3C6}", // 🏆
  challenge: "\u{1F3AF}", // 🎯
  error: "\u{26A0}\u{FE0F}", // ⚠️
};

function fmtShortDate(dateStr: string) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}월 ${d}일`;
}

function fmtFullDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${y}년 ${m}월 ${d}일`;
}

function fmtScore(n: number | undefined) {
  if (n == null) return "";
  return Math.round(n).toLocaleString();
}

function eventLabel(item: FeedItemEvent) {
  switch (item.kind) {
    case "first": return "첫 플레이";
    case "milestone": return `${item.count}회 달성`;
    case "challenge": return "달성";
    case "error": return "에러플";
    default: return "";
  }
}

function EventLine({ item }: { item: FeedItemEvent }) {
  const isChallenge = item.kind === "challenge";
  return (
    <Link to={isChallenge ? "/challenges" : `/game/${item.game_id}`} className="feed-event-line">
      <span className="feed-event-text">
        {EVENT_EMOJI[item.kind]} {item.author} · {isChallenge ? `'${item.challenge_name}'` : item.game_name} {eventLabel(item)}
        {item.kind === "error" && item.note ? ` — "${item.note}"` : ""}
      </span>
      <span className="muted feed-event-date">{fmtShortDate(item.date)}</span>
    </Link>
  );
}

// 결산 카드에 들어가는 사건 요약. 종류별로 묶어 "첫 플레이 7개 / 플립타운, 마라카이보 외 5"처럼
// 한 줄로 만든다. 전부 나열하면 카드가 길어지고, 개수만 적으면 뭘 했는지가 안 남는다.
const DIGEST_ORDER: MonthEvent["kind"][] = ["first", "best", "milestone", "challenge"];
// 대표로 이름을 보여줄 개수. 나머지는 "외 N"으로 접는다.
// 최고점은 이름 뒤에 점수까지 붙어 길어지므로 하나만 보여준다 - 좁은 화면에서
// 두 개를 넣으면 "내셔널 / 이코노미"처럼 줄이 갈린다.
function digestNameLimit(kind: MonthEvent["kind"]) {
  return kind === "best" ? 1 : 2;
}

function digestTitle(kind: MonthEvent["kind"], rows: MonthEvent[]) {
  if (kind === "first") return `첫 플레이 ${rows.length}개`;
  if (kind === "best") return `최고점 갱신 ${rows.length}번`;
  if (kind === "challenge") return `도전과제 ${rows.length}개`;
  // N회 달성은 횟수가 섞일 수 있어(10회·100회) 개수 대신 그대로 둔다
  const counts = [...new Set(rows.map((r) => r.count))].filter(Boolean);
  return counts.length === 1 ? `${counts[0]}회 달성` : "플레이 횟수 달성";
}

function digestNames(kind: MonthEvent["kind"], rows: MonthEvent[]) {
  const label = (r: MonthEvent) => {
    if (kind === "challenge") return r.challengeName || "";
    const name = r.gameName || "";
    if (kind === "best" && r.score != null) return `${name} ${fmtScore(r.score)}점`;
    if (kind === "milestone" && r.count != null) return `${name} ${r.count}회`;
    return name;
  };
  const shown = rows.slice(0, digestNameLimit(kind)).map(label).filter(Boolean);
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} 외 ${rest}` : shown.join(", ");
}

function MonthCard({ item, avatarByName }: { item: FeedItemMonth; avatarByName: Map<string, string> }) {
  const avatar = avatarByName.get(item.author);

  // 종류별로 묶되 순서는 고정한다(첫 플레이 -> 최고점 -> 달성 -> 도전과제).
  // 달마다 있는 종류가 달라서 정렬을 데이터에 맡기면 카드끼리 줄 순서가 뒤바뀐다.
  const groups = DIGEST_ORDER
    .map((kind) => ({ kind, rows: item.events.filter((e) => e.kind === kind) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="card month-card">
      <div className="month-card-author">
        {avatar ? (
          <img decoding="async" className="feed-avatar feed-avatar-img" src={api.avatarUrl(avatar)} alt={item.author} />
        ) : (
          <div className="feed-avatar feed-avatar-initial" style={{ background: colorForName(item.author) }}>
            {item.author.slice(0, 1)}
          </div>
        )}
        <span className="month-card-author-name">{item.author}</span>
      </div>

      <div className="month-card-head">
        <span className="month-card-title">{item.year}년 {item.monthNum}월 결산</span>
        <span className="muted month-card-counts">
          {item.totalPlays}회 · {item.playedDays}일 · {item.distinctGames}개 게임
        </span>
      </div>

      <div className="month-card-body">
        {/* 3x3 썸네일. 원본이 200x150이라 크게 그리면 흐려진다 - 한 칸 46px 정도로 두면 선명하다 */}
        <div className="month-grid">
          {item.topGames.map((g) => (
            <Link key={g.gameId} to={`/game/${g.gameId}`} className="month-grid-cell" onClick={(e) => e.stopPropagation()}>
              {g.thumbnail ? (
                <>
                  {/* contain으로 생긴 레터박스 여백을 같은 이미지를 블러로 깔아 채운다.
                      같은 URL이라 브라우저 캐시를 그대로 써서 추가 요청이 없다 */}
                  <img decoding="async" className="month-grid-bg" src={imgUrl(g.thumbnail)} alt="" aria-hidden="true" />
                  <img decoding="async" className="month-grid-fg" src={imgUrl(g.thumbnail)} alt={g.name} />
                </>
              ) : (
                <div className="month-grid-noimg">{g.name}</div>
              )}
              <span className="month-grid-badge">{g.count}</span>
            </Link>
          ))}
        </div>

        <div className="month-digest">
          {groups.length === 0 ? (
            <p className="muted empty-hint">이 달엔 특별한 기록이 없습니다.</p>
          ) : (
            groups.map((g) => (
              <div key={g.kind} className="month-digest-row">
                <span className="month-digest-icon" aria-hidden="true">{EVENT_EMOJI[g.kind]}</span>
                <div className="month-digest-text">
                  <div className="month-digest-title">{digestTitle(g.kind, g.rows)}</div>
                  <div className="muted month-digest-names">{digestNames(g.kind, g.rows)}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function PlayCard({
  item, onTagClick, avatarByName,
}: {
  item: FeedItemPlay;
  onTagClick: (kind: "game" | "category", value: string, gameId?: number) => void;
  avatarByName: Map<string, string>;
}) {
  const p = item.play;
  const navigate = useNavigate();

  const winner = p.players.find((pl) => pl.win && !pl.is_automa);
  const myResult = winner ? `${winner.win ? "승" : "패"}` : null;
  const authorAvatar = avatarByName.get(p.author);

  return (
    <div className="card feed-play-card">
      <div className="feed-play-header" onClick={() => navigate(`/plays/${p.id}`)}>
        {authorAvatar ? (
          <img decoding="async" className="feed-avatar feed-avatar-img" src={api.avatarUrl(authorAvatar)} alt={p.author} />
        ) : (
          <div className="feed-avatar feed-avatar-initial" style={{ background: colorForName(p.author) }}>
            {p.author.slice(0, 1)}
          </div>
        )}
        <div className="feed-play-headinfo">
          <div className="feed-play-author">{p.author}</div>
          <div className="muted feed-play-date">{fmtFullDate(p.played_at)}</div>
        </div>
      </div>

      {p.photos.length > 0 && <PhotoSlider photos={p.photos} />}

      {p.has_rule_error && <span className="feed-error-badge">⚠️ 에러플</span>}

      <div className="feed-play-tags">
        <button className="chip chip-static" onClick={() => onTagClick("game", p.game_name, p.game_id)}>
          #{p.game_name}
        </button>
        {p.categories.map((c) => (
          <button key={c} className="chip chip-static" onClick={() => onTagClick("category", c)}>#{c}</button>
        ))}
      </div>

      {p.comment && <p className="feed-play-comment">{p.comment}</p>}

      <div className="muted feed-play-meta">
        {[
          myResult,
          winner?.score != null ? `${fmtScore(winner.score)}점` : null,
          p.duration_min ? `${p.duration_min}분` : null,
          p.location,
        ].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

export default function FeedPage() {
  const { users } = useUser();
  // 이름 -> 아바타 파일명 맵 (PlaysPage와 동일한 방식)
  const avatarByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) if (u.avatar) map.set(u.name, u.avatar);
    return map;
  }, [users]);
  // 뒤로 왔을 때 첫 그림부터 목록이 채워져 있어야 보던 자리에 그대로 있다.
  const [items, setItems] = useState<FeedItem[]>(() => getCached<FeedItem[]>("feed") ?? []);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [authorFilter, setAuthorFilter] = useState<number | null>(null);
  const [contentFilter, setContentFilter] = useState<"all" | "photo" | "event">("all");
  const [tagFilter, setTagFilter] = useState<{ kind: "game" | "category"; value: string; gameId?: number } | null>(null);
  // 검색은 서버에서 거른다 - 무한 스크롤과 같이 동작해야 해서 화면에 받아둔 것만 훑으면 안 된다.
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 뒤로 가기로 돌아왔을 때 "몇 개까지 보고 있었는지"를 되살린다.
  // 이게 없으면 스크롤 위치는 기억해도 목록이 20개뿐이라 그만큼 내려갈 수가 없다.
  // 서버는 피드 전체를 만든 뒤 잘라 주므로 100개를 한 번에 받는 편이
  // 20개씩 다섯 번 받는 것보다 오히려 빠르다(실측 서버 시간 동일, 전송량만 13KB -> 59KB).
  const COUNT_KEY = "bgg_feed_count";
  const restoreCount = useRef(
    (() => {
      if (typeof window === "undefined") return 0;
      const saved = Number(sessionStorage.getItem(COUNT_KEY) || 0);
      return Number.isFinite(saved) && saved > 20 ? Math.min(saved, 100) : 0;
    })()
  );

  const loadMore = useCallback(async (reset: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const off = reset ? 0 : offsetRef.current;
      // 돌아온 직후 첫 요청만 크게 받는다. 그다음부터는 다시 20개씩.
      const take = reset && restoreCount.current > 0 ? restoreCount.current : 20;
      if (reset) restoreCount.current = 0;
      const res = await api.feed({
        author: authorFilter ?? undefined,
        filter: contentFilter === "all" ? undefined : contentFilter,
        game_id: tagFilter?.kind === "game" ? tagFilter.gameId : undefined,
        category: tagFilter?.kind === "category" ? tagFilter.value : undefined,
        q: debouncedQuery || undefined,
        limit: take,
        offset: off,
      });
      setItems((prev) => {
        const next = reset ? res.items : [...prev, ...res.items];
        try { sessionStorage.setItem(COUNT_KEY, String(next.length)); } catch { /* 무시 */ }
        // 필터가 걸리지 않은 기본 피드만 캐시한다 - 필터별로 다 담으면 낡은 값이 섞인다
        if (!authorFilter && contentFilter === "all" && !tagFilter && !debouncedQuery) setCached("feed", next);
        return next;
      });
      offsetRef.current = off + res.items.length;
      setHasMore(res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [authorFilter, contentFilter, tagFilter, debouncedQuery]);

  // 아래 탭에서 "피드"를 누르면 목록을 첫 페이지로 되돌린다.
  // 무한 스크롤로 쌓인 수백 개를 계속 들고 있으면 탭을 오갈 때마다 무겁다.
  useEffect(() => {
    function onReset(e: Event) {
      if ((e as CustomEvent).detail !== "/") return;
      restoreCount.current = 0;
      warmStart.current = false;
      offsetRef.current = 0;
      setHasMore(true);
      loadMore(true);
    }
    window.addEventListener(TAB_RESET_EVENT, onReset);
    return () => window.removeEventListener(TAB_RESET_EVENT, onReset);
  }, [loadMore]);

  // 필터가 바뀌면 처음부터 다시 불러온다.
  // 단, 뒤로 와서 캐시로 시작한 첫 순간에는 다시 받지 않는다 - 서버는 한 번에 100개까지만
  // 주므로, 그보다 깊이 내려가 봤다면 다시 받는 순간 목록이 짧아지면서 보던 자리가 날아간다.
  const warmStart = useRef(getCached<FeedItem[]>("feed") !== undefined);
  useEffect(() => {
    if (warmStart.current) {
      warmStart.current = false;
      offsetRef.current = items.length;
      setLoading(false);
      return;
    }
    offsetRef.current = 0;
    loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorFilter, contentFilter, tagFilter, debouncedQuery]);

  useEffect(() => {
    // IntersectionObserver만 쓰면 일부 환경에서 콜백이 아예 안 불려 더 안 불러온다.
    // 스크롤 위치 계산을 폴백으로 같이 둔다.
    if (!hasMore) return;

    const pane = paneOf(sentinelRef.current);
    function maybeLoad() {
      if (!hasMore || loadingRef.current || !pane) return;
      const remaining = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      if (remaining < 300) loadMore(false);
    }

    const el = sentinelRef.current;
    const observer = el
      ? new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting) maybeLoad();
        }, { rootMargin: "200px" })
      : null;
    observer?.observe(el!);

    pane?.addEventListener("scroll", maybeLoad, { passive: true });
    window.addEventListener("resize", maybeLoad);
    maybeLoad();

    return () => {
      observer?.disconnect();
      pane?.removeEventListener("scroll", maybeLoad);
      window.removeEventListener("resize", maybeLoad);
    };
  }, [hasMore, loadMore]);

  function handleTagClick(kind: "game" | "category", value: string, gameId?: number) {
    setTagFilter((cur) => (cur && cur.kind === kind && cur.value === value ? null : { kind, value, gameId }));
  }

  return (
    <div className="page feed-page">
      <div className="page-header">
        <h1>피드</h1>
      </div>

      <input
        className="search-input"
        placeholder="게임 이름 · 코멘트 · 태그 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="chip-row">
        <button className={`chip${authorFilter == null ? " chip-active" : ""}`} onClick={() => setAuthorFilter(null)}>전체</button>
        {users.map((u) => (
          <button key={u.id} className={`chip${authorFilter === u.id ? " chip-active" : ""}`} onClick={() => setAuthorFilter(u.id)}>
            {u.name}
          </button>
        ))}
        <button className={`chip${contentFilter === "photo" ? " chip-active" : ""}`} onClick={() => setContentFilter((f) => (f === "photo" ? "all" : "photo"))}>
          사진만
        </button>
        <button className={`chip${contentFilter === "event" ? " chip-active" : ""}`} onClick={() => setContentFilter((f) => (f === "event" ? "all" : "event"))}>
          이벤트만
        </button>
      </div>

      {tagFilter && (
        <div className="feed-tag-filter">
          <span>#{tagFilter.value} 필터 적용됨</span>
          <button className="btn-small" onClick={() => setTagFilter(null)}>해제</button>
        </div>
      )}

      {items.length === 0 && !loading && !error && (
        <p className="muted empty-hint">표시할 내용이 없습니다.</p>
      )}
      {error && <p className="error-text empty-hint">{error}</p>}

      <div className="feed-list">
        {items.map((item, i) => {
          if (item.type === "play") {
            return (
              <PlayCard
                key={`play-${item.play.id}`}
                item={item}
                onTagClick={handleTagClick}
                avatarByName={avatarByName}
              />
            );
          }
          if (item.type === "event") {
            return <EventLine key={`event-${item.kind}-${item.game_id}-${item.userId}-${item.date}-${i}`} item={item} />;
          }
          return <MonthCard key={`month-${item.userId}-${item.month}`} item={item} avatarByName={avatarByName} />;
        })}
      </div>

      {loading && <p className="muted empty-hint">불러오는 중...</p>}
      <div ref={sentinelRef} style={{ height: 1 }} />
    </div>
  );
}
