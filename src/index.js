import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { BrowserRouter } from 'react-router-dom';
import App from './components/App/App.js';
import Auth from './components/Auth/Auth.js';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';
import { app } from './firebase.js';
import { DataProvider } from './context/DataProvider.jsx';

function Root() {
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState('');
  const [activeInventoryId, setActiveInventoryId] = useState(null); // NUEVO

  useEffect(() => {
    const auth = getAuth(app);
    const db = getFirestore(app);

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setAuthError('');
      if (currentUser) {
        const lsKey = `activeInventory:${currentUser.uid}`;
        const lsValue = localStorage.getItem(lsKey);
        if (lsValue) {
          setActiveInventoryId(lsValue); // Fallback inmediato
        }

        const userDocRef = doc(db, 'users', currentUser.uid);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
          const data = userDoc.data();
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
    <BrowserRouter>
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
    </BrowserRouter>
  );
}

ReactDOM.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
  document.getElementById('root')
);