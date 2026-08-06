// GameDetailPage와 CollectionTable(표 모드)이 공유하는 별점 컴포넌트.
// 0~10 원점수 스케일(별 하나=2점, 클릭 위치 좌/우 절반으로 0.5 단위 구현).
export default function StarRating({ value, onChange, disabled, size = 22 }: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  size?: number;
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
}
