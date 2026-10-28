import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DeskApp } from './v2/desk-app';
import { deskRequested } from './uiRoute';
import './styles.css';
import './v2/desk.css';

const desk = deskRequested(location.search);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {desk ? <DeskApp /> : <App />}
  </React.StrictMode>,
);
