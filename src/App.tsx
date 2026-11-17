import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiRequest, setAuthToken } from './lib/api.ts';
import type { UserProfile } from './shared/types.ts';
import { AuthPortal } from './components/AuthPortal.tsx';
import { MemberDashboard } from './components/MemberDashboard.tsx';
import { AdminDashboard } from './components/AdminDashboard.tsx';

interface ToastState {
  message: string;
  tone: 'success' | 'error';
}

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let mounted = true;
    async function bootstrap() {
      try {
        const me = await apiRequest<{ user: UserProfile }>('/api/auth/me');
        if (mounted) setUser(me.user);
      } catch {
        if (mounted) {
          setUser(null);
        }
      } finally {
        if (mounted) setInitializing(false);
      }
    }
    void bootstrap();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSignOut = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore logout transport errors and clear local session anyway
    }
    setAuthToken(null);
    setUser(null);
    notify('Signed out of SmartLib.', 'success');
  };

  if (initializing) {
    return (
      <div className="min-h-screen bg-blue-50/40 flex items-center justify-center">
        <div className="text-center">
          <p className="font-display text-xl font-semibold text-blue-900">SmartLib</p>
          <p className="text-xs text-slate-500 mt-1">Verifying session...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 max-w-sm px-4 py-3 rounded-xl border text-xs font-medium flex items-center justify-between gap-3 shadow-sm ${
            toast.tone === 'error'
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-blue-900 border-blue-800 text-white'
          }`}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
            className="opacity-75 hover:opacity-100 shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {!user ? (
        <AuthPortal onAuthenticated={(u) => setUser(u)} />
      ) : user.role === 'admin' ? (
        <AdminDashboard
          initialUser={user}
          onSignOut={() => void handleSignOut()}
          onNotify={notify}
        />
      ) : (
        <MemberDashboard
          initialUser={user}
          onSignOut={() => void handleSignOut()}
          onNotify={notify}
        />
      )}
    </>
  );
}
