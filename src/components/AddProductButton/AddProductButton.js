import React from 'react';
import './AddProductButton.css';

function AddProductButton({ onClick }) {
  return (
    // Eliminamos el "+" de aquí. El icono se creará con CSS.
    <button className="fab" onClick={onClick} aria-label="Añadir nuevo producto"></button>
  );
}

export default AddProductButton;