import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, BookOpen, ShieldCheck, UserCheck } from 'lucide-react';
import { apiRequest, setAuthToken } from '../lib/api.ts';
import type { UserProfile } from '../shared/types.ts';

interface AuthPortalProps {
  onAuthenticated: (user: UserProfile) => void;
}

type AuthMode = 'member-login' | 'admin-login' | 'register';

export function AuthPortal({ onAuthenticated }: AuthPortalProps) {
  const [mode, setMode] = useState<AuthMode>('member-login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'register') {
        const res = await apiRequest<{ token: string; user: UserProfile }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, name, password, department }),
        });
        setAuthToken(res.token);
        onAuthenticated(res.user);
      } else {
        const portalRole = mode === 'admin-login' ? 'admin' : 'member';
        const res = await apiRequest<{ token: string; user: UserProfile }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password, portalRole }),
        });
        setAuthToken(res.token);
        onAuthenticated(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const quickSignIn = async (
    targetMode: 'member-login' | 'admin-login',
    demoEmail: string,
    demoPassword: string
  ) => {
    setMode(targetMode);
    setEmail(demoEmail);
    setPassword(demoPassword);
    setError(null);
    setSubmitting(true);
    try {
      const portalRole = targetMode === 'admin-login' ? 'admin' : 'member';
      const res = await apiRequest<{ token: string; user: UserProfile }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: demoEmail, password: demoPassword, portalRole }),
      });
      setAuthToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Demo sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 via-white to-blue-50/40 text-slate-900 flex flex-col items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md bg-white border border-blue-100 rounded-2xl p-7 sm:p-8 shadow-xs">
        {/* Clean Brand Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-blue-700 text-white mb-3">
            <BookOpen className="w-5 h-5" />
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-blue-950">
            SmartLib
          </h1>
          <p className="text-xs text-slate-500 mt-1">Sign in to access your library account</p>
        </div>

        {/* Role Mode Switch */}
        <div className="grid grid-cols-3 p-1 bg-blue-50 rounded-lg mb-6">
          <button
            type="button"
            onClick={() => switchMode('member-login')}
            className={`py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              mode === 'member-login'
                ? 'bg-white text-blue-900 shadow-xs'
                : 'text-slate-600 hover:text-blue-900'
            }`}
          >
            Member
          </button>
          <button
            type="button"
            onClick={() => switchMode('admin-login')}
            className={`py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              mode === 'admin-login'
                ? 'bg-white text-blue-900 shadow-xs'
                : 'text-slate-600 hover:text-blue-900'
            }`}
          >
            Admin
          </button>
          <button
            type="button"
            onClick={() => switchMode('register')}
            className={`py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              mode === 'register'
                ? 'bg-white text-blue-900 shadow-xs'
                : 'text-slate-600 hover:text-blue-900'
            }`}
          >
            Register
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 px-3.5 py-2.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <>
              <div>
                <label htmlFor="reg-name" className="block text-xs font-medium text-slate-700 mb-1">
                  Full Name
                </label>
                <input
                  id="reg-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Priya Iyer"
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
                />
              </div>
              <div>
                <label htmlFor="reg-dept" className="block text-xs font-medium text-slate-700 mb-1">
                  Department / Course
                </label>
                <input
                  id="reg-dept"
                  type="text"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="B.Tech CSE"
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
                />
              </div>
            </>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700 mb-1">
              Email
            </label>
            <input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={
                mode === 'admin-login' ? 'arvind.kulkarni@smartlib.in' : 'ananya.sharma@smartlib.in'
              }
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            />
          </div>

          <div>
            <label
              htmlFor="auth-password"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              required
              minLength={mode === 'register' ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'Minimum 8 characters' : 'Enter password'}
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
          >
            <span>
              {submitting
                ? 'Signing in...'
                : mode === 'admin-login'
                  ? 'Sign In as Admin'
                  : mode === 'register'
                    ? 'Create Member Account'
                    : 'Sign In'}
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        {/* Compact Demo Shortcuts */}
        <div className="mt-6 pt-5 border-t border-blue-100 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            disabled={submitting}
            onClick={() =>
              void quickSignIn('member-login', 'ananya.sharma@smartlib.in', 'MemberPass!2026')
            }
            className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-900 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <UserCheck className="w-3.5 h-3.5 text-blue-700 shrink-0" />
            <span>Demo Member</span>
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() =>
              void quickSignIn(
                'admin-login',
                'arvind.kulkarni@smartlib.in',
                'LibrarianAdmin!2026'
              )
            }
            className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-900 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-blue-700 shrink-0" />
            <span>Demo Admin</span>
          </button>
        </div>
      </div>
    </div>
  );
}
