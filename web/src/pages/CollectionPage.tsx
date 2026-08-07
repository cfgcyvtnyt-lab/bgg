import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { getCached, setCached } from "../utils/listCache";
import type { CollectionListEntry } from "../api/types";
import GameCard from "../components/GameCard";
import AlphaIndex from "../components/AlphaIndex";
import BggSearchModal from "../components/BggSearchModal";
import CollectionTable from "../components/CollectionTable";
import {
  VIEW_DEFS, STATUS_DEFS, matchesFilter, filterLabel,
  PRIMARY_SORTS, MORE_SORTS, sortFieldLabel, compareEntries,
  groupOf,
} from "../utils/collectionSort";
import type { FilterState, SortField } from "../utils/collectionSort";
import "../styles/Collection.css";

const SORT_KEY = "bgg_sort_v2";

function loadSort(): { field: SortField; dir: "asc" | "desc" } {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // 손상된 값이면 기본값으로
  }
  return { field: "name", dir: "asc" };
}

export default function CollectionPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // 뒤로 왔을 때 받아둔 목록이 있으면 그걸로 시작한다. 첫 그림부터 목록이 완성돼 있어야
  // 스크롤이 보던 자리에 그대로 있다(비었다가 채워지면 그 사이 위치가 날아간다).
  const cacheKey = `collection:${localStorage.getItem("bgg_include_expansions") === "1"}`;
  const cached = getCached<CollectionListEntry[]>(cacheKey);
  const [entries, setEntries] = useState<CollectionListEntry[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterState>({ kind: "view", key: "all" });
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [sort, setSort] = useState(loadSort);
  const [view, setView] = useState<"grid" | "list" | "table">(() => (localStorage.getItem("bgg_view") as "grid" | "list" | "table") || "grid");
  // 표 뷰는 PC 전용. 모바일에서 버튼을 숨기고, 화면이 좁아지면 표 모드였어도 격자로 되돌린다.
  const [isWide, setIsWide] = useState(() => window.innerWidth >= 900);
  const [showSearch, setShowSearch] = useState(false);
  const [includeExpansions, setIncludeExpansions] = useState(
    () => localStorage.getItem("bgg_include_expansions") === "1"
  );
  const listRef = useRef<HTMLDivElement>(null);

  async function load(withExpansions: boolean) {
    const key = `collection:${withExpansions}`;
    const hit = getCached<CollectionListEntry[]>(key);
    // 받아둔 게 있으면 그것부터 보여주고, 뒤에서 조용히 최신으로 바꾼다.
    if (hit) setEntries(hit);
    else setLoading(true);
    setError(null);
    try {
      const coll = await api.collection(undefined, undefined, withExpansions);
      setEntries(coll);
      setCached(key, coll);
    } catch (err) {
      if (!hit) setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(includeExpansions); }, [includeExpansions]);
  useEffect(() => { localStorage.setItem("bgg_view", view); }, [view]);
  useEffect(() => {
    function onResize() { setIsWide(window.innerWidth >= 900); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    if (view === "table" && !isWide) setView("grid");
  }, [isWide, view]);
  // 표 모드일 때만 620px 폭 제한을 풀어준다. 페이지를 떠나거나 다른 뷰로 바꾸면 원복.
  useEffect(() => {
    // 탭이 살아 있는 구조라 unmount 정리에 기대면 안 된다 - 표 모드인 채로 다른 탭에 가면
    // 정리가 안 돌아서 그 탭까지 1400px로 퍼진다. 컬렉션 탭이 화면에 있을 때만 켠다.
    document.body.classList.toggle("wide-mode", view === "table" && pathname === "/collection");
    return () => document.body.classList.remove("wide-mode");
  }, [view]);
  useEffect(() => { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); }, [sort]);
  useEffect(() => {
    localStorage.setItem("bgg_include_expansions", includeExpansions ? "1" : "0");
  }, [includeExpansions]);

  const searched = useMemo(() => {
    // 대소문자 무시. 표시명이 한글이어도 영문명으로 찾을 수 있어야 한다
    // ("agricola"로 아그리콜라가 나와야 함).
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      `${e.game_name || ""} ${e.game_name_en || ""}`.toLowerCase().includes(q)
    );
  }, [entries, query]);

  const filtered = useMemo(() => searched.filter((e) => matchesFilter(e, filter)), [searched, filter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => compareEntries(a, b, sort.field, sort.dir));
  }, [filtered, sort]);

  const activeGroups = useMemo(() => new Set(sorted.map((e) => groupOf(e.game_name))), [sorted]);

  function jumpToGroup(group: string) {
    const target = sorted.find((e) => groupOf(e.game_name) === group);
    if (!target) return;
    const el = document.getElementById(`row-game-${target.game_id}`);
    el?.scrollIntoView({ block: "start", behavior: "auto" });
  }

  function selectFilter(f: FilterState) {
    setFilter(f);
    setShowFilterMenu(false);
  }

  function selectSortField(field: SortField) {
    setSort((s) => ({ ...s, field }));
    setShowSortMenu(false);
  }

  return (
    <div className="page collection-page">
      <div className="page-header">
        <div className="filter-dropdown-wrap">
          <button className="filter-dropdown-trigger" onClick={() => setShowFilterMenu((v) => !v)}>
            {filterLabel(filter)} <span className="filter-dropdown-caret">▼</span>
          </button>
          {showFilterMenu && (
            <>
              <div className="dropdown-backdrop" onClick={() => setShowFilterMenu(false)} />
              <div className="filter-dropdown-menu">
                <div className="filter-dropdown-section-title">뷰</div>
                {VIEW_DEFS.map((v) => (
                  <button
                    key={v.key}
                    className={`filter-dropdown-item${filter.kind === "view" && filter.key === v.key ? " filter-dropdown-item-active" : ""}`}
                    onClick={() => selectFilter({ kind: "view", key: v.key })}
                  >
                    {v.label}
                  </button>
                ))}
                <div className="filter-dropdown-section-title">상태별</div>
                {STATUS_DEFS.map((s) => {
                  const count = searched.filter((e) => matchesFilter(e, { kind: "status", key: s.key })).length;
                  return (
                    <button
                      key={s.key}
                      className={`filter-dropdown-item${filter.kind === "status" && filter.key === s.key ? " filter-dropdown-item-active" : ""}`}
                      onClick={() => selectFilter({ kind: "status", key: s.key })}
                    >
                      {s.label} <span className="muted">({count})</span>
                    </button>
                  );
                })}
                <div className="filter-dropdown-section-title">옵션</div>
                <label className="filter-dropdown-item filter-dropdown-checkbox">
                  <input
                    type="checkbox"
                    checked={includeExpansions}
                    onChange={(e) => setIncludeExpansions(e.target.checked)}
                  />
                  확장 포함
                </label>
                {/* 슬리브 재고는 앱 설정이 아니라 소유한 게임에 딸린 정보라 컬렉션 쪽에 둔다 */}
                <div className="filter-dropdown-section-title">관리</div>
                <button
                  className="filter-dropdown-item"
                  onClick={() => { setShowFilterMenu(false); navigate("/sleeves"); }}
                >
                  슬리브 재고
                </button>
              </div>
            </>
          )}
        </div>
        <button className="icon-btn" onClick={() => setShowSearch(true)} aria-label="게임 추가">＋</button>
      </div>

      <input
        className="search-input"
        placeholder="게임 이름 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {/* 표 모드는 헤더 클릭으로 정렬하므로 정렬 칩/메뉴/방향 토글은 격자·목록에서만 보인다 */}
      {view !== "table" && (
        <div className="sort-row">
          <div className="chip-row sort-chip-row">
            {PRIMARY_SORTS.map((s) => (
              <button
                key={s.key}
                className={`chip${sort.field === s.key ? " chip-active" : ""}`}
                onClick={() => selectSortField(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {/* chip-row는 overflow-x:auto라 그 안에 두면 드롭다운이 세로로도 함께 잘려 안 보였다.
              스크롤 컨테이너 밖(sort-row 직속)으로 빼서 메뉴가 실제로 뜨게 한다. */}
          <div className="sort-more-wrap">
            <button className="chip" onClick={() => setShowSortMenu((v) => !v)}>
              {MORE_SORTS.some((s) => s.key === sort.field) ? sortFieldLabel(sort.field) : "···"}
            </button>
            {showSortMenu && (
              <>
                <div className="dropdown-backdrop" onClick={() => setShowSortMenu(false)} />
                <div className="sort-more-menu">
                  {MORE_SORTS.map((s) => (
                    <button
                      key={s.key}
                      className={`filter-dropdown-item${sort.field === s.key ? " filter-dropdown-item-active" : ""}`}
                      onClick={() => selectSortField(s.key)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            className="sort-dir-btn"
            onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
            aria-label="정렬 방향 전환"
            title={sort.dir === "asc" ? "오름차순" : "내림차순"}
          >
            {sort.dir === "asc" ? "↑" : "↓"}
          </button>
        </div>
      )}

      <div className="view-toggle">
        <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>격자</button>
        <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>목록</button>
        {isWide && (
          <button className={view === "table" ? "active" : ""} onClick={() => setView("table")}>표</button>
        )}
        <span className="view-toggle-count muted">{sorted.length} 게임</span>
      </div>

      {loading && <p className="muted empty-hint">불러오는 중...</p>}
      {error && <p className="error-text empty-hint">{error}</p>}
      {!loading && !error && sorted.length === 0 && (
        <p className="muted empty-hint">표시할 게임이 없습니다.</p>
      )}

      {view === "table" ? (
        <CollectionTable entries={sorted} />
      ) : (
        <div className="collection-list-wrap">
          <div ref={listRef} className={view === "grid" ? "game-grid" : "game-list"}>
            {sorted.map((e) => (
              <GameCard key={e.id ?? `u${e.game_id}`} entry={e} view={view} sortField={sort.field} />
            ))}
          </div>
          {sorted.length > 20 && <AlphaIndex activeGroups={activeGroups} onJump={jumpToGroup} />}
        </div>
      )}

      {showSearch && (
        <BggSearchModal onClose={() => setShowSearch(false)} onAdded={() => load(includeExpansions)} />
      )}
    </div>
  );
}
