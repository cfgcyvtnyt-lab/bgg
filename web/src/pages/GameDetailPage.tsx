import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api/client";
import type { GameDetail, Play } from "../api/types";
import { imgUrl } from "../utils/imgUrl";
import "../styles/GameDetail.css";

const STATUS_LIST = ["보유", "선주문", "위시리스트", "방출 예정", "방출 확정", "방출 완료"];
const RECENT_PLAYS_COUNT = 5;

function fmtNum(n: number | null | undefined) {
  if (n == null) return "-";
  return Math.round(n).toLocaleString();
}

type SectionKey = "intro" | "myrecord" | "myinfo" | "history" | "plays";

// 접고 펼 수 있는 섹션 하나. 기본은 소개·내 기록만 펼쳐둔다(스펙).
function Section({
  title, sectionKey, open, onToggle, children,
}: {
  title: string;
  sectionKey: SectionKey;
  open: boolean;
  onToggle: (key: SectionKey) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="detail-section">
      <button className="detail-section-header" onClick={() => onToggle(sectionKey)}>
        <span>{title}</span>
        <span className={`detail-section-chevron${open ? " open" : ""}`}>▾</span>
      </button>
      {open && <div className="detail-section-body">{children}</div>}
    </div>
  );
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

  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    intro: true, myrecord: true, myinfo: false, history: false, plays: false,
  });
  function toggle(key: SectionKey) {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
  }

  // 이름 인라인 편집
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);

  // 소개 섹션: 원문/번역 토글, 번역 진행 상태
  const [showOriginal, setShowOriginal] = useState(false);
  const [translating, setTranslating] = useState(false);

  // 플레이 기록 전체 보기
  const [showAllPlays, setShowAllPlays] = useState(false);

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

  function startEditName() {
    if (!game) return;
    setNameInput(game.custom_name || "");
    setEditingName(true);
  }

  // 빈 값으로 저장하면 서버가 custom_name을 NULL로 되돌려 원래(BGG) 이름으로 복귀시킨다.
  async function saveName() {
    if (!game) return;
    setSavingName(true);
    try {
      await api.updateGame(game.id, { custom_name: nameInput.trim() });
      setEditingName(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "이름 저장 실패");
    } finally {
      setSavingName(false);
    }
  }

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

  async function translate() {
    if (!game) return;
    setTranslating(true);
    try {
      const { description_ko } = await api.translateGame(game.id);
      setGame((g) => (g ? { ...g, description_ko } : g));
    } catch (err) {
      setError(err instanceof Error ? err.message : "번역 실패");
    } finally {
      setTranslating(false);
    }
  }

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;
  if (error || !game) return <div className="page center-pad error-text">{error || "게임을 찾을 수 없습니다"}</div>;

  const thumb = imgUrl(game.image || game.thumbnail);
  const currentStatus = game.collectionHistory.length > 0
    ? game.collectionHistory[game.collectionHistory.length - 1].status
    : "미보유";

  // 상단 스탯 한 줄: "2-4인 · 60분 · 웨이트 3.2 · 긱 7.9 (26위)"
  const statParts: string[] = [];
  statParts.push(game.min_players && game.max_players
    ? (game.min_players === game.max_players ? `${game.min_players}인` : `${game.min_players}-${game.max_players}인`)
    : "인원 미상");
  statParts.push(game.playing_time ? `${game.playing_time}분` : "시간 미상");
  statParts.push(`웨이트 ${game.weight ? game.weight.toFixed(1) : "-"}`);
  statParts.push(game.bgg_rating != null
    ? `긱 ${game.bgg_rating.toFixed(1)}${game.bgg_rank ? ` (${fmtNum(game.bgg_rank)}위)` : ""}`
    : "긱 평점 없음");

  const description = game.description_ko && !showOriginal ? game.description_ko : game.description;
  const visiblePlays = showAllPlays ? plays : plays.slice(0, RECENT_PLAYS_COUNT);

  return (
    <div className="page game-detail-page">
      <button className="back-btn" onClick={() => navigate(-1)}>← 뒤로</button>

      <div className="detail-hero">
        {thumb ? <img src={thumb} alt="" /> : <div className="detail-hero-empty">?</div>}
        <div className="detail-hero-info">
          {editingName ? (
            <div className="name-edit-row">
              <input
                className="name-edit-input"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder={game.original_name || game.name}
                autoFocus
              />
              <button className="btn-small" disabled={savingName} onClick={saveName}>
                {savingName ? "저장 중..." : "저장"}
              </button>
              <button className="btn-small" onClick={() => setEditingName(false)}>취소</button>
            </div>
          ) : (
            <h1 className="name-view-row">
              {game.name}
              <button className="name-edit-btn" aria-label="이름 편집" onClick={startEditName}>✎</button>
            </h1>
          )}
          {game.custom_name && game.original_name && game.original_name !== game.name && (
            <p className="muted name-original">원래 이름: {game.original_name}</p>
          )}
          {game.name_en && <p className="muted">{game.name_en}{game.year_published ? ` (${game.year_published})` : ""}</p>}
          <p className="muted detail-hero-statline">{statParts.join(" · ")}</p>
        </div>
      </div>

      <Section title="게임 소개" sectionKey="intro" open={open.intro} onToggle={toggle}>
        <div className="card intro-box">
          {description ? (
            <>
              <p className="intro-desc">{description}</p>
              {game.description_ko && (
                <button className="btn-small intro-toggle" onClick={() => setShowOriginal((v) => !v)}>
                  {showOriginal ? "번역본 보기" : "원문 보기"}
                </button>
              )}
              {!game.description_ko && game.description && (
                <button className="btn-small intro-toggle" disabled={translating} onClick={translate}>
                  {translating ? "번역 중..." : "한글로 번역"}
                </button>
              )}
            </>
          ) : (
            <p className="muted">설명이 없습니다.</p>
          )}

          {(game.designers?.length || game.artists?.length) ? (
            <div className="intro-people">
              {game.designers && game.designers.length > 0 && (
                <div className="info-row"><span className="muted">디자이너</span><span>{game.designers.join(", ")}</span></div>
              )}
              {game.artists && game.artists.length > 0 && (
                <div className="info-row"><span className="muted">아티스트</span><span>{game.artists.join(", ")}</span></div>
              )}
            </div>
          ) : null}

          {(game.categories && game.categories.length > 0) && (
            <div className="chip-wrap">
              {game.categories.map((c) => <span key={c} className="chip chip-static">{c}</span>)}
            </div>
          )}
          {(game.mechanics && game.mechanics.length > 0) && (
            <div className="chip-wrap">
              {game.mechanics.map((m) => <span key={m} className="chip chip-static chip-mechanic">{m}</span>)}
            </div>
          )}

          <div className="info-row"><span className="muted">BGG 평점</span><span>{game.bgg_rating ? game.bgg_rating.toFixed(1) : "-"}</span></div>
          <div className="info-row"><span className="muted">BGG 순위</span><span>{game.bgg_rank ? `#${fmtNum(game.bgg_rank)}` : "-"}</span></div>
          <div className="info-row"><span className="muted">내 평점</span><span>{game.my_rating != null ? game.my_rating.toFixed(1) : "-"}</span></div>
        </div>
      </Section>

      <Section title="내 기록" sectionKey="myrecord" open={open.myrecord} onToggle={toggle}>
        {game.stats && game.stats.playCount > 0 ? (
          <>
            <div className="card info-box">
              <div className="info-row"><span className="muted">플레이 수</span><span>{fmtNum(game.stats.playCount)}회</span></div>
              <div className="info-row"><span className="muted">승률</span><span>{game.stats.winRate != null ? `${game.stats.winRate}%` : "-"}</span></div>
              <div className="info-row"><span className="muted">평균 소요시간</span><span>{game.stats.avgDurationMin != null ? `${game.stats.avgDurationMin}분` : "-"}</span></div>
              <div className="info-row"><span className="muted">마지막 플레이</span><span>{game.stats.lastPlayedAt || "-"}</span></div>
            </div>

            {(game.stats.score.solo || game.stats.score.multi) && (
              <div className="card score-split-box">
                {game.stats.score.solo && (
                  <div className="score-split-col">
                    <div className="score-split-label muted">1인 ({game.stats.score.solo.count}판)</div>
                    <div className="info-row"><span className="muted">최고</span><span>{fmtNum(game.stats.score.solo.best)}</span></div>
                    <div className="info-row"><span className="muted">최저</span><span>{fmtNum(game.stats.score.solo.worst)}</span></div>
                    <div className="info-row"><span className="muted">평균</span><span>{fmtNum(game.stats.score.solo.avg)}</span></div>
                  </div>
                )}
                {game.stats.score.multi && (
                  <div className="score-split-col">
                    <div className="score-split-label muted">2인+ ({game.stats.score.multi.count}판)</div>
                    <div className="info-row"><span className="muted">최고</span><span>{fmtNum(game.stats.score.multi.best)}</span></div>
                    <div className="info-row"><span className="muted">최저</span><span>{fmtNum(game.stats.score.multi.worst)}</span></div>
                    <div className="info-row"><span className="muted">평균</span><span>{fmtNum(game.stats.score.multi.avg)}</span></div>
                  </div>
                )}
              </div>
            )}

            {game.stats.opponents.length > 0 && (
              <div className="card opponent-box">
                {game.stats.opponents.map((o) => (
                  <div key={o.name} className="info-row">
                    <span className="muted">{o.name}</span>
                    <span>{o.games}판 중 {o.myWins}승</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="muted center-pad">아직 플레이 기록이 없습니다.</p>
        )}
      </Section>

      {/* 소유 상태·구매가는 두 사람 공유 컬렉션 정보다. "내 것"은 평점·플레이 기록뿐. */}
      <Section title="컬렉션 정보" sectionKey="myinfo" open={open.myinfo} onToggle={toggle}>
        <div className="card info-box">
          <div className="info-row"><span className="muted">소유 상태</span><span>{currentStatus}</span></div>
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
      </Section>

      {game.collectionHistory.length > 1 && (
        <Section title="취득 이력" sectionKey="history" open={open.history} onToggle={toggle}>
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
        </Section>
      )}

      <Section title={`플레이 기록 (${plays.length})`} sectionKey="plays" open={open.plays} onToggle={toggle}>
        {plays.length === 0 && <p className="muted center-pad">아직 플레이 기록이 없습니다.</p>}
        <div className="play-list">
          {visiblePlays.map((p) => (
            <Link key={p.id} to={`/plays/${p.id}`} className="play-row">
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
        {!showAllPlays && plays.length > RECENT_PLAYS_COUNT && (
          <button className="btn-small" onClick={() => setShowAllPlays(true)}>전체 보기 ({plays.length})</button>
        )}
      </Section>

      <button className="btn-primary record-btn" onClick={() => navigate(`/plays/new?game_id=${gameId}`)}>
        플레이 기록하기
      </button>
    </div>
  );
}
