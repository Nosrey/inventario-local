import React, { useRef, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import './ImageViewerModal.css';

function ImageViewerModal({ isOpen, onClose, src, alt = '' }) {
  // Hooks must be called unconditionally. We place refs/callbacks/effects
  // here and early-return later to satisfy the rules-of-hooks.
  const panelRef = useRef(null);
  const contentRef = useRef(null);
  const imgRef = useRef(null);

  const fitImage = useCallback(() => {
    const img = imgRef.current;
    const content = contentRef.current;
    const panel = panelRef.current;
    if (!img || !content || !panel) return;

    // Guard against server-side execution
    if (typeof window === 'undefined') return;

  // viewport constraints (desired content area max)
  const vw = Math.max(320, Math.min(window.innerWidth * 0.9, 1200));
  const vh = Math.max(240, Math.min(window.innerHeight * 0.85, 1200));

    const naturalW = img.naturalWidth || img.width || vw;
    const naturalH = img.naturalHeight || img.height || vh;
    if (!naturalW || !naturalH) return;

    // Reset inline styles first
    content.style.width = 'auto';
    content.style.height = 'auto';
    img.style.width = 'auto';
    img.style.height = 'auto';
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';

  // Compute available inner space by subtracting padding/borders so the image fits inside the
  // panel and its inner content without producing overflow.
  const panelStyles = window.getComputedStyle(panel);
  const contentStyles = window.getComputedStyle(content);
  const panelPadX = (parseFloat(panelStyles.paddingLeft) || 0) + (parseFloat(panelStyles.paddingRight) || 0);
  const panelPadY = (parseFloat(panelStyles.paddingTop) || 0) + (parseFloat(panelStyles.paddingBottom) || 0);
  const contentPadX = (parseFloat(contentStyles.paddingLeft) || 0) + (parseFloat(contentStyles.paddingRight) || 0);
  const contentPadY = (parseFloat(contentStyles.paddingTop) || 0) + (parseFloat(contentStyles.paddingBottom) || 0);

  const totalHorizontalSpace = panelPadX + contentPadX;
  const totalVerticalSpace = panelPadY + contentPadY + 32; // leave extra room for close button / controls

  const availableW = Math.max(48, vw - totalHorizontalSpace);
  const availableH = Math.max(48, vh - totalVerticalSpace);

  // Compute scale that ensures both width and height fit inside the available inner area
  const scaleW = availableW / naturalW;
  const scaleH = availableH / naturalH;
    // Choose the smaller scale so the image fits entirely in both dimensions.
    // Do not upscale above natural size to avoid blurring; clamp max scale to 1.
    const scale = Math.min(scaleW, scaleH, 1);

    const displayW = Math.max(1, Math.round(naturalW * scale));
    const displayH = Math.max(1, Math.round(naturalH * scale));

    // Apply explicit pixel dimensions so the image always fits and never overflows.
    img.style.width = `${displayW}px`;
    img.style.height = `${displayH}px`;
    img.style.objectFit = 'contain';

  // Size the content to the image size so centering and backdrop behave predictably.
  content.style.width = `${displayW}px`;
  content.style.height = `${displayH}px`;

  // Ensure the panel encloses the content and clips overflow so the image cannot escape
  // the rounded panel bounds. Compute panel desired width/height including paddings we measured.
  const desiredPanelW = displayW + totalHorizontalSpace;
  const desiredPanelH = displayH + totalVerticalSpace;

  panel.style.overflow = 'hidden';
  panel.style.width = `${Math.min(vw, desiredPanelW)}px`;
  panel.style.maxWidth = `${Math.min(vw, desiredPanelW)}px`;
  panel.style.maxHeight = `${Math.min(vh + 32, desiredPanelH)}px`;
  }, []);

  useEffect(() => {
    // Only attach resize listeners and schedule fits when running in the browser
    // and when the modal is actually open.
    if (typeof window === 'undefined' || !isOpen) return;

    const onResize = () => fitImage();
    window.addEventListener('resize', onResize);
    // Attempt initial fit after a short delay to allow image to load if cached
    const t = setTimeout(() => fitImage(), 20);
    return () => { clearTimeout(t); window.removeEventListener('resize', onResize); };
  }, [fitImage, isOpen]);

  const handleImgLoad = () => {
    fitImage();
  };

  // Early return guards after hooks
  if (!isOpen) return null;
  if (typeof document === 'undefined') return null;

  const modal = (
    <div className="ivm-backdrop" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose && onClose()}>
      <div className="ivm-panel" ref={panelRef} onMouseDown={(e) => e.stopPropagation()}>
        <button className="ivm-close ivm-close--large" aria-label="Cerrar" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true" focusable="false">
            <path d="M6 6 L18 18 M6 18 L18 6" stroke="currentColor" strokeWidth="3.75" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
        <div className="ivm-content" ref={contentRef}>
          <img ref={imgRef} src={src} alt={alt} onLoad={handleImgLoad} />
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(modal, document.body);
}

export default ImageViewerModal;
