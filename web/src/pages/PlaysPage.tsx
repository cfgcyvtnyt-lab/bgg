import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { getCached, setCached } from "../utils/listCache";
import type { Game, Play, PlayPlayer, User } from "../api/types";
import { useUser } from "../context/UserContext";
import { TAB_RESET_EVENT } from "../components/BottomNav";
import "../styles/Plays.css";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const PAGE_SIZE = 40;

// 사용자별 이니셜 원 색 고정 - 아바타가 없을 때도 항상 같은 색으로 보이게 이름 해시로 고른다.

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

function fmtDateHeader(dateStr: string) {
  // dateStr: YYYY-MM-DD (로컬 타임존 이슈를 피하려고 문자열을 직접 쪼갠다)
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return { weekday: WEEKDAYS[date.getDay()], label: `${y}년 ${m}월 ${d}일` };
}

export default function PlaysPage() {
  const { currentUser } = useUser();
  const [users, setUsers] = useState<User[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // URL의 game_id는 플레이 상세의 "N회 플레이 >" 링크로 들어올 때나, 아래 필터 드롭다운으로 고를 때 쓰인다.
  const gameId = searchParams.get("game_id");
  const gameNameParam = searchParams.get("game_name");

  // 뒤로 왔을 때 목록이 비었다가 채워지면 그 사이 스크롤 위치가 날아간다.
  // 받아둔 게 있으면 첫 그림부터 목록이 완성돼 있게 해서 보던 자리에 그대로 있게 한다.
  // (useEffect로 채우면 빈 화면이 한 프레임 지나가므로 상태 초기값으로 넣는다)
  const warmPlays = getCached<Play[]>(`plays:${gameId ?? ""}`);
  const [plays, setPlays] = useState<Play[]>(warmPlays ?? []);
  const [loading, setLoading] = useState(!warmPlays);

  // 필터(깔때기) 드롭다운: 게임 이름 검색 후 선택
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [filterResults, setFilterResults] = useState<Game[]>([]);
  const filterWrapRef = useRef<HTMLDivElement>(null);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.users().then(setUsers).catch(() => {});
  }, []);

  const loadPage = useCallback(async (reset: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const warm = reset && getCached<Play[]>(`plays:${gameId ?? ""}`);
    if (reset && !warm) setLoading(true);
    else if (!reset) setLoadingMore(true);
    setError(null);
    try {
      const off = reset ? 0 : offsetRef.current;
      const page = await api.plays({
        limit: PAGE_SIZE,
        offset: off,
        game_id: gameId ? Number(gameId) : undefined,
      });
      setPlays((prev) => {
        const next = reset ? page : [...prev, ...page];
        setCached(`plays:${gameId ?? ""}`, next);
        return next;
      });
      offsetRef.current = off + page.length;
      setHasMore(page.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
      setLoadingMore(false);
      loadingRef.current = false;
    }
  }, [gameId]);

  // 필터(game_id)가 바뀌면 처음부터 다시 불러온다
  // 캐시로 시작한 첫 순간에는 다시 받지 않는다. 서버는 한 번에 40개씩 주므로
  // 깊이 내려가 봤다면 다시 받는 순간 목록이 짧아지면서 보던 자리가 날아간다.
  const warmStart = useRef(!!warmPlays);
  useEffect(() => {
    if (warmStart.current) {
      warmStart.current = false;
      offsetRef.current = warmPlays!.length;
      return;
    }
    offsetRef.current = 0;
    setHasMore(true);
    loadPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  // 아래 탭에서 "기록"을 누르면 목록을 첫 페이지로 되돌린다(피드와 같은 이유).
  useEffect(() => {
    function onReset(e: Event) {
      if ((e as CustomEvent).detail !== "/plays") return;
      warmStart.current = false;
      offsetRef.current = 0;
      setHasMore(true);
      loadPage(true);
    }
    window.addEventListener(TAB_RESET_EVENT, onReset);
    return () => window.removeEventListener(TAB_RESET_EVENT, onReset);
  }, [loadPage]);

  // 하단 근처에 오면 다음 페이지를 불러온다 (무한 스크롤).
  // IntersectionObserver만 쓰면 일부 환경(임베디드 웹뷰 등)에서 콜백이 아예 안 불려
  // 스크롤을 내려도 더 안 불러오는 일이 생긴다. 그래서 스크롤 위치 계산도 같이 둔다.
  useEffect(() => {
    if (!hasMore) return;

    const pane = paneOf(sentinelRef.current);
    function maybeLoad() {
      if (!hasMore || loadingRef.current || !pane) return;
      const remaining = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      if (remaining < 400) loadPage(false);
    }

    const el = sentinelRef.current;
    const observer = el
      ? new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting) maybeLoad();
        }, { root: pane, rootMargin: "300px" })
      : null;
    observer?.observe(el!);

    pane?.addEventListener("scroll", maybeLoad, { passive: true });
    window.addEventListener("resize", maybeLoad);
    // 첫 페이지가 화면을 다 못 채우면 스크롤이 생기지 않아 영영 안 불러온다.
    maybeLoad();

    return () => {
      observer?.disconnect();
      pane?.removeEventListener("scroll", maybeLoad);
      window.removeEventListener("resize", maybeLoad);
    };
  }, [hasMore, loadPage]);

  // 필터 드롭다운 바깥을 클릭하면 닫는다
  useEffect(() => {
    if (!filterOpen) return;
    function onClick(e: MouseEvent) {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [filterOpen]);

  useEffect(() => {
    if (!filterQuery.trim()) { setFilterResults([]); return; }
    const t = setTimeout(() => {
      api.games(filterQuery.trim(), 20).then(setFilterResults).catch(() => setFilterResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [filterQuery]);

  function selectFilterGame(g: Game) {
    setFilterOpen(false);
    setFilterQuery("");
    setFilterResults([]);
    navigate(`/plays?game_id=${g.id}&game_name=${encodeURIComponent(g.name)}`);
  }

  // 이름 -> 아바타 파일명 맵 (프로필 사진이 있는 사용자만)
  const avatarByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) if (u.avatar) map.set(u.name, u.avatar);
    return map;
  }, [users]);

  // BGStats처럼 날짜(일)별로 묶는다 - 서버가 이미 최신순으로 정렬해준다.
  const groups = useMemo(() => {
    const map = new Map<string, Play[]>();
    for (const p of plays) {
      if (!map.has(p.played_at)) map.set(p.played_at, []);
      map.get(p.played_at)!.push(p);
    }
    return [...map.entries()];
  }, [plays]);

  return (
    <div className="page plays-page">
      <div className="page-header">
        <h1>기록</h1>
        <div className="plays-header-actions">
          <div className="plays-filter-wrap" ref={filterWrapRef}>
            <button className="icon-btn plays-filter-btn" onClick={() => setFilterOpen((o) => !o)} aria-label="게임으로 필터">
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M2 3h16l-6 8v5l-4 2v-7z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </button>
            {filterOpen && (
              <div className="plays-filter-dropdown">
                <input
                  autoFocus
                  placeholder="게임 이름 검색"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                />
                {filterResults.length > 0 && (
                  <ul className="plays-filter-results">
                    {filterResults.map((g) => (
                      <li key={g.id}>
                        <button onClick={() => selectFilterGame(g)}>{g.name}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => navigate("/plays/new")} aria-label="기록 추가">＋</button>
        </div>
      </div>

      {gameId && (
        <div className="plays-scoped-banner">
          <span>{gameNameParam || "게임"} 플레이 목록</span>
          <Link to="/plays" className="plays-scoped-clear">전체 기록 보기</Link>
        </div>
      )}

      {loading && <p className="muted empty-hint">불러오는 중...</p>}
      {error && <p className="error-text empty-hint">{error}</p>}
      {!loading && !error && plays.length === 0 && (
        <p className="muted empty-hint">플레이 기록이 없습니다.</p>
      )}

      {groups.map(([date, list]) => {
        const { weekday, label } = fmtDateHeader(date);
        return (
          <div key={date} className="play-day-group">
            <div className="play-day-divider">
              <span className="play-day-weekday">{weekday}</span>
              <span className="muted">{label}</span>
            </div>
            {list.map((p) => {
              // win=1인 플레이어만 승자로 취급한다 (트로피 오귀속 버그 수정 - 이제 프로필 사진으로 표시).
              const winners = p.players.filter((pl) => pl.win === true || pl.win === 1);
              const orderedPlayers = [
                ...winners,
                ...p.players.filter((pl) => !(pl.win === true || pl.win === 1)),
              ];
              const humanCount = p.players.filter((pl) => !pl.is_automa).length;
              // 협력/솔로 판은 개인별 승자 표시가 의미 없다 - 성공/실패 아이콘 하나로만 보여준다.
              const isSoloOrCoop = !!p.is_coop || humanCount <= 1;
              // 트로피는 "로그인한 사용자"가 이겼을 때만 붙인다 - name_alias 병합 덕분에
              // play_player.name과 로그인 사용자 이름이 정확히 일치한다.
              const myName = currentUser?.name;
              const myPlayer = myName ? p.players.find((pl) => pl.name === myName) : undefined;
              const succeeded = myPlayer
                ? myPlayer.win === true || myPlayer.win === 1
                : winners.length > 0;
              return (
                <Link key={p.id} to={`/plays/${p.id}`} className="play-item">
                  <div className="play-item-text">
                    <div className="play-item-game">{p.game_name}</div>
                    <div className="play-item-loc muted">
                      {/* 장소를 안 적은 판은 "미기록"이라고 티 내지 않고 그냥 비운다 */}
                      {p.location && <>{p.location}{orderedPlayers.length > 0 && " · "}</>}
                      {/* 금색은 "내가 이겼을 때"만. 남이 이긴 건 표시하지 않는다(트로피 규칙과 동일) */}
                      {orderedPlayers.map((pl, i) => (
                        <span key={pl.id ?? i}>
                          {i > 0 && ", "}
                          <span className={pl === myPlayer && (pl.win === true || pl.win === 1) ? "winner-name" : undefined}>{pl.name}</span>
                        </span>
                      ))}
                      {orderedPlayers.length === 0 && "플레이어 없음"}
                      {humanCount <= 1 ? " · 솔로" : ""}
                      {p.is_coop ? " · 협력" : ""}
                    </div>
                  </div>
                  <div className="play-item-winners">
                    {!!p.has_rule_error && (
                      <span className="rule-error-icon" aria-label="에러플" title="에러플">⚠️</span>
                    )}
                    {(() => {
                      // 트로피/해골은 판 전체 결과를 나타내는 아이콘 하나 - 프로필 앞(왼쪽)에 붙는다.
                      // 협력/솔로는 성공 여부, 경쟁전은 "로그인 사용자가 이겼을 때만"(기존 규칙 유지).
                      const showTrophy = isSoloOrCoop ? succeeded : !!myPlayer && (myPlayer.win === true || myPlayer.win === 1);
                      const showLoss = isSoloOrCoop && !succeeded;
                      // 프로필은 항상 전원 표시(BGStats 방식). 겹쳐 그리므로 앞에 온 사람이 제일 위에 보인다.
                      // 그 자리를 이긴 사람에게 준다 - 한 판을 훑을 때 누가 이겼는지가 먼저 읽힌다.
                      // 승패가 같으면(협력·솔로 등) 로그인 사용자를 앞에 둔다.
                      const rank = (pl: PlayPlayer) => (pl.win === true || pl.win === 1 ? 0 : 1);
                      const displayPlayers = [...p.players].sort((a, b) => {
                        if (rank(a) !== rank(b)) return rank(a) - rank(b);
                        if (a === myPlayer) return -1;
                        if (b === myPlayer) return 1;
                        return 0;
                      });
                      const MAX_VISIBLE = 4;
                      const visiblePlayers = displayPlayers.slice(0, MAX_VISIBLE);
                      const overflowCount = displayPlayers.length - visiblePlayers.length;
                      return (
                        <>
                          {showTrophy && <span className="result-icon" aria-label="승리" title="승리">🏆</span>}
                          {showLoss && <span className="result-icon result-icon-loss" aria-label="실패" title="실패">💀</span>}
                          <div className="play-item-avatars">
                            {visiblePlayers.map((pl, i) => {
                              const avatar = avatarByName.get(pl.name);
                              const label = pl.is_automa ? "봇" : pl.name;
                              return (
                                <span key={pl.id ?? i} className="avatar-slot" style={{ zIndex: visiblePlayers.length - i }} title={label}>
                                  {avatar ? (
                                    <img decoding="async" className="winner-avatar" src={api.avatarUrl(avatar)} alt={label} />
                                  ) : (
                                    <div className="winner-initial" style={{ background: colorForName(pl.name) }}>
                                      {label.slice(0, 1)}
                                    </div>
                                  )}
                                </span>
                              );
                            })}
                            {overflowCount > 0 && (
                              <span className="avatar-slot avatar-overflow" style={{ zIndex: 0 }}>+{overflowCount}</span>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </Link>
              );
            })}
          </div>
        );
      })}

      {loadingMore && <p className="muted plays-loading-more">불러오는 중...</p>}
      {/* 조건부로 렌더링하면 로딩이 끝나 처음 나타나는 시점에 옵저버 effect가 이미 지나가버려
          영영 관찰을 못 시작한다 - 그래서 항상 렌더링해두고 hasMore는 콜백 안에서만 체크한다. */}
      <div ref={sentinelRef} className="plays-scroll-sentinel" />
    </div>
  );
}
