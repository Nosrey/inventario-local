import React from 'react';

function ProductSearchBar({ searchTerm, onSearchChange }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <input
        type="search"
        id="product-search"
        name="product-search"
        placeholder="Buscar producto por nombre..."
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        aria-label="Buscar producto por nombre"
      />
    </div>
  );
}

export default ProductSearchBar;