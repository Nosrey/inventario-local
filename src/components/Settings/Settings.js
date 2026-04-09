import React, { useState, useEffect, useRef } from 'react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase'; // Asegúrate de que la ruta a tu configuración de Firebase sea correcta
import './Settings.css';
import ExcelImporter from './ExcelImporter.js';

function Settings({ user }) {
    // --- Estados para los valores actuales del formulario ---
    const [username, setUsername] = useState('');
    const [appSettings, setAppSettings] = useState({
        dolarBCV: '',
        dolarParalelo: '',
        dolarMercadoNegro: ''
    });

    // --- Estados para las fechas de última edición ---
    const [lastEdited, setLastEdited] = useState({
        username: null,
        dolarBCV: null,
        dolarParalelo: null,
        dolarMercadoNegro: null
    });

    // --- Ref para almacenar los datos originales cargados ---
    const originalData = useRef({
        username: '',
        appSettings: {}
    });

    // --- Estados de UI (carga, guardado, errores, notificaciones) ---
    const [loading, setLoading] = useState(true);
    const [isSavingUser, setIsSavingUser] = useState(false);
    const [isSavingSettings, setIsSavingSettings] = useState(false);
    const [error, setError] = useState(null);
    const [notification, setNotification] = useState({ message: '', type: '' });

    // Nivel de acceso del usuario (por defecto 1)
    const [accessLevel, setAccessLevel] = useState(1);
    
    // Efecto para cargar todos los datos al iniciar
    useEffect(() => {
        const fetchData = async () => {
            if (!user) return;
            setLoading(true);
            try {
                // Cargar datos del usuario
                const userDocRef = doc(db, 'users', user.uid);
                const userDocSnap = await getDoc(userDocRef);
                if (userDocSnap.exists()) {
                    const data = userDocSnap.data();
                    setUsername(data.username || '');
                    setLastEdited(prev => ({ ...prev, username: data.usernameLastEdited?.toDate() }));
                    originalData.current.username = data.username || '';
                   // leer accessLevel (fallback a 1)
                   setAccessLevel(typeof data.accessLevel === 'number' ? data.accessLevel : 1);
                }

                // Cargar configuración de la aplicación
                const settingsDocRef = doc(db, 'settings', 'main');
                const settingsDocSnap = await getDoc(settingsDocRef);
                if (settingsDocSnap.exists()) {
                    const data = settingsDocSnap.data();
                    const newAppSettings = {
                        dolarBCV: data.dolarBCV || '',
                        dolarParalelo: data.dolarParalelo || '',
                        dolarMercadoNegro: data.dolarMercadoNegro || ''
                    };
                    setAppSettings(newAppSettings);
                    setLastEdited(prev => ({
                        ...prev,
                        dolarBCV: data.dolarBCVLastEdited?.toDate(),
                        dolarParalelo: data.dolarParaleloLastEdited?.toDate(),
                        dolarMercadoNegro: data.dolarMercadoNegroLastEdited?.toDate()
                    }));
                    originalData.current.appSettings = newAppSettings;
                }
            } catch (err) {
                console.error("Error al cargar la configuración:", err);
                setError('No se pudo cargar la configuración.');
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [user]);

    const showNotification = (message, type) => {
        setNotification({ message, type });
        setTimeout(() => setNotification({ message: '', type: '' }), 3000);
    };

    // Guardar preferencias de usuario
    const handleUserSave = async (e) => {
        e.preventDefault();
        if (username === originalData.current.username) {
            showNotification('No hay cambios para guardar en el nombre de usuario.', 'info');
            return;
        }
        setIsSavingUser(true);
        try {
            const userDocRef = doc(db, 'users', user.uid);
            await setDoc(userDocRef, {
                username,
                usernameLastEdited: serverTimestamp()
            }, { merge: true });
            originalData.current.username = username; // Actualizar el valor original
            setLastEdited(prev => ({ ...prev, username: new Date() }));
            showNotification('Nombre de usuario guardado con éxito.', 'success');
        } catch (err) {
            showNotification('Error al guardar el nombre de usuario.', 'error');
        } finally {
            setIsSavingUser(false);
        }
    };

    // Guardar configuración de la aplicación
    const handleSettingsSave = async (e) => {
        e.preventDefault();
        setIsSavingSettings(true);
        const dataToSave = {};

        // Compara cada campo y lo añade al objeto a guardar si ha cambiado
        for (const key in appSettings) {
            if (appSettings[key] !== originalData.current.appSettings[key]) {
                dataToSave[key] = appSettings[key];
                dataToSave[`${key}LastEdited`] = serverTimestamp();
            }
        }

        if (Object.keys(dataToSave).length === 0) {
            showNotification('No hay cambios para guardar en la configuración.', 'info');
            setIsSavingSettings(false);
            return;
        }

        try {
            const settingsDocRef = doc(db, 'settings', 'main');
            await setDoc(settingsDocRef, dataToSave, { merge: true });

            // Actualizar UI con las nuevas fechas y valores originales
            const newLastEdited = {};
            for (const key in appSettings) {
                if (dataToSave.hasOwnProperty(key)) {
                    newLastEdited[key] = new Date();
                }
            }
            setLastEdited(prev => ({ ...prev, ...newLastEdited }));
            originalData.current.appSettings = { ...appSettings };

            showNotification('Configuración de la aplicación guardada.', 'success');
        } catch (err) {
            showNotification('Error al guardar la configuración.', 'error');
        } finally {
            setIsSavingSettings(false);
        }
    };

    const handleSettingsChange = (e) => {
        const { name, value } = e.target;
        setAppSettings(prev => ({ ...prev, [name]: value }));
    };

    const handleImportComplete = (count) => {
        showNotification(`${count} productos importados con éxito al inventario 'Local'.`, 'success');
    };

    return (
        <section className="settings-container">
            <header>
                <h1>Configuración</h1>
                <p className="muted">Gestiona las preferencias de tu cuenta y de la aplicación.</p>
            </header>

            {loading && <article aria-busy="true">Cargando...</article>}
            {error && !loading && <article className="error-message">{error}</article>}
            {notification.message && <div className={`notification-banner ${notification.type}`}>{notification.message}</div>}

            {!loading && !error && (
                <>
                    <form onSubmit={handleUserSave}>
                        <article>
                            <hgroup>
                                <h2>Preferencias de Usuario</h2>
                                <h3>Aquí podrás cambiar tus datos personales.</h3>
                            </hgroup>
                            <label htmlFor="username">Nombre de usuario</label>
                            <input type="text" id="username" name="username" placeholder="Nombre de usuario" value={username} onChange={(e) => setUsername(e.target.value)} />
                            {lastEdited.username && <small>Última actualización: {lastEdited.username.toLocaleString()}</small>}
                            
                            <label htmlFor="email" style={{ marginTop: '1rem' }}>Correo electrónico</label>
                            <input type="email" id="email" name="email" defaultValue={user?.email || ''} disabled />
                            
                            <button type="submit" aria-busy={isSavingUser}>{isSavingUser ? 'Guardando...' : 'Guardar'}</button>
                        </article>
                    </form>

                    {/* Mostrar sección de Configuración de la Aplicación solo si accessLevel >= 3 */}
                    {accessLevel >= 3 && (
                      <form onSubmit={handleSettingsSave}>
                          <article>
                              <hgroup>
                                  <h2>Configuración de la Aplicación</h2>
                                  <h3>Define las tasas de cambio de referencia.</h3>
                              </hgroup>
                              
                              <div className="grid">
                                  <div>
                                      <label htmlFor="dolarBCV">Dólar BCV</label>
                                      <input type="number" id="dolarBCV" name="dolarBCV" placeholder="0.00" value={appSettings.dolarBCV} onChange={handleSettingsChange} step="any" />
                                      {lastEdited.dolarBCV && <small>Última actualización: {lastEdited.dolarBCV.toLocaleString()}</small>}
                                  </div>
                                  <div>
                                      <label htmlFor="dolarParalelo">Dólar Paralelo</label>
                                      <input type="number" id="dolarParalelo" name="dolarParalelo" placeholder="0.00" value={appSettings.dolarParalelo} onChange={handleSettingsChange} step="any" />
                                      {lastEdited.dolarParalelo && <small>Última actualización: {lastEdited.dolarParalelo.toLocaleString()}</small>}
                                  </div>
                                  <div>
                                      <label htmlFor="dolarMercadoNegro">Dólar Mercado Negro</label>
                                      <input type="number" id="dolarMercadoNegro" name="dolarMercadoNegro" placeholder="0.00" value={appSettings.dolarMercadoNegro} onChange={handleSettingsChange} step="any" />
                                      {lastEdited.dolarMercadoNegro && <small>Última actualización: {lastEdited.dolarMercadoNegro.toLocaleString()}</small>}
                                  </div>
                              </div>
                              
                              <button type="submit" aria-busy={isSavingSettings}>{isSavingSettings ? 'Guardando...' : 'Guardar Cambios'}</button>
                          </article>
                      </form>
                    )}

                    {/* Mostrar Importador solo si accessLevel >= 4 */}
                    {accessLevel >= 4 && (
                      <ExcelImporter onImportComplete={handleImportComplete} />
                    )}
                </>
            )}
        </section>
    );
}

export default Settings;