import { useEffect, useRef, useState } from "react";
import "../styles/DateField.css";

interface Props {
  value: string; // YYYY-MM-DD
  onChange: (v: string) => void;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// Date <-> "YYYY-MM-DD" 변환은 항상 로컬 기준으로 한다.
// toISOString()은 UTC라 한국 시간 자정~오전 9시 사이에 하루 전 날짜가 나온다.
export function toDateStr(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseDateStr(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function label(s: string) {
  const d = parseDateStr(s);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

// 브라우저 기본 <input type="date">는 달력 팝업이 OS·브라우저 스킨으로 그려져서
// 다크 테마인 앱 안에서 혼자 튄다(스타일을 먹일 방법도 없다). 그래서 직접 그린다.
export default function DateField({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => parseDateStr(value));
  const wrapRef = useRef<HTMLDivElement>(null);

  // 열 때마다 선택된 달로 되돌린다 - 지난번에 넘겨둔 달이 남아 있으면 헷갈린다.
  useEffect(() => {
    if (open) setCursor(parseDateStr(value));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  // 그 달 1일이 무슨 요일인지만큼 앞을 비우고, 말일까지 채운다.
  const leading = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const todayStr = toDateStr(new Date());

  function pick(day: number) {
    onChange(toDateStr(new Date(year, month, day)));
    setOpen(false);
  }

  return (
    <div className="date-field" ref={wrapRef}>
      <button type="button" className="date-field-button" onClick={() => setOpen((v) => !v)}>
        {/* 값이 비어 있을 수 있는 자리(인사이트 기간 직접입력 등)에서는 오늘 날짜를 보여주면
            이미 고른 것처럼 보인다. 그래서 안내 문구를 대신 띄운다. */}
        {value ? <span>{label(value)}</span> : <span className="muted">날짜 선택</span>}
        <span className="date-field-icon" aria-hidden>📅</span>
      </button>

      {open && (
        <div className="date-popup">
          <div className="date-popup-head">
            <button type="button" className="date-nav" onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="이전 달">‹</button>
            <span className="date-popup-title">{year}년 {month + 1}월</span>
            <button type="button" className="date-nav" onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="다음 달">›</button>
          </div>

          <div className="date-grid">
            {WEEKDAYS.map((w, i) => (
              <span key={w} className={`date-weekday${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}>{w}</span>
            ))}
            {cells.map((day, i) => {
              if (day == null) return <span key={`e${i}`} />;
              const ds = toDateStr(new Date(year, month, day));
              const dow = i % 7;
              return (
                <button
                  type="button"
                  key={ds}
                  className={`date-cell${ds === value ? " selected" : ""}${ds === todayStr ? " today" : ""}${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}`}
                  onClick={() => pick(day)}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="date-popup-foot">
            <button type="button" className="date-today-btn" onClick={() => { onChange(todayStr); setOpen(false); }}>오늘</button>
          </div>
        </div>
      )}
    </div>
  );
}
