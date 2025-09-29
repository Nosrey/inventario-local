import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { db } from '../firebase';
import { collection, doc, onSnapshot } from 'firebase/firestore';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [productsMap, setProductsMap] = useState({});   // {docId: { docId, ... }}
  const [inventories, setInventories] = useState([]);   // [{id, ...}]
  const [brands, setBrands] = useState([]);             // [{id, ...}]
  const [usersMap, setUsersMap] = useState({});        // {uid: { uid, ... }}
  const [settings, setSettings] = useState({ dolarBCV: 0, dolarParalelo: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let gotP = false, gotI = false, gotB = false, gotS = false;
    const maybeDone = () => { if (gotP && gotI && gotB && gotS) setLoading(false); };

    const unsubProducts = onSnapshot(collection(db, 'products'), (snap) => {
      setProductsMap(prev => {
        const next = { ...prev };
        snap.docChanges().forEach(c => {
          const id = c.doc.id;
          if (c.type === 'removed') delete next[id];
          else next[id] = { docId: id, ...c.doc.data() };
        });
        return next;
      });
      gotP = true; maybeDone();
    }, () => { gotP = true; maybeDone(); });

    const unsubInventories = onSnapshot(collection(db, 'inventories'), (snap) => {
      setInventories(prev => {
        const map = new Map(prev.map(i => [i.id, i]));
        snap.docChanges().forEach(c => {
          const id = c.doc.id;
          if (c.type === 'removed') map.delete(id);
          else map.set(id, { id, ...c.doc.data() });
        });
        return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
      });
      gotI = true; maybeDone();
    }, () => { gotI = true; maybeDone(); });

    const unsubBrands = onSnapshot(collection(db, 'brands'), (snap) => {
      setBrands(prev => {
        const map = new Map(prev.map(b => [b.id, b]));
        snap.docChanges().forEach(c => {
          const id = c.doc.id;
          if (c.type === 'removed') map.delete(id);
          else map.set(id, { id, ...c.doc.data() });
        });
      return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
      });
      gotB = true; maybeDone();
    }, () => { gotB = true; maybeDone(); });

    const unsubSettings = onSnapshot(doc(db, 'settings', 'main'), (snap) => {
      const data = snap.exists() ? snap.data() : {};
      setSettings({
        dolarBCV: parseFloat(data.dolarBCV) || 0,
        dolarParalelo: parseFloat(data.dolarParalelo) || 0,
      });
      gotS = true; maybeDone();
    }, () => { gotS = true; maybeDone(); });

    const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
      setUsersMap(prev => {
        const next = { ...prev };
        snap.docChanges().forEach(c => {
          const id = c.doc.id;
          if (c.type === 'removed') delete next[id];
          else next[id] = { uid: id, ...c.doc.data() };
        });
        return next;
      });
    }, () => {/* ignore users errors */});

    return () => {
      try { unsubProducts(); } catch {}
      try { unsubInventories(); } catch {}
      try { unsubBrands(); } catch {}
      try { unsubSettings(); } catch {}
      try { unsubUsers(); } catch {}
    };
  }, []);

  const products = useMemo(() => Object.values(productsMap), [productsMap]);

  const value = useMemo(() => ({
    loading,
    products,        // array
    productsMap,     // mapa por docId
    inventories,
    brands,
    settings,
    usersMap
  }), [loading, products, productsMap, inventories, brands, settings, usersMap]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}