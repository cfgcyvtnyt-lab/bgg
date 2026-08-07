import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const [zoomOpen, setZoomOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // lastX/lastT: 손을 떼는 순간의 속도를 구하려고 직전 위치와 시각을 들고 간다.
  const touchRef = useRef({ startX: 0, startY: 0, horizontal: false, moved: false, dragging: false, lastX: 0, lastT: 0, vx: 0 });
  // 리스너 안에서 최신 index를 봐야 하는데, 리스너는 한 번만 붙이므로 ref로 들고 간다.
  const indexRef = useRef(0);
  const total = photos.length;
  indexRef.current = index;


  function goTo(i: number) {
    setIndex(Math.max(0, Math.min(total - 1, i)));
  }

  // 좌우 스와이프는 React의 onTouch*로는 안 된다.
  // React가 붙이는 터치 리스너는 passive라 그 안에서 preventDefault()가 무시되고,
  // 그러면 옆으로 미는 동안에도 브라우저가 세로 스크롤을 같이 해버린다.
  // 그래서 { passive: false }로 직접 붙이고, 가로로 판정되는 순간 기본 동작을 막는다.
  // (티스토리 스킨 script.js의 슬라이더와 같은 방식)
  useEffect(() => {
    const track = trackRef.current;
    const wrap = wrapRef.current;
    if (!track || !wrap || total <= 1) return;

    // ms를 주면 그 시간에 걸쳐 붙는다. 안 주면 손을 따라 즉시 움직인다.
    const apply = (dx: number, ms?: number) => {
      track.style.transition = ms == null ? "none" : `transform ${ms}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      track.style.transform = `translateX(calc(-${indexRef.current * 100}% + ${dx}px))`;
    };

    function onStart(e: globalThis.TouchEvent) {
      const x = e.touches[0].clientX;
      touchRef.current = {
        startX: x, startY: e.touches[0].clientY,
        horizontal: false, moved: false, dragging: true,
        lastX: x, lastT: e.timeStamp, vx: 0,
      };
      apply(0);
    }

    function onMove(e: globalThis.TouchEvent) {
      const t = touchRef.current;
      if (!t.dragging) return;
      const dx = e.touches[0].clientX - t.startX;
      const dy = e.touches[0].clientY - t.startY;
      if (!t.horizontal && Math.abs(dx) > Math.abs(dy)) t.horizontal = true;
      if (!t.horizontal) return;
      // 세로 스크롤이 같이 따라오는 걸 막는다. 이 한 줄이 핵심이다.
      e.preventDefault();
      if (Math.abs(dx) > 5) t.moved = true;
      // 최근 순간속도(px/ms). 직전 프레임과의 차이만 보므로 손을 뗄 때의 세기가 그대로 잡힌다.
      const dt = e.timeStamp - t.lastT;
      if (dt > 0) t.vx = (e.touches[0].clientX - t.lastX) / dt;
      t.lastX = e.touches[0].clientX;
      t.lastT = e.timeStamp;
      apply(dx);
    }

    function onEnd(e: globalThis.TouchEvent) {
      const t = touchRef.current;
      if (!t.dragging) return;
      t.dragging = false;
      if (!t.horizontal) return;

      const dx = e.changedTouches[0].clientX - t.startX;
      const width = wrap!.getBoundingClientRect().width || 1;

      // 넘길지 말지는 거리와 속도를 함께 본다. 거리만 보면 툭 튕겼을 때
      // 40px을 못 채웠다고 제자리로 돌아와 "안 먹었다"는 느낌이 든다.
      const FLICK = 0.35;            // px/ms. 이보다 빠르면 살짝만 밀어도 넘긴다
      const flicked = Math.abs(t.vx) > FLICK;
      const farEnough = Math.abs(dx) > width * 0.25;
      const goNext = (flicked || farEnough) && dx < 0 && indexRef.current < total - 1;
      const goPrev = (flicked || farEnough) && dx > 0 && indexRef.current > 0;

      // 남은 거리를 지금 속도로 가면 몇 ms인지. 느리게 놓으면 길게, 빠르게 튕기면 짧게.
      const remain = goNext || goPrev ? width - Math.abs(dx) : Math.abs(dx);
      const speed = Math.max(Math.abs(t.vx), 0.4);
      const ms = Math.max(120, Math.min(420, remain / speed));

      if (goNext || goPrev) {
        // 다음 장 자리까지 마저 밀어 붙인 뒤, 인덱스를 옮기면서 순간이동시킨다.
        const dir = goNext ? -1 : 1;
        apply(dir * width, ms);
        window.setTimeout(() => {
          goTo(indexRef.current + (goNext ? 1 : -1));
        }, ms);
      } else {
        apply(0, ms);
      }
    }

    // 트랙이 아니라 바깥 상자에 붙인다. 트랙에는 touch-action: pan-y가 걸려 있어서,
    // 사파리는 그 요소 위에서 시작한 제스처를 세로 스크롤로 먼저 확정해버린다.
    // 그 뒤엔 preventDefault를 불러도 되돌릴 수 없다. (티스토리 스킨도 wrapper에 붙였다)
    wrap.addEventListener("touchstart", onStart, { passive: false });
    wrap.addEventListener("touchmove", onMove, { passive: false });
    wrap.addEventListener("touchend", onEnd);
    wrap.addEventListener("touchcancel", onEnd);
    return () => {
      wrap.removeEventListener("touchstart", onStart);
      wrap.removeEventListener("touchmove", onMove);
      wrap.removeEventListener("touchend", onEnd);
      wrap.removeEventListener("touchcancel", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  function onSlideClick() {
    if (touchRef.current.moved) {
      touchRef.current.moved = false;
      return;
    }
    setZoomOpen(true);
  }

  return (
    <div className="photo-slider" ref={wrapRef}>
      <div
        ref={trackRef}
        className="photo-slider-track"
        style={{ transform: `translateX(-${index * 100}%)` }}
      >
        {/* 지금 보는 것과 좌우 한 장씩만 실제로 받는다. loading="lazy"는 이 구조에서
            믿을 수 없다 - 슬라이드가 transform으로 밀려 있을 뿐 레이아웃상 화면 안이라
            브라우저에 따라 전부 받아버린다. 피드는 판 20개를 한 번에 뿌리므로
            판마다 5장이면 100장(20MB)이 한꺼번에 날아온다. */}
        {photos.map((p, i) => {
          const near = Math.abs(i - index) <= 1;
          return (
            <div className="photo-slider-slide" key={p.id} onClick={onSlideClick}>
              {near && (
                <img decoding="async" src={api.photoUrl(p.filename)} alt={p.caption || "플레이 사진"} draggable={false} />
              )}
            </div>
          );
        })}
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

      {/* 라이트박스는 body 밑으로 빼서 그린다.
          카드에 content-visibility를 걸면 contain: paint가 같이 걸리는데, 그러면 그 카드가
          position: fixed의 기준점이 돼서 전체 화면을 덮어야 할 라이트박스가 카드 안에 갇힌다.
          어차피 화면 전체를 덮는 물건이라 카드 안에 있을 이유도 없다. */}
      {zoomOpen && createPortal(
        <PhotoLightbox
          photos={photos}
          index={index}
          onIndexChange={goTo}
          onClose={() => setZoomOpen(false)}
        />,
        document.body
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
  // 확대·이동 값은 제스처 중에 초당 수십 번 바뀐다. 이걸 state로 두면 매 이벤트마다
  // 리렌더가 돌아 손가락이 끊긴다. 그래서 진행 중에는 ref에만 쌓고 캐시해둔 img 엘리먼트에
  // transform을 직접 쓰되, rAF로 묶어 한 프레임에 한 번만 반영한다.
  // (기존 티스토리 스킨 script.js의 applyZoomTransform과 같은 방식)
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const rafPending = useRef(false);
  // 버튼 활성/비활성과 확대 커서만 리렌더가 필요하다. 값 자체가 아니라 "1배냐 아니냐"만 본다.
  const [zoomed, setZoomed] = useState(false);

  // pointers: 지금 화면에 닿아 있는 손가락 수. 이게 바뀌는 순간 기준점을 다시 잡아야 한다.
  const gesture = useRef({ startX: 0, startY: 0, initialDist: 0, moved: false, mouseDragging: false, pointers: 0 });

  function applyTransform() {
    rafPending.current = false;
    const el = imgRef.current;
    if (!el) return;
    const v = view.current;
    el.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  }

  // 손가락·마우스를 따라가는 동안에는 CSS transition을 꺼야 한다.
  // 켜둔 채로 매 프레임 새 위치를 주면 브라우저가 그때마다 0.15초짜리 애니메이션을
  // 새로 시작해서, 이미지가 항상 한 박자 뒤처져 따라온다.
  // 버튼으로 확대·축소할 때는 켜둬야 부드러우므로 제스처 시작·종료에만 토글한다.
  function setDragging(on: boolean) {
    const el = imgRef.current;
    if (!el) return;
    el.style.transition = on ? "none" : "";
  }

  function schedule() {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(applyTransform);
  }

  function setView(next: Partial<{ scale: number; x: number; y: number }>) {
    const v = view.current;
    if (next.scale !== undefined) v.scale = Math.min(Math.max(1, next.scale), ZOOM_MAX);
    if (next.x !== undefined) v.x = next.x;
    if (next.y !== undefined) v.y = next.y;
    if (v.scale <= 1) { v.x = 0; v.y = 0; }
    schedule();
    const z = v.scale > 1;
    setZoomed((cur) => (cur === z ? cur : z));
  }

  function reset() {
    view.current = { scale: 1, x: 0, y: 0 };
    schedule();
    setZoomed(false);
  }

  // 좌우로 사진을 넘기면 확대 상태를 초기화한다
  useEffect(() => { reset(); }, [index]);

  // 열려 있는 동안 뒤 화면이 스크롤되지 않게 잠근다(Modal과 같은 방식).
  useEffect(() => {
    const pane = document.querySelector<HTMLElement>(".app-pane.active");
    const prev = pane?.style.overflowY ?? "";
    if (pane) pane.style.overflowY = "hidden";
    return () => { if (pane) pane.style.overflowY = prev; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Esc") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function zoomBy(delta: number) {
    setView({ scale: view.current.scale + delta });
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  function pinchDist(e: TouchEvent) {
    return Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY,
    );
  }

  // 손가락 수가 바뀌면 그 시점의 손 위치와 현재 사진 위치로 기준을 다시 잡는다.
  // 이걸 안 하면 두 손가락 확대 중 하나를 먼저 뗄 때, 남은 손가락을 처음 짚었던 자리
  // 기준으로 계산해서 사진이 그 차이만큼 한쪽으로 확 튄다.
  function anchor(e: TouchEvent) {
    const g = gesture.current;
    g.pointers = e.touches.length;
    if (e.touches.length === 1) {
      g.startX = e.touches[0].clientX - view.current.x;
      g.startY = e.touches[0].clientY - view.current.y;
    } else if (e.touches.length === 2) {
      g.initialDist = pinchDist(e);
    }
  }

  function onTouchStart(e: TouchEvent) {
    gesture.current.moved = false;
    setDragging(true);
    anchor(e);
  }

  function onTouchMove(e: TouchEvent) {
    const g = gesture.current;
    // 손가락이 늘거나 줄었으면 이번 프레임은 기준만 다시 잡고 넘어간다
    if (e.touches.length !== g.pointers) {
      anchor(e);
      return;
    }
    if (e.touches.length === 2) {
      g.moved = true;
      const dist = pinchDist(e);
      const ratio = dist / g.initialDist;
      g.initialDist = dist;
      setView({ scale: view.current.scale * ratio });
    } else if (e.touches.length === 1 && view.current.scale > 1) {
      g.moved = true;
      setView({ x: e.touches[0].clientX - g.startX, y: e.touches[0].clientY - g.startY });
    }
  }

  // 손을 떼면 transition을 되살린다. 안 그러면 이후 버튼 확대·축소가 뚝뚝 끊긴다.
  function onZoomTouchEnd(e: TouchEvent) {
    // 손가락이 아직 남아 있으면 제스처가 끝난 게 아니다. 기준만 다시 잡고 이어간다.
    if (e.touches.length > 0) {
      anchor(e);
      return;
    }
    gesture.current.pointers = 0;
    setDragging(false);
  }

  function onMouseDown(e: MouseEvent) {
    const g = gesture.current;
    // 확대 전이라 끌 게 없어도 "이번엔 안 끌었다"는 표시는 남겨야 탭으로 닫힌다
    g.moved = false;
    if (view.current.scale <= 1) return;
    g.mouseDragging = true;
    setDragging(true);
    g.startX = e.clientX - view.current.x;
    g.startY = e.clientY - view.current.y;
  }

  // 리스너는 한 번만 붙인다. 예전엔 pos를 의존성에 넣어 마우스를 움직일 때마다
  // 리스너를 떼었다 다시 붙이고 있었다.
  useEffect(() => {
    function onMove(e: globalThis.MouseEvent) {
      const g = gesture.current;
      if (!g.mouseDragging) return;
      const nx = e.clientX - g.startX;
      const ny = e.clientY - g.startY;
      if (Math.abs(nx - view.current.x) > 3 || Math.abs(ny - view.current.y) > 3) g.moved = true;
      setView({ x: nx, y: ny });
    }
    function onUp() {
      if (!gesture.current.mouseDragging) return;
      gesture.current.mouseDragging = false;
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function onBackgroundClick() {
    if (gesture.current.moved) {
      gesture.current.moved = false;
      return;
    }
    onClose();
  }

  // 사진 자체를 눌러도 닫는다. ✕까지 찾아가지 않아도 되고, 확대한 상태에서도 마찬가지다.
  // 다만 끌어서 옮기거나 핀치로 확대한 직후의 클릭은 닫으면 안 된다 - 그건 조작이지 탭이 아니다.
  function onImageClick(e: MouseEvent) {
    e.stopPropagation();
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

      <img decoding="async"
        ref={imgRef}
        className={`photo-lightbox-img${zoomed ? " is-zoomed" : ""}`}
        src={api.photoUrl(photo.filename)}
        alt={photo.caption || "플레이 사진"}
        draggable={false}
        onClick={onImageClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onZoomTouchEnd}
        onTouchCancel={onZoomTouchEnd}
        onMouseDown={onMouseDown}
        onWheel={onWheel}
      />

      <div className="photo-lightbox-zoom-controls" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomBy(-ZOOM_STEP)} disabled={!zoomed} aria-label="축소">−</button>
        <button type="button" onClick={() => zoomBy(ZOOM_STEP)} aria-label="확대">+</button>
      </div>
    </div>
  );
}
