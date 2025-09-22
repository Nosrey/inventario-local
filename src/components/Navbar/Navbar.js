// filepath: c:\Users\nosre\OneDrive\Documents\Github\Trabajo\local-software\frontend\src\components\Navbar\Navbar.js
import React, { useState, useEffect } from 'react';
import { NavLink, useHistory, useLocation } from 'react-router-dom';
import './Navbar.css';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { app } from '../../firebase.js';

function Navbar({ title, rightContent, onLogout, user }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [accessLevel, setAccessLevel] = useState(1); // por defecto 1
    const history = useHistory();
    const location = useLocation();
    const db = getFirestore(app);

    useEffect(() => {
      let mounted = true;
      async function fetchAccess() {
        if (!user?.uid) {
          setAccessLevel(1);
          return;
        }
        try {
          const ud = await getDoc(doc(db, 'users', user.uid));
          if (mounted && ud.exists()) {
            const data = ud.data();
            setAccessLevel(typeof data.accessLevel === 'number' ? data.accessLevel : 1);
          } else if (mounted) {
            setAccessLevel(1);
          }
        } catch (e) {
          if (mounted) setAccessLevel(1);
        }
      }
      fetchAccess();
      return () => { mounted = false; };
    }, [user?.uid, db]);

    // Redirect if user with low accessLevel tries to visit disallowed route
    useEffect(() => {
      const allowed = ['/cashier', '/settings', '/'];
      if (accessLevel <= 1) {
        const path = location.pathname;
        if (!allowed.includes(path)) {
          history.replace('/cashier');
        }
      }
    }, [accessLevel, location.pathname, history]);

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

                {/* siempre mostrar Ventas */}
                <li>
                    <NavLink to="/cashier" role="button" className="contrast outline" activeStyle={activeStyle}>
                        Ventas
                    </NavLink>
                </li>

                {/* mostrar Inventario solo si accessLevel > 1 */}
                {accessLevel > 1 && (
                  <li>
                    <NavLink to="/inventory" role="button" className="contrast outline" activeStyle={activeStyle}>
                        Inventario
                    </NavLink>
                  </li>
                )}

                {/* mostrar Historial solo si accessLevel > 1 */}
                {accessLevel > 1 && (
                  <li>
                    <NavLink to="/history" role="button" className="contrast outline" activeStyle={activeStyle}>
                        Historial
                    </NavLink>
                  </li>
                )}

                {/* Configuración permitida para accessLevel <=1 también */}
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

                        {accessLevel > 1 && (
                          <li>
                            <NavLink to="/inventory" role="button" className="contrast outline" onClick={toggleMenu} activeStyle={activeStyle}>
                                Inventario
                            </NavLink>
                          </li>
                        )}

                        {accessLevel > 1 && (
                          <li>
                            <NavLink to="/history" role="button" className="contrast outline" onClick={toggleMenu} activeStyle={activeStyle}>
                                Historial
                            </NavLink>
                          </li>
                        )}

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