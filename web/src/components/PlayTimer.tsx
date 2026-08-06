import { useEffect, useRef, useState } from "react";

interface Props {
  onDurationChange: (minutes: number) => void;
  avgMinutes: number | null;
}

function fmt(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 실시간으로 흐르는 타이머. Date.now() 기준으로 계산해서 탭이 백그라운드에 가있어도
// setInterval 드리프트와 무관하게 정확한 경과 시간을 보여준다.
export default function PlayTimer({ onDurationChange, avgMinutes }: Props) {
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [running]);

  const displayMs = running && startRef.current != null
    ? elapsedMs + (Date.now() - startRef.current)
    : elapsedMs;

  function start() {
    startRef.current = Date.now();
    setRunning(true);
  }

  function pause() {
    if (startRef.current != null) {
      setElapsedMs((prev) => prev + (Date.now() - startRef.current!));
    }
    startRef.current = null;
    setRunning(false);
  }

  function stop() {
    let finalMs = elapsedMs;
    if (startRef.current != null) {
      finalMs += Date.now() - startRef.current;
    }
    startRef.current = null;
    setRunning(false);
    setElapsedMs(finalMs);
    onDurationChange(Math.round(finalMs / 60000));
  }

  function reset() {
    startRef.current = null;
    setRunning(false);
    setElapsedMs(0);
  }

  return (
    <div className="play-timer card">
      <div className="play-timer-display">{fmt(Math.floor(displayMs / 1000))}</div>
      <div className="play-timer-buttons">
        {!running && elapsedMs === 0 && <button className="btn-primary" onClick={start}>시작</button>}
        {running && <button className="btn-secondary" onClick={pause}>일시정지</button>}
        {!running && elapsedMs > 0 && <button className="btn-primary" onClick={start}>재개</button>}
        {(running || elapsedMs > 0) && <button className="btn-secondary" onClick={stop}>종료</button>}
        {!running && elapsedMs > 0 && <button className="btn-secondary" onClick={reset}>초기화</button>}
      </div>
      {avgMinutes != null && (
        <div className="play-timer-avg muted">이 게임 평균 소요시간: 약 {Math.round(avgMinutes)}분</div>
      )}
    </div>
  );
}
