import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DeskApp } from './v2/desk-app';
import './styles.css';
import './v2/desk.css';

const classic = new URLSearchParams(location.search).has('classic');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {classic ? <App /> : <DeskApp />}
  </React.StrictMode>,
);
