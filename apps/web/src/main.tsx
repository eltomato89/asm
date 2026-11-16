import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders, createQueryClient } from './app';
import { createAppRouter } from './routes/router';
import './styles/index.css';

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
