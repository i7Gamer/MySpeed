import React from 'react';
import ReactDOM from "react-dom/client";
import App from './App';
import {migrateStoredPassword} from '@/common/utils/RequestUtil';

// The project URLs used to be declared here and imported back by four
// components. They live in common/utils/InvariantText.js now: this module
// mounts the app when evaluated, so nothing that wants to be loaded outside a
// browser can import from it.

// Runs before the first render so the very first request already carries the
// session, rather than bouncing the user through a password prompt on upgrade.
//
// Its failure must not stop the app. Awaited bare, a rejection here leaves this
// module never finishing evaluation, so the render below never runs and the
// page is blank with only a console message to say why. login() answers a
// refusal by returning rather than throwing, so a stale password is already
// handled - but it awaits fetch, and fetch rejects outright when the server
// cannot be reached, which is the upgrade restart this path exists for. The
// stored password is cleared either way, so the next load starts clean.
await migrateStoredPassword().catch(() => undefined);

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
