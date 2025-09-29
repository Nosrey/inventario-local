import React from 'react';
import { Switch, Route, Redirect } from 'react-router-dom';
import Inventory from '../Inventory/Inventory';
import Navbar from '../Navbar/Navbar';
import Buys from '../Buys/Buys';
import Cashier from '../Cashier/Cashier';
import Settings from '../Settings/Settings';
import History from '../History/History.js';

function App({ user, onLogout, initialActiveInventoryId }) {
  return (
    <>
      <Navbar 
        title="Inventario de Productos" 
        rightContent={user?.email}
        user={user}                        // <-- pasamos user para que Navbar lea accessLevel
        onLogout={onLogout} 
      />
      <main
        style={{          
          width: '100%',
          margin: '0 auto',
          padding: '0rem 0.5rem',
          marginTop: '4rem'
        }}
      >
        <section className="card" style={{ padding: '0rem' }}>
          <Switch>
            <Route exact path="/">
              <Redirect to="/cashier" />
            </Route>
            <Route path="/inventory">
              <Inventory user={user} />
            </Route>
            <Route path="/cashier">
              <Cashier
                user={user}
                initialActiveInventoryId={initialActiveInventoryId}
              />
            </Route>
            <Route path="/buys">
              <Buys
                user={user}
                initialActiveInventoryId={initialActiveInventoryId}
              />
            </Route>
            <Route path="/history">
              <History />
            </Route>
            <Route path="/settings">
              <Settings user={user} />
            </Route>
          </Switch>
        </section>
      </main>
    </>
  );
}

export default App;