import { Fragment, useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api } from "../api/client";
import type { PlayDetail } from "../api/types";
import PhotoSlider from "../components/PhotoSlider";
import "../styles/PlayDetail.css";

function fmtNum(n: number | null | undefined) {
  if (n == null) return "-";
  return Math.round(n).toLocaleString();
}

export default function PlayDetailPage() {
  const { id } = useParams();
  const playId = Number(id);
  const navigate = useNavigate();

  const [play, setPlay] = useState<PlayDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.play(playId)
      .then(setPlay)
      .catch((err) => setError(err instanceof Error ? err.message : "불러오기 실패"))
      .finally(() => setLoading(false));
  }, [playId]);

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;
  if (error || !play) return <div className="page center-pad error-text">{error || "기록을 찾을 수 없습니다"}</div>;

  const comboMap = new Map(play.comboStats.players.map((c) => [c.name, c]));
  const humanCount = play.players.filter((p) => !p.is_automa).length;

  return (
    <div className="page play-detail-page">
      <button className="back-btn" onClick={() => navigate(-1)}>← 뒤로</button>

      <div className="page-header">
        <h1><Link to={`/game/${play.game_id}`}>{play.game_name}</Link></h1>
        <button className="icon-btn" style={{ background: "none", color: "var(--muted)" }}
          onClick={() => navigate(`/plays/${play.id}/edit`)} aria-label="기록 수정">✎</button>
      </div>

      {play.photos.length > 0 && (
        <div className="card play-detail-photos">
          <PhotoSlider photos={play.photos} />
        </div>
      )}

      <div className="card info-box">
        <div className="info-row"><span className="muted">날짜</span><span>{play.played_at}</span></div>
        <div className="info-row"><span className="muted">장소</span><span>{play.location || "미기록"}</span></div>
        <div className="info-row"><span className="muted">시간</span><span>{play.duration_min ? `${play.duration_min}분` : "-"}</span></div>
        <div className="info-row"><span className="muted">인원</span><span>{humanCount <= 1 ? "1인" : `${humanCount}인+`}{play.is_coop ? " · 협력" : ""}</span></div>
      </div>

      {play.comment && (
        <>
          <div className="section-title">코멘트</div>
          <div className="card"><p>{play.comment}</p></div>
        </>
      )}

      <div className="section-title">플레이어</div>
      <div className="card play-detail-players">
        {play.players.map((p, i) => {
          const combo = comboMap.get(p.name);
          return (
            <div key={i} className="play-detail-player-row">
              <div className="play-detail-player-main">
                <span className="play-detail-player-name">
                  {p.name}{p.is_automa ? " 🤖" : ""}{p.win ? " 🏆" : ""}
                </span>
                <span>{p.score != null ? fmtNum(p.score) : "-"}</span>
              </div>
              <div className="play-detail-badges">
                {p.isBestScore && <span className="badge badge-best">최고 점수!</span>}
                {combo && combo.currentStreak >= 2 && (
                  <span className="badge badge-streak">{combo.currentStreak} 연승</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {play.players.some((p) => p.score_breakdown) && (
        <>
          <div className="section-title">점수 시트</div>
          <div className="card score-breakdown-table" style={{ gridTemplateColumns: `1fr repeat(${play.players.length}, 0.8fr)` }}>
            <span className="score-breakdown-header muted">항목</span>
            {play.players.map((p, i) => <span key={i} className="score-breakdown-header muted">{p.name}</span>)}
            {[...new Set(play.players.flatMap((p) => Object.keys(p.score_breakdown || {})))].map((field) => (
              <Fragment key={field}>
                <span className="muted">{field}</span>
                {play.players.map((p, i) => (
                  <span key={i}>{p.score_breakdown?.[field] != null ? fmtNum(p.score_breakdown[field]) : "-"}</span>
                ))}
              </Fragment>
            ))}
          </div>
        </>
      )}

      {play.comboStats.matchCount > 1 && (
        <>
          <div className="section-title">이 조합의 통계 ({play.comboStats.matchCount}판)</div>
          <div className="card combo-stats-table">
            <div className="combo-stats-header muted">
              <span>플레이어</span><span>승</span><span>승률</span><span>평균</span><span>최고</span>
            </div>
            {play.comboStats.players.map((c) => (
              <div key={c.name} className="combo-stats-row">
                <span>{c.name}</span>
                <span>{c.wins}/{c.plays}</span>
                <span>{c.winRate != null ? `${c.winRate}%` : "-"}</span>
                <span>{c.avgScore != null ? fmtNum(c.avgScore) : "-"}</span>
                <span>{c.bestScore != null ? fmtNum(c.bestScore) : "-"}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
