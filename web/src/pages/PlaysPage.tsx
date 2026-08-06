import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Play } from "../api/types";
import "../styles/Plays.css";

function fmtNum(n: number | null | undefined) {
  if (n == null) return "";
  return Math.round(n).toLocaleString();
}

export default function PlaysPage() {
  const [plays, setPlays] = useState<Play[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    api.plays({ limit: 500 })
      .then(setPlays)
      .catch((err) => setError(err instanceof Error ? err.message : "불러오기 실패"))
      .finally(() => setLoading(false));
  }, []);

  // 월 구분선을 넣기 위해 played_at 기준으로 그룹핑 (서버가 이미 최신순으로 정렬해준다)
  const groups = useMemo(() => {
    const map = new Map<string, Play[]>();
    for (const p of plays) {
      const month = p.played_at.slice(0, 7);
      if (!map.has(month)) map.set(month, []);
      map.get(month)!.push(p);
    }
    return [...map.entries()];
  }, [plays]);

  return (
    <div className="page plays-page">
      <div className="page-header">
        <h1>기록</h1>
        <button className="icon-btn" onClick={() => navigate("/plays/new")} aria-label="기록 추가">＋</button>
      </div>

      {loading && <p className="muted center-pad">불러오는 중...</p>}
      {error && <p className="error-text center-pad">{error}</p>}
      {!loading && !error && plays.length === 0 && (
        <p className="muted center-pad">아직 플레이 기록이 없습니다. + 버튼으로 추가해보세요.</p>
      )}

      {groups.map(([month, list]) => (
        <div key={month} className="play-month-group">
          <div className="play-month-divider">{month.replace("-", "년 ")}월</div>
          {list.map((p) => (
            <Link key={p.id} to={`/plays/${p.id}/edit`} className="play-item">
              <div className="play-item-top">
                <span className="play-item-game">{p.game_name}</span>
                <span className="muted">{p.played_at.slice(8, 10)}일</span>
              </div>
              <div className="play-item-loc muted">
                {p.location || "장소 미기록"}{p.is_coop ? " · 협력" : ""}
              </div>
              <div className="play-item-players">
                {p.players.map((pl, i) => (
                  <span key={i} className={`player-chip${pl.win ? " win" : ""}`}>
                    {pl.name}{pl.score != null ? ` ${fmtNum(pl.score)}` : ""}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}
