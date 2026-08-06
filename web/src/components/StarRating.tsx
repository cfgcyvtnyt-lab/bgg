import { useEffect, useRef, useState } from "react";

interface StarRatingProps {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  size?: number;
  // true면 별을 클릭했을 때 숫자 직접 입력 + 드래그 조절이 가능한 팝오버를 띄운다.
  // false(기본)는 기존처럼 클릭 위치 좌/우 절반으로 0.5 단위 토글 - GameDetailPage는 이 기본 동작을 그대로 쓴다.
  editable?: boolean;
}

// GameDetailPage와 CollectionTable(표 모드)이 공유하는 별점 컴포넌트.
// 0~10 원점수 스케일(별 하나=2점).
export default function StarRating({ value, onChange, disabled, size = 22, editable = false }: StarRatingProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value != null ? String(value) : "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);

  // 팝오버를 열 때마다 현재 값으로 입력칸을 초기화한다.
  useEffect(() => {
    if (open) setDraft(value != null ? String(value) : "");
  }, [open, value]);

  // 바깥을 클릭하면 팝오버를 닫는다(저장하지 않고 취소).
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const stars = [1, 2, 3, 4, 5];
  // 팝오버가 열려있는 동안은 드래그/입력 중인 draft 값을 별 채움에 바로 반영해 미리보기로 보여준다.
  const draftNum = draft.trim() === "" ? null : Number(draft);
  const displayValue = open && draftNum != null && !Number.isNaN(draftNum) ? draftNum : open ? null : value;

  function handleStarClick(e: React.MouseEvent<HTMLSpanElement>, star: number) {
    if (disabled) return;
    if (editable) {
      setOpen((v) => !v);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const half = e.clientX - rect.left < rect.width / 2;
    const newValue = star * 2 - (half ? 1 : 0);
    // 이미 같은 값을 다시 클릭하면 평점을 지운다(토글).
    onChange(value === newValue ? null : newValue);
  }

  function valueFromClientX(clientX: number): number {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    // 0.1 단위로 정밀하게
    return Math.round(ratio * 10 * 10) / 10;
  }

  function handleDragStart(e: React.MouseEvent) {
    if (!editable || disabled || !open) return;
    e.preventDefault();
    draggingRef.current = true;
    setDraft(String(valueFromClientX(e.clientX)));
    function onMove(ev: MouseEvent) {
      if (!draggingRef.current) return;
      setDraft(String(valueFromClientX(ev.clientX)));
    }
    function onUp() {
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onChange(null);
      setOpen(false);
      return;
    }
    const num = Number(trimmed);
    if (Number.isNaN(num)) {
      setOpen(false);
      return;
    }
    onChange(Math.max(0, Math.min(10, num)));
    setOpen(false);
  }

  function clear() {
    onChange(null);
    setOpen(false);
  }

  const stars_el = (
    <span
      className="star-rating-stars"
      ref={barRef}
      onMouseDown={editable && open ? handleDragStart : undefined}
    >
      {stars.map((star) => {
        const filled = displayValue != null ? Math.max(0, Math.min(1, displayValue - (star - 1) * 2)) : 0;
        return (
          <span
            key={star}
            onClick={(e) => handleStarClick(e, star)}
            style={{
              position: "relative",
              display: "inline-block",
              fontSize: size,
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

  if (!editable) return stars_el;

  return (
    <div className="star-rating-wrap" ref={wrapRef}>
      {stars_el}
      {open && (
        <div className="star-rating-popover" onClick={(e) => e.stopPropagation()}>
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="star-rating-popover-actions">
            <button type="button" onClick={clear}>지우기</button>
            <button type="button" className="star-rating-popover-confirm" onClick={commit}>확인</button>
          </div>
        </div>
      )}
    </div>
  );
}
