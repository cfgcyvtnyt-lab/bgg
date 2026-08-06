import { Fragment, useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api } from "../api/client";
import type { PlayDetail, User } from "../api/types";
import { imgUrl } from "../utils/imgUrl";
import PhotoSlider from "../components/PhotoSlider";
import "../styles/PlayDetail.css";

function fmtNum(n: number | null | undefined) {
  if (n == null) return "-";
  return Math.round(n).toLocaleString();
}

// 목록 페이지와 동일한 규칙 - 아바타 없는 사용자는 이니셜 원을 이름 해시로 고정된 색으로 보여준다.
const INITIAL_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)", "var(--c9)", "var(--c10)"];
function colorForName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return INITIAL_COLORS[hash % INITIAL_COLORS.length];
}

export default function PlayDetailPage() {
  const { id } = useParams();
  const playId = Number(id);
  const navigate = useNavigate();

  const [play, setPlay] = useState<PlayDetail | null>(null);
  const [users, setUsers] = useState<User[]>([]);
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

  useEffect(() => {
    api.users().then(setUsers).catch(() => {});
  }, []);

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;
  if (error || !play) return <div className="page center-pad error-text">{error || "기록을 찾을 수 없습니다"}</div>;

  const comboMap = new Map(play.comboStats.players.map((c) => [c.name, c]));
  const avatarByName = new Map(users.filter((u) => u.avatar).map((u) => [u.name, u.avatar as string]));
  const boxArt = imgUrl(play.game_thumbnail || play.game_image);

  return (
    <div className="page play-detail-page">
      <button className="back-btn" onClick={() => navigate(-1)}>← 뒤로</button>

      <div className="play-detail-header">
        <Link to={`/game/${play.game_id}`} className="play-detail-boxart">
          {boxArt ? <img src={boxArt} alt="" /> : <div className="play-detail-boxart-empty">?</div>}
        </Link>
        <div className="play-detail-header-text">
          <Link to={`/game/${play.game_id}`} className="play-detail-header-name">{play.game_name}</Link>
          <div className="muted">{play.played_at}</div>
        </div>
        <button className="icon-btn" style={{ background: "none", color: "var(--muted)" }}
          onClick={() => navigate(`/plays/${play.id}/edit`)} aria-label="기록 수정">✎</button>
      </div>

      <div className="card info-box">
        <div className="info-row"><span className="muted">위치</span><span>{play.location || "미기록"}</span></div>
        <div className="info-row"><span className="muted">시간</span><span>{play.duration_min ? `${play.duration_min}분` : "-"}</span></div>
      </div>

      {!!play.has_rule_error && (
        <div className="card rule-error-box">
          <span className="rule-error-tag">⚠️ 룰 실수</span>
          {play.rule_error_note && <span className="rule-error-note">{play.rule_error_note}</span>}
        </div>
      )}

      <div className="section-title">플레이어</div>
      <div className="card play-detail-players">
        {play.players.map((p, i) => {
          const combo = comboMap.get(p.name);
          const isWinner = p.win === true || p.win === 1;
          const avatar = avatarByName.get(p.name);
          return (
            <div key={i} className="play-detail-player-row">
              <div className="play-detail-player-left">
                {avatar ? (
                  <img className="player-avatar" src={api.avatarUrl(avatar)} alt="" />
                ) : (
                  <div className="player-initial" style={{ background: colorForName(p.name) }}>{p.name.slice(0, 1)}</div>
                )}
                <span className="play-detail-player-name">{p.name}{p.is_automa ? " 🤖" : ""}</span>
                {isWinner && <span className="player-wreath" aria-label="승자" title="승자">🏆</span>}
              </div>
              <div className="play-detail-player-right">
                {p.isBestScore && <span className="badge badge-best">최고 점수!</span>}
                {combo && combo.currentStreak >= 2 && (
                  <span className="badge badge-streak">{combo.currentStreak} 연승</span>
                )}
                <span className="play-detail-player-score">{p.score != null ? fmtNum(p.score) : "-"}</span>
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
          <div className="section-title combo-stats-title">
            <span>이 조합의 통계</span>
            <Link to={`/plays?game_id=${play.game_id}&game_name=${encodeURIComponent(play.game_name || "")}`} className="combo-stats-link">
              {play.comboStats.matchCount}회 플레이 &gt;
            </Link>
          </div>
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

      {play.comment && (
        <>
          <div className="section-title">코멘트</div>
          <div className="card play-detail-comment">{play.comment}</div>
        </>
      )}

      {play.photos.length > 0 && (
        <div className="card play-detail-photos">
          <PhotoSlider photos={play.photos} />
        </div>
      )}
    </div>
  );
}
