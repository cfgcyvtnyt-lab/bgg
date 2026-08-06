import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Play } from "../api/types";
import "../styles/Plays.css";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function fmtDateHeader(dateStr: string) {
  // dateStr: YYYY-MM-DD (로컬 타임존 이슈를 피하려고 문자열을 직접 쪼갠다)
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return { weekday: WEEKDAYS[date.getDay()], label: `${y}년 ${m}월 ${d}일` };
}

export default function PlaysPage() {
  const [plays, setPlays] = useState<Play[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    setError(null);
    // 서버가 /api/plays 응답을 500건으로 캡핑해서, 전체 개수(1,286 플레이 등)를 보여주려면
    // 500건씩 끊어서 다 받아올 때까지 페이지를 넘긴다.
    (async () => {
      try {
        const all: Play[] = [];
        for (let offset = 0; ; offset += 500) {
          const page = await api.plays({ limit: 500, offset });
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
  }, []);

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

      {!loading && !error && plays.length > 0 && (
        <p className="plays-total muted">{plays.length.toLocaleString()} 플레이</p>
      )}

      {loading && <p className="muted center-pad">불러오는 중...</p>}
      {error && <p className="error-text center-pad">{error}</p>}
      {!loading && !error && plays.length === 0 && (
        <p className="muted center-pad">아직 플레이 기록이 없습니다. + 버튼으로 추가해보세요.</p>
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
              const winners = p.players.filter((pl) => pl.win).map((pl) => pl.name);
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
                    {p.location || "장소 미기록"} · {p.players.map((pl) => pl.name).join(", ") || "플레이어 없음"}
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
