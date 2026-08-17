import React from 'react';
import ReactDOM from "react-dom/client";
import App from './App';
import {migrateStoredPassword} from '@/common/utils/RequestUtil';

export const PROJECT_URL = "https://github.com/i7Gamer/MySpeed";

// Where the binaries and the release notes live.
export const RELEASES_URL = `${PROJECT_URL}/releases/latest`;

// Installation and update instructions live in the repository README now that
// the separate documentation site is gone. #readme is a stable GitHub anchor.
export const INSTALL_URL = `${PROJECT_URL}#readme`;

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
