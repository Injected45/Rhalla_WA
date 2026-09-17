import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { RoleProvider, useRole, type UserRole } from './hooks/useRole';
import { ErrorBoundary } from './components/ErrorBoundary';
import './App.css';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const Users = lazy(() => import('./pages/Users').then(m => ({ default: m.Users })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const Messages = lazy(() => import('./pages/Messages').then(m => ({ default: m.Messages })));
const Groups = lazy(() => import('./pages/Groups').then(m => ({ default: m.Groups })));
const Contacts = lazy(() => import('./pages/Contacts').then(m => ({ default: m.Contacts })));
const Channels = lazy(() => import('./pages/Channels').then(m => ({ default: m.Channels })));
const Status = lazy(() => import('./pages/Status').then(m => ({ default: m.Status })));
const Catalog = lazy(() => import('./pages/Catalog').then(m => ({ default: m.Catalog })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  // Initialize from localStorage to avoid setState in effect
  const savedKey = localStorage.getItem('openwa_api_key');
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedKey);
  const [, setApiKey] = useState(savedKey || '');
  const { setRole, role } = useRole();

  // POST /auth/login now returns the account's role alongside the key, so the
  // usual case needs no second round-trip; the validate call is only a fallback
  // for an older server response that omits it.
  const handleLogin = async (key: string, loginRole?: UserRole) => {
    setApiKey(key);
    localStorage.setItem('openwa_api_key', key);

    if (loginRole) {
      setRole(loginRole);
      setIsAuthenticated(true);
      return;
    }

    try {
      const response = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'X-API-Key': key },
      });
      if (response.ok) {
        const data = await response.json();
        setRole(data.role as UserRole);
      }
    } catch {
      // Default to viewer if we can't fetch role
      setRole('viewer');
    }

    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setApiKey('');
    setIsAuthenticated(false);
    setRole(null);
    localStorage.removeItem('openwa_api_key');
  };

  // Re-validate and get role on mount if already authenticated
  useEffect(() => {
    if (!savedKey) return;

    fetch('/api/auth/validate', {
      method: 'POST',
      headers: { 'X-API-Key': savedKey },
    })
      .then(res => res.json())
      .then(data => {
        if (data.valid && data.role) {
          setRole(data.role as UserRole);
        }
      })
      .catch(() => {
        // Keep existing role from localStorage if validation fails
      });
  }, [savedKey, setRole]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (!isAuthenticated) {
    return (
      <Suspense fallback={loadingFallback}>
        <Login onLogin={handleLogin} />
      </Suspense>
    );
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
          <Routes>
            <Route path="/" element={<Layout onLogout={handleLogout} userRole={role} />}>
              <Route index element={<Dashboard />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="webhooks" element={<Webhooks />} />
              <Route path="api-keys" element={<ApiKeys />} />
              {role === 'admin' && <Route path="users" element={<Users />} />}
              {role === 'admin' && <Route path="logs" element={<Logs />} />}
              <Route path="message-tester" element={<MessageTester />} />
              <Route path="messages" element={<Messages />} />
              <Route path="groups" element={<Groups />} />
              <Route path="contacts" element={<Contacts />} />
              <Route path="channels" element={<Channels />} />
              <Route path="status" element={<Status />} />
              <Route path="catalog" element={<Catalog />} />
              {role === 'admin' && <Route path="infrastructure" element={<Infrastructure />} />}
              {role === 'admin' && <Route path="plugins" element={<Plugins />} />}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
