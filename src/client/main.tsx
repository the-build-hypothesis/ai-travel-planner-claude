import '@fontsource-variable/fraunces';
import '@fontsource-variable/inter';
import './styles.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth';
import { Shell } from './components/Shell';
import { AccountPage } from './pages/Account';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './pages/AuthPages';
import { ExplorePage } from './pages/Explore';
import { LandingPage } from './pages/Landing';
import { NotFoundPage } from './pages/NotFound';
import { TripsPage } from './pages/Trips';
import { Spinner, ToastProvider } from './ui';

const WorkspacePage = lazy(() => import('./pages/Workspace'));
// The admin console is a separate chunk, so ordinary visitors never download it.
const AdminApp = lazy(() => import('./admin/AdminApp'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/admin/*" element={<AdminApp />} />
            <Route
              path="/trips/:id"
              element={
                <AuthProvider>
                  <WorkspacePage />
                </AuthProvider>
              }
            />
            <Route
              element={
                <AuthProvider>
                  <Shell />
                </AuthProvider>
              }
            >
              <Route index element={<LandingPage />} />
              <Route path="trips" element={<TripsPage />} />
              <Route path="explore" element={<ExplorePage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="forgot-password" element={<ForgotPasswordPage />} />
              <Route path="reset-password" element={<ResetPasswordPage />} />
              <Route path="verify-email" element={<VerifyEmailPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
