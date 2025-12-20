import React from 'react';
import './ProductSearchBar.css';

function ProductSearchBar({ searchTerm, onSearchChange }) {
  const handleClear = () => {
    onSearchChange('');
  }

  return (
    <div className="search-bar-container" style={{}}>
      <input
        type="search"
        id="product-search"
        name="product-search"
        placeholder="Buscar producto por nombre..."
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        aria-label="Buscar producto por nombre"
        className="search-input"
      />
      {searchTerm && (
        <button
          type="button"
          onClick={handleClear}
          className="btn btn-outline search-clear-btn"
          aria-label="Limpiar búsqueda"
        >
          {/* Ícono SVG simple para la X */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      )}
    </div>
  );
}

export default ProductSearchBar;