import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './business-ui.css';
import './ops.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
