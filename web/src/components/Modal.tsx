import { useEffect } from "react";
import "../styles/Modal.css";
import { createPortal } from "react-dom";

interface Props {
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** 좁은 창(평점 조절 등)은 "narrow", 목록이 긴 창은 기본값 */
  size?: "narrow" | "wide";
}

// 앱의 모든 모달이 쓰는 껍데기. 예전엔 화면마다 오버레이를 따로 만들어서
// z-index가 제각각이라 하단 탭바에 가리는 사고가 났고, 바깥 클릭 닫기나
// 배경 스크롤 잠금 같은 기본 동작도 있는 데만 있었다.
export default function Modal({ title, onClose, children, size = "wide" }: Props) {
  // 창이 떠 있는 동안 뒤 화면이 같이 스크롤되면 어지럽다.
  useEffect(() => {
    // 스크롤 주체가 body가 아니라 화면 패널(.app-pane)이다. body를 잠가봐야
    // 창 뒤의 목록이 그대로 스크롤되므로, 지금 보이는 패널을 잠근다.
    const pane = document.querySelector<HTMLElement>(".app-pane.active");
    const prev = pane?.style.overflowY ?? "";
    if (pane) pane.style.overflowY = "hidden";
    return () => { if (pane) pane.style.overflowY = prev; };
  }, []);

  // ESC로 닫기
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // body 밑으로 빼서 그린다. 카드에 content-visibility가 걸리면 contain: paint가 함께 걸려
  // 그 카드가 position: fixed의 기준점이 되고, 화면을 덮어야 할 창이 카드 안에 갇힌다.
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-sheet${size === "narrow" ? " modal-sheet-narrow" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="modal-close" onClick={onClose} aria-label="닫기">✕</button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}
