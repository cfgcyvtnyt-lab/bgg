import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import { ratingColor } from "../utils/ratingTier";
import "../styles/StarRating.css";

interface StarRatingProps {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  size?: number;
  // true면 별을 눌렀을 때 조절 창이 뜬다. false면 보여주기만 한다.
  editable?: boolean;
}

// BGG와 같은 10점 척도. 별 하나가 1점이라 9점이면 별 9개다.
// (예전엔 별 5개짜리라 별 하나가 2점이었고, 그래서 9점이 별 5개로 꽉 차 보이는 문제가 있었다.)
const STAR_COUNT = 10;

// BGG 평점 안내문. 별을 조절할 때 지금 점수가 무슨 뜻인지 그대로 보여준다.
const RATING_LABELS: Record<number, string> = {
  10: "최고 — 언제나 하고 싶고, 앞으로도 그럴 것 같다.",
  9: "훌륭함 — 언제든 하고 싶다.",
  8: "아주 좋음 — 즐겁게 하고, 남에게도 권한다.",
  7: "좋음 — 하자고 하면 대체로 한다.",
  6: "괜찮음 — 재미나 도전이 있고, 기분 나면 가끔 한다.",
  5: "보통 — 조금 지루하다. 해도 그만 안 해도 그만.",
  4: "별로 — 끌리진 않지만 가끔은 해줄 수 있다.",
  3: "나쁨 — 다시 할 일은 없을 듯하나 설득은 가능하다.",
  2: "매우 별로 — 다시는 안 한다.",
  1: "최악 — 나쁜 게임이라는 말로도 부족하다. 다시는 안 한다.",
};

function labelFor(v: number | null) {
  if (v == null || v <= 0) return "평점 없음";
  // 7.5처럼 소수는 올림해서 위 등급의 설명을 쓴다(BGG도 같은 식으로 보여준다).
  return RATING_LABELS[Math.min(10, Math.max(1, Math.ceil(v)))] || "";
}

/** 별 10개를 그린다. 채움은 0.1 단위까지 그대로 반영되고, 반 칸 이하도 그만큼만 칠해진다.
 *  onPick이 있으면 누르거나 문질러서 값을 바꿀 수 있다(별 띠 자체가 슬라이더 역할). */
function Stars({ value, size, onPick }: { value: number | null; size: number; onPick?: (v: number) => void }) {
  const barRef = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);

  // 별 띠 위 x좌표를 0~10 값으로. 0.5 단위로 맞춰야 별 반 칸과 눈금이 맞는다.
  function valueAt(clientX: number) {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(ratio * STAR_COUNT * 2) / 2;
  }

  useEffect(() => {
    if (!onPick) return;
    function move(e: PointerEvent) {
      if (dragging.current) onPick!(valueAt(e.clientX));
    }
    function up() { dragging.current = false; }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
  }, [onPick]);

  return (
    <span
      className={`star-rating-stars${onPick ? " pickable" : ""}`}
      ref={barRef}
      onPointerDown={onPick ? (e) => {
        e.preventDefault();
        dragging.current = true;
        onPick(valueAt(e.clientX));
      } : undefined}
    >
      {Array.from({ length: STAR_COUNT }, (_, i) => {
        const filled = value != null ? Math.max(0, Math.min(1, value - i)) : 0;
        return (
          <span key={i} className="star-rating-star" style={{ fontSize: size }}>
            ★
            <span className="star-rating-star-fill" style={{ width: `${filled * 100}%` }}>★</span>
          </span>
        );
      })}
    </span>
  );
}

/** 별점 조절 창. 별을 눌렀을 때도, 표의 숫자 뱃지를 눌렀을 때도 이게 뜬다. */
function RatingDialog({ value, onChange, onClose }: { value: number | null; onChange: (v: number | null) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<number>(value ?? 0);
  const [text, setText] = useState(value != null ? String(value) : "");
  const [editing, setEditing] = useState(false);

  function setValue(v: number) {
    const clamped = Math.round(Math.max(0, Math.min(10, v)) * 10) / 10;
    setDraft(clamped);
    setText(String(clamped));
  }

  function commit() {
    onChange(draft <= 0 ? null : draft);
    onClose();
  }

  return (
    <Modal onClose={onClose} size="narrow">
      <div className="rating-modal">
        {/* 숫자를 누르면 그 자리가 입력칸이 된다 - 별도의 "직접 입력" 칸을 두지 않는다 */}
        {editing ? (
          <input
            className="rating-modal-value-input"
            type="number"
            min={0}
            max={10}
            step={0.1}
            autoFocus
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value !== "" && !Number.isNaN(n)) setDraft(Math.round(Math.max(0, Math.min(10, n)) * 10) / 10);
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button type="button" className="rating-modal-value" onClick={() => setEditing(true)} title="눌러서 직접 입력">
            {draft > 0 ? draft.toFixed(1) : "-"}
          </button>
        )}

        {/* 별을 누르거나 좌우로 문지르면 0.5 단위로 바뀐다 */}
        <Stars value={draft} size={26} onPick={setValue} />

        <div className="rating-modal-label">{labelFor(draft)}</div>

        <div className="rating-modal-actions">
          <button type="button" onClick={() => { onChange(null); onClose(); }}>지우기</button>
          <button type="button" onClick={onClose}>취소</button>
          <button type="button" className="primary" onClick={commit}>확인</button>
        </div>
      </div>
    </Modal>
  );
}

export default function StarRating({ value, onChange, disabled, size = 22, editable = false }: StarRatingProps) {
  const [open, setOpen] = useState(false);
  const stars = <Stars value={value} size={size} />;

  if (!editable || disabled) return stars;

  return (
    <>
      <button type="button" className="star-rating-trigger" onClick={() => setOpen(true)} aria-label="평점 매기기">
        {stars}
      </button>
      {open && <RatingDialog value={value} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 표 모드용. 별 10개는 열 하나를 다 잡아먹어서, 긱 평점과 같은 모양의 색 있는 숫자로 대신한다. */
export function RatingBadge({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="rating-badge-btn"
        style={value != null ? { borderColor: ratingColor(value), color: ratingColor(value) } : undefined}
        onClick={() => setOpen(true)}
        aria-label="평점 매기기"
      >
        {value != null ? value.toFixed(1) : "-"}
      </button>
      {open && <RatingDialog value={value} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}
