import React, { useState, useEffect } from 'react';
import {
    getAuth,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
} from "firebase/auth";
// Ya no se necesitan las importaciones de firestore ni signOut aquí
import { app } from '../../firebase.js';

function Auth({ onAuthSuccess, initialFeedback }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isRegistering, setIsRegistering] = useState(false);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [touched, setTouched] = useState({
        email: false,
        password: false,
    });
    const [passwordError, setPasswordError] = useState(false);
    const [registrationSuccess, setRegistrationSuccess] = useState(false);

    const auth = getAuth(app);

    useEffect(() => {
        // Si index.js nos dice que el registro fue exitoso, mostramos el mensaje.
        if (initialFeedback === 'REGISTRATION_SUCCESS') {
            setRegistrationSuccess(true);
            setIsRegistering(false);
            setError('');
            setEmail('');
            setPassword('');
            setTouched({ email: false, password: false });
        } else if (initialFeedback) {
            // Si index.js nos pasa otro error (ej. cuenta no activada), lo mostramos.
            setError(initialFeedback);
            setPasswordError(true);
        }
    }, [initialFeedback]);

    const handleAuthAction = async (action) => {
        setLoading(true);
        setError('');
        setPasswordError(false);
        setRegistrationSuccess(false); // Limpiar al iniciar una nueva acción

        try {
            // Simplemente se ejecuta la acción de Firebase.
            // onAuthStateChanged en index.js se encargará del resto.
            await action();
            onAuthSuccess(); // Se puede mantener si tiene otros usos.
        } catch (err) {
            // La gestión de errores de Firebase (contraseña incorrecta, etc.) se mantiene igual.
            console.error(err);
            const errorMessage = err.code || err.message || '';
            if (errorMessage.includes('auth/weak-password')) {
                setError('La contraseña debe tener al menos 6 caracteres.');
            } else if (errorMessage.includes('auth/wrong-password')) {
                setError('La contraseña es incorrecta.');
            } else if (errorMessage.includes('auth/user-not-found')) {
                setError('No se encontró un usuario con ese correo.');
            } else if (errorMessage.includes('auth/email-already-in-use')) {
                setError('Este correo electrónico ya está en uso.');
            } else if (errorMessage.includes('auth/invalid-credential')) {
                setError('Credenciales inválidas. Por favor, verifica e inténtalo de nuevo.');
                setPasswordError(true);
            } else {
                setError('Ocurrió un error. Por favor, inténtalo de nuevo.');
            }
        } finally {
            setLoading(false);
        }
    };

    const handleBlur = (e) => {
        const { name } = e.target;
        setTouched((prev) => ({ ...prev, [name]: true }));
    };

    const handleSubmit = (e) => {
        e.preventDefault();

        const action = isRegistering
            ? () => createUserWithEmailAndPassword(auth, email, password)
            : () => signInWithEmailAndPassword(auth, email, password);
        handleAuthAction(action);
    };

    return (
        <article style={{ margin: '5% 5%' }}>
            {registrationSuccess ? (
                <div className="container" style={{ padding: '0.5rem' }}>
                    <div style={{ maxWidth: 640, margin: '0 auto' }}>
                        <section
                            role="status"
                            aria-live="polite"
                            className="card text-center"
                            style={{
                                padding: '1.5rem',
                                borderRadius: 10,
                                boxShadow: '0 8px 28px rgba(10, 10, 10, 0.06)',
                                background: 'var(--pico-color-bg)',
                                color: 'var(--pico-color-fg)'
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon" aria-hidden="true" style={{ color: 'var(--pico-color-green-500)' }}>
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                                    <polyline points="22 4 12 14.01 9 11.01"></polyline>
                                </svg>
                            </div>

                            <h2 style={{ margin: '0 0 8px', fontSize: '1.25rem', lineHeight: 1.2 }}>
                                Registro enviado
                            </h2>

                            <p style={{ margin: 0, color: 'var(--pico-color-muted)', fontSize: '0.95rem' }}>
                                Tu cuenta se creó correctamente. Un administrador revisará y activará tu cuenta en breve.
                                Recibirás una notificación cuando esté activa. Gracias por registrarte.
                            </p>

                            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <br />
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() => {
                                        setRegistrationSuccess(false);
                                        setIsRegistering(false);
                                    }}
                                    style={{ minWidth: 180 }}
                                >
                                    Volver a Inicio de Sesión
                                </button>
                            </div>
                        </section>
                    </div>
                </div>
            ) : (
                <>
                    <header>
                        <h2>{isRegistering ? 'Registro' : 'Inicio de Sesión'}</h2>
                    </header>

                    <form onSubmit={handleSubmit}>
                        <input
                            type="email"
                            name="email"
                            placeholder="Correo electrónico"
                            value={email}
                            onChange={(e) => {
                                setEmail(e.target.value);
                                setPasswordError(false);
                            }}
                            onBlur={handleBlur}
                            required
                            aria-invalid={
                                error ? "true" : (touched.email ? (email.length === 0 ? "true" : "false") : undefined)
                            }
                            className={touched.email && email.length > 0 && !error ? 'valid' : ''}
                        />
                        <input
                            type="password"
                            name="password"
                            placeholder="Contraseña"
                            value={password}
                            onChange={(e) => {
                                setPassword(e.target.value);
                                setPasswordError(false);
                                if (error && e.target.value.length >= 6) setError('');
                            }}
                            onBlur={handleBlur}
                            required
                            aria-invalid={
                                passwordError ? "true" : (touched.password ? (password.length < 6 ? "true" : "false") : undefined)
                            }
                            className={
                                passwordError ? 'invalid' : (touched.password && password.length >= 6 && !error ? 'valid' : '')
                            }
                        />
                        {touched.password && password.length < 6 && (
                            <small style={{ color: 'var(--pico-color-red-500)' }}>
                                La contraseña debe tener al menos 6 caracteres.
                            </small>
                        )}
                        {error && <small style={{ color: 'var(--pico-color-red-500)' }}>{error}</small>}
                        <button type="submit" aria-busy={loading}>
                            {isRegistering ? 'Registrarse' : 'Iniciar Sesión'}
                        </button>
                    </form>

                    <footer>
                        <button className="secondary" onClick={() => setIsRegistering(!isRegistering)}>
                            {isRegistering ? '¿Ya tienes cuenta? Inicia Sesión' : 'Crear una cuenta'}
                        </button>
                    </footer>
                </>
            )}
        </article>
    );
}

export default Auth;