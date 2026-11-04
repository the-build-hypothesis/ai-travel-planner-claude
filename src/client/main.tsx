import "./styles.css";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { PageLoader, ToastProvider } from "./components/ui";
import { SessionProvider } from "./lib/session";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/Home";
import { TripsPage } from "./pages/Trips";
import { LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "./pages/Auth";
import { AccountPage } from "./pages/Account";
import { NotFoundPage } from "./pages/NotFound";

const TripPage = lazy(() => import("./pages/Trip"));
const AdminApp = lazy(() => import("./admin/AdminApp"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/admin/*" element={<AdminApp />} />
            <Route
              path="*"
              element={
                <SessionProvider>
                  <AppShell>
                    <Suspense fallback={<PageLoader />}>
                      <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/trips" element={<TripsPage />} />
                        <Route path="/trips/:id" element={<TripPage />} />
                        <Route path="/login" element={<LoginPage />} />
                        <Route path="/register" element={<RegisterPage />} />
                        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                        <Route path="/reset-password" element={<ResetPasswordPage />} />
                        <Route path="/verify-email" element={<VerifyEmailPage />} />
                        <Route path="/account" element={<AccountPage />} />
                        <Route path="*" element={<NotFoundPage />} />
                      </Routes>
                    </Suspense>
                  </AppShell>
                </SessionProvider>
              }
            />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
