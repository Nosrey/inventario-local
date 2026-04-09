import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
// import { BrowserRouter } from 'react-router-dom';
import { HashRouter } from 'react-router-dom';
import App from './components/App/App.js';
import Auth from './components/Auth/Auth.js';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp, /* ... */ getDocFromServer } from 'firebase/firestore';
import { app, db } from './firebase.js'; // usar instancia compartida con cache persistente
import { DataProvider } from './context/DataProvider.jsx';

// Añadidos: instancia de auth y claves de localStorage usadas abajo
const auth = getAuth(app);
const lsKey = 'activeInventoryId';
const lsValue = typeof window !== 'undefined' ? localStorage.getItem(lsKey) : null;

function Root() {
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState('');
  const [activeInventoryId, setActiveInventoryId] = useState(null); // NUEVO

  useEffect(() => {

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        if (lsValue) {
          setActiveInventoryId(lsValue); // Fallback inmediato
        }

        const userDocRef = doc(db, 'users', currentUser.uid);
        // FORZAR lectura desde el servidor para asegurar estado "activate" actualizado
        let userDocSnapshot;
        try {
          userDocSnapshot = await getDocFromServer(userDocRef);
        } catch (serverErr) {
          // fallback (cache / online) si getDocFromServer no está disponible o falla
          userDocSnapshot = await getDoc(userDocRef);
        }

        if (userDocSnapshot?.exists()) {
          const data = userDocSnapshot.data();
          if (data.activate === true) {
            setUser(currentUser);
            if (data.activeInventory) {
              setActiveInventoryId(data.activeInventory);
              localStorage.setItem(lsKey, data.activeInventory);
            }
          } else {
            setAuthError('Tu cuenta aún no ha sido activada por un administrador.');
            await signOut(auth);
            setUser(null);
            setActiveInventoryId(null);
          }
        } else {
          await setDoc(userDocRef, {
            activate: false,
            createdAt: new Date(),
            email: currentUser.email,
            uid: currentUser.uid,
            accessLevel: 1, // nuevo: valor por defecto
          });
          setAuthError('REGISTRATION_SUCCESS');
          await signOut(auth);
          setUser(null);
          setActiveInventoryId(null);
        }
      } else {
        setUser(null);
        setActiveInventoryId(null);
      }
      setLoadingAuth(false);
    });

    return () => unsubscribe();
  }, []);

  const handleLogout = () => {
    const auth = getAuth(app);
    signOut(auth);
  };

  if (loadingAuth) {
    return <article aria-busy="true">Verificando sesión...</article>;
  }

  return (
    <HashRouter>
      {user ? (
        <DataProvider>
          <App
            user={user}
            onLogout={handleLogout}
            initialActiveInventoryId={activeInventoryId} /* NUEVO */
          />
        </DataProvider>
      ) : (
        <Auth onAuthSuccess={() => {}} initialFeedback={authError} />
      )}
    </HashRouter>
  );
}

ReactDOM.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
  document.getElementById('root')
);