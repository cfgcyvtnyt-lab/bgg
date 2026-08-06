import { useEffect, useRef, useState } from "react";
import type { MouseEvent, TouchEvent, WheelEvent } from "react";
import { api } from "../api/client";
import type { Photo } from "../api/types";
import "../styles/PhotoSlider.css";

const ZOOM_STEP = 0.5;
const ZOOM_MAX = 4;

// 블로그(new/script.js)의 buildSlider를 React로 이식: 트랙 드래그로 좌우 넘기기 + 화살표/점 인디케이터.
// 실제 DOM을 직접 건드리는 대신 React state(index, dragX)로 transform을 계산해서 리렌더와 어긋나지 않게 한다.
export default function PhotoSlider({ photos }: { photos: Photo[] }) {
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const touchRef = useRef({ startX: 0, startY: 0, horizontal: false, moved: false });
  const total = photos.length;

  if (total === 0) return null;

  function goTo(i: number) {
    setIndex(Math.max(0, Math.min(total - 1, i)));
  }

  function onTouchStart(e: TouchEvent) {
    touchRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, horizontal: false, moved: false };
    setDragging(true);
  }

  function onTouchMove(e: TouchEvent) {
    const s = touchRef.current;
    const diffX = e.touches[0].clientX - s.startX;
    const diffY = e.touches[0].clientY - s.startY;
    if (!s.horizontal && Math.abs(diffX) > Math.abs(diffY)) s.horizontal = true;
    if (s.horizontal) {
      if (Math.abs(diffX) > 5) s.moved = true;
      setDragX(diffX);
    }
  }

  function onTouchEnd(e: TouchEvent) {
    const s = touchRef.current;
    setDragging(false);
    setDragX(0);
    if (s.horizontal) {
      const diffX = e.changedTouches[0].clientX - s.startX;
      if (diffX < -40 && index < total - 1) goTo(index + 1);
      else if (diffX > 40 && index > 0) goTo(index - 1);
    }
  }

  function onSlideClick() {
    if (touchRef.current.moved) {
      touchRef.current.moved = false;
      return;
    }
    setZoomOpen(true);
  }

  return (
    <div className="photo-slider">
      <div
        className="photo-slider-track"
        style={{
          transform: `translateX(calc(-${index * 100}% + ${dragX}px))`,
          transition: dragging ? "none" : undefined,
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {photos.map((p) => (
          <div className="photo-slider-slide" key={p.id} onClick={onSlideClick}>
            <img src={api.photoUrl(p.filename)} alt={p.caption || "플레이 사진"} draggable={false} />
          </div>
        ))}
      </div>

      {total > 1 && (
        <>
          {index > 0 && (
            <button
              className="photo-slider-arrow prev"
              onClick={(e) => { e.stopPropagation(); goTo(index - 1); }}
              aria-label="이전 사진"
            >
              ❮
            </button>
          )}
          {index < total - 1 && (
            <button
              className="photo-slider-arrow next"
              onClick={(e) => { e.stopPropagation(); goTo(index + 1); }}
              aria-label="다음 사진"
            >
              ❯
            </button>
          )}
          <div className="photo-slider-dots">
            {photos.map((p, i) => (
              <span key={p.id} className={`photo-slider-dot${i === index ? " active" : ""}`} />
            ))}
          </div>
        </>
      )}

      {zoomOpen && (
        <PhotoLightbox
          photos={photos}
          index={index}
          onIndexChange={goTo}
          onClose={() => setZoomOpen(false)}
        />
      )}
    </div>
  );
}

function PhotoLightbox({
  photos, index, onIndexChange, onClose,
}: {
  photos: Photo[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  // 핀치/드래그 진행 상태는 리렌더를 매번 유발할 필요가 없어 ref로 들고 있는다
  const gesture = useRef({ startX: 0, startY: 0, initialDist: 0, moved: false, mouseDragging: false });

  // 좌우로 사진을 넘기면 확대 상태를 초기화한다
  useEffect(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, [index]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Esc") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function clampScale(s: number) {
    return Math.min(Math.max(1, s), ZOOM_MAX);
  }

  function zoomBy(delta: number) {
    setScale((s) => {
      const next = clampScale(s + delta);
      if (next <= 1) setPos({ x: 0, y: 0 });
      return next;
    });
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  function onTouchStart(e: TouchEvent) {
    const g = gesture.current;
    g.moved = false;
    if (e.touches.length === 1) {
      g.startX = e.touches[0].clientX - pos.x;
      g.startY = e.touches[0].clientY - pos.y;
    } else if (e.touches.length === 2) {
      g.initialDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
    }
  }

  function onTouchMove(e: TouchEvent) {
    const g = gesture.current;
    if (e.touches.length === 2) {
      g.moved = true;
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      const ratio = dist / g.initialDist;
      g.initialDist = dist;
      setScale((s) => clampScale(s * ratio));
    } else if (e.touches.length === 1 && scale > 1) {
      g.moved = true;
      setPos({ x: e.touches[0].clientX - g.startX, y: e.touches[0].clientY - g.startY });
    }
  }

  function onMouseDown(e: MouseEvent) {
    if (scale <= 1) return;
    const g = gesture.current;
    g.mouseDragging = true;
    g.moved = false;
    g.startX = e.clientX - pos.x;
    g.startY = e.clientY - pos.y;
  }

  useEffect(() => {
    function onMove(e: globalThis.MouseEvent) {
      const g = gesture.current;
      if (!g.mouseDragging) return;
      const nx = e.clientX - g.startX;
      const ny = e.clientY - g.startY;
      if (Math.abs(nx - pos.x) > 3 || Math.abs(ny - pos.y) > 3) g.moved = true;
      setPos({ x: nx, y: ny });
    }
    function onUp() {
      gesture.current.mouseDragging = false;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [pos]);

  function onBackgroundClick() {
    if (gesture.current.moved) {
      gesture.current.moved = false;
      return;
    }
    onClose();
  }

  const photo = photos[index];

  return (
    <div className="photo-lightbox" onClick={onBackgroundClick}>
      <button className="photo-lightbox-close" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="닫기">✕</button>

      {photos.length > 1 && index > 0 && (
        <button
          className="photo-lightbox-arrow prev"
          onClick={(e) => { e.stopPropagation(); onIndexChange(index - 1); }}
          aria-label="이전 사진"
        >
          ❮
        </button>
      )}
      {photos.length > 1 && index < photos.length - 1 && (
        <button
          className="photo-lightbox-arrow next"
          onClick={(e) => { e.stopPropagation(); onIndexChange(index + 1); }}
          aria-label="다음 사진"
        >
          ❯
        </button>
      )}

      <img
        className={`photo-lightbox-img${scale > 1 ? " is-zoomed" : ""}`}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
        src={api.photoUrl(photo.filename)}
        alt={photo.caption || "플레이 사진"}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onMouseDown={onMouseDown}
        onWheel={onWheel}
      />

      <div className="photo-lightbox-zoom-controls" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomBy(-ZOOM_STEP)} disabled={scale <= 1} aria-label="축소">−</button>
        <button type="button" onClick={() => zoomBy(ZOOM_STEP)} disabled={scale >= ZOOM_MAX - 0.001} aria-label="확대">+</button>
      </div>
    </div>
  );
}
