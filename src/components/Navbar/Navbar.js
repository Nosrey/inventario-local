// filepath: c:\Users\nosre\OneDrive\Documents\Github\Trabajo\local-software\frontend\src\components\Navbar\Navbar.js
import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import './Navbar.css';

function Navbar({ title, rightContent, onLogout }) {
    const [menuOpen, setMenuOpen] = useState(false);

    const toggleMenu = () => {
        setMenuOpen(!menuOpen);
    };

    const activeStyle = {
        '--background-color': 'var(--contrast)',
        '--color': 'var(--contrast-inverse)',
    };

    return (
        <nav className="container-fluid">
            <ul>
                <li>
                    <strong className="navbar-title">{title}</strong>
                </li>
            </ul>

            {/* Menú para escritorio */}
            <ul className="desktop-nav">
                {rightContent && <li><span className="navbar-brand">{rightContent}</span></li>}
                <li>
                    <NavLink to="/cashier" role="button" className="contrast outline" activeStyle={activeStyle}>
                        Ventas
                    </NavLink>
                </li>
                <li>
                    <NavLink to="/inventory" role="button" className="contrast outline" activeStyle={activeStyle}>
                        Inventario
                    </NavLink>
                </li>
                <li>
                    <NavLink to="/history" role="button" className="contrast outline" activeStyle={activeStyle}>
                        Historial
                    </NavLink>
                </li>
                <li>
                    <NavLink to="/settings" role="button" className="contrast outline" activeStyle={activeStyle}>
                        Configuración
                    </NavLink>
                </li>
                <li><button className="contrast outline" onClick={onLogout}>Cerrar sesión</button></li>
            </ul>

            {/* Botón de hamburguesa para móvil */}
            <div className="hamburger" onClick={toggleMenu}>
                <div className="line"></div>
                <div className="line"></div>
                <div className="line"></div>
            </div>

            {/* Menú desplegable para móvil */}
            {menuOpen && (
                <div className="mobile-nav">
                    <ul>
                        {rightContent && <li><span className="navbar-brand">{rightContent}</span></li>}
                        <li>
                            <NavLink to="/cashier" role="button" className="contrast outline" onClick={toggleMenu} activeStyle={activeStyle}>
                                Ventas
                            </NavLink>
                        </li>
                        <li>
                            <NavLink to="/inventory" role="button" className="contrast outline" onClick={toggleMenu} activeStyle={activeStyle}>
                                Inventario
                            </NavLink>
                        </li>
                        <li>
                            <NavLink to="/history" role="button" className="contrast outline" onClick={toggleMenu} activeStyle={activeStyle}>
                                Historial
                            </NavLink>
                        </li>
                        <li>
                            <NavLink to="/settings" role="button" className="contrast outline" onClick={toggleMenu} activeStyle={activeStyle}>
                                Configuración
                            </NavLink>
                        </li>
                        <li><button className="contrast outline" onClick={onLogout}>Cerrar sesión</button></li>
                    </ul>
                </div>
            )}
        </nav>
    );
}

export default Navbar;