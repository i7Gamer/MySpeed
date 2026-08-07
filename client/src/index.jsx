import React from 'react';
import ReactDOM from "react-dom/client";
import App from './App';

export const PROJECT_URL = "https://github.com/i7Gamer/MySpeed";

// Where the binaries and the release notes live.
export const RELEASES_URL = `${PROJECT_URL}/releases/latest`;

// Installation and update instructions live in the repository README now that
// the separate documentation site is gone. #readme is a stable GitHub anchor.
export const INSTALL_URL = `${PROJECT_URL}#readme`;

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
