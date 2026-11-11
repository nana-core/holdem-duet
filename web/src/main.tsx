import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Poker} from './Poker';
import './poker.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Poker />
  </StrictMode>,
);
