import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import type { FeedItem, FeedItemEvent, FeedItemMonth, FeedItemPlay } from "../api/types";
import PhotoSlider from "../components/PhotoSlider";
import { imgUrl } from "../utils/imgUrl";
import "../styles/Feed.css";

const EVENT_EMOJI: Record<FeedItemEvent["kind"], string> = {
  first: "\u{1F389}", // 🎉
  milestone: "\u{1F525}", // 🔥
  best: "\u{1F3C6}", // 🏆
  worst: "\u{1F4C9}", // 📉
  challenge: "\u{1F3AF}", // 🎯
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
    case "best": return `최고점 갱신 ${fmtScore(item.score)}점`;
    case "worst": return `최저점 갱신 ${fmtScore(item.score)}점`;
    case "challenge": return "달성";
    default: return "";
  }
}

function EventLine({ item }: { item: FeedItemEvent }) {
  const isChallenge = item.kind === "challenge";
  return (
    <Link to={isChallenge ? "/challenges" : `/game/${item.game_id}`} className="feed-event-line">
      <span className="feed-event-text">
        {EVENT_EMOJI[item.kind]} {item.author} · {isChallenge ? `'${item.challenge_name}'` : item.game_name} {eventLabel(item)}
      </span>
      <span className="muted feed-event-date">{fmtShortDate(item.date)}</span>
    </Link>
  );
}

function MonthCard({ item }: { item: FeedItemMonth }) {
  const [open, setOpen] = useState(false);
  const top = item.topGames[0];
  const hours = Math.floor(item.totalMinutes / 60);
  const mins = item.totalMinutes % 60;
  return (
    <div className="card month-card" onClick={() => setOpen((o) => !o)}>
      <div className="month-card-summary">
        <span>
          {"\u{1F4CA}"} {item.year}년 {item.monthNum}월 결산 — {item.totalPlays}판 · 새 게임 {item.newGameCount}개
          {top ? ` · 최다 ${top.name} ${top.count}판` : ""}
        </span>
        <span className="muted month-card-caret">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="month-card-detail" onClick={(e) => e.stopPropagation()}>
          {/* BGStats 3x3 결산 이미지처럼 그 달 최다 플레이 게임을 썸네일 그리드로 보여준다 */}
          <div className="month-grid">
            {item.topGames.map((g) => (
              <Link key={g.gameId} to={`/game/${g.gameId}`} className="month-grid-cell" onClick={(e) => e.stopPropagation()}>
                {g.thumbnail ? (
                  <img src={imgUrl(g.thumbnail)} alt={g.name} loading="lazy" />
                ) : (
                  <div className="month-grid-noimg">{g.name}</div>
                )}
                <span className="month-grid-badge">{g.count}판</span>
              </Link>
            ))}
          </div>
          <div className="info-row"><span className="muted">총 판수</span><span>{item.totalPlays}판</span></div>
          <div className="info-row">
            <span className="muted">새 게임</span>
            <span>{item.newGameCount}개</span>
          </div>
          <div className="info-row">
            <span className="muted">총 플레이 시간</span>
            <span>{hours > 0 ? `${hours}시간 ` : ""}{mins}분</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayCard({
  item, onTagClick,
}: {
  item: FeedItemPlay;
  onTagClick: (kind: "game" | "category", value: string, gameId?: number) => void;
}) {
  const p = item.play;
  const navigate = useNavigate();

  const winner = p.players.find((pl) => pl.win && !pl.is_automa);
  const myResult = winner ? `${winner.win ? "승" : "패"}` : null;

  return (
    <div className="card feed-play-card">
      <div className="feed-play-header" onClick={() => navigate(`/plays/${p.id}`)}>
        <div className="feed-avatar">{p.author}</div>
        <div className="feed-play-headinfo">
          <div className="feed-play-author">{p.author}</div>
          <div className="muted feed-play-date">{fmtFullDate(p.played_at)}</div>
        </div>
      </div>

      {p.photos.length > 0 && <PhotoSlider photos={p.photos} />}

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
  const [items, setItems] = useState<FeedItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [authorFilter, setAuthorFilter] = useState<number | null>(null);
  const [contentFilter, setContentFilter] = useState<"all" | "photo" | "event">("all");
  const [tagFilter, setTagFilter] = useState<{ kind: "game" | "category"; value: string; gameId?: number } | null>(null);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async (reset: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const off = reset ? 0 : offsetRef.current;
      const res = await api.feed({
        author: authorFilter ?? undefined,
        filter: contentFilter === "all" ? undefined : contentFilter,
        game_id: tagFilter?.kind === "game" ? tagFilter.gameId : undefined,
        category: tagFilter?.kind === "category" ? tagFilter.value : undefined,
        limit: 20,
        offset: off,
      });
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      offsetRef.current = off + res.items.length;
      setHasMore(res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [authorFilter, contentFilter, tagFilter]);

  // 필터가 바뀌면 처음부터 다시 불러온다
  useEffect(() => {
    offsetRef.current = 0;
    loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorFilter, contentFilter, tagFilter]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingRef.current) {
        loadMore(false);
      }
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  function handleTagClick(kind: "game" | "category", value: string, gameId?: number) {
    setTagFilter((cur) => (cur && cur.kind === kind && cur.value === value ? null : { kind, value, gameId }));
  }

  return (
    <div className="page feed-page">
      <div className="page-header">
        <h1>피드</h1>
      </div>

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
        <p className="muted center-pad">표시할 내용이 없습니다.</p>
      )}
      {error && <p className="error-text center-pad">{error}</p>}

      <div className="feed-list">
        {items.map((item, i) => {
          if (item.type === "play") {
            return (
              <PlayCard
                key={`play-${item.play.id}`}
                item={item}
                onTagClick={handleTagClick}
              />
            );
          }
          if (item.type === "event") {
            return <EventLine key={`event-${item.kind}-${item.game_id}-${item.userId}-${item.date}-${i}`} item={item} />;
          }
          return <MonthCard key={`month-${item.month}`} item={item} />;
        })}
      </div>

      {loading && <p className="muted center-pad">불러오는 중...</p>}
      <div ref={sentinelRef} style={{ height: 1 }} />
    </div>
  );
}
