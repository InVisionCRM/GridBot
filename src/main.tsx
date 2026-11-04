import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DeskApp } from './v2/desk-app';
import { deskRequested } from './uiRoute';
import { ConfirmHost } from './ui/Confirm';
import { installSpotlight } from './ui/spotlight';
import './styles.css';
import './v2/desk.css';

const desk = deskRequested(location.search);
installSpotlight();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {desk ? <DeskApp /> : <App />}
    <ConfirmHost />
  </React.StrictMode>,
);
