import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders, createQueryClient } from './app';
import { registerServiceWorker } from './lib/push';
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

// Service worker for Web Push notifications (no caching); feature-checked inside.
registerServiceWorker();
