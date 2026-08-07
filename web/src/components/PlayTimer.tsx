import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

interface Props {
  onDurationChange: (minutes: number) => void;
  avgMinutes: number | null;
  /** "직접입력" 버튼을 눌렀을 때. 부모가 분 입력칸을 펼친다. 이미 펼쳐져 있으면 버튼을 숨긴다. */
  onManualInput?: () => void;
  manualInputOpen?: boolean;
}

export interface PlayTimerHandle {
  /** 저장 직전에 부모가 부른다. 돌아가는 중이든 멈춰 있든 지금까지의 분을 확정해 돌려주고
   *  타이머를 0으로 되돌린다(저장한 기록의 시간이 다음 기록까지 따라오면 안 되므로).
   *  한 번도 쓰지 않았으면 null - 이때는 부모가 직접 입력한 값을 그대로 쓴다. */
  finalize: () => number | null;
}

// 진행 중인 타이머를 localStorage에 남긴다. 폰에서 화면을 끄거나 다른 앱에 갔다 오는 정도는
// Date.now() 계산으로 버티지만, 탭을 닫거나 새로고침하면 상태가 통째로 사라지기 때문이다.
const STORAGE_KEY = "bgg_timer_v1";

interface Saved {
  elapsedMs: number;
  startedAt: number | null; // 진행 중이면 시작 시각(epoch), 멈춰 있으면 null
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { elapsedMs: 0, startedAt: null };
    const v = JSON.parse(raw);
    const elapsedMs = Number(v?.elapsedMs);
    const startedAt = v?.startedAt == null ? null : Number(v.startedAt);
    // 저장값이 깨졌으면 0으로 되돌린다 - 이상한 값이 화면에 찍히는 것보다 낫다.
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return { elapsedMs: 0, startedAt: null };
    if (startedAt != null && (!Number.isFinite(startedAt) || startedAt <= 0)) {
      return { elapsedMs, startedAt: null };
    }
    return { elapsedMs, startedAt };
  } catch {
    return { elapsedMs: 0, startedAt: null };
  }
}

function save(s: Saved) {
  try {
    if (s.elapsedMs === 0 && s.startedAt == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 저장 실패는 무시 - 타이머 자체는 계속 동작해야 한다
  }
}

function fmt(totalSeconds: number) {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const PlayTimer = forwardRef<PlayTimerHandle, Props>(function PlayTimer({ onDurationChange, avgMinutes, onManualInput, manualInputOpen }, ref) {
  const initial = useRef<Saved>(load());
  const [elapsedMs, setElapsedMs] = useState(initial.current.elapsedMs);
  const [startedAt, setStartedAt] = useState<number | null>(initial.current.startedAt);
  const [, forceTick] = useState(0);

  const running = startedAt != null;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => { save({ elapsedMs, startedAt }); }, [elapsedMs, startedAt]);

  const displayMs = startedAt != null ? elapsedMs + (Date.now() - startedAt) : elapsedMs;

  function start() {
    setStartedAt(Date.now());
  }

  // 경과분을 setState 콜백 안에서 ref로 읽으면 안 된다. 콜백은 렌더 시점에 실행되는데
  // 그 전에 핸들러가 ref를 비워버려 Date.now() - 0(=epoch 전체)이 더해지는 버그가 있었다.
  // 그래서 지금 값을 지역 변수로 먼저 확정한 뒤 상태를 갱신한다.
  function pause() {
    if (startedAt == null) return;
    const delta = Date.now() - startedAt;
    setElapsedMs((prev) => prev + delta);
    setStartedAt(null);
  }

  function stop() {
    const finalMs = startedAt != null ? elapsedMs + (Date.now() - startedAt) : elapsedMs;
    setStartedAt(null);
    setElapsedMs(finalMs);
    onDurationChange(Math.round(finalMs / 60000));
  }

  function reset() {
    setStartedAt(null);
    setElapsedMs(0);
  }

  // deps를 주지 않아 매 렌더마다 최신 elapsedMs/startedAt을 담은 새 함수로 바뀐다.
  // (deps를 걸면 저장 시점에 옛날 값이 잡혀 시간이 빠진다)
  useImperativeHandle(ref, () => ({
    finalize() {
      const finalMs = startedAt != null ? elapsedMs + (Date.now() - startedAt) : elapsedMs;
      // 값과 무관하게 타이머는 반드시 비운다 - 저장한 기록의 시간이 다음 기록까지 따라오면 안 된다.
      setStartedAt(null);
      setElapsedMs(0);
      save({ elapsedMs: 0, startedAt: null });
      // 30초도 안 되는 건 잘못 누른 것이지 실제 플레이 시간이 아니다. 0분을 기록하느니
      // 타이머를 안 쓴 것으로 치고(null) 직접 입력값을 살린다.
      if (finalMs < 30000) return null;
      return Math.round(finalMs / 60000);
    },
  }));

  return (
    <div className="play-timer">
      <span className="play-timer-display">{fmt(Math.floor(displayMs / 1000))}</span>
      {!running && elapsedMs === 0 && (
        <button type="button" className="play-timer-btn" onClick={start}>시작</button>
      )}
      {running && (
        <button type="button" className="play-timer-btn" onClick={pause}>일시정지</button>
      )}
      {!running && elapsedMs > 0 && (
        <button type="button" className="play-timer-btn" onClick={start}>재개</button>
      )}
      {(running || elapsedMs > 0) && (
        <button type="button" className="play-timer-btn primary" onClick={stop}>종료</button>
      )}
      {!running && elapsedMs > 0 && (
        <button type="button" className="play-timer-btn ghost" onClick={reset}>초기화</button>
      )}
      {onManualInput && !manualInputOpen && (
        <button type="button" className="play-timer-btn ghost" onClick={onManualInput}>직접입력</button>
      )}
      {avgMinutes != null && (
        <span className="play-timer-avg muted">평균 {Math.round(avgMinutes)}분</span>
      )}
    </div>
  );
});

export default PlayTimer;
