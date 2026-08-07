import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api/client";
import type { GameDetail, Play, ScoreTemplate, TagCount, GameSleeve, GameVersion } from "../api/types";
import { imgUrl } from "../utils/imgUrl";
import { ratingColor, weightColor } from "../utils/ratingTier";
import { bggGameUrl, bggSleevesUrl } from "../utils/bggUrl";
import { useUser } from "../context/UserContext";
import StarRating from "../components/StarRating";
import Modal from "../components/Modal";
import "../styles/GameDetail.css";

const STATUS_LIST = ["보유", "선주문", "위시리스트", "방출 예정", "방출 완료"];
const RECENT_PLAYS_COUNT = 5;
const INTRO_TRUNCATE_CHARS = 160; // 대략 4줄 분량 - CSS 라인 수 대신 글자 수로 근사한다.

function fmtNum(n: number | null | undefined) {
  if (n == null) return "-";
  return Math.round(n).toLocaleString();
}

type SectionKey = "myrecord" | "myinfo" | "history";

// 접고 펼 수 있는 섹션 하나.
// - collapsible=false면 제목만 두고 항상 펼쳐둔다(내 기록은 접을 일이 없다).
// - summary를 주면 접혀 있을 때 그 요약을 대신 보여준다.
function Section({
  title, sectionKey, open, onToggle, children, collapsible = true, summary,
}: {
  title: string;
  sectionKey: SectionKey;
  open: boolean;
  onToggle: (key: SectionKey) => void;
  children: React.ReactNode;
  collapsible?: boolean;
  summary?: React.ReactNode;
}) {
  if (!collapsible) {
    return (
      <div className="detail-section">
        <div className="detail-section-header detail-section-header-static">{title}</div>
        <div className="detail-section-body">{children}</div>
      </div>
    );
  }
  return (
    <div className="detail-section">
      <button className="detail-section-header" onClick={() => onToggle(sectionKey)}>
        <span>{title}</span>
        <span className={`detail-section-chevron${open ? " open" : ""}`}>▾</span>
      </button>
      {open ? (
        <div className="detail-section-body">{children}</div>
      ) : (
        summary && <div className="detail-section-body">{summary}</div>
      )}
    </div>
  );
}

export default function GameDetailPage() {
  const { id } = useParams();
  const gameId = Number(id);
  const navigate = useNavigate();
  const { currentUser } = useUser();
  // 트로피·금색 이름은 로그인한 사람이 이겼을 때만 붙인다.
  const myName = currentUser?.name;

  const [game, setGame] = useState<GameDetail | null>(null);
  const [plays, setPlays] = useState<Play[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    myrecord: true, myinfo: false, history: false,
  });
  function toggle(key: SectionKey) {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
  }

  // 이름 인라인 편집
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);

  // 대체 이미지 선택 - 이미지를 탭하면 BGG 다른 버전(언어판 등) 목록에서 고를 수 있다.
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<GameVersion[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [imageSaving, setImageSaving] = useState(false);

  async function openVersions() {
    setShowVersions(true);
    if (versions !== null) return; // 이미 받아둔 목록이 있으면 재요청하지 않는다
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const list = await api.gameVersions(gameId);
      setVersions(list);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : "버전 목록을 불러오지 못했습니다");
    } finally {
      setVersionsLoading(false);
    }
  }

  async function chooseVersionImage(url: string | null) {
    if (!game) return;
    setImageSaving(true);
    try {
      await api.updateGame(game.id, { custom_image: url });
      setShowVersions(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "이미지 저장 실패");
    } finally {
      setImageSaving(false);
    }
  }

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

  // 슬리브 필요치 - 게임에 속한 공유 값. 재고 규격 목록은 사이즈 입력 드롭다운 제안용으로만 쓴다.
  const [gameSleeves, setGameSleeves] = useState<GameSleeve[]>([]);
  const [sleeveSizeOptions, setSleeveSizeOptions] = useState<string[]>([]);
  const [addingSleeve, setAddingSleeve] = useState(false);
  const [sleeveForm, setSleeveForm] = useState({ size: "", count: "", note: "" });
  const [editingSleeveId, setEditingSleeveId] = useState<number | null>(null);
  const [editSleeveForm, setEditSleeveForm] = useState({ size: "", count: "", note: "" });
  const [sleeveSaving, setSleeveSaving] = useState(false);

  function loadGameSleeves() {
    api.gameSleeves(gameId).then(setGameSleeves).catch(() => setGameSleeves([]));
  }
  useEffect(() => {
    loadGameSleeves();
    api.sleeves().then((rows) => setSleeveSizeOptions(rows.map((r) => r.size))).catch(() => setSleeveSizeOptions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  async function submitAddSleeve() {
    const count = Number(sleeveForm.count);
    if (!sleeveForm.size.trim() || !Number.isFinite(count) || count <= 0) return;
    setSleeveSaving(true);
    try {
      await api.addGameSleeve(gameId, { size: sleeveForm.size.trim(), count, note: sleeveForm.note.trim() || null });
      setSleeveForm({ size: "", count: "", note: "" });
      setAddingSleeve(false);
      loadGameSleeves();
    } catch (err) {
      setError(err instanceof Error ? err.message : "슬리브 필요치 저장 실패");
    } finally {
      setSleeveSaving(false);
    }
  }

  function startEditSleeve(s: GameSleeve) {
    setEditingSleeveId(s.id);
    setEditSleeveForm({ size: s.size, count: String(s.count), note: s.note ?? "" });
  }

  async function saveEditSleeve(id: number) {
    const count = Number(editSleeveForm.count);
    if (!editSleeveForm.size.trim() || !Number.isFinite(count) || count <= 0) return;
    setSleeveSaving(true);
    try {
      await api.updateGameSleeve(id, { size: editSleeveForm.size.trim(), count, note: editSleeveForm.note.trim() || null });
      setEditingSleeveId(null);
      loadGameSleeves();
    } catch (err) {
      setError(err instanceof Error ? err.message : "슬리브 필요치 저장 실패");
    } finally {
      setSleeveSaving(false);
    }
  }

  async function removeGameSleeve(id: number) {
    if (!window.confirm("이 슬리브 필요치를 삭제할까요?")) return;
    setSleeveSaving(true);
    try {
      await api.deleteGameSleeve(id);
      loadGameSleeves();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    } finally {
      setSleeveSaving(false);
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

  // BGG에 등록된 다른 이름들(aliases)을 후보 칩으로 제안한다. 예: 펭귄 파티(56933)처럼
  // 한글 이름이 여러 개 등록돼 우리가 고른 표시명이 사용자 기대와 다를 수 있어서다.
  // 한글이 먼저 오게 정렬하고, 현재 표시명과 같은 건 뺀다.
  const HANGUL_RE = /[가-힣]/;
  const nameCandidates = (game?.aliases || [])
    .filter((a) => a && a !== game?.name)
    .sort((a, b) => Number(HANGUL_RE.test(b)) - Number(HANGUL_RE.test(a)));

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

  // 컬렉션에서 게임을 빼는 것. 상태만 바꾸는 게 아니라 취득 이력 행을 전부 지운다.
  // 잘못 추가했거나 위시에서 마음이 떠난 게임을 목록에서 치우는 용도라, 지우면
  // 구매·판매가가 지출 요약에서도 빠진다. 플레이 기록은 컬렉션과 무관하므로 남는다.
  const [removingCollection, setRemovingCollection] = useState(false);
  async function removeFromCollection() {
    if (!game || game.collectionHistory.length === 0) return;
    const rows = game.collectionHistory;
    const paid = rows.reduce((sum, h) => sum + (h.price_paid || 0), 0);
    const parts = [`"${game.name}"을(를) 컬렉션에서 삭제할까요?`];
    parts.push(rows.length > 1 ? `취득 이력 ${rows.length}건이 지워집니다.` : "");
    if (paid > 0) parts.push(`구매가 ${fmtNum(paid)}원이 지출 요약에서 빠집니다.`);
    parts.push(playCount > 0 ? "플레이 기록은 남습니다." : "");
    if (!window.confirm(parts.filter(Boolean).join(" "))) return;
    setRemovingCollection(true);
    try {
      for (const h of rows) await api.deleteCollection(h.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "컬렉션 삭제 실패");
    } finally {
      setRemovingCollection(false);
    }
  }

  // 별점 편집: StarRating은 0~10 원점수 스케일(별 하나=2점)로 값을 주고받는다 - my_rating과 동일 스케일이라 변환이 필요없다.
  async function saveRating(rating10: number | null) {
    if (!game) return;
    setRatingSaving(true);
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

  // 박스아트는 110x110로만 그린다. 원본(game.image)은 1000~2000px에 몇 MB짜리도 있어서
  // (Legacy of Yu 5.2MB) 그걸 받는 건 낭비다. 썸네일을 우선한다.
  // 대체 이미지를 골랐으면 서버가 이미 thumbnail 자리에 넣어서 내려준다(COALESCE).
  const thumb = imgUrl(game.thumbnail || game.image);
  const latestEntry = game.collectionHistory.length > 0
    ? game.collectionHistory[game.collectionHistory.length - 1]
    : null;
  const currentStatus = latestEntry ? latestEntry.status : "미보유";

  // 컬렉션 정보가 접혀 있을 때 보여줄 요약. 온라인 플레이(BGA/TTS/App)는 실물을 안 쓰므로
  // 판당 비용에서 빼는 인사이트 규칙과 맞추고 싶지만, 여기선 게임 상세라 전체 플레이로 계산한다.
  const playCount = game.stats?.playCount ?? 0;
  const costPerPlay = latestEntry?.price_paid && playCount > 0
    ? Math.round(latestEntry.price_paid / playCount)
    : null;
  const sleeveLine = gameSleeves.length > 0
    ? gameSleeves.map((s2) => `${s2.size} ${s2.count}장`).join(" · ")
    : null;

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
  const introTruncated = !introExpanded && description && description.length > INTRO_TRUNCATE_CHARS;
  const introShown = introTruncated ? `${description!.slice(0, INTRO_TRUNCATE_CHARS)}...` : description;
  const hasPeopleOrTags = (game.designers?.length || game.artists?.length || game.categories?.length || game.mechanics?.length);

  const visiblePlays = plays.slice(0, RECENT_PLAYS_COUNT);
  // BGG에 등록이 없는 게임은 음수 id로 넣는다(동기화가 건드리지 않고 BGG id와도 안 겹친다).
  // 이런 게임은 BGG 링크·슬리브 페이지·다른 버전 이미지가 존재하지 않으므로 숨긴다.
  const isLocalOnly = game.id < 0;
  const usedTags = allTags.map((t) => t.tag);
  const formTagList = form.tags.split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <div className="page game-detail-page">
      {/* 기록 추가는 기록 탭과 같은 자리·같은 모양의 ＋ 버튼으로 둔다 */}
      <div className="detail-topbar">
        <button className="back-btn" onClick={() => navigate(-1)}>← 뒤로</button>
        <button
          className="icon-btn"
          onClick={() => navigate(`/plays/new?game_id=${gameId}`)}
          aria-label="이 게임 기록 추가"
        >
          ＋
        </button>
      </div>

      <div className="detail-hero">
        {thumb ? (
          <button type="button" className="detail-hero-img-btn" onClick={openVersions} disabled={isLocalOnly} aria-label="다른 버전 이미지 선택">
            <img decoding="async" src={thumb} alt="" />
          </button>
        ) : (
          <button type="button" className="detail-hero-empty" onClick={openVersions} disabled={isLocalOnly} aria-label="다른 버전 이미지 선택">?</button>
        )}
        <div className="detail-hero-info">
          {editingName ? (
            <>
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
              {nameCandidates.length > 0 && (
                <div className="name-candidate-row">
                  {nameCandidates.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="name-candidate-chip"
                      onClick={() => setNameInput(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </>
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

          {/* 긱 평점 + 내 평점(별) + 평가 수. 박스아트 옆 좁은 칸이라 이 세 개까지만 둔다. */}
          <div className="detail-hero-top">
            {game.bgg_rating != null && (
              <div className="rating-badge-mini" style={{ borderColor: ratingColor(game.bgg_rating), color: ratingColor(game.bgg_rating) }}>
                {game.bgg_rating.toFixed(1)}
              </div>
            )}
            {game.users_rated != null && (
              <div className="rating-badge-users muted">평가 {fmtNum(game.users_rated)}+</div>
            )}
          </div>
          {/* 별을 누르면 조절 창이 뜬다 */}
          <div className="my-rating-inline">
            <StarRating editable size={13} value={game.my_rating ?? null} onChange={saveRating} disabled={ratingSaving} />
          </div>

        </div>
      </div>

      {/* 순위·인원·퍼블리셔는 박스아트 옆 좁은 칸(폰에서 220px)에 두면 "전체 196 / 위 ·"처럼
          낱말이 쪼개지고, 기기 폭마다 접히는 자리가 달라 제각각으로 보인다.
          박스아트 아래 전체 폭으로 내려 한 줄에 담기게 한다. */}
      <div className="detail-hero-meta">
        {rankParts.length > 0 && <div className="detail-hero-rankline">{rankParts.join(" · ")}</div>}
          <p className="muted detail-hero-statline">
            <span className="stat-part">{playersLine}</span>
            <span className="stat-sep"> · </span>
            <span className="stat-part">{playtimeLine}</span>
            {ageLine && (
              <>
                <span className="stat-sep"> · </span>
                <span className="stat-part">{ageLine}</span>
              </>
            )}
            <span className="stat-sep"> · </span>
            <span className="stat-part detail-hero-weight" style={{ color: weightColor(game.weight) }}>
              웨이트 {game.weight ? game.weight.toFixed(1) : "-"}
            </span>
          </p>
          {game.publishers && game.publishers.length > 0 && (
            <p className="detail-hero-publishers">퍼블리셔: {game.publishers.join(", ")}</p>
          )}
          {!isLocalOnly && (
          <a
            className="bgg-link-btn"
            href={bggGameUrl(game.id, game.name_en)}
            target="_blank"
            rel="noreferrer"
            title="BGG에서 보기"
            aria-label="BGG에서 보기"
          >
            BGG ↗
          </a>
        )}
      </div>

      {/* 소개를 헤더 아래 한 덩어리로 - 접이식 섹션 없이 바로 이어붙이고, 길면 더보기로 디자이너/카테고리까지 펼친다 */}
      <div className="intro-block">
        {description ? (
          <>
            <p className="intro-desc">{introShown}</p>
            {description!.length > INTRO_TRUNCATE_CHARS && (
              <button className="show-more-btn" onClick={() => setIntroExpanded((v) => !v)}>
                {introExpanded ? "접기" : "... 더보기"}
              </button>
            )}
            {translating && <span className="muted" style={{ fontSize: 12 }}>번역 중...</span>}
          </>
        ) : (
          <p className="muted">설명이 없습니다.</p>
        )}

        {introExpanded && hasPeopleOrTags ? (
          <div className="intro-expanded">
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
                {game.categories.map((c) => <span key={c} className="chip chip-static">#{c}</span>)}
              </div>
            )}
            {(game.mechanics && game.mechanics.length > 0) && (
              <div className="chip-wrap">
                {game.mechanics.map((m) => <span key={m} className="chip chip-static chip-mechanic">#{m}</span>)}
              </div>
            )}
          </div>
        ) : null}

        {/* 접혀 있을 때는 숨기고, 펼쳤을 때만 펼쳐진 본문(디자이너·아티스트·카테고리) 맨 끝에 붙인다 */}
        {introExpanded && game.description_ko && (
          <a className="intro-original-link" onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? "번역본 보기" : "원문 보기"}
          </a>
        )}
      </div>

      <Section
        title="컬렉션 정보"
        sectionKey="myinfo"
        open={open.myinfo}
        onToggle={toggle}
        summary={
          <div className="card info-box collection-summary">
            <div className="info-row"><span className="muted">소유 상태</span><span>{currentStatus}</span></div>
            {/* 판당 비용은 구매가 바로 옆에 괄호로 붙인다 - 줄을 따로 두면 라벨만 늘어난다 */}
            <div className="info-row">
              <span className="muted">구매가</span>
              <span>
                {costPerPlay != null && <span className="muted">({fmtNum(costPerPlay)}원/회) </span>}
                {latestEntry?.price_paid != null ? `${fmtNum(latestEntry.price_paid)}원` : "-"}
              </span>
            </div>
            {sleeveLine && (
              <div className="info-row"><span className="muted">슬리브</span><span>{sleeveLine}</span></div>
            )}
            {latestEntry?.note && (
              <div className="info-row collection-summary-note">
                <span className="muted">메모</span><span>{latestEntry.note}</span>
              </div>
            )}
          </div>
        }
      >
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
                    #{t}
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

          {game.collectionHistory.length > 0 && (
            <button
              className="btn-small danger collection-remove-btn"
              disabled={removingCollection}
              onClick={removeFromCollection}
            >
              {removingCollection ? "삭제 중..." : "컬렉션에서 삭제"}
            </button>
          )}

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

          <div className="score-template-manage">
            <div className="info-row">
              <span className="muted">슬리브</span>
              <div className="field-row" style={{ gap: 8 }}>
                {!isLocalOnly && (
                  <a
                    className="btn-small"
                    href={bggSleevesUrl(game.id, game.name_en)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    BGG 슬리브 페이지 ↗
                  </a>
                )}
                <button className="btn-small" onClick={() => setAddingSleeve((v) => !v)}>
                  {addingSleeve ? "취소" : "+ 규격 추가"}
                </button>
              </div>
            </div>

            {gameSleeves.length === 0 && !addingSleeve && (
              <p className="muted">등록된 슬리브 규격이 없습니다.</p>
            )}

            {gameSleeves.map((s) => (
              editingSleeveId === s.id ? (
                <div key={s.id} className="sleeve-edit-form" style={{ marginTop: 6 }}>
                  <input
                    list="sleeve-size-options"
                    value={editSleeveForm.size}
                    onChange={(e) => setEditSleeveForm((f) => ({ ...f, size: e.target.value }))}
                    placeholder="규격 (예: 63.5x88)"
                  />
                  <input
                    type="number"
                    value={editSleeveForm.count}
                    onChange={(e) => setEditSleeveForm((f) => ({ ...f, count: e.target.value }))}
                    placeholder="필요 장수"
                  />
                  <input
                    value={editSleeveForm.note}
                    onChange={(e) => setEditSleeveForm((f) => ({ ...f, note: e.target.value }))}
                    placeholder="메모"
                  />
                  <div className="sleeve-edit-actions">
                    <button className="btn-small" disabled={sleeveSaving} onClick={() => saveEditSleeve(s.id)}>저장</button>
                    <button className="btn-small" onClick={() => setEditingSleeveId(null)}>취소</button>
                  </div>
                </div>
              ) : (
                <div key={s.id} className="info-row">
                  <span>
                    {s.size} · {s.count}장{s.note ? ` (${s.note})` : ""}
                  </span>
                  <span className="field-row" style={{ gap: 8, alignItems: "center" }}>
                    <span style={{ color: s.enough ? "var(--success, #2e8b57)" : "var(--warning, #d9822b)" }}>
                      {s.enough
                        ? `재고 ${s.stock}장 ✓`
                        : `재고 ${s.stock}장, ${s.count - s.stock}장 부족`}
                    </span>
                    <button className="btn-small" onClick={() => startEditSleeve(s)}>수정</button>
                    <button className="btn-small danger" disabled={sleeveSaving} onClick={() => removeGameSleeve(s.id)}>삭제</button>
                  </span>
                </div>
              )
            ))}

            {addingSleeve && (
              <div className="sleeve-edit-form" style={{ marginTop: 6 }}>
                <input
                  list="sleeve-size-options"
                  value={sleeveForm.size}
                  onChange={(e) => setSleeveForm((f) => ({ ...f, size: e.target.value }))}
                  placeholder="규격 (예: 63.5x88)"
                  autoFocus
                />
                <input
                  type="number"
                  value={sleeveForm.count}
                  onChange={(e) => setSleeveForm((f) => ({ ...f, count: e.target.value }))}
                  placeholder="필요 장수"
                />
                <input
                  value={sleeveForm.note}
                  onChange={(e) => setSleeveForm((f) => ({ ...f, note: e.target.value }))}
                  placeholder="메모"
                />
                <div className="sleeve-edit-actions">
                  <button className="btn-small" disabled={sleeveSaving} onClick={submitAddSleeve}>추가</button>
                </div>
              </div>
            )}
            <datalist id="sleeve-size-options">
              {sleeveSizeOptions.map((size) => <option key={size} value={size} />)}
            </datalist>
          </div>
        </div>
      </Section>

      <Section title="내 기록" sectionKey="myrecord" open onToggle={toggle} collapsible={false}>
        {game.stats && game.stats.playCount > 0 ? (
          <>
            <div className="card info-box">
              {/* 위 카드는 "얼마나·언제" 했는지, 아래 카드는 "얼마나 잘했는지"(승률·점수) */}
              <div className="info-row"><span className="muted">플레이 횟수</span><span>{fmtNum(game.stats.playCount)}회</span></div>
              <div className="info-row"><span className="muted">평균 소요시간</span><span>{game.stats.avgDurationMin != null ? `${game.stats.avgDurationMin}분` : "-"}</span></div>
              <div className="info-row"><span className="muted">첫 플레이</span><span>{game.stats.firstPlayedAt || "-"}</span></div>
              <div className="info-row"><span className="muted">마지막 플레이</span><span>{game.stats.lastPlayedAt || "-"}</span></div>
            </div>

            <div className="card info-box">
              {game.stats.winRateSplit?.solo && (
                <div className="info-row">
                  <span className="muted">승률 (솔로)</span>
                  <span>{game.stats.winRateSplit.solo.rate}% ({game.stats.winRateSplit.solo.plays}회)</span>
                </div>
              )}
              {game.stats.winRateSplit?.multi && (
                <div className="info-row">
                  <span className="muted">승률 (2인+)</span>
                  <span>{game.stats.winRateSplit.multi.rate}% ({game.stats.winRateSplit.multi.plays}회)</span>
                </div>
              )}
              {!game.stats.winRateSplit?.solo && !game.stats.winRateSplit?.multi && (
                <div className="info-row"><span className="muted">승률</span><span>{game.stats.winRate != null ? `${game.stats.winRate}%` : "-"}</span></div>
              )}
                {game.stats.score.solo && (
                  <div className="info-row">
                    <span className="muted">점수 (솔로, {game.stats.score.solo.count}회)</span>
                    <span>
                      최저 <b className="score-worst">{fmtNum(game.stats.score.solo.worst)}</b> · 평균 <b className="score-avg">{fmtNum(game.stats.score.solo.avg)}</b> · 최고 <b className="score-best">{fmtNum(game.stats.score.solo.best)}</b>
                    </span>
                  </div>
                )}
                {game.stats.score.multi && (
                  <div className="info-row">
                    <span className="muted">점수 (2인+, {game.stats.score.multi.count}회)</span>
                    <span>
                      최저 <b className="score-worst">{fmtNum(game.stats.score.multi.worst)}</b> · 평균 <b className="score-avg">{fmtNum(game.stats.score.multi.avg)}</b> · 최고 <b className="score-best">{fmtNum(game.stats.score.multi.best)}</b>
                    </span>
                  </div>
                )}
            </div>
          </>
        ) : null}

        {/* 기록이 없으면 안내는 한 번만. 예전엔 통계 자리와 목록 자리에서 두 번 나왔다. */}
        {plays.length === 0 ? (
          <p className="muted empty-hint">아직 플레이 기록이 없습니다.</p>
        ) : (
          <>
            {/* 플레이 기록 목록 - BGStats처럼 한 줄에 날짜·장소·플레이어·점수. 최근 5개만, 전체는 PlaysPage로 링크 */}
            <div className="play-list-header">
              <span className="play-list-title">플레이 기록</span>
              <Link
                to={`/plays?game_id=${gameId}&game_name=${encodeURIComponent(game.name)}`}
                className="play-list-link"
              >
                {plays.length}회 플레이 &gt;
              </Link>
            </div>
            <div className="play-list">
            {visiblePlays.map((p) => (
              <Link key={p.id} to={`/plays/${p.id}`} className="play-row-compact">
                <span className="play-compact-left">
                  <span className="play-compact-date">{p.played_at}</span>
                  {p.location && <span className="play-compact-loc muted">{p.location}</span>}
                </span>
                <span className="play-compact-players">
                  {p.players.map((pl, i) => (
                    <span key={i} className="play-compact-player">
                      {/* 트로피·금색 이름은 "내가 이겼을 때"만. 앱 전체가 같은 규칙이다.
                          win은 SQLite에서 0/1로 오므로 && 로 쓰면 진 사람 앞에 "0"이 찍힌다. */}
                      {pl.win && pl.name === myName ? <span className="play-compact-trophy" aria-label="승리">🏆</span> : null}
                      <span className={pl.win && pl.name === myName ? "winner-name" : undefined}>{pl.name}</span>
                      {pl.score != null && <span className="play-compact-score">{fmtNum(pl.score)}</span>}
                    </span>
                  ))}
                </span>
              </Link>
            ))}
            </div>
          </>
        )}
      </Section>

      {/* 소유 상태·구매가는 두 사람 공유 컬렉션 정보다. "내 것"은 평점·플레이 기록뿐. */}

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

      {showVersions && (
        <Modal title="다른 버전 이미지 선택" onClose={() => setShowVersions(false)}>
            {game.custom_image && (
              <button className="btn-small version-reset-btn" disabled={imageSaving} onClick={() => chooseVersionImage(null)}>
                기본 이미지로 되돌리기
              </button>
            )}

            {versionsLoading && <p className="muted empty-hint">불러오는 중...</p>}
            {versionsError && <p className="error-text empty-hint">{versionsError}</p>}
            {!versionsLoading && !versionsError && versions && versions.length === 0 && (
              <p className="muted empty-hint">다른 버전 이미지가 없습니다.</p>
            )}
            {!versionsLoading && versions && versions.length > 0 && (
              <div className="version-list">
                {versions.map((v, i) => {
                  // 후보 격자도 작게 그린다. 여기서 원본을 부르면 안 고른 버전까지
                  // 전부 캐시에 쌓인다(실측 고아 108개 53MB의 주범이었다).
                  const vThumb = imgUrl(v.thumbnail || v.image || undefined);
                  const selected = !!game.custom_image && game.custom_image === v.image;
                  return (
                    <button
                      key={v.id ?? i}
                      type="button"
                      className={`version-item${selected ? " selected" : ""}`}
                      disabled={imageSaving}
                      onClick={() => chooseVersionImage(v.image)}
                    >
                      {vThumb ? <img decoding="async" src={vThumb} alt="" loading="lazy" /> : <div className="version-item-empty">?</div>}
                      <span className="version-item-name">{v.name || "이름 없음"}</span>
                    </button>
                  );
                })}
              </div>
            )}
        </Modal>
      )}
    </div>
  );
}
