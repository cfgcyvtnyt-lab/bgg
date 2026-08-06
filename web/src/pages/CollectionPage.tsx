import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { CollectionEntry } from "../api/types";
import GameCard from "../components/GameCard";
import BggSearchModal from "../components/BggSearchModal";
import "../styles/Collection.css";

const STATUS_LIST = ["보유", "선주문", "위시리스트", "방출 예정", "방출 확정", "방출 완료"];

export default function CollectionPage() {
  const [entries, setEntries] = useState<CollectionEntry[]>([]);
  const [playCounts, setPlayCounts] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "list">(() => (localStorage.getItem("bgg_view") as "grid" | "list") || "grid");
  const [showSearch, setShowSearch] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [coll, insights] = await Promise.all([api.collection(), api.insights()]);
      setEntries(coll);
      const counts: Record<number, number> = {};
      for (const g of insights.topGames) counts[g.game_id] = g.count;
      setPlayCounts(counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => { localStorage.setItem("bgg_view", view); }, [view]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) for (const t of e.tags) set.add(t);
    return [...set].sort();
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (statusFilter && e.status !== statusFilter) return false;
      if (tagFilter && !e.tags.includes(tagFilter)) return false;
      if (query.trim() && !(e.game_name || "").includes(query.trim())) return false;
      return true;
    });
  }, [entries, statusFilter, tagFilter, query]);

  return (
    <div className="page collection-page">
      <div className="page-header">
        <h1>컬렉션</h1>
        <button className="icon-btn" onClick={() => setShowSearch(true)} aria-label="게임 추가">＋</button>
      </div>

      <input
        className="search-input"
        placeholder="게임 이름 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="chip-row">
        <button className={`chip${statusFilter === null ? " chip-active" : ""}`} onClick={() => setStatusFilter(null)}>
          전체 ({entries.length})
        </button>
        {STATUS_LIST.map((s) => {
          const count = entries.filter((e) => e.status === s).length;
          if (count === 0) return null;
          return (
            <button
              key={s}
              className={`chip${statusFilter === s ? " chip-active" : ""}`}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            >
              {s} ({count})
            </button>
          );
        })}
      </div>

      {allTags.length > 0 && (
        <div className="chip-row">
          {allTags.map((t) => (
            <button
              key={t}
              className={`chip chip-tag${tagFilter === t ? " chip-active" : ""}`}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      <div className="view-toggle">
        <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>격자</button>
        <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>목록</button>
        <span className="view-toggle-count muted">{filtered.length}개</span>
      </div>

      {loading && <p className="muted center-pad">불러오는 중...</p>}
      {error && <p className="error-text center-pad">{error}</p>}
      {!loading && !error && filtered.length === 0 && (
        <p className="muted center-pad">표시할 게임이 없습니다.</p>
      )}

      <div className={view === "grid" ? "game-grid" : "game-list"}>
        {filtered.map((e) => (
          <GameCard key={e.id} entry={e} playCount={playCounts[e.game_id] || 0} view={view} />
        ))}
      </div>

      {showSearch && (
        <BggSearchModal onClose={() => setShowSearch(false)} onAdded={load} />
      )}
    </div>
  );
}
