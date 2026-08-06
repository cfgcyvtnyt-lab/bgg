import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api/client";
import type { GameDetail, Play, ScoreTemplate, TagCount } from "../api/types";
import { imgUrl } from "../utils/imgUrl";
import { ratingColor, weightColor } from "../utils/ratingTier";
import "../styles/GameDetail.css";

const STATUS_LIST = ["보유", "선주문", "위시리스트", "방출 예정", "방출 확정", "방출 완료"];
const RECENT_PLAYS_COUNT = 5;
const INTRO_TRUNCATE_CHARS = 160; // 대략 4줄 분량 - CSS 라인 수 대신 글자 수로 근사한다.

// 0.5 단위 별점 입력. 별 하나가 2점(=★ 한 칸당 rating 2)이라 클릭 위치의 좌/우 절반으로 0.5 단위를 구현한다.
function StarRating({ value, onChange, disabled }: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  const stars = [1, 2, 3, 4, 5];
  function handleClick(e: React.MouseEvent<HTMLSpanElement>, star: number) {
    if (disabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const half = e.clientX - rect.left < rect.width / 2;
    const newValue = star * 2 - (half ? 1 : 0);
    // 이미 같은 값을 다시 클릭하면 평점을 지운다(토글).
    onChange(value === newValue ? null : newValue);
  }
  return (
    <span className="star-rating-stars">
      {stars.map((star) => {
        const filled = value != null ? Math.max(0, Math.min(1, value - (star - 1) * 2)) : 0;
        return (
          <span
            key={star}
            onClick={(e) => handleClick(e, star)}
            style={{
              position: "relative",
              display: "inline-block",
              fontSize: 22,
              cursor: disabled ? "default" : "pointer",
              color: "var(--border)",
            }}
          >
            ★
            <span
              style={{
                position: "absolute", inset: 0, overflow: "hidden",
                width: `${filled * 100}%`, color: "#d9a441",
              }}
            >
              ★
            </span>
          </span>
        );
      })}
    </span>
  );
}

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

  // 소개 섹션: 원문/번역 토글, 번역 진행 상태, 4줄 초과 시 더보기
  const [showOriginal, setShowOriginal] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [introExpanded, setIntroExpanded] = useState(false);

  // 내 평점 (별점) 편집
  const [ratingSaving, setRatingSaving] = useState(false);

  // 용도 태그 제안 칩 - 컬렉션 전체에서 이미 쓰인 태그
  const [allTags, setAllTags] = useState<TagCount[]>([]);
  useEffect(() => {
    api.tags().then(setAllTags).catch(() => setAllTags([]));
  }, []);

  // 플레이 기록 전체 보기
  const [showAllPlays, setShowAllPlays] = useState(false);

  // 편집 중인 "내 정보" 폼 상태 (최신 취득 이력 기준)
  const [form, setForm] = useState({
    status: "보유", price_paid: "", price_sold: "", tags: "", note: "",
  });

  // 점수 시트 템플릿 - 게임에 속한 공유 값이라 컬렉션 정보 근처에서 관리한다.
  const [scoreTemplate, setScoreTemplate] = useState<ScoreTemplate | null>(null);
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [templateFieldsText, setTemplateFieldsText] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);

  useEffect(() => {
    api.scoreTemplate(gameId).then(setScoreTemplate).catch(() => setScoreTemplate(null));
  }, [gameId]);

  function startEditTemplate() {
    setTemplateFieldsText(scoreTemplate ? scoreTemplate.fields.join(", ") : "");
    setEditingTemplate(true);
  }

  async function saveTemplate() {
    const fields = templateFieldsText.split(",").map((f) => f.trim()).filter(Boolean);
    if (fields.length === 0) return;
    setTemplateSaving(true);
    try {
      const t = await api.saveScoreTemplate(gameId, fields);
      setScoreTemplate(t);
      setEditingTemplate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "점수 시트 저장 실패");
    } finally {
      setTemplateSaving(false);
    }
  }

  async function deleteTemplate() {
    if (!window.confirm("점수 시트를 삭제할까요?")) return;
    setTemplateSaving(true);
    try {
      await api.deleteScoreTemplate(gameId);
      setScoreTemplate(null);
      setEditingTemplate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "점수 시트 삭제 실패");
    } finally {
      setTemplateSaving(false);
    }
  }

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

  // 상세를 열었을 때 번역 캐시(description_ko)가 없으면 버튼 없이 자동으로 한 번 번역해둔다.
  // 실패하면 조용히 영문을 그대로 보여준다(에러를 화면에 띄우지 않는다).
  useEffect(() => {
    if (!game || !game.description || game.description_ko || translating) return;
    setTranslating(true);
    api.translateGame(game.id)
      .then(({ description_ko }) => setGame((g) => (g ? { ...g, description_ko } : g)))
      .catch(() => { /* 조용히 실패 - 영문 그대로 표시 */ })
      .finally(() => setTranslating(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id, game?.description, game?.description_ko]);

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
      api.tags().then(setAllTags).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  // 별점 편집: 0~10 스케일로 저장하고, 화면에는 0~5(★)로 나눠 보여준다.
  async function saveRating(starValue: number | null) {
    if (!game) return;
    setRatingSaving(true);
    const rating10 = starValue == null ? null : starValue * 2;
    try {
      const { my_rating } = await api.setRating(game.id, rating10);
      setGame((g) => (g ? { ...g, my_rating } : g));
    } catch (err) {
      setError(err instanceof Error ? err.message : "평점 저장 실패");
    } finally {
      setRatingSaving(false);
    }
  }

  function toggleFormTag(tag: string) {
    const cur = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag];
    setForm((f) => ({ ...f, tags: next.join(", ") }));
  }

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;
  if (error || !game) return <div className="page center-pad error-text">{error || "게임을 찾을 수 없습니다"}</div>;

  const thumb = imgUrl(game.image || game.thumbnail);
  const currentStatus = game.collectionHistory.length > 0
    ? game.collectionHistory[game.collectionHistory.length - 1].status
    : "미보유";

  // 인원/시간/연령 줄: "1–4인 (베스트 1–2)" / "45–90분" / "14+"
  const playersLine = game.min_players && game.max_players
    ? (game.min_players === game.max_players ? `${game.min_players}인` : `${game.min_players}–${game.max_players}인`)
      + (game.best_players ? ` (베스트 ${game.best_players.replace("-", "–")})` : "")
    : "인원 미상";
  const playtimeLine = game.min_playtime && game.max_playtime
    ? (game.min_playtime === game.max_playtime ? `${game.min_playtime}분` : `${game.min_playtime}–${game.max_playtime}분`)
    : game.playing_time ? `${game.playing_time}분` : "시간 미상";
  const ageLine = game.min_age ? `${game.min_age}+` : null;

  // 순위 줄: "전체 48위 · Customizable 3위" - boardgame(전체)은 bgg_rank, sub_ranks에서 상위 1~2개만.
  const rankParts: string[] = [];
  if (game.bgg_rank) rankParts.push(`전체 ${fmtNum(game.bgg_rank)}위`);
  for (const r of (game.sub_ranks || []).slice(0, 2)) {
    rankParts.push(`${r.name.replace(/ Rank$/, "")} ${fmtNum(r.value)}위`);
  }

  const description = game.description_ko && !showOriginal ? game.description_ko : game.description;
  const tagline = description ? description.split(/(?<=[.!?다\.])\s+/)[0] : null;
  const introTruncated = !introExpanded && description && description.length > INTRO_TRUNCATE_CHARS;
  const introShown = introTruncated ? `${description!.slice(0, INTRO_TRUNCATE_CHARS)}...` : description;

  const visiblePlays = showAllPlays ? plays : plays.slice(0, RECENT_PLAYS_COUNT);
  const usedTags = allTags.map((t) => t.tag);
  const formTagList = form.tags.split(",").map((t) => t.trim()).filter(Boolean);

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

          <div className="detail-hero-top">
            {game.bgg_rating != null && (
              <div className="rating-badge" style={{ background: ratingColor(game.bgg_rating) }}>
                <span className="rating-badge-value">{game.bgg_rating.toFixed(1)}</span>
              </div>
            )}
            <div>
              {game.users_rated != null && (
                <div className="rating-badge-users muted">평가 {fmtNum(game.users_rated)}+</div>
              )}
              {rankParts.length > 0 && <div className="detail-hero-rankline">{rankParts.join(" · ")}</div>}
            </div>
          </div>

          <p className="muted detail-hero-statline">
            {playersLine} · {playtimeLine}{ageLine ? ` · ${ageLine}` : ""} ·{" "}
            <span className="detail-hero-weight" style={{ color: weightColor(game.weight) }}>
              웨이트 {game.weight ? game.weight.toFixed(1) : "-"}
            </span>
          </p>
          {game.publishers && game.publishers.length > 0 && (
            <p className="detail-hero-publishers">퍼블리셔: {game.publishers.join(", ")}</p>
          )}
          {tagline && <p className="detail-tagline">{tagline}</p>}
          <a className="bgg-link-btn" href={`https://boardgamegeek.com/boardgame/${game.id}`} target="_blank" rel="noreferrer">
            BGG에서 보기 ↗
          </a>
        </div>
      </div>

      <Section title="게임 소개" sectionKey="intro" open={open.intro} onToggle={toggle}>
        <div className="card intro-box">
          {description ? (
            <>
              <p className="intro-desc">{introShown}</p>
              <div className="field-row" style={{ gap: 8 }}>
                {description!.length > INTRO_TRUNCATE_CHARS && (
                  <button className="btn-small intro-toggle" onClick={() => setIntroExpanded((v) => !v)}>
                    {introExpanded ? "접기" : "...더보기"}
                  </button>
                )}
                {game.description_ko && (
                  <button className="btn-small intro-toggle" onClick={() => setShowOriginal((v) => !v)}>
                    {showOriginal ? "번역본 보기" : "원문 보기"}
                  </button>
                )}
                {translating && <span className="muted" style={{ fontSize: 12 }}>번역 중...</span>}
              </div>
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
        <div className="card star-rating-row">
          <StarRating value={game.my_rating != null ? game.my_rating / 2 : null} onChange={saveRating} disabled={ratingSaving} />
          <span className="star-rating-value">{game.my_rating != null ? game.my_rating.toFixed(1) : "평점 없음"}</span>
          {game.my_rating != null && (
            <button className="star-clear-btn" disabled={ratingSaving} onClick={() => saveRating(null)}>지우기</button>
          )}
        </div>
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
            {usedTags.length > 0 && (
              <div className="tag-suggest-row">
                {usedTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`tag-suggest-chip${formTagList.includes(t) ? " active" : ""}`}
                    onClick={() => toggleFormTag(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="field">
            <label>메모</label>
            <textarea rows={3} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          </div>
          <button className="btn-primary" disabled={saving} onClick={saveInfo}>{saving ? "저장 중..." : "저장"}</button>

          <div className="score-template-manage">
            <div className="info-row">
              <span className="muted">점수 시트</span>
              <span>{scoreTemplate ? scoreTemplate.fields.join(", ") : "없음"}</span>
            </div>
            {editingTemplate ? (
              <>
                <input
                  value={templateFieldsText}
                  onChange={(e) => setTemplateFieldsText(e.target.value)}
                  placeholder="밭, 목초지, 곡식, 채소, 가축"
                />
                <div className="field-row" style={{ marginTop: 6 }}>
                  <button className="btn-small" disabled={templateSaving || !templateFieldsText.trim()} onClick={saveTemplate}>
                    {templateSaving ? "저장 중..." : "저장"}
                  </button>
                  <button className="btn-small" onClick={() => setEditingTemplate(false)}>취소</button>
                </div>
              </>
            ) : (
              <div className="field-row" style={{ marginTop: 6 }}>
                <button className="btn-small" onClick={startEditTemplate}>{scoreTemplate ? "수정" : "만들기"}</button>
                {scoreTemplate && (
                  <button className="btn-small danger" disabled={templateSaving} onClick={deleteTemplate}>삭제</button>
                )}
              </div>
            )}
          </div>
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
