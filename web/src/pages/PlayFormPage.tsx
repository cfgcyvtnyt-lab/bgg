import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { Game, GameDetail, Photo, PlayPlayer, ScoreBucket, ScoreTemplate, WinRateSplitBucket } from "../api/types";
import { evalScoreExpression } from "../utils/scoreParser";
import { imgUrl } from "../utils/imgUrl";
import { compressPhoto } from "../utils/compressPhoto";
import { useUser } from "../context/UserContext";
import PlayTimer, { type PlayTimerHandle } from "../components/PlayTimer";
import DateField, { toDateStr } from "../components/DateField";
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

// 마지막으로 저장한 기록의 플레이어 이름 구성을 기억해뒀다가 다음 새 기록에 미리 채운다.
const LAST_PLAYERS_KEY = "bgg_last_players";
// 시작 플레이어 뽑기 애니메이션: 점점 느려지는 간격(ms), 마지막 항목이 최종 당첨.
const DRAW_DELAYS = [60, 65, 70, 80, 90, 105, 125, 150, 180, 220, 270];

// toISOString()은 UTC라 한국 시간 자정~오전 9시에 어제 날짜가 나온다. 로컬 기준으로 만든다.
function todayStr() {
  return toDateStr(new Date());
}

// 플레이어 이름은 자유 입력이 아니라 정해진 후보에서 고른다. 자유 입력을 허용하면
// 같은 사람이 "ㅇ"/"ㅇ."/"A."처럼 갈려서 통계가 쪼개진다(실제로 기존 기록이 그렇게 갈려 있다).
const BOT_NAME = "봇";
const ANON_NAME = "익명";

// 설정의 "장소"에서 만들어만 두고 아직 한 판도 기록 안 한 장소. 서버 목록은 play.location을
// 집계한 것이라 그런 장소를 모르므로, 여기서 같은 키를 읽어 드롭다운에 같이 보여준다.
// 장소는 계정별로 다르므로(ㅇ은 Home/BGA, ㅃ는 B.) 키에 계정 id가 들어간다.
function loadExtraLocations(userId?: number): string[] {
  try {
    const raw = localStorage.getItem(`bgg_extra_locations_${userId ?? 0}`);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function emptyPlayer(): PlayerRow {
  return { name: "", scoreText: "", win: false, isAutoma: false, breakdownText: {} };
}

// 목록·상세 페이지와 동일한 규칙 - 아바타 없는 사람은 이름 해시로 고정된 색의 이니셜 원.
const INITIAL_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)", "var(--c9)", "var(--c10)"];
function colorForName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return INITIAL_COLORS[hash % INITIAL_COLORS.length];
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return "-";
  return Math.round(n).toLocaleString();
}

// 미리보기 요약: 평균 -> 최고 -> 승률 순. 점수 기록이 없는 게임은 승률만 보여준다.
function previewScoreLine(bucket: ScoreBucket | null | undefined, winRate: WinRateSplitBucket | null | undefined) {
  // 게임 상세의 점수 요약과 같은 색 규칙(평균 노랑·최고 초록)을 쓴다.
  const parts: React.ReactNode[] = [];
  if (bucket) {
    parts.push(<span key="avg">평균 <b className="score-avg">{fmtNum(bucket.avg)}</b></span>);
    parts.push(<span key="best">최고 <b className="score-best">{fmtNum(bucket.best)}</b></span>);
  }
  if (winRate) parts.push(<span key="rate">승률 {winRate.rate}%</span>);
  return parts.map((p, i) => <Fragment key={i}>{i > 0 ? " · " : ""}{p}</Fragment>);
}

// 플레이어 앞 아이콘: 앱 계정이면 프로필 사진, 봇이면 로봇, 익명이면 사람 실루엣,
// 그 외(예전 기록에 남은 이름)는 이니셜 원.
function PlayerIcon({ name, isAutoma, users }: { name: string; isAutoma: boolean; users: { name: string; avatar?: string | null }[] }) {
  const appUser = users.find((u) => u.name === name);
  if (appUser?.avatar) {
    return <img decoding="async" className="player-chip-avatar" src={api.avatarUrl(appUser.avatar)} alt="" />;
  }
  if (isAutoma || name === BOT_NAME || name === "Bot") {
    return <span className="player-chip-icon" aria-hidden>🤖</span>;
  }
  if (name === ANON_NAME) {
    return <span className="player-chip-icon" aria-hidden>👤</span>;
  }
  return (
    <span className="player-chip-initial" style={{ background: colorForName(name) }}>{name.slice(0, 1)}</span>
  );
}

export default function PlayFormPage() {
  const { id } = useParams();
  const isEdit = !!id;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { currentUser } = useUser();

  const [gameQuery, setGameQuery] = useState("");
  const [gameResults, setGameResults] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<{ id: number; name: string } | null>(null);
  const [gameDetail, setGameDetail] = useState<GameDetail | null>(null);
  const [playedAt, setPlayedAt] = useState(todayStr());

  // 장소는 드롭다운으로만 고른다 - 자유 입력을 허용하면 Home/Home2/H. 처럼 표기가 갈린다.
  const [locations, setLocations] = useState<{ name: string; count: number }[]>([]);
  const [location, setLocation] = useState("");
  const [locationOpen, setLocationOpen] = useState(false);
  // 설정에서 만들어만 둔 장소(아직 기록 0판)도 고를 수 있게 같이 보여준다.
  const [extraLocations, setExtraLocations] = useState<string[]>([]);
  // 사용자의 대표 장소. 새 기록을 열면 이 값이 미리 선택된다.
  const [defaultLocation, setDefaultLocation] = useState("");

  const [comment, setComment] = useState("");
  const [hasRuleError, setHasRuleError] = useState(false);
  const [ruleErrorNote, setRuleErrorNote] = useState("");
  const [isCoop, setIsCoop] = useState(false);
  const [coopSuccess, setCoopSuccess] = useState(true);
  const [players, setPlayers] = useState<PlayerRow[]>([emptyPlayer(), emptyPlayer()]);
  const [startPlayerIndex, setStartPlayerIndex] = useState<number | null>(null);
  // 앱 계정 목록(ㅇ/ㅃ). 플레이어 추가 메뉴에서 아직 안 들어간 사람만 후보로 보여준다.
  const [appUsers, setAppUsers] = useState<{ id: number; name: string; avatar?: string | null }[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // 시작 플레이어 뽑기 애니메이션 중 현재 하이라이트된 인덱스
  const [drawingIndex, setDrawingIndex] = useState<number | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [durationMin, setDurationMin] = useState<number | null>(null);
  // 분 입력칸을 펼쳤는지. 타이머 종료로 값이 들어온 경우까지 펼치진 않는다(타이머가 이미 보여준다).
  const [manualDuration, setManualDuration] = useState(false);
  const timerRef = useRef<PlayTimerHandle>(null);
  const [saving, setSaving] = useState(false);

  // 게임별 설정(협력 기본/승리 조건) 인라인 편집
  const [editingGameSettings, setEditingGameSettings] = useState(false);
  const [settingsCoop, setSettingsCoop] = useState(false);
  const [settingsWinCondition, setSettingsWinCondition] = useState<"high" | "low" | "none">("high");
  const [settingsSaving, setSettingsSaving] = useState(false);
  // 게임을 새로 고를 때 한 번만 coop_default를 반영한다 - 사용자가 이후 직접 토글한 걸 덮지 않기 위함.
  const appliedCoopForGame = useRef<number | null>(null);
  // 승패 자동 판정: 사용자가 승/패 체크를 직접 건드리면 그 뒤로는 자동 갱신을 멈춘다.
  const [winAutoOverridden, setWinAutoOverridden] = useState(false);
  // 새 기록에 기본 플레이어를 한 번만 채우기 위한 가드
  const defaultPlayersApplied = useRef(false);

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
    setExtraLocations(loadExtraLocations(currentUser?.id));
  }, [currentUser]);

  // 현재 사용자의 대표 장소를 읽어온다. useUser 컨텍스트는 default_location을 안 들고 있을 수 있어
  // (전역 캐시가 오래됐을 수 있음) 여기서 항상 새로 조회한다.
  useEffect(() => {
    if (!currentUser) return;
    api.users().then((list) => {
      setAppUsers(list);
      const u = list.find((x) => x.id === currentUser.id);
      setDefaultLocation(u?.default_location || "");
    }).catch(() => {});
  }, [currentUser]);

  // 새 기록: 대표 장소가 있고 아직 장소를 고르지 않았다면 미리 채운다.
  useEffect(() => {
    if (isEdit || !defaultLocation || location) return;
    setLocation(defaultLocation);
  }, [isEdit, defaultLocation, location]);

  // 새 기록: 현재 사용자를 항상 1번 플레이어로, 나머지는 마지막 저장 기록의 구성으로 미리 채운다.
  useEffect(() => {
    if (isEdit || !currentUser || defaultPlayersApplied.current) return;
    defaultPlayersApplied.current = true;
    let savedNames: string[] = [];
    try {
      const raw = localStorage.getItem(LAST_PLAYERS_KEY);
      if (raw) savedNames = JSON.parse(raw);
    } catch {
      savedNames = [];
    }
    const rest = savedNames.filter((n) => n && n !== currentUser.name);
    const names = [currentUser.name, ...rest];
    // 예전엔 빈 행을 하나 더 깔아뒀지만, 이제 이름은 "플레이어 추가" 메뉴에서 고르므로
    // 빈 행은 입력칸만 덩그러니 남는다. 나 혼자만 채우고 나머지는 사용자가 고르게 한다.
    setPlayers(names.map((n) => ({ ...emptyPlayer(), name: n, isAutoma: n === BOT_NAME })));
  }, [isEdit, currentUser]);

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
        setHasRuleError(!!found.has_rule_error);
        setRuleErrorNote(found.rule_error_note || "");
        setIsCoop(!!found.is_coop);
        setDurationMin(found.duration_min);
        // 이미 기록된 시간이 있으면 수정할 수 있게 처음부터 입력칸을 펼쳐 둔다.
        if (found.duration_min != null) setManualDuration(true);
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

  // 게임을 고르면 그 게임의 내 기록 요약(최고/최저/평균, 평균시간, 최근 플레이)을 미리보기로 보여준다.
  useEffect(() => {
    if (!selectedGame) { setGameDetail(null); return; }
    api.game(selectedGame.id).then(setGameDetail).catch(() => setGameDetail(null));
  }, [selectedGame]);

  // 게임을 새로 고를 때만 coop_default를 협력 모드 체크에 반영한다(수정 모드는 저장된 값을 그대로 쓴다).
  // 같은 게임에 대해 인라인 설정을 저장해 gameDetail이 다시 오더라도 여기서 재적용하지 않는다(ref 가드).
  useEffect(() => {
    if (!gameDetail || isEdit) return;
    if (appliedCoopForGame.current === gameDetail.id) return;
    appliedCoopForGame.current = gameDetail.id;
    setIsCoop(!!gameDetail.coop_default);
    setWinAutoOverridden(false);
  }, [gameDetail, isEdit]);

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
  function addPlayer(name: string, isAutoma = false) {
    setPlayers((prev) => [...prev, { ...emptyPlayer(), name, isAutoma }]);
    setAddMenuOpen(false);
  }
  // 아직 자리에 없는 앱 계정만 후보로 (같은 사람을 두 번 넣을 일은 없다)
  const availableUsers = appUsers.filter((u) => !players.some((p) => p.name === u.name));
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

  // 승패 자동 판정: win_condition에 따라 최고점/최저점 플레이어에게 자동으로 승을 매긴다.
  // 사용자가 승/패를 수동으로 건드리면(winAutoOverridden) 더 이상 갱신하지 않는다.
  useEffect(() => {
    if (isCoop || winAutoOverridden) return;
    const wc = gameDetail?.win_condition || "high";
    if (wc === "none") return;
    const values = players.map((_p, i) => (scoreTemplate ? breakdownSums[i] : parsedScores[i]));
    const scored = values.filter((v): v is number => v != null);
    if (scored.length === 0) return;
    const target = wc === "low" ? Math.min(...scored) : Math.max(...scored);
    setPlayers((prev) => {
      let changed = false;
      const next = prev.map((p, i) => {
        const shouldWin = values[i] != null && values[i] === target;
        if (p.win !== shouldWin) { changed = true; return { ...p, win: shouldWin }; }
        return p;
      });
      return changed ? next : prev;
    });
  }, [parsedScores, breakdownSums, scoreTemplate, gameDetail, isCoop, winAutoOverridden]);

  // 승/패 체크박스를 사용자가 직접 누르면 자동 판정을 끈다.
  function toggleWin(i: number, win: boolean) {
    setWinAutoOverridden(true);
    updatePlayer(i, { win });
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

  // 플레이어들을 빠르게 순환 하이라이트하다가 점점 느려지며(DRAW_DELAYS) 한 명에 멈춘다.
  function pickStartPlayer() {
    if (isDrawing) return;
    const filledIdx = players.map((p, i) => (p.name.trim() ? i : -1)).filter((i) => i >= 0);
    if (filledIdx.length === 0) return;
    const finalPick = filledIdx[Math.floor(Math.random() * filledIdx.length)];
    setIsDrawing(true);
    setStartPlayerIndex(null);

    let step = 0;
    const tick = () => {
      const isLast = step === DRAW_DELAYS.length - 1;
      const idx = isLast ? finalPick : filledIdx[Math.floor(Math.random() * filledIdx.length)];
      setDrawingIndex(idx);
      if (isLast) {
        setTimeout(() => {
          setDrawingIndex(null);
          setStartPlayerIndex(finalPick);
          setIsDrawing(false);
        }, DRAW_DELAYS[step]);
        return;
      }
      setTimeout(tick, DRAW_DELAYS[step]);
      step++;
    };
    tick();
  }

  function selectLocation(name: string) {
    setLocation(name);
    setLocationOpen(false);
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
      // 저장 시점에 축소한다 - 미리보기는 원본 objectURL이라 고르는 동안엔 비용이 없다
      await api.uploadPhoto(playId, await compressPhoto(p.file));
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

      // 타이머를 돌려놓고 "종료"를 안 누른 채 저장하는 일이 잦다. 그러면 시간이 안 들어가고
      // 멈춘 타이머만 다음 기록까지 남는다. 그래서 저장할 때 타이머를 대신 종료시킨다.
      // 타이머를 아예 안 썼으면 null이 오고, 이때만 직접 입력한 값을 쓴다.
      const timerMin = timerRef.current?.finalize() ?? null;
      const finalDuration = timerMin ?? durationMin;

      const body = {
        game_id: selectedGame.id,
        played_at: playedAt,
        duration_min: finalDuration,
        location: location || null,
        comment: comment || null,
        is_coop: isCoop,
        has_rule_error: hasRuleError,
        rule_error_note: hasRuleError ? (ruleErrorNote || null) : null,
        players: finalPlayers,
      };

      if (isEdit) {
        await api.updatePlay(Number(id), body);
        await uploadPendingPhotos(Number(id));
      } else {
        const created = await api.addPlay(body);
        await uploadPendingPhotos(created.id);
        // 다음 새 기록에 미리 채울 수 있게 이번 플레이어 이름 구성을 기억해둔다.
        try {
          localStorage.setItem(LAST_PLAYERS_KEY, JSON.stringify(finalPlayers.map((p) => p.name)));
        } catch {
          // localStorage 저장 실패는 무시(용량 초과 등)
        }
      }
      navigate(-1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  // 게임 선택 시 인라인으로 협력 기본/승리 조건 설정 편집 열기
  function openGameSettings() {
    setSettingsCoop(!!gameDetail?.coop_default);
    setSettingsWinCondition((gameDetail?.win_condition as "high" | "low" | "none") || "high");
    setEditingGameSettings(true);
  }

  async function saveGameSettings() {
    if (!selectedGame) return;
    setSettingsSaving(true);
    try {
      const updated = await api.updateGame(selectedGame.id, {
        coop_default: settingsCoop,
        win_condition: settingsWinCondition,
      });
      setGameDetail((prev) => (prev ? { ...prev, coop_default: updated.coop_default, win_condition: updated.win_condition } : prev));
      setEditingGameSettings(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "게임 설정 저장 실패");
    } finally {
      setSettingsSaving(false);
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
  const soloWinRate = stats?.winRateSplit?.solo ?? null;
  const multiWinRate = stats?.winRateSplit?.multi ?? null;
  // 점수 기록이 없어도 승률은 있을 수 있어서(winRateSplit) 점수 버킷과 별도로 존재 여부를 판단한다.
  const hasScorePreview = stats && (stats.score.solo || stats.score.multi || soloWinRate || multiWinRate);

  // 서버가 아는 장소(= 기록이 있는 곳) + 만들어만 둔 로컬 장소 + 지금 고른 값.
  // 현재 위치가 목록에 없으면(예: 수정 화면에서 예전 값) 놓치지 않게 앞에 붙인다.
  const locationChips = (() => {
    const list = [...locations];
    for (const name of extraLocations) {
      if (!list.some((l) => l.name === name)) list.push({ name, count: 0 });
    }
    if (location && !list.some((l) => l.name === location)) list.unshift({ name: location, count: 0 });
    return list;
  })();

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
                    <button
                      className="game-search-item"
                      onClick={() => { setSelectedGame({ id: g.id, name: g.name }); setGameQuery(""); setGameResults([]); }}
                    >
                      <span className="game-search-thumb">
                        {g.thumbnail ? <img decoding="async" src={imgUrl(g.thumbnail)} alt="" loading="lazy" /> : <span className="game-search-thumb-empty">?</span>}
                      </span>
                      <span className="game-search-name">{g.name}</span>
                      {g.year_published && <span className="muted game-search-year">{g.year_published}</span>}
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
            {(stats!.score.solo || soloWinRate) && (
              <div className="preview-score-col">
                <div className="muted preview-score-label">1인 ({stats!.score.solo?.count ?? soloWinRate?.plays ?? 0}회)</div>
                <div className="preview-score-line">{previewScoreLine(stats!.score.solo, soloWinRate)}</div>
              </div>
            )}
            {(stats!.score.multi || multiWinRate) && (
              <div className="preview-score-col">
                <div className="muted preview-score-label">2인+ ({stats!.score.multi?.count ?? multiWinRate?.plays ?? 0}회)</div>
                <div className="preview-score-line">{previewScoreLine(stats!.score.multi, multiWinRate)}</div>
              </div>
            )}
          </div>
        </div>
      )}
      {gameDetail && !hasScorePreview && gameDetail.playCount === 0 && (
        <p className="muted preview-empty">아직 이 게임의 기록이 없습니다.</p>
      )}

      <div className="field-row">
        <div className="field">
          <label>날짜</label>
          <DateField value={playedAt} onChange={setPlayedAt} />
        </div>
      </div>

      <div className="field location-field">
        <label>장소</label>
        <button className="location-current" onClick={() => setLocationOpen((o) => !o)}>
          <span>{location || "장소 선택"}</span>
          <span className="location-caret">{locationOpen ? "▴" : "▾"}</span>
        </button>
        {locationOpen && (
          <div className="location-dropdown">
            {/* 여기서는 고르기만 한다. 추가·이름 바꾸기·삭제·대표 지정은 설정의 "장소"에 있다 -
                판을 적는 중에 할 일이 아니고, 잘못 눌러 기록 전체의 장소가 바뀌면 곤란하다. */}
            {locationChips.map((l) => (
              <div key={l.name} className="location-dropdown-row">
                <button
                  className={`location-dropdown-item${location === l.name ? " active" : ""}`}
                  onClick={() => selectLocation(l.name)}
                >
                  {l.name}
                </button>
                {defaultLocation === l.name && <span className="default-location-badge muted">대표</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <PlayTimer
        ref={timerRef}
        avgMinutes={stats?.avgDurationMin ?? null}
        onDurationChange={setDurationMin}
        onManualInput={() => setManualDuration(true)}
        manualInputOpen={manualDuration}
      />

      {/* 분 입력칸은 평소엔 숨긴다 - 타이머로 재는 게 기본이고, 직접 적을 때만 꺼내 쓴다.
          수정 모드처럼 이미 시간이 들어있으면 처음부터 펼쳐 둔다. */}
      {manualDuration && (
        <div className="field">
          <div className="duration-manual-head">
            <label>플레이 시간 (분)</label>
            {/* 잘못 눌러서 열었을 때 되돌릴 길이 있어야 한다 - 닫으면 입력한 값도 지운다 */}
            <button className="btn-tiny" onClick={() => { setManualDuration(false); setDurationMin(null); }}>취소</button>
          </div>
          <input
            type="number"
            autoFocus
            value={durationMin ?? ""}
            onChange={(e) => setDurationMin(e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
      )}

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
        {selectedGame && !editingGameSettings && (
          <button className="btn-link game-settings-link" onClick={openGameSettings}>이 게임 설정</button>
        )}
      </div>

      {editingGameSettings && (
        <div className="card game-settings-edit">
          <label className="switch-label settings-toggle-label">
            <input type="checkbox" checked={settingsCoop} onChange={(e) => setSettingsCoop(e.target.checked)} />
            협력 게임 기본 체크
          </label>
          <div className="field" style={{ marginTop: 8 }}>
            <label>승패 자동 판정</label>
            <div className="win-condition-options">
              <label className={`win-condition-chip${settingsWinCondition === "high" ? " active" : ""}`}>
                <input type="radio" name="win_condition" checked={settingsWinCondition === "high"} onChange={() => setSettingsWinCondition("high")} />
                최고점 승
              </label>
              <label className={`win-condition-chip${settingsWinCondition === "low" ? " active" : ""}`}>
                <input type="radio" name="win_condition" checked={settingsWinCondition === "low"} onChange={() => setSettingsWinCondition("low")} />
                최저점 승
              </label>
              <label className={`win-condition-chip${settingsWinCondition === "none" ? " active" : ""}`}>
                <input type="radio" name="win_condition" checked={settingsWinCondition === "none"} onChange={() => setSettingsWinCondition("none")} />
                수동
              </label>
            </div>
          </div>
          <div className="field-row" style={{ marginTop: 8 }}>
            <button className="btn-small" disabled={settingsSaving} onClick={saveGameSettings}>
              {settingsSaving ? "저장 중..." : "저장"}
            </button>
            <button className="btn-small" onClick={() => setEditingGameSettings(false)}>취소</button>
          </div>
        </div>
      )}

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
        <div key={i} className={`player-row-edit${isCoop ? " coop" : ""}${drawingIndex === i ? " drawing-highlight" : ""}`}>
          {/* 이름이 비어 있을 때(= 메뉴에서 "직접 입력"으로 만든 행)만 입력칸을 준다.
              나머지는 아이콘 + 이름 칩으로 고정해 표기가 갈리지 않게 한다. */}
          {p.name === "" ? (
            <input
              className="player-name-input"
              placeholder="이름 직접 입력"
              value={p.name}
              autoFocus
              onChange={(e) => updatePlayer(i, { name: e.target.value })}
            />
          ) : (
            <span className="player-name-chip">
              <PlayerIcon name={p.name} isAutoma={p.isAutoma} users={appUsers} />
              <span className="player-name-chip-text">{p.name}</span>
              {startPlayerIndex === i && !isDrawing && <span className="start-player-flag" title="시작 플레이어">🚩</span>}
            </span>
          )}
          {scoreTemplate ? (
            <span className="player-score-input player-score-readonly">{Math.round(breakdownSums[i] || 0)}</span>
          ) : (
            <input
              className="player-score-input"
              placeholder="점수"
              value={p.scoreText}
              onChange={(e) => updatePlayer(i, { scoreText: e.target.value })}
            />
          )}
          {!isCoop && (
            <label className="win-checkbox">
              <input type="checkbox" checked={p.win} onChange={(e) => toggleWin(i, e.target.checked)} />
              승
            </label>
          )}
          <button className="remove-player-btn" onClick={() => removePlayer(i)} aria-label="플레이어 제거">✕</button>
          {!scoreTemplate && p.scoreText.trim() && parsedScores[i] == null && (
            <div className="score-error">식을 계산할 수 없습니다</div>
          )}
          {!scoreTemplate && p.scoreText.trim() && parsedScores[i] != null && p.scoreText.trim() !== String(parsedScores[i]) && (
            <div className="score-preview muted">= {Math.round(parsedScores[i]!)}</div>
          )}
        </div>
      ))}
      <div className="add-player-wrap">
        <div className={`add-player-bar${isCoop ? " coop" : ""}`}>
          <button className="btn-secondary add-player-btn" onClick={() => setAddMenuOpen((v) => !v)}>
            + 플레이어 추가
          </button>
          {/* 뽑기는 자주 쓰는 기능이 아니라 반대쪽 끝에 작게 둔다 */}
          {players.length > 1 && (
            <button
              className="draw-start-btn"
              disabled={isDrawing}
              onClick={pickStartPlayer}
              title="시작 플레이어 뽑기"
              aria-label="시작 플레이어 뽑기"
            >
              {isDrawing ? "···" : "🎲"}
            </button>
          )}
        </div>
        {addMenuOpen && (
          <div className="add-player-menu">
            {availableUsers.map((u) => (
              <button key={u.id} className="add-player-option" onClick={() => addPlayer(u.name)}>
                <PlayerIcon name={u.name} isAutoma={false} users={appUsers} />
                <span>{u.name}</span>
              </button>
            ))}
            <button className="add-player-option" onClick={() => addPlayer(BOT_NAME, true)}>
              <span className="player-chip-icon" aria-hidden>🤖</span>
              <span>봇</span>
            </button>
            <button className="add-player-option" onClick={() => addPlayer(ANON_NAME)}>
              <span className="player-chip-icon" aria-hidden>👤</span>
              <span>{ANON_NAME}</span>
            </button>
            {/* 앱 계정도 봇도 익명도 아닌 손님(예전 기록의 "용덕이")을 위한 탈출구 */}
            <button className="add-player-option" onClick={() => addPlayer("")}>
              <span className="player-chip-icon" aria-hidden>✏️</span>
              <span>직접 입력</span>
            </button>
          </div>
        )}
      </div>

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

      <div className="field rule-error-field">
        <label className="switch-label settings-toggle-label">
          <input type="checkbox" checked={hasRuleError} onChange={(e) => setHasRuleError(e.target.checked)} />
          에러플
        </label>
        {hasRuleError && (
          <textarea
            rows={2}
            placeholder="어떤 룰을 틀렸는지 메모"
            value={ruleErrorNote}
            onChange={(e) => setRuleErrorNote(e.target.value)}
          />
        )}
      </div>

      <div className="field">
        <label>사진</label>
        <div className="photo-picker-grid">
          {existingPhotos.map((p) => (
            <div className="photo-picker-item" key={`existing-${p.id}`}>
              <img decoding="async" src={api.photoUrl(p.filename)} alt="" />
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
              <img decoding="async" src={p.previewUrl} alt="" />
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

      {/* 저장을 오른쪽에 둔다. 오른손으로 폰을 쥐면 엄지가 닿는 쪽이라 자주 누르는 쪽이
          거기 있어야 하고, 삭제가 그 자리에 있으면 잘못 누르기도 쉽다. */}
      <div className="play-form-actions">
        {isEdit && (
          <button className="btn-secondary danger" disabled={deleting} onClick={handleDelete}>
            {deleting ? "삭제 중..." : "삭제"}
          </button>
        )}
        <button className="btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>
    </div>
  );
}
