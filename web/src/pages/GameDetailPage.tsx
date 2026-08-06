import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api/client";
import type { GameDetail, Play } from "../api/types";
import "../styles/GameDetail.css";

const STATUS_LIST = ["보유", "선주문", "위시리스트", "방출 예정", "방출 확정", "방출 완료"];

function fmtNum(n: number | null | undefined) {
  if (n == null) return "-";
  return Math.round(n).toLocaleString();
}

export default function GameDetailPage() {
  const { id } = useParams();
  const gameId = Number(id);
  const navigate = useNavigate();

  const [game, setGame] = useState<GameDetail | null>(null);
  const [plays, setPlays] = useState<Play[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 편집 중인 "내 정보" 폼 상태 (최신 취득 이력 기준)
  const [form, setForm] = useState({
    status: "보유", price_paid: "", price_sold: "", tags: "", note: "",
  });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [g, p] = await Promise.all([
        api.game(gameId),
        api.plays({ game_id: gameId, limit: 500 }),
      ]);
      setGame(g);
      setPlays(p);
      const latest = g.collectionHistory[g.collectionHistory.length - 1];
      if (latest) {
        setForm({
          status: latest.status,
          price_paid: latest.price_paid != null ? String(latest.price_paid) : "",
          price_sold: latest.price_sold != null ? String(latest.price_sold) : "",
          tags: latest.tags.join(", "),
          note: latest.note || "",
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [gameId]);

  async function saveInfo() {
    if (!game) return;
    setSaving(true);
    try {
      const latest = game.collectionHistory[game.collectionHistory.length - 1];
      const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const body = {
        status: form.status,
        price_paid: form.price_paid === "" ? null : Number(form.price_paid),
        price_sold: form.price_sold === "" ? null : Number(form.price_sold),
        tags,
        note: form.note || null,
      };
      if (latest) {
        await api.updateCollection(latest.id, body);
      } else {
        await api.addCollection({ game_id: gameId, ...body });
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;
  if (error || !game) return <div className="page center-pad error-text">{error || "게임을 찾을 수 없습니다"}</div>;

  const thumb = game.image || game.thumbnail;

  return (
    <div className="page game-detail-page">
      <button className="back-btn" onClick={() => navigate(-1)}>← 뒤로</button>

      <div className="detail-hero">
        {thumb ? <img src={thumb} alt="" /> : <div className="detail-hero-empty">?</div>}
        <div className="detail-hero-info">
          <h1>{game.name}</h1>
          {game.name_en && <p className="muted">{game.name_en}{game.year_published ? ` (${game.year_published})` : ""}</p>}
          <div className="detail-hero-stats">
            <span>{game.min_players && game.max_players
              ? (game.min_players === game.max_players ? `${game.min_players}인` : `${game.min_players}-${game.max_players}인`)
              : "인원 미상"}</span>
            <span>{game.playing_time ? `${game.playing_time}분` : "시간 미상"}</span>
            <span>난이도 {game.weight ? game.weight.toFixed(1) : "-"}</span>
          </div>
        </div>
      </div>

      <div className="section-title">BGG 정보</div>
      <div className="card info-box">
        <div className="info-row"><span className="muted">BGG 평점</span><span>{game.bgg_rating ? game.bgg_rating.toFixed(1) : "-"}</span></div>
        <div className="info-row"><span className="muted">BGG 순위</span><span>{game.bgg_rank ? `#${fmtNum(game.bgg_rank)}` : "-"}</span></div>
        <div className="info-row"><span className="muted">내 평점</span><span>{game.my_rating != null ? game.my_rating.toFixed(1) : "-"}</span></div>
        <div className="info-row"><span className="muted">내 플레이 수</span><span>{fmtNum(game.playCount)}회</span></div>
        <div className="info-row"><span className="muted">소유 상태</span><span>{game.collectionHistory.length > 0 ? game.collectionHistory[game.collectionHistory.length - 1].status : "미보유"}</span></div>
      </div>

      <div className="section-title">내 정보 (편집 가능)</div>
      <div className="card info-box">
        <div className="field">
          <label>상태</label>
          <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
            {STATUS_LIST.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field-row">
          <div className="field">
            <label>구매가</label>
            <input type="number" value={form.price_paid} onChange={(e) => setForm((f) => ({ ...f, price_paid: e.target.value }))} placeholder="원" />
          </div>
          <div className="field">
            <label>판매가</label>
            <input type="number" value={form.price_sold} onChange={(e) => setForm((f) => ({ ...f, price_sold: e.target.value }))} placeholder="원" />
          </div>
        </div>
        <div className="field">
          <label>용도 태그 (쉼표로 구분)</label>
          <input value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} placeholder="전략, 필러" />
        </div>
        <div className="field">
          <label>메모</label>
          <textarea rows={3} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </div>
        <button className="btn-primary" disabled={saving} onClick={saveInfo}>{saving ? "저장 중..." : "저장"}</button>
      </div>

      {game.collectionHistory.length > 1 && (
        <>
          <div className="section-title">취득 이력</div>
          <div className="card">
            {game.collectionHistory.map((h) => (
              <div key={h.id} className="history-row">
                <span>{h.status}</span>
                <span className="muted">{h.acquired_at || h.created_at.slice(0, 10)}</span>
                <span className="muted">
                  {h.price_paid != null ? `구매 ${fmtNum(h.price_paid)}` : ""}
                  {h.price_sold != null ? ` / 판매 ${fmtNum(h.price_sold)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">내 플레이 기록 ({plays.length})</div>
      {plays.length === 0 && <p className="muted center-pad">아직 플레이 기록이 없습니다.</p>}
      <div className="play-list">
        {plays.map((p) => (
          <Link key={p.id} to={`/plays/${p.id}/edit`} className="play-row">
            <div className="play-row-date">{p.played_at}</div>
            <div className="play-row-detail muted">
              {p.location || "장소 미기록"}
              {p.duration_min ? ` · ${p.duration_min}분` : ""}
            </div>
            <div className="play-row-players">
              {p.players.map((pl) => `${pl.name}${pl.win ? "🏆" : ""}${pl.score != null ? ` ${fmtNum(pl.score)}` : ""}`).join(", ")}
            </div>
          </Link>
        ))}
      </div>

      <button className="btn-primary record-btn" onClick={() => navigate(`/plays/new?game_id=${gameId}`)}>
        플레이 기록하기
      </button>
    </div>
  );
}
