import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Clock,
  CreditCard,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { apiRequest, formatCurrency, formatShortDate } from '../lib/api.ts';
import type { BookRecord, LoanRecord, UserProfile } from '../shared/types.ts';
import { BookCover } from './BookCover.tsx';

interface MemberDashboardProps {
  initialUser: UserProfile;
  onSignOut: () => void;
  onNotify: (message: string, tone?: 'success' | 'error') => void;
}

type MemberTab = 'catalog' | 'loans' | 'history';

interface MemberDashboardPayload {
  profile: UserProfile;
  loans: LoanRecord[];
  books: BookRecord[];
}

export function MemberDashboard({
  initialUser,
  onSignOut,
  onNotify,
}: MemberDashboardProps) {
  const [activeTab, setActiveTab] = useState<MemberTab>('catalog');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [profile, setProfile] = useState<UserProfile>(initialUser);
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [loans, setLoans] = useState<LoanRecord[]>([]);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [inspectedBook, setInspectedBook] = useState<BookRecord | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await apiRequest<MemberDashboardPayload>('/api/member/dashboard');
      setProfile(data.profile);
      setBooks(data.books);
      setLoans(data.loans);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to refresh member data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const activeLoans = useMemo(() => loans.filter((l) => l.status === 'active'), [loans]);
  const pastLoans = useMemo(() => loans.filter((l) => l.status !== 'active'), [loans]);
  const overdueLoans = useMemo(() => activeLoans.filter((l) => l.isOverdue), [activeLoans]);

  const categories = useMemo(() => {
    const set = new Set<string>(['All']);
    for (const b of books) set.add(b.category);
    return Array.from(set);
  }, [books]);

  const filteredBooks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return books.filter((b) => {
      if (b.availableCopies <= 0) return false;
      if (selectedCategory !== 'All' && b.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        b.author.toLowerCase().includes(q) ||
        b.isbn.toLowerCase().includes(q) ||
        b.callNumber.toLowerCase().includes(q)
      );
    });
  }, [books, selectedCategory, searchQuery]);

  const handleBorrow = async (book: BookRecord) => {
    setBusyKey(`borrow-${book.id}`);
    try {
      const res = await apiRequest<{ loanId: number; dueDate: string }>('/api/member/borrow', {
        method: 'POST',
        body: JSON.stringify({ bookId: book.id }),
      });
      onNotify(`Checked out "${book.title}". Due ${formatShortDate(res.dueDate)}.`, 'success');
      setInspectedBook(null);
      await loadData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to borrow title.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRenew = async (loan: LoanRecord) => {
    setBusyKey(`renew-${loan.id}`);
    try {
      const res = await apiRequest<{ newDueDate: string }>(`/api/member/loans/${loan.id}/renew`, {
        method: 'POST',
      });
      onNotify(`Renewed "${loan.bookTitle}" until ${formatShortDate(res.newDueDate)}.`, 'success');
      await loadData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to renew loan.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleReturn = async (loan: LoanRecord) => {
    setBusyKey(`return-${loan.id}`);
    try {
      const res = await apiRequest<{
        fineCents: number;
        autoFulfilledHold: boolean;
      }>(`/api/member/loans/${loan.id}/return`, { method: 'POST' });
      const extra = res.autoFulfilledHold
        ? ' Next waitlist patron was automatically assigned.'
        : '';
      onNotify(`Returned "${loan.bookTitle}".${extra}`, 'success');
      await loadData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to return book.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleOpenBook = (book: BookRecord) => {
    setInspectedBook(book);
  };

  const navItems: Array<{ id: MemberTab; label: string; count?: number; icon: typeof BookOpen }> = [
    { id: 'catalog', label: 'Available Books', count: books.length, icon: BookOpen },
    { id: 'loans', label: 'My Active Loans', count: activeLoans.length, icon: Clock },
    { id: 'history', label: 'Card & History', icon: CreditCard },
  ];

  const currentTabLabel = navItems.find((i) => i.id === activeTab)?.label || 'Available Books';

  return (
    <div className="min-h-screen bg-blue-50/35 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 bg-white border-r border-blue-100 shrink-0">
        <div className="h-16 px-6 flex items-center border-b border-blue-100">
          <span className="font-display text-xl font-semibold tracking-tight text-blue-900 whitespace-nowrap">
            SmartLib
          </span>
        </div>

        <div className="px-6 py-4 border-b border-blue-50">
          <p className="text-xs font-medium text-blue-700">Member · View &amp; Borrow Only</p>
          <p className="text-sm font-semibold text-slate-900 mt-0.5 truncate">{profile.name}</p>
          <p className="font-mono text-xs text-slate-500 mt-0.5 tabular-nums">
            {profile.cardNumber}
          </p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                  active
                    ? 'bg-blue-50 text-blue-800'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {typeof item.count === 'number' && (
                  <span className="font-mono text-xs tabular-nums text-slate-500">
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-blue-100">
          <div className="mb-3 px-2 text-xs text-slate-500">
            <div className="flex items-center justify-between">
              <span>Loan Quota</span>
              <span className="font-mono tabular-nums text-slate-800 font-medium">
                {activeLoans.length} / {profile.maxLoans}
              </span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span>Outstanding Fees</span>
              <span className="font-mono tabular-nums text-slate-800 font-medium">
                {formatCurrency(profile.totalFinesCents || 0)}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200/80 rounded-lg transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Contextual Top Header */}
        <header className="sticky top-0 z-20 h-16 bg-white border-b border-blue-100 px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
                Member Portal
              </span>
              <span className="text-slate-300 hidden sm:inline">/</span>
              <h1 className="font-semibold text-slate-900 truncate">{currentTabLabel}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => void loadData()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Sync Shelves</span>
            </button>
          </div>
        </header>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-40 lg:hidden flex">
            <div
              className="fixed inset-0 bg-slate-950/40"
              onClick={() => setMobileMenuOpen(false)}
            />
            <div className="relative w-72 max-w-[85vw] bg-white h-full flex flex-col justify-between p-4 z-10 border-r border-blue-100">
              <div>
                <div className="flex items-center justify-between pb-4 border-b border-blue-100">
                  <span className="font-display text-lg font-semibold text-blue-900">
                    SmartLib
                  </span>
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(false)}
                    aria-label="Close navigation menu"
                    className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <nav className="mt-4 space-y-1">
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setActiveTab(item.id);
                          setMobileMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg ${
                          activeTab === item.id
                            ? 'bg-blue-50 text-blue-800'
                            : 'text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <Icon className="w-4 h-4" />
                          <span>{item.label}</span>
                        </span>
                        {typeof item.count === 'number' && (
                          <span className="font-mono text-xs tabular-nums">{item.count}</span>
                        )}
                      </button>
                    );
                  })}
                </nav>
              </div>
              <button
                type="button"
                onClick={onSignOut}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-6xl w-full mx-auto">
          {profile.status === 'suspended' && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
              Your borrowing privileges are currently suspended. Please contact the Circulation Desk
              to restore access.
            </div>
          )}

          {overdueLoans.length > 0 && activeTab !== 'loans' && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-sm text-amber-900">
                You have <span className="font-semibold tabular-nums">{overdueLoans.length}</span>{' '}
                overdue title(s) accruing ₹10.00/day late fees.
              </p>
              <button
                type="button"
                onClick={() => setActiveTab('loans')}
                className="text-xs font-semibold text-amber-900 underline underline-offset-4 whitespace-nowrap self-start sm:self-auto cursor-pointer"
              >
                Review overdue loans
              </button>
            </div>
          )}

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  className="h-44 bg-white border border-blue-100 rounded-xl animate-pulse"
                />
              ))}
            </div>
          ) : activeTab === 'catalog' ? (
            <section>
              {/* Search & Available Holdings Note */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 text-blue-600 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search available books by title, author, ISBN..."
                    className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-blue-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
                  />
                </div>

                <p className="text-xs text-slate-600 tabular-nums">
                  Showing <span className="font-semibold text-blue-900">{filteredBooks.length}</span>{' '}
                  currently available book(s) on shelf
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 mb-6">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      selectedCategory === cat
                        ? 'bg-blue-700 text-white'
                        : 'bg-white border border-blue-100 text-slate-600 hover:text-blue-900'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {filteredBooks.length === 0 ? (
                <div className="bg-white border border-blue-100 rounded-xl p-12 text-center">
                  <p className="text-sm font-medium text-slate-900">
                    No available books match your current search.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedCategory('All');
                    }}
                    className="mt-3 px-4 py-2 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer"
                  >
                    Reset Search Filters
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {filteredBooks.map((book) => {
                    const isBorrowedByUser = Boolean(book.userLoanId);
                    const isBorrowBusy = busyKey === `borrow-${book.id}`;

                    return (
                      <article
                        key={book.id}
                        className="bg-white border border-blue-100 rounded-xl p-5 flex gap-4 hover:border-blue-300 transition-colors"
                      >
                        <button
                          type="button"
                          onClick={() => handleOpenBook(book)}
                          className="shrink-0 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-700 rounded-lg"
                        >
                          <BookCover
                            src={book.coverUrl}
                            title={book.title}
                            author={book.author}
                            className="w-24 h-34 rounded-lg"
                          />
                        </button>

                        <div className="flex-1 min-w-0 flex flex-col justify-between">
                          <div>
                            <p className="text-xs text-blue-700 font-medium truncate">
                              {book.category} · {book.publicationYear}
                            </p>
                            <button
                              type="button"
                              onClick={() => handleOpenBook(book)}
                              className="text-left mt-1 cursor-pointer group"
                            >
                              <h2 className="font-display text-base font-semibold text-slate-900 group-hover:text-blue-700 leading-snug line-clamp-2 transition-colors">
                                {book.title}
                              </h2>
                            </button>
                            <p className="text-xs text-slate-600 mt-1 truncate">{book.author}</p>
                            <p className="font-mono text-[11px] text-slate-400 mt-1 truncate">
                              {book.callNumber} · {book.shelfLocation}
                            </p>
                          </div>

                          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
                            <span className="font-mono text-xs font-medium tabular-nums text-emerald-700">
                              {book.availableCopies} available on shelf
                            </span>

                            {isBorrowedByUser ? (
                              <button
                                type="button"
                                onClick={() => setActiveTab('loans')}
                                className="px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                Checked Out
                              </button>
                            ) : (
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleOpenBook(book)}
                                  className="px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                                >
                                  Details
                                </button>
                                <button
                                  type="button"
                                  disabled={isBorrowBusy || profile.status === 'suspended'}
                                  onClick={() => void handleBorrow(book)}
                                  className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                                >
                                  {isBorrowBusy ? 'Borrowing...' : 'Borrow Book'}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : activeTab === 'loans' ? (
            <section className="space-y-4">
              {activeLoans.length === 0 ? (
                <div className="bg-white border border-blue-100 rounded-xl p-12 text-center">
                  <p className="text-sm font-medium text-slate-900">
                    You have no active loans right now.
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Browse available books to borrow up to {profile.maxLoans} concurrent titles.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('catalog')}
                    className="mt-4 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
                  >
                    View Available Books
                  </button>
                </div>
              ) : (
                <div className="bg-white border border-blue-100 rounded-xl divide-y divide-blue-50">
                  {activeLoans.map((loan) => {
                    const renewDisabled =
                      busyKey === `renew-${loan.id}` ||
                      loan.renewalsCount >= 2 ||
                      loan.hasWaitingHolds;
                    const returnBusy = busyKey === `return-${loan.id}`;

                    return (
                      <div
                        key={loan.id}
                        className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
                      >
                        <div className="flex items-start gap-4 min-w-0">
                          <BookCover
                            src={loan.bookCoverUrl}
                            title={loan.bookTitle}
                            author={loan.bookAuthor}
                            className="w-16 h-22 rounded-md shrink-0"
                          />
                          <div className="min-w-0">
                            <h3 className="font-display text-base font-semibold text-slate-900 leading-snug">
                              {loan.bookTitle}
                            </h3>
                            <p className="text-xs text-slate-600 mt-0.5">
                              {loan.bookAuthor} ·{' '}
                              <span className="font-mono">{loan.bookCallNumber}</span>
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                              <span className="text-slate-500 tabular-nums">
                                Borrowed {formatShortDate(loan.checkedOutAt)}
                              </span>
                              <span className="text-slate-300">·</span>
                              <span className="font-mono text-slate-700 tabular-nums">
                                Due {formatShortDate(loan.dueDate)}
                              </span>
                              <span className="text-slate-300">·</span>
                              {loan.isOverdue ? (
                                <span className="font-medium text-red-600 tabular-nums">
                                  Overdue by {loan.daysOverdue}d (
                                  {formatCurrency(loan.computedFineCents)})
                                </span>
                              ) : loan.daysRemaining <= 3 ? (
                                <span className="font-medium text-amber-700 tabular-nums">
                                  Due soon ({loan.daysRemaining}d left)
                                </span>
                              ) : (
                                <span className="font-medium text-emerald-700 tabular-nums">
                                  On time ({loan.daysRemaining}d left)
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2.5 shrink-0">
                          <button
                            type="button"
                            disabled={renewDisabled}
                            onClick={() => void handleRenew(loan)}
                            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-45 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                          >
                            {busyKey === `renew-${loan.id}`
                              ? 'Renewing...'
                              : `Renew +7d (${loan.renewalsCount}/2)`}
                          </button>
                          <button
                            type="button"
                            disabled={returnBusy}
                            onClick={() => void handleReturn(loan)}
                            className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                          >
                            {returnBusy ? 'Returning...' : 'Return Book'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : (
            <section className="space-y-6">
              {/* Library Card Summary */}
              <div className="bg-white border border-blue-100 rounded-xl p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                <div>
                  <p className="text-xs text-slate-500">SmartLib Card Number</p>
                  <p className="font-mono text-lg font-semibold text-blue-950 mt-1 tabular-nums">
                    {profile.cardNumber}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">{profile.department}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Account Standing</p>
                  <p
                    className={`text-lg font-semibold mt-1 capitalize ${
                      profile.status === 'active' ? 'text-emerald-700' : 'text-red-600'
                    }`}
                  >
                    {profile.status}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Member since {formatShortDate(profile.createdAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Active Borrowing Quota</p>
                  <p className="font-mono text-lg font-semibold text-slate-900 mt-1 tabular-nums">
                    {activeLoans.length} / {profile.maxLoans}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">14-day circulation term</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Assessed Unpaid Fees</p>
                  <p className="font-mono text-lg font-semibold text-slate-900 mt-1 tabular-nums">
                    {formatCurrency(profile.totalFinesCents || 0)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">₹10.00/day overdue rate</p>
                </div>
              </div>

              {/* Past Loans Table */}
              <div className="bg-white border border-blue-100 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-blue-100">
                  <h2 className="text-sm font-semibold text-slate-900">Circulation History</h2>
                </div>
                {pastLoans.length === 0 ? (
                  <p className="p-8 text-center text-xs text-slate-500">
                    No completed or archived loans recorded yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-blue-50/50 text-slate-500 border-b border-blue-100">
                        <tr>
                          <th className="px-6 py-3 font-medium">Title</th>
                          <th className="px-4 py-3 font-medium">Checked Out</th>
                          <th className="px-4 py-3 font-medium">Returned</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                          <th className="px-6 py-3 font-medium text-right">Fee</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {pastLoans.map((l) => (
                          <tr key={l.id} className="hover:bg-blue-50/30">
                            <td className="px-6 py-3.5">
                              <p className="font-medium text-slate-900">{l.bookTitle}</p>
                              <p className="text-slate-500">{l.bookAuthor}</p>
                            </td>
                            <td className="px-4 py-3.5 font-mono tabular-nums text-slate-600">
                              {formatShortDate(l.checkedOutAt)}
                            </td>
                            <td className="px-4 py-3.5 font-mono tabular-nums text-slate-600">
                              {l.returnedAt ? formatShortDate(l.returnedAt) : '—'}
                            </td>
                            <td className="px-4 py-3.5 capitalize text-slate-700">{l.status}</td>
                            <td className="px-6 py-3.5 text-right font-mono tabular-nums text-slate-700">
                              {l.fineCents > 0
                                ? `${formatCurrency(l.fineCents)} ${l.finePaid ? '(Paid/Waived)' : '(Due)'}`
                                : '₹0.00'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          )}
        </main>
      </div>

      {/* Book Detail Modal */}
      {inspectedBook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50">
          <div className="bg-white border border-blue-100 rounded-xl max-w-2xl w-full p-6 relative max-h-[90vh] overflow-y-auto">
            <button
              type="button"
              onClick={() => setInspectedBook(null)}
              aria-label="Close book details"
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-800 rounded-lg hover:bg-slate-100 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex flex-col sm:flex-row gap-6">
              <BookCover
                src={inspectedBook.coverUrl}
                title={inspectedBook.title}
                author={inspectedBook.author}
                className="w-36 h-48 rounded-lg shrink-0 mx-auto sm:mx-0"
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-blue-700 font-medium">
                  {inspectedBook.category} · {inspectedBook.publicationYear}
                </p>
                <h2 className="font-display text-xl font-semibold text-slate-900 mt-1">
                  {inspectedBook.title}
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  by {inspectedBook.author} · {inspectedBook.publisher}
                </p>

                <p className="mt-4 text-sm text-slate-700 leading-relaxed">
                  {inspectedBook.synopsis}
                </p>

                <dl className="mt-5 grid grid-cols-2 gap-3 text-xs border-t border-slate-200 pt-4">
                  <div>
                    <dt className="text-slate-500">ISBN-13</dt>
                    <dd className="font-mono text-slate-900 mt-0.5 tabular-nums">
                      {inspectedBook.isbn}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Call Number</dt>
                    <dd className="font-mono text-slate-900 mt-0.5">{inspectedBook.callNumber}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Shelf Location</dt>
                    <dd className="text-slate-900 mt-0.5">{inspectedBook.shelfLocation}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Available Copies</dt>
                    <dd className="font-mono text-emerald-700 font-medium mt-0.5 tabular-nums">
                      {inspectedBook.availableCopies} on shelf
                    </dd>
                  </div>
                </dl>

                <div className="mt-6 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setInspectedBook(null)}
                    className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                  >
                    Close
                  </button>
                  {inspectedBook.userLoanId ? (
                    <button
                      type="button"
                      onClick={() => {
                        setInspectedBook(null);
                        setActiveTab('loans');
                      }}
                      className="px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg cursor-pointer"
                    >
                      Manage Active Loan
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={
                        busyKey === `borrow-${inspectedBook.id}` || profile.status === 'suspended'
                      }
                      onClick={() => void handleBorrow(inspectedBook)}
                      className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
                    >
                      Borrow Book (14 Days)
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
