import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Game, Play } from "../api/types";
import "../styles/Plays.css";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function fmtDateHeader(dateStr: string) {
  // dateStr: YYYY-MM-DD (로컬 타임존 이슈를 피하려고 문자열을 직접 쪼갠다)
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return { weekday: WEEKDAYS[date.getDay()], label: `${y}년 ${m}월 ${d}일` };
}

// 로컬 타임존 기준 YYYY-MM-DD (UTC 변환 시 날짜가 하루 밀리는 걸 피한다)
function fmtLocalDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return fmtLocalDate(new Date());
}

function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fmtLocalDate(d);
}

export default function PlaysPage() {
  const [plays, setPlays] = useState<Play[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // ---------- 필터 ----------
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [gameId, setGameId] = useState<number | null>(null);
  const [gameName, setGameName] = useState("");
  const [gameQuery, setGameQuery] = useState("");
  const [gameOptions, setGameOptions] = useState<Game[]>([]);
  const [showGameDropdown, setShowGameDropdown] = useState(false);

  const activePreset = useMemo(() => {
    if (!from && !to) return "all";
    if (to === todayStr() && from === daysAgoStr(6)) return "7";
    if (to === todayStr() && from === daysAgoStr(29)) return "30";
    return null;
  }, [from, to]);

  function applyPreset(preset: "all" | "7" | "30") {
    if (preset === "all") { setFrom(""); setTo(""); return; }
    setTo(todayStr());
    setFrom(daysAgoStr(preset === "7" ? 6 : 29));
  }

  // 게임 검색 드롭다운 - 입력할 때마다 바로 조회 (디바운스 없이도 /api/games가 충분히 가볍다)
  useEffect(() => {
    const q = gameQuery.trim();
    if (!q) { setGameOptions([]); return; }
    let cancelled = false;
    api.games(q, 20).then((list) => { if (!cancelled) setGameOptions(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, [gameQuery]);

  function clearGameFilter() {
    setGameId(null);
    setGameName("");
    setGameQuery("");
    setGameOptions([]);
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    // 서버가 /api/plays 응답을 500건으로 캡핑해서, 전체 개수를 보여주려면
    // 500건씩 끊어서 다 받아올 때까지 페이지를 넘긴다.
    (async () => {
      try {
        const all: Play[] = [];
        for (let offset = 0; ; offset += 500) {
          const page = await api.plays({
            limit: 500,
            offset,
            from: from || undefined,
            to: to || undefined,
            game_id: gameId ?? undefined,
          });
          all.push(...page);
          if (page.length < 500) break;
        }
        setPlays(all);
      } catch (err) {
        setError(err instanceof Error ? err.message : "불러오기 실패");
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to, gameId]);

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
        <button className="icon-btn" onClick={() => navigate("/plays/new")} aria-label="기록 추가">＋</button>
      </div>

      <div className="plays-filter-row">
        <div className="chip-row plays-period-chips">
          <button className={`chip${activePreset === "all" ? " chip-active" : ""}`} onClick={() => applyPreset("all")}>전체</button>
          <button className={`chip${activePreset === "7" ? " chip-active" : ""}`} onClick={() => applyPreset("7")}>최근 7일</button>
          <button className={`chip${activePreset === "30" ? " chip-active" : ""}`} onClick={() => applyPreset("30")}>최근 30일</button>
        </div>
        <div className="plays-date-inputs">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="시작일" />
          <span className="muted">~</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="종료일" />
        </div>
        <div className="plays-game-filter">
          {gameId ? (
            <div className="plays-game-selected chip chip-active">
              {gameName}
              <button className="plays-game-clear" onClick={clearGameFilter} aria-label="게임 필터 해제">×</button>
            </div>
          ) : (
            <div className="plays-game-search">
              <input
                className="search-input"
                placeholder="게임으로 필터링"
                value={gameQuery}
                onChange={(e) => { setGameQuery(e.target.value); setShowGameDropdown(true); }}
                onFocus={() => setShowGameDropdown(true)}
                onBlur={() => setTimeout(() => setShowGameDropdown(false), 150)}
              />
              {showGameDropdown && gameOptions.length > 0 && (
                <div className="plays-game-dropdown">
                  {gameOptions.map((g) => (
                    <button
                      key={g.id}
                      className="filter-dropdown-item"
                      onMouseDown={() => { setGameId(g.id); setGameName(g.custom_name || g.name); setGameQuery(""); setGameOptions([]); setShowGameDropdown(false); }}
                    >
                      {g.custom_name || g.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {!loading && !error && plays.length > 0 && (
        <p className="plays-total muted">{plays.length.toLocaleString()} 플레이</p>
      )}

      {loading && <p className="muted center-pad">불러오는 중...</p>}
      {error && <p className="error-text center-pad">{error}</p>}
      {!loading && !error && plays.length === 0 && (
        <p className="muted center-pad">조건에 맞는 플레이 기록이 없습니다.</p>
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
              // win=1인 플레이어만 승자로 취급한다 (트로피 오귀속 버그 수정).
              const winners = p.players.filter((pl) => pl.win === true || pl.win === 1).map((pl) => pl.name);
              // 플레이어 나열은 승자를 먼저 보여준다 (원래 순서는 각 그룹 내에서 유지).
              const orderedPlayers = [
                ...p.players.filter((pl) => pl.win === true || pl.win === 1),
                ...p.players.filter((pl) => !(pl.win === true || pl.win === 1)),
              ];
              const humanCount = p.players.filter((pl) => !pl.is_automa).length;
              return (
                <Link key={p.id} to={`/plays/${p.id}`} className="play-item">
                  <div className="play-item-top">
                    <span className="play-item-game">{p.game_name}</span>
                    {winners.length > 0 && (
                      <span className="play-item-winner">🏆 {winners.join(", ")}</span>
                    )}
                  </div>
                  <div className="play-item-loc muted">
                    {p.location || "장소 미기록"} · {orderedPlayers.map((pl) => pl.name).join(", ") || "플레이어 없음"}
                    {humanCount <= 1 ? " · 솔로" : ""}
                    {p.is_coop ? " · 협력" : ""}
                  </div>
                </Link>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
