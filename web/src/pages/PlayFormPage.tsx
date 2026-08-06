import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { Game, GameDetail, Photo, PlayPlayer, ScoreTemplate } from "../api/types";
import { evalScoreExpression } from "../utils/scoreParser";
import PlayTimer from "../components/PlayTimer";
import "../styles/PlayForm.css";

interface PendingPhoto {
  key: string;
  file: File;
  previewUrl: string;
}

interface PlayerRow {
  name: string;
  scoreText: string;
  win: boolean;
  isAutoma: boolean;
  // 점수 시트 템플릿이 있을 때만 쓴다: 항목 이름 -> 입력 텍스트(계산기 파서 재사용)
  breakdownText: Record<string, string>;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function emptyPlayer(): PlayerRow {
  return { name: "", scoreText: "", win: false, isAutoma: false, breakdownText: {} };
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return "-";
  return Math.round(n).toLocaleString();
}

export default function PlayFormPage() {
  const { id } = useParams();
  const isEdit = !!id;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [gameQuery, setGameQuery] = useState("");
  const [gameResults, setGameResults] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<{ id: number; name: string } | null>(null);
  const [gameDetail, setGameDetail] = useState<GameDetail | null>(null);
  const [playedAt, setPlayedAt] = useState(todayStr());

  // 장소는 드롭다운/칩으로만 고른다 - 자유 입력을 허용하면 Home/Home2/H. 처럼 표기가 갈린다.
  const [locations, setLocations] = useState<{ name: string; count: number }[]>([]);
  const [location, setLocation] = useState("");
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocationText, setNewLocationText] = useState("");

  const [comment, setComment] = useState("");
  const [isCoop, setIsCoop] = useState(false);
  const [coopSuccess, setCoopSuccess] = useState(true);
  const [players, setPlayers] = useState<PlayerRow[]>([emptyPlayer(), emptyPlayer()]);
  const [startPlayerIndex, setStartPlayerIndex] = useState<number | null>(null);
  const [durationMin, setDurationMin] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // 점수 시트 템플릿: 있으면 항목별 입력 그리드, 없으면 기존 총점 입력.
  const [scoreTemplate, setScoreTemplate] = useState<ScoreTemplate | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [templateFieldsText, setTemplateFieldsText] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);

  // 사진: 이미 저장된 사진(수정 모드에서 불러옴)과, 아직 업로드 안 한 선택분을 분리해 관리한다.
  // 새 기록은 play_id가 있어야 업로드할 수 있으므로, 저장 시 play를 먼저 만들고 나서 pendingPhotos를 올린다.
  const [existingPhotos, setExistingPhotos] = useState<Photo[]>([]);
  const [pendingPhotos, setPendingPhotos] = useState<PendingPhoto[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [deletingPhotoId, setDeletingPhotoId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.locations().then(setLocations).catch(() => setLocations([]));
  }, []);

  // 수정 모드: 단건 조회 엔드포인트로 바로 가져온다.
  useEffect(() => {
    if (!isEdit) return;
    const targetId = Number(id);
    (async () => {
      setLoading(true);
      try {
        const found = await api.play(targetId);
        setSelectedGame({ id: found.game_id, name: found.game_name || "" });
        setPlayedAt(found.played_at);
        setLocation(found.location || "");
        setComment(found.comment || "");
        setIsCoop(!!found.is_coop);
        setDurationMin(found.duration_min);
        if (found.is_coop) {
          setCoopSuccess(found.players.some((p) => p.win));
        }
        setPlayers(
          found.players.length
            ? found.players.map((p) => ({
                name: p.name,
                scoreText: p.score != null ? String(p.score) : "",
                win: !!p.win,
                isAutoma: !!p.is_automa,
                breakdownText: p.score_breakdown
                  ? Object.fromEntries(Object.entries(p.score_breakdown).map(([k, v]) => [k, String(v)]))
                  : {},
              }))
            : [emptyPlayer(), emptyPlayer()],
        );
        const startIdx = found.players.findIndex((p) => String(p.start_position) === "1");
        setStartPlayerIndex(startIdx >= 0 ? startIdx : null);
        setExistingPhotos(found.photos || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "불러오기 실패");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, isEdit]);

  // 신규 작성 + 쿼리스트링으로 게임이 지정된 경우 (게임 상세의 "플레이 기록하기")
  useEffect(() => {
    if (isEdit) return;
    const gid = searchParams.get("game_id");
    if (!gid) return;
    api.game(Number(gid)).then((g) => setSelectedGame({ id: g.id, name: g.name })).catch(() => {});
  }, [isEdit, searchParams]);

  // 게임을 고르면 그 게임의 내 기록 요약(최고/최저/평균, 평균시간, 최근 플레이, 상대 전적)을 미리보기로 보여준다.
  useEffect(() => {
    if (!selectedGame) { setGameDetail(null); return; }
    api.game(selectedGame.id).then(setGameDetail).catch(() => setGameDetail(null));
  }, [selectedGame]);

  // 게임별 점수 시트 템플릿. 템플릿이 있으면 총점 입력 대신 항목별 그리드를 보여준다.
  useEffect(() => {
    if (!selectedGame) { setScoreTemplate(null); return; }
    setCreatingTemplate(false);
    api.scoreTemplate(selectedGame.id).then(setScoreTemplate).catch(() => setScoreTemplate(null));
  }, [selectedGame]);

  useEffect(() => {
    if (isEdit || !gameQuery.trim()) { setGameResults([]); return; }
    const t = setTimeout(() => {
      api.games(gameQuery.trim(), 20).then(setGameResults).catch(() => setGameResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [gameQuery, isEdit]);

  function updatePlayer(i: number, patch: Partial<PlayerRow>) {
    setPlayers((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function addPlayer() { setPlayers((prev) => [...prev, emptyPlayer()]); }
  function removePlayer(i: number) {
    setPlayers((prev) => prev.filter((_, idx) => idx !== i));
    setStartPlayerIndex((cur) => (cur === i ? null : cur != null && cur > i ? cur - 1 : cur));
  }

  const parsedScores = useMemo(
    () => players.map((p) => (p.scoreText.trim() === "" ? null : evalScoreExpression(p.scoreText))),
    [players],
  );

  // 템플릿이 있을 때 항목별 입력의 플레이어별 합계. 빈 칸/파싱 실패는 0으로 친다.
  const breakdownSums = useMemo(() => {
    if (!scoreTemplate) return [];
    return players.map((p) =>
      scoreTemplate.fields.reduce((sum, f) => {
        const text = p.breakdownText[f]?.trim() || "";
        if (text === "") return sum;
        const v = evalScoreExpression(text);
        return sum + (v ?? 0);
      }, 0),
    );
  }, [players, scoreTemplate]);

  function updateBreakdown(i: number, field: string, value: string) {
    setPlayers((prev) => prev.map((p, idx) =>
      idx === i ? { ...p, breakdownText: { ...p.breakdownText, [field]: value } } : p));
  }

  async function saveTemplate() {
    if (!selectedGame) return;
    const fields = templateFieldsText.split(",").map((f) => f.trim()).filter(Boolean);
    if (fields.length === 0) return;
    setTemplateSaving(true);
    try {
      const t = await api.saveScoreTemplate(selectedGame.id, fields);
      setScoreTemplate(t);
      setCreatingTemplate(false);
      setTemplateFieldsText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "점수 시트 저장 실패");
    } finally {
      setTemplateSaving(false);
    }
  }

  // "사람 플레이어가 1명 이하"면 솔로 - 오토마만 상대인 판도 솔로다.
  const humanCount = players.filter((p) => p.name.trim() && !p.isAutoma).length;

  function pickStartPlayer() {
    const filledIdx = players.map((p, i) => (p.name.trim() ? i : -1)).filter((i) => i >= 0);
    if (filledIdx.length === 0) return;
    const pick = filledIdx[Math.floor(Math.random() * filledIdx.length)];
    setStartPlayerIndex(pick);
  }

  function selectLocation(name: string) {
    setLocation(name);
    setAddingLocation(false);
  }

  const ALLOWED_PHOTO_EXT = [".jpg", ".jpeg", ".png", ".webp", ".heic"];

  function onFilesSelected(files: FileList | null) {
    if (!files) return;
    setPhotoError(null);
    const next: PendingPhoto[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
      if (!ALLOWED_PHOTO_EXT.includes(ext)) {
        setPhotoError("jpg/jpeg/png/webp/heic 파일만 업로드할 수 있습니다");
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        setPhotoError("파일이 너무 큽니다 (최대 20MB)");
        continue;
      }
      next.push({ key: `${Date.now()}_${file.name}_${Math.random()}`, file, previewUrl: URL.createObjectURL(file) });
    }
    setPendingPhotos((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removePendingPhoto(key: string) {
    setPendingPhotos((prev) => prev.filter((p) => p.key !== key));
  }

  async function deleteExistingPhoto(id: number) {
    setDeletingPhotoId(id);
    try {
      await api.deletePhoto(id);
      setExistingPhotos((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "사진 삭제 실패");
    } finally {
      setDeletingPhotoId(null);
    }
  }

  async function uploadPendingPhotos(playId: number) {
    for (const p of pendingPhotos) {
      await api.uploadPhoto(playId, p.file);
    }
  }

  async function handleSave() {
    if (!selectedGame) { setError("게임을 선택하세요"); return; }
    setError(null);
    setSaving(true);
    try {
      const finalPlayers: PlayPlayer[] = players
        .filter((p) => p.name.trim())
        .map((p, i) => {
          // 템플릿이 있으면 항목별 합계가 총점이 된다 - 통계·이벤트 로직은 score만 보므로 그대로 호환된다.
          let breakdown: Record<string, number> | undefined;
          if (scoreTemplate) {
            breakdown = {};
            for (const f of scoreTemplate.fields) {
              const text = p.breakdownText[f]?.trim() || "";
              if (text === "") continue;
              const v = evalScoreExpression(text);
              if (v != null) breakdown[f] = v;
            }
          }
          return {
            name: p.name.trim(),
            score: scoreTemplate ? breakdownSums[i] : parsedScores[i],
            score_breakdown: breakdown,
            win: isCoop ? coopSuccess : p.win,
            team: isCoop ? "coop" : undefined,
            is_automa: p.isAutoma,
            start_position: startPlayerIndex === i ? "1" : null,
          };
        });

      const body = {
        game_id: selectedGame.id,
        played_at: playedAt,
        duration_min: durationMin,
        location: location || null,
        comment: comment || null,
        is_coop: isCoop,
        players: finalPlayers,
      };

      if (isEdit) {
        await api.updatePlay(Number(id), body);
        await uploadPendingPhotos(Number(id));
      } else {
        const created = await api.addPlay(body);
        await uploadPendingPhotos(created.id);
      }
      navigate(-1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    if (!window.confirm("이 기록을 삭제할까요?")) return;
    setDeleting(true);
    try {
      await api.deletePlay(Number(id));
      navigate("/plays");
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;

  const stats = gameDetail?.stats;
  const hasScorePreview = stats && (stats.score.solo || stats.score.multi);

  // 현재 위치가 목록에 없으면(예: 수정 화면에서 예전 값) 칩 목록에 추가해서 놓치지 않게 한다.
  const locationChips = location && !locations.some((l) => l.name === location)
    ? [{ name: location, count: 0 }, ...locations]
    : locations;

  return (
    <div className="page play-form-page">
      <div className="page-header">
        <h1>{isEdit ? "기록 수정" : "플레이 기록"}</h1>
        <button className="icon-btn" style={{ background: "none", color: "var(--muted)" }} onClick={() => navigate(-1)}>✕</button>
      </div>

      <div className="field">
        <label>게임</label>
        {selectedGame ? (
          <div className="selected-game">
            <span>{selectedGame.name}</span>
            {!isEdit && <button className="btn-small" onClick={() => setSelectedGame(null)}>변경</button>}
          </div>
        ) : (
          <>
            <input placeholder="게임 이름 검색" value={gameQuery} onChange={(e) => setGameQuery(e.target.value)} />
            {gameResults.length > 0 && (
              <ul className="game-search-dropdown">
                {gameResults.map((g) => (
                  <li key={g.id}>
                    <button onClick={() => { setSelectedGame({ id: g.id, name: g.name }); setGameQuery(""); setGameResults([]); }}>
                      {g.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {hasScorePreview && (
        <div className="card preview-box">
          <div className="section-title" style={{ margin: "0 0 8px" }}>이 게임의 내 기록</div>
          <div className="preview-score-split">
            {stats!.score.solo && (
              <div className="preview-score-col">
                <div className="muted preview-score-label">1인 ({stats!.score.solo.count}판)</div>
                <div className="preview-score-line">최고 {fmtNum(stats!.score.solo.best)} · 최저 {fmtNum(stats!.score.solo.worst)} · 평균 {fmtNum(stats!.score.solo.avg)}</div>
              </div>
            )}
            {stats!.score.multi && (
              <div className="preview-score-col">
                <div className="muted preview-score-label">2인+ ({stats!.score.multi.count}판)</div>
                <div className="preview-score-line">최고 {fmtNum(stats!.score.multi.best)} · 최저 {fmtNum(stats!.score.multi.worst)} · 평균 {fmtNum(stats!.score.multi.avg)}</div>
              </div>
            )}
          </div>
          <div className="preview-meta muted">
            {stats!.avgDurationMin != null && <span>평균 {stats!.avgDurationMin}분</span>}
            {stats!.lastPlayedAt && <span>최근 {stats!.lastPlayedAt}</span>}
          </div>
          {stats!.opponents.length > 0 && (
            <div className="preview-opponents muted">
              {stats!.opponents.map((o) => `${o.name} ${o.games}판 ${o.myWins}승`).join(" · ")}
            </div>
          )}
        </div>
      )}
      {gameDetail && !hasScorePreview && gameDetail.playCount === 0 && (
        <p className="muted preview-empty">아직 이 게임의 기록이 없습니다.</p>
      )}

      <div className="field-row">
        <div className="field">
          <label>날짜</label>
          <input type="date" value={playedAt} onChange={(e) => setPlayedAt(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label>장소</label>
        {location && !addingLocation ? (
          <div className="selected-game">
            <span>{location}</span>
            <button className="btn-small" onClick={() => setAddingLocation(true)}>변경</button>
          </div>
        ) : (
          <>
            <div className="chip-row">
              {locationChips.map((l) => (
                <button key={l.name} className={`chip${location === l.name ? " chip-active" : ""}`}
                  onClick={() => selectLocation(l.name)}>
                  {l.name}{l.count > 0 ? ` (${l.count})` : ""}
                </button>
              ))}
              <button className="chip" onClick={() => setAddingLocation(true)}>+ 새 장소</button>
            </div>
            {addingLocation && (
              <div className="new-location-row">
                <input
                  placeholder="새 장소 이름"
                  value={newLocationText}
                  onChange={(e) => setNewLocationText(e.target.value)}
                  autoFocus
                />
                <button className="btn-small" onClick={() => { if (newLocationText.trim()) selectLocation(newLocationText.trim()); setNewLocationText(""); }}>
                  추가
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <PlayTimer avgMinutes={stats?.avgDurationMin ?? null} onDurationChange={setDurationMin} />

      <div className="field">
        <label>플레이 시간 (분, 직접 수정 가능)</label>
        <input
          type="number"
          value={durationMin ?? ""}
          onChange={(e) => setDurationMin(e.target.value === "" ? null : Number(e.target.value))}
        />
      </div>

      <div className="field coop-toggle">
        <label className="switch-label">
          <input type="checkbox" checked={isCoop} onChange={(e) => setIsCoop(e.target.checked)} />
          협력 모드
        </label>
        {isCoop && (
          <div className="coop-result">
            <button className={coopSuccess ? "btn-primary" : "btn-secondary"} onClick={() => setCoopSuccess(true)}>성공</button>
            <button className={!coopSuccess ? "btn-primary" : "btn-secondary"} onClick={() => setCoopSuccess(false)}>실패</button>
          </div>
        )}
      </div>

      <div className="section-title">
        플레이어 <span className="muted" style={{ textTransform: "none" }}>({humanCount <= 1 ? "1인 · 솔로" : `${humanCount}인+`})</span>
        {selectedGame && !scoreTemplate && !creatingTemplate && (
          <button className="btn-link score-template-link" onClick={() => setCreatingTemplate(true)}>
            + 점수 시트 만들기
          </button>
        )}
      </div>

      {creatingTemplate && (
        <div className="card score-template-create">
          <label>항목 이름 (쉼표로 구분)</label>
          <input
            placeholder="밭, 목초지, 곡식, 채소, 가축"
            value={templateFieldsText}
            onChange={(e) => setTemplateFieldsText(e.target.value)}
            autoFocus
          />
          <div className="field-row" style={{ marginTop: 8 }}>
            <button className="btn-small" disabled={templateSaving || !templateFieldsText.trim()} onClick={saveTemplate}>
              {templateSaving ? "저장 중..." : "저장"}
            </button>
            <button className="btn-small" onClick={() => setCreatingTemplate(false)}>취소</button>
          </div>
        </div>
      )}

      {players.map((p, i) => (
        <div key={i} className="player-row-edit">
          <input
            className="player-name-input"
            placeholder="이름"
            value={p.name}
            onChange={(e) => updatePlayer(i, { name: e.target.value })}
          />
          {scoreTemplate ? (
            <span className="player-score-input player-score-readonly">{Math.round(breakdownSums[i] || 0)}</span>
          ) : (
            <input
              className="player-score-input"
              placeholder="점수 (12+8+5 가능)"
              value={p.scoreText}
              onChange={(e) => updatePlayer(i, { scoreText: e.target.value })}
            />
          )}
          {!isCoop && (
            <label className="win-checkbox">
              <input type="checkbox" checked={p.win} onChange={(e) => updatePlayer(i, { win: e.target.checked })} />
              승
            </label>
          )}
          <button className="remove-player-btn" onClick={() => removePlayer(i)} aria-label="플레이어 제거">✕</button>
          <label className="automa-checkbox">
            <input type="checkbox" checked={p.isAutoma} onChange={(e) => updatePlayer(i, { isAutoma: e.target.checked })} />
            오토마/봇
          </label>
          {startPlayerIndex === i && <span className="start-player-tag">시작 플레이어</span>}
          {!scoreTemplate && p.scoreText.trim() && parsedScores[i] == null && (
            <div className="score-error">식을 계산할 수 없습니다</div>
          )}
          {!scoreTemplate && p.scoreText.trim() && parsedScores[i] != null && p.scoreText.trim() !== String(parsedScores[i]) && (
            <div className="score-preview muted">= {Math.round(parsedScores[i]!)}</div>
          )}
        </div>
      ))}
      <button className="btn-secondary add-player-btn" onClick={addPlayer}>+ 플레이어 추가</button>
      <button className="btn-secondary add-player-btn" onClick={pickStartPlayer}>🎲 시작 플레이어 뽑기</button>

      {scoreTemplate && (
        <div className="card score-grid-box">
          <div className="section-title" style={{ margin: "0 0 8px" }}>점수 시트</div>
          <div className="score-grid" style={{ gridTemplateColumns: `auto repeat(${players.length}, 1fr)` }}>
            <div className="score-grid-cell score-grid-header" />
            {players.map((p, i) => (
              <div key={i} className="score-grid-cell score-grid-header">{p.name.trim() || `플레이어 ${i + 1}`}</div>
            ))}
            {scoreTemplate.fields.map((field) => (
              <Fragment key={field}>
                <div className="score-grid-cell score-grid-label muted">{field}</div>
                {players.map((p, i) => (
                  <input
                    key={`${field}-${i}`}
                    className="score-grid-cell score-grid-input"
                    placeholder="0"
                    value={p.breakdownText[field] ?? ""}
                    onChange={(e) => updateBreakdown(i, field, e.target.value)}
                  />
                ))}
              </Fragment>
            ))}
            <div className="score-grid-cell score-grid-label score-grid-total-label">합계</div>
            {players.map((_p, i) => (
              <div key={`total-${i}`} className="score-grid-cell score-grid-total">{Math.round(breakdownSums[i] || 0)}</div>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label>코멘트</label>
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>

      <div className="field">
        <label>사진</label>
        <div className="photo-picker-grid">
          {existingPhotos.map((p) => (
            <div className="photo-picker-item" key={`existing-${p.id}`}>
              <img src={api.photoUrl(p.filename)} alt="" />
              <button
                className="photo-picker-remove"
                onClick={() => deleteExistingPhoto(p.id)}
                disabled={deletingPhotoId === p.id}
                aria-label="사진 삭제"
              >
                {deletingPhotoId === p.id ? "..." : "✕"}
              </button>
            </div>
          ))}
          {pendingPhotos.map((p) => (
            <div className="photo-picker-item" key={p.key}>
              <img src={p.previewUrl} alt="" />
              <button className="photo-picker-remove" onClick={() => removePendingPhoto(p.key)} aria-label="사진 제거">✕</button>
            </div>
          ))}
          <button className="photo-picker-add" onClick={() => fileInputRef.current?.click()}>+ 사진</button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          style={{ display: "none" }}
          onChange={(e) => onFilesSelected(e.target.files)}
        />
        {photoError && <p className="error-text">{photoError}</p>}
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="play-form-actions">
        <button className="btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? "저장 중..." : "저장"}
        </button>
        {isEdit && (
          <button className="btn-secondary danger" disabled={deleting} onClick={handleDelete}>
            {deleting ? "삭제 중..." : "삭제"}
          </button>
        )}
      </div>
    </div>
  );
}
