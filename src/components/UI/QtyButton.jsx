import React from 'react';
import './QtyButton.css';

export default function QtyButton({ onClick, disabled = false, ariaLabel, variant = 'plus' }) {
  const isPlus = variant === 'plus';
  return (
    <button
      type="button"
      className={`qty-icon btn-svg ${disabled ? 'disabled' : ''}`}
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      {isPlus ? (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      )}
    </button>
  );
}
