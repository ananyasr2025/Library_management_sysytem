import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  AlertTriangle,
  Archive,
  BookPlus,
  ClipboardList,
  Edit3,
  Layers,
  ListChecks,
  LogOut,
  Menu,
  PackagePlus,
  RefreshCw,
  Search,
  Users,
  X,
} from 'lucide-react';
import { apiRequest, formatCurrency, formatDateTime, formatShortDate } from '../lib/api.ts';
import type {
  AdminOverviewStats,
  BookRecord,
  InventoryEventRecord,
  LoanRecord,
  ReservationRecord,
  RestockAlertRecord,
  UserProfile,
} from '../shared/types.ts';

interface AdminDashboardProps {
  initialUser: UserProfile;
  onSignOut: () => void;
  onNotify: (message: string, tone?: 'success' | 'error') => void;
}

type AdminTab =
  | 'inventory'
  | 'catalog'
  | 'circulation'
  | 'waitlist'
  | 'audit'
  | 'members';

interface AdminDashboardPayload {
  stats: AdminOverviewStats;
  books: BookRecord[];
  alerts: RestockAlertRecord[];
  loans: LoanRecord[];
  holds: ReservationRecord[];
  events: InventoryEventRecord[];
  members: UserProfile[];
}

const CATEGORIES = [
  'Architecture & Design',
  'Computer Science',
  'Natural Sciences',
  'Literature & Biography',
  'Competitive & Policy',
  'History & Archives',
];

export function AdminDashboard({
  initialUser,
  onSignOut,
  onNotify,
}: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('inventory');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [stats, setStats] = useState<AdminOverviewStats | null>(null);
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [alerts, setAlerts] = useState<RestockAlertRecord[]>([]);
  const [loans, setLoans] = useState<LoanRecord[]>([]);
  const [holds, setHolds] = useState<ReservationRecord[]>([]);
  const [events, setEvents] = useState<InventoryEventRecord[]>([]);
  const [members, setMembers] = useState<UserProfile[]>([]);

  // Filters
  const [alertFilter, setAlertFilter] = useState<'active' | 'resolved'>('active');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('All');
  const [loanFilter, setLoanFilter] = useState<'active' | 'overdue' | 'closed'>('active');
  const [eventFilter, setEventFilter] = useState<string>('ALL');

  // Desk Checkout Form
  const [checkoutUserId, setCheckoutUserId] = useState<string>('');
  const [checkoutBookId, setCheckoutBookId] = useState<string>('');

  // Book Create / Edit Modal
  const [bookModalOpen, setBookModalOpen] = useState(false);
  const [editingBook, setEditingBook] = useState<BookRecord | null>(null);
  const [bookForm, setBookForm] = useState({
    isbn: '',
    title: '',
    author: '',
    category: CATEGORIES[0],
    publicationYear: String(new Date().getFullYear()),
    publisher: '',
    callNumber: '',
    shelfLocation: '',
    synopsis: '',
    totalCopies: '3',
    reorderThreshold: '2',
  });

  // Restock Modal
  const [restockModalBook, setRestockModalBook] = useState<{
    bookId: number;
    title: string;
    suggestedQty: number;
  } | null>(null);
  const [restockQty, setRestockQty] = useState('3');
  const [restockNotes, setRestockNotes] = useState('');

  const loadAdminData = useCallback(async () => {
    try {
      const data = await apiRequest<AdminDashboardPayload>('/api/admin/dashboard');
      setStats(data.stats);
      setBooks(data.books);
      setAlerts(data.alerts);
      setLoans(data.loans);
      setHolds(data.holds);
      setEvents(data.events);
      setMembers(data.members);
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Unable to load librarian dashboard.',
        'error'
      );
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  const activeAlerts = useMemo(
    () => alerts.filter((a) => a.status === 'open' || a.status === 'ordered'),
    [alerts]
  );
  const resolvedAlerts = useMemo(
    () => alerts.filter((a) => a.status === 'resolved'),
    [alerts]
  );

  const sortedWatchlistBooks = useMemo(() => {
    const rank = { out: 0, low: 1, healthy: 2 };
    return [...books].sort((a, b) => {
      if (rank[a.stockHealth] !== rank[b.stockHealth]) {
        return rank[a.stockHealth] - rank[b.stockHealth];
      }
      return a.availableCopies - b.availableCopies;
    });
  }, [books]);

  const filteredCatalogBooks = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    return books.filter((b) => {
      if (catalogCategory !== 'All' && b.category !== catalogCategory) return false;
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        b.author.toLowerCase().includes(q) ||
        b.isbn.toLowerCase().includes(q) ||
        b.callNumber.toLowerCase().includes(q)
      );
    });
  }, [books, catalogSearch, catalogCategory]);

  const filteredLoans = useMemo(() => {
    if (loanFilter === 'overdue') return loans.filter((l) => l.status === 'active' && l.isOverdue);
    if (loanFilter === 'closed') return loans.filter((l) => l.status !== 'active');
    return loans.filter((l) => l.status === 'active');
  }, [loans, loanFilter]);

  const filteredEvents = useMemo(() => {
    if (eventFilter === 'ALL') return events;
    return events.filter((e) => e.eventType === eventFilter);
  }, [events, eventFilter]);

  const activePatrons = useMemo(
    () => members.filter((m) => m.status === 'active'),
    [members]
  );
  const availableForCheckout = useMemo(
    () => books.filter((b) => b.availableCopies > 0),
    [books]
  );

  const openCreateBookModal = () => {
    setEditingBook(null);
    setBookForm({
      isbn: '',
      title: '',
      author: '',
      category: CATEGORIES[0],
      publicationYear: String(new Date().getFullYear()),
      publisher: 'Universities Press India',
      callNumber: '',
      shelfLocation: '',
      synopsis: '',
      totalCopies: '3',
      reorderThreshold: '2',
    });
    setBookModalOpen(true);
  };

  const openEditBookModal = (book: BookRecord) => {
    setEditingBook(book);
    setBookForm({
      isbn: book.isbn,
      title: book.title,
      author: book.author,
      category: book.category,
      publicationYear: String(book.publicationYear),
      publisher: book.publisher,
      callNumber: book.callNumber,
      shelfLocation: book.shelfLocation,
      synopsis: book.synopsis,
      totalCopies: String(book.totalCopies),
      reorderThreshold: String(book.reorderThreshold),
    });
    setBookModalOpen(true);
  };

  const handleSaveBook = async (e: FormEvent) => {
    e.preventDefault();
    setBusyKey('save-book');
    try {
      if (editingBook) {
        await apiRequest(`/api/admin/books/${editingBook.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: bookForm.title,
            author: bookForm.author,
            category: bookForm.category,
            publicationYear: Number(bookForm.publicationYear),
            publisher: bookForm.publisher,
            callNumber: bookForm.callNumber,
            shelfLocation: bookForm.shelfLocation,
            synopsis: bookForm.synopsis,
            reorderThreshold: Number(bookForm.reorderThreshold),
          }),
        });
        onNotify(`Updated catalog record "${bookForm.title}".`, 'success');
      } else {
        await apiRequest('/api/admin/books', {
          method: 'POST',
          body: JSON.stringify({
            isbn: bookForm.isbn,
            title: bookForm.title,
            author: bookForm.author,
            category: bookForm.category,
            publicationYear: Number(bookForm.publicationYear),
            publisher: bookForm.publisher,
            callNumber: bookForm.callNumber,
            shelfLocation: bookForm.shelfLocation,
            synopsis: bookForm.synopsis,
            totalCopies: Number(bookForm.totalCopies),
            reorderThreshold: Number(bookForm.reorderThreshold),
          }),
        });
        onNotify(`Cataloged "${bookForm.title}" into active holdings.`, 'success');
      }
      setBookModalOpen(false);
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to save catalog entry.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleArchiveBook = async (book: BookRecord) => {
    setBusyKey(`archive-${book.id}`);
    try {
      await apiRequest(`/api/admin/books/${book.id}`, { method: 'DELETE' });
      onNotify(`Archived "${book.title}" from active circulation.`, 'success');
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to archive book.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handlePlacePurchaseOrder = async (alert: RestockAlertRecord) => {
    setBusyKey(`order-${alert.id}`);
    try {
      await apiRequest(`/api/admin/alerts/${alert.id}/order`, { method: 'POST' });
      onNotify(
        `Purchase order logged for "${alert.bookTitle}" (+${alert.suggestedQty} copies).`,
        'success'
      );
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to place purchase order.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleQuickRestock = async (bookId: number, title: string, qty: number, notes?: string) => {
    setBusyKey(`restock-${bookId}`);
    try {
      const res = await apiRequest<{
        newTotal: number;
        newAvailable: number;
        fulfilledCount: number;
      }>(`/api/admin/books/${bookId}/restock`, {
        method: 'POST',
        body: JSON.stringify({ quantity: qty, notes }),
      });
      const holdMsg =
        res.fulfilledCount > 0
          ? ` ${res.fulfilledCount} waitlist hold(s) automatically fulfilled.`
          : '';
      onNotify(
        `Restocked "${title}" (+${qty}). Now ${res.newAvailable}/${res.newTotal} on shelf.${holdMsg}`,
        'success'
      );
      setRestockModalBook(null);
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Restock operation failed.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleWriteOff = async (bookId: number, title: string, loanId?: number) => {
    setBusyKey(`writeoff-${bookId}-${loanId || 'shelf'}`);
    try {
      await apiRequest(`/api/admin/books/${bookId}/writeoff`, {
        method: 'POST',
        body: JSON.stringify(loanId ? { loanId } : {}),
      });
      onNotify(`Inventory write-off recorded for "${title}".`, 'success');
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Write-off failed.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeskCheckout = async (e: FormEvent) => {
    e.preventDefault();
    if (!checkoutUserId || !checkoutBookId) return;
    setBusyKey('desk-checkout');
    try {
      await apiRequest('/api/admin/circulation/checkout', {
        method: 'POST',
        body: JSON.stringify({
          userId: Number(checkoutUserId),
          bookId: Number(checkoutBookId),
        }),
      });
      onNotify('Desk checkout recorded and inventory updated.', 'success');
      setCheckoutBookId('');
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Desk checkout failed.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleAdminReturn = async (loan: LoanRecord) => {
    setBusyKey(`admin-return-${loan.id}`);
    try {
      const res = await apiRequest<{ autoFulfilledHold: boolean }>(
        `/api/admin/loans/${loan.id}/return`,
        { method: 'POST' }
      );
      onNotify(
        `Checked in "${loan.bookTitle}" from ${loan.userName}.${
          res.autoFulfilledHold ? ' Next waitlist hold automatically fulfilled.' : ''
        }`,
        'success'
      );
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Check-in failed.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleWaiveFine = async (loanId: number) => {
    setBusyKey(`waive-${loanId}`);
    try {
      await apiRequest(`/api/admin/loans/${loanId}/waive-fine`, { method: 'POST' });
      onNotify('Late fee settled and cleared.', 'success');
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to clear fee.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCancelHold = async (hold: ReservationRecord) => {
    setBusyKey(`admin-hold-cancel-${hold.id}`);
    try {
      await apiRequest(`/api/member/holds/${hold.id}`, { method: 'DELETE' });
      onNotify(`Cancelled waitlist hold for ${hold.userName}.`, 'success');
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to cancel hold.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleMember = async (member: UserProfile) => {
    setBusyKey(`member-toggle-${member.id}`);
    try {
      const res = await apiRequest<{ status: string }>(
        `/api/admin/members/${member.id}/toggle-status`,
        { method: 'POST' }
      );
      onNotify(`${member.name} account is now ${res.status}.`, 'success');
      await loadAdminData();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to update member status.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const navItems: Array<{
    id: AdminTab;
    label: string;
    count?: number;
    icon: typeof AlertTriangle;
  }> = [
    {
      id: 'inventory',
      label: 'Inventory & Alerts',
      count: activeAlerts.length,
      icon: AlertTriangle,
    },
    { id: 'catalog', label: 'Catalog Management', count: books.length, icon: Layers },
    {
      id: 'circulation',
      label: 'Circulation Desk',
      count: stats?.activeLoans,
      icon: ListChecks,
    },
    { id: 'waitlist', label: 'Waitlist Queue', count: holds.length, icon: PackagePlus },
    { id: 'audit', label: 'Automated Audit Log', count: events.length, icon: ClipboardList },
    { id: 'members', label: 'Member Directory', count: members.length, icon: Users },
  ];

  const currentTabLabel = navItems.find((n) => n.id === activeTab)?.label || 'Inventory & Alerts';

  return (
    <div className="min-h-screen bg-blue-50/35 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 bg-blue-900 text-blue-50 shrink-0">
        <div className="h-16 px-6 flex items-center border-b border-blue-800">
          <span className="font-display text-xl font-semibold tracking-tight text-white whitespace-nowrap">
            SmartLib
          </span>
        </div>

        <div className="px-6 py-4 border-b border-blue-800">
          <p className="text-xs font-medium text-blue-200">Librarian Administration</p>
          <p className="text-sm font-semibold text-white mt-0.5 truncate">{initialUser.name}</p>
          <p className="font-mono text-xs text-blue-200/80 mt-0.5 tabular-nums">
            {initialUser.cardNumber}
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
                    ? 'bg-white text-blue-900 shadow-xs'
                    : 'text-blue-100 hover:bg-blue-800 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {typeof item.count === 'number' && (
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      active ? 'text-blue-700 font-semibold' : 'text-blue-200'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-blue-800">
          <button
            type="button"
            onClick={onSignOut}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-white bg-blue-800 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract */}
        <header className="sticky top-0 z-20 h-16 bg-white border-b border-blue-100 px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open librarian menu"
              className="lg:hidden p-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
                Librarian Desk
              </span>
              <span className="text-slate-300 hidden sm:inline">/</span>
              <h1 className="font-semibold text-slate-900 truncate">{currentTabLabel}</h1>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => void loadAdminData()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Refresh Ledger</span>
            </button>
            <button
              type="button"
              onClick={openCreateBookModal}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <BookPlus className="w-3.5 h-3.5" />
              <span>Add Book</span>
            </button>
          </div>
        </header>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-40 lg:hidden flex">
            <div
              className="fixed inset-0 bg-slate-950/50"
              onClick={() => setMobileMenuOpen(false)}
            />
            <div className="relative w-72 max-w-[85vw] bg-blue-900 text-blue-50 h-full flex flex-col justify-between p-4 z-10">
              <div>
                <div className="flex items-center justify-between pb-4 border-b border-blue-800">
                  <span className="font-display text-lg font-semibold text-white">SmartLib</span>
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(false)}
                    aria-label="Close librarian menu"
                    className="p-1.5 text-slate-400 hover:text-white rounded-md"
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
                            ? 'bg-white text-blue-900'
                            : 'text-blue-100 hover:bg-blue-800'
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
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium text-slate-200 bg-slate-800 rounded-lg"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
          {/* 4-Column KPI Strip */}
          {stats && (
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <p className="text-xs font-medium text-slate-500">Catalog Volumes</p>
                <p className="font-mono text-2xl font-semibold text-slate-900 mt-1.5 tabular-nums">
                  {stats.availableVolumes}{' '}
                  <span className="text-sm font-normal text-slate-400">/ {stats.totalVolumes}</span>
                </p>
                <p className="text-xs text-slate-500 mt-1 tabular-nums">
                  On shelf across {stats.totalTitles} active titles
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <p className="text-xs font-medium text-slate-500">Active Circulation</p>
                <p className="font-mono text-2xl font-semibold text-slate-900 mt-1.5 tabular-nums">
                  {stats.activeLoans}
                </p>
                <p className="text-xs mt-1 tabular-nums">
                  <span className={stats.overdueLoans > 0 ? 'text-red-600 font-medium' : 'text-slate-500'}>
                    {stats.overdueLoans} overdue
                  </span>
                  <span className="text-slate-400"> · {formatCurrency(stats.unpaidFinesCents)} unpaid</span>
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <p className="text-xs font-medium text-slate-500">Automated Reorder Alerts</p>
                <p className="font-mono text-2xl font-semibold text-slate-900 mt-1.5 tabular-nums">
                  {stats.openAlerts + stats.orderedAlerts}
                </p>
                <p className="text-xs text-slate-500 mt-1 tabular-nums">
                  {stats.openAlerts} open · {stats.orderedAlerts} purchase order(s) active
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <p className="text-xs font-medium text-slate-500">Waitlist &amp; Patrons</p>
                <p className="font-mono text-2xl font-semibold text-slate-900 mt-1.5 tabular-nums">
                  {stats.activeHolds}
                </p>
                <p className="text-xs text-slate-500 mt-1 tabular-nums">
                  Queued holds across {stats.totalMembers} registered members
                </p>
              </div>
            </section>
          )}

          {loading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse"
                />
              ))}
            </div>
          ) : activeTab === 'inventory' ? (
            <div className="space-y-6">
              {/* Automated Reorder Alert Queue */}
              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Automated Stock &amp; Reorder Alerts
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Evaluated automatically on every checkout, return, write-off, and hold request.
                    </p>
                  </div>

                  <div className="inline-flex p-1 bg-slate-100 rounded-lg self-start">
                    <button
                      type="button"
                      onClick={() => setAlertFilter('active')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        alertFilter === 'active'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Active ({activeAlerts.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setAlertFilter('resolved')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        alertFilter === 'resolved'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Resolved ({resolvedAlerts.length})
                    </button>
                  </div>
                </div>

                {(alertFilter === 'active' ? activeAlerts : resolvedAlerts).length === 0 ? (
                  <div className="p-10 text-center text-xs text-slate-500">
                    {alertFilter === 'active'
                      ? 'All titles are currently above their configured reorder thresholds.'
                      : 'No resolved restock alerts recorded yet.'}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                        <tr>
                          <th className="px-6 py-3 font-medium">Title &amp; ISBN</th>
                          <th className="px-4 py-3 font-medium">Trigger Rule</th>
                          <th className="px-4 py-3 font-medium text-right">Stock / Threshold</th>
                          <th className="px-4 py-3 font-medium text-right">Holds</th>
                          <th className="px-4 py-3 font-medium text-right">Suggested Order</th>
                          <th className="px-4 py-3 font-medium">State</th>
                          <th className="px-6 py-3 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(alertFilter === 'active' ? activeAlerts : resolvedAlerts).map((alert) => (
                          <tr key={alert.id} className="hover:bg-slate-50/70">
                            <td className="px-6 py-3.5">
                              <p className="font-medium text-slate-900">{alert.bookTitle}</p>
                              <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                                {alert.bookIsbn}
                              </p>
                            </td>
                            <td className="px-4 py-3.5">
                              <span
                                className={`font-medium ${
                                  alert.triggerReason === 'OUT_OF_STOCK'
                                    ? 'text-red-700'
                                    : alert.triggerReason === 'WAITLIST_DEMAND'
                                      ? 'text-amber-700'
                                      : 'text-amber-700'
                                }`}
                              >
                                {alert.triggerReason === 'OUT_OF_STOCK'
                                  ? 'Out of Stock'
                                  : alert.triggerReason === 'WAITLIST_DEMAND'
                                    ? 'Waitlist Exceeds Stock'
                                    : 'Below Threshold'}
                              </span>
                            </td>
                            <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-700">
                              {alert.availableCopies}/{alert.totalCopies} (min {alert.reorderThreshold})
                            </td>
                            <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-700">
                              {alert.waitlistCount}
                            </td>
                            <td className="px-4 py-3.5 text-right font-mono tabular-nums font-medium text-slate-900">
                              +{alert.suggestedQty} copies
                            </td>
                            <td className="px-4 py-3.5">
                              <span
                                className={`font-medium capitalize ${
                                  alert.status === 'open'
                                    ? 'text-red-700'
                                    : alert.status === 'ordered'
                                      ? 'text-blue-700'
                                      : 'text-emerald-700'
                                }`}
                              >
                                {alert.status === 'ordered' ? 'PO Ordered' : alert.status}
                              </span>
                            </td>
                            <td className="px-6 py-3.5 text-right whitespace-nowrap">
                              {alert.status !== 'resolved' ? (
                                <div className="inline-flex items-center gap-2">
                                  {alert.status === 'open' && (
                                    <button
                                      type="button"
                                      disabled={busyKey === `order-${alert.id}`}
                                      onClick={() => void handlePlacePurchaseOrder(alert)}
                                      className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                                    >
                                      Place Order
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    disabled={busyKey === `restock-${alert.bookId}`}
                                    onClick={() =>
                                      void handleQuickRestock(
                                        alert.bookId,
                                        alert.bookTitle,
                                        alert.suggestedQty,
                                        `Automated restock fulfillment (+${alert.suggestedQty}) resolving alert #${alert.id}.`
                                      )
                                    }
                                    className="px-2.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md cursor-pointer"
                                  >
                                    Receive +{alert.suggestedQty}
                                  </button>
                                </div>
                              ) : (
                                <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                                  {alert.resolvedAt ? formatShortDate(alert.resolvedAt) : 'Resolved'}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Real-Time Stock Health Matrix */}
              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200">
                  <h2 className="text-base font-semibold text-slate-900">
                    Stack Inventory Health Monitor
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Sorted by depletion risk. Receiving stock automatically fulfills waiting patron
                    holds first.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 font-medium">Title</th>
                        <th className="px-4 py-3 font-medium">Shelf Location</th>
                        <th className="px-4 py-3 font-medium text-right">Available</th>
                        <th className="px-4 py-3 font-medium text-right">On Loan</th>
                        <th className="px-4 py-3 font-medium text-right">Total</th>
                        <th className="px-4 py-3 font-medium">Health</th>
                        <th className="px-6 py-3 font-medium text-right">Quick Adjustment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {sortedWatchlistBooks.map((book) => (
                        <tr key={book.id} className="hover:bg-slate-50/70">
                          <td className="px-6 py-3">
                            <p className="font-medium text-slate-900">{book.title}</p>
                            <p className="text-slate-500">{book.author}</p>
                          </td>
                          <td className="px-4 py-3 font-mono text-slate-600">
                            {book.shelfLocation}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-slate-900">
                            {book.availableCopies}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600">
                            {book.activeLoansCount}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600">
                            {book.totalCopies}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`font-medium ${
                                book.stockHealth === 'out'
                                  ? 'text-red-700'
                                  : book.stockHealth === 'low'
                                    ? 'text-amber-700'
                                    : 'text-emerald-700'
                              }`}
                            >
                              {book.stockHealth === 'out'
                                ? 'Out of Stock'
                                : book.stockHealth === 'low'
                                  ? 'Low Stock'
                                  : 'Healthy'}
                            </span>
                          </td>
                          <td className="px-6 py-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busyKey === `restock-${book.id}`}
                                onClick={() => {
                                  setRestockModalBook({
                                    bookId: book.id,
                                    title: book.title,
                                    suggestedQty: Math.max(2, book.reorderThreshold * 2 - book.availableCopies),
                                  });
                                  setRestockQty(
                                    String(Math.max(2, book.reorderThreshold * 2 - book.availableCopies))
                                  );
                                  setRestockNotes('');
                                }}
                                className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md cursor-pointer"
                              >
                                Restock
                              </button>
                              <button
                                type="button"
                                disabled={
                                  book.availableCopies <= 0 ||
                                  busyKey === `writeoff-${book.id}-shelf`
                                }
                                onClick={() => void handleWriteOff(book.id, book.title)}
                                className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md cursor-pointer"
                              >
                                Write-off -1
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          ) : activeTab === 'catalog' ? (
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    placeholder="Filter catalog by title, author, ISBN, or call no..."
                    className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {['All', ...CATEGORIES].map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCatalogCategory(cat)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        catalogCategory === cat
                          ? 'bg-blue-700 text-white'
                          : 'bg-blue-50 text-blue-900 hover:bg-blue-100'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={openCreateBookModal}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap cursor-pointer ml-1"
                  >
                    <BookPlus className="w-3.5 h-3.5" />
                    <span>Add Book</span>
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 font-medium">Title &amp; Author</th>
                      <th className="px-4 py-3 font-medium">ISBN-13</th>
                      <th className="px-4 py-3 font-medium">Call No. &amp; Shelf</th>
                      <th className="px-4 py-3 font-medium text-right">Stock</th>
                      <th className="px-4 py-3 font-medium text-right">Min</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-6 py-3 font-medium text-right">Manage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredCatalogBooks.map((book) => (
                      <tr key={book.id} className="hover:bg-slate-50/70">
                        <td className="px-6 py-3.5">
                          <p className="font-medium text-slate-900">{book.title}</p>
                          <p className="text-slate-500">
                            {book.author} · {book.category}
                          </p>
                        </td>
                        <td className="px-4 py-3.5 font-mono tabular-nums text-slate-600">
                          {book.isbn}
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="font-mono text-slate-700">{book.callNumber}</p>
                          <p className="text-slate-500">{book.shelfLocation}</p>
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-900">
                          {book.availableCopies} / {book.totalCopies}
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-500">
                          {book.reorderThreshold}
                        </td>
                        <td className="px-4 py-3.5">
                          <span
                            className={`font-medium ${
                              book.stockHealth === 'out'
                                ? 'text-red-700'
                                : book.stockHealth === 'low'
                                  ? 'text-amber-700'
                                  : 'text-emerald-700'
                            }`}
                          >
                            {book.stockHealth === 'out'
                              ? 'Out of Stock'
                              : book.stockHealth === 'low'
                                ? 'Low Stock'
                                : 'Healthy'}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEditBookModal(book)}
                              title="Edit title"
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                            >
                              <Edit3 className="w-3 h-3" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRestockModalBook({
                                  bookId: book.id,
                                  title: book.title,
                                  suggestedQty: 2,
                                });
                                setRestockQty('2');
                                setRestockNotes('');
                              }}
                              className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md cursor-pointer"
                            >
                              +Stock
                            </button>
                            <button
                              type="button"
                              disabled={busyKey === `archive-${book.id}`}
                              onClick={() => void handleArchiveBook(book)}
                              title="Archive title"
                              className="p-1.5 text-slate-500 hover:text-red-700 hover:bg-red-50 rounded-md cursor-pointer"
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : activeTab === 'circulation' ? (
            <div className="space-y-6">
              {/* Desk Checkout Form */}
              <section className="bg-white border border-slate-200 rounded-xl p-6">
                <h2 className="text-base font-semibold text-slate-900">
                  Circulation Desk Check-Out
                </h2>
                <p className="text-xs text-slate-500 mt-0.5 mb-4">
                  Issue an available volume directly to a registered patron (14-day term).
                </p>
                <form
                  onSubmit={handleDeskCheckout}
                  className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end"
                >
                  <div className="md:col-span-5">
                    <label
                      htmlFor="desk-patron"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Select Patron
                    </label>
                    <select
                      id="desk-patron"
                      required
                      value={checkoutUserId}
                      onChange={(e) => setCheckoutUserId(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
                    >
                      <option value="">Choose patron...</option>
                      {activePatrons.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.cardNumber}) — {p.activeLoanCount}/{p.maxLoans} loans
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="md:col-span-5">
                    <label
                      htmlFor="desk-book"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Select Available Volume
                    </label>
                    <select
                      id="desk-book"
                      required
                      value={checkoutBookId}
                      onChange={(e) => setCheckoutBookId(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
                    >
                      <option value="">Choose available book...</option>
                      {availableForCheckout.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.title} ({b.availableCopies}/{b.totalCopies} avail)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <button
                      type="submit"
                      disabled={busyKey === 'desk-checkout'}
                      className="w-full px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                    >
                      {busyKey === 'desk-checkout' ? 'Issuing...' : 'Check Out'}
                    </button>
                  </div>
                </form>
              </section>

              {/* Loans Ledger */}
              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <h2 className="text-base font-semibold text-slate-900">Circulation Ledger</h2>
                  <div className="inline-flex p-1 bg-slate-100 rounded-lg self-start">
                    {(
                      [
                        { id: 'active', label: 'Active Loans' },
                        { id: 'overdue', label: 'Overdue Only' },
                        { id: 'closed', label: 'Returned / Lost' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setLoanFilter(tab.id)}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                          loanFilter === tab.id
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredLoans.length === 0 ? (
                  <p className="p-10 text-center text-xs text-slate-500">
                    No circulation records match this filter.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                        <tr>
                          <th className="px-6 py-3 font-medium">Patron</th>
                          <th className="px-4 py-3 font-medium">Book Title</th>
                          <th className="px-4 py-3 font-medium">Due Date</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                          <th className="px-4 py-3 font-medium text-right">Assessed Fee</th>
                          <th className="px-6 py-3 font-medium text-right">Desk Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredLoans.map((loan) => (
                          <tr key={loan.id} className="hover:bg-slate-50/70">
                            <td className="px-6 py-3.5">
                              <p className="font-medium text-slate-900">{loan.userName}</p>
                              <p className="font-mono text-[11px] text-slate-500">
                                {loan.userCardNumber}
                              </p>
                            </td>
                            <td className="px-4 py-3.5">
                              <p className="font-medium text-slate-900">{loan.bookTitle}</p>
                              <p className="font-mono text-[11px] text-slate-500">
                                {loan.bookCallNumber}
                              </p>
                            </td>
                            <td className="px-4 py-3.5 font-mono tabular-nums text-slate-700">
                              {formatShortDate(loan.dueDate)}
                            </td>
                            <td className="px-4 py-3.5">
                              {loan.status === 'active' ? (
                                loan.isOverdue ? (
                                  <span className="font-medium text-red-700 tabular-nums">
                                    Overdue {loan.daysOverdue}d
                                  </span>
                                ) : (
                                  <span className="font-medium text-emerald-700 tabular-nums">
                                    Active ({loan.daysRemaining}d left)
                                  </span>
                                )
                              ) : (
                                <span className="capitalize text-slate-600">{loan.status}</span>
                              )}
                            </td>
                            <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-800">
                              {formatCurrency(loan.computedFineCents)}{' '}
                              {loan.computedFineCents > 0 && (
                                <span className="text-[11px] text-slate-500">
                                  {loan.finePaid ? '(Cleared)' : '(Due)'}
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-3.5 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                {loan.status === 'active' && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={busyKey === `admin-return-${loan.id}`}
                                      onClick={() => void handleAdminReturn(loan)}
                                      className="px-2.5 py-1 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md cursor-pointer"
                                    >
                                      Check In
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busyKey === `writeoff-${loan.bookId}-${loan.id}`}
                                      onClick={() =>
                                        void handleWriteOff(loan.bookId, loan.bookTitle, loan.id)
                                      }
                                      className="px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-md cursor-pointer"
                                    >
                                      Mark Lost
                                    </button>
                                  </>
                                )}
                                {loan.computedFineCents > 0 && !loan.finePaid && (
                                  <button
                                    type="button"
                                    disabled={busyKey === `waive-${loan.id}`}
                                    onClick={() => void handleWaiveFine(loan.id)}
                                    className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                                  >
                                    Clear Fee
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          ) : activeTab === 'waitlist' ? (
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200">
                <h2 className="text-base font-semibold text-slate-900">
                  Active Patron Waitlist Queue
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Holds are automatically converted into loans in FIFO order when a volume is
                  returned or restocked.
                </p>
              </div>
              {holds.length === 0 ? (
                <p className="p-10 text-center text-xs text-slate-500">
                  No patron holds are currently waiting in queue.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 font-medium">Queue #</th>
                        <th className="px-4 py-3 font-medium">Title</th>
                        <th className="px-4 py-3 font-medium">Patron</th>
                        <th className="px-4 py-3 font-medium">Requested</th>
                        <th className="px-6 py-3 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {holds.map((hold) => (
                        <tr key={hold.id} className="hover:bg-slate-50/70">
                          <td className="px-6 py-3.5 font-mono tabular-nums font-semibold text-blue-700">
                            #{hold.queuePosition}
                          </td>
                          <td className="px-4 py-3.5">
                            <p className="font-medium text-slate-900">{hold.bookTitle}</p>
                            <p className="font-mono text-[11px] text-slate-500">{hold.bookIsbn}</p>
                          </td>
                          <td className="px-4 py-3.5">
                            <p className="font-medium text-slate-900">{hold.userName}</p>
                            <p className="font-mono text-[11px] text-slate-500">
                              {hold.userCardNumber}
                            </p>
                          </td>
                          <td className="px-4 py-3.5 font-mono tabular-nums text-slate-600">
                            {formatShortDate(hold.createdAt)}
                          </td>
                          <td className="px-6 py-3.5 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                disabled={busyKey === `restock-${hold.bookId}`}
                                onClick={() =>
                                  void handleQuickRestock(
                                    hold.bookId,
                                    hold.bookTitle,
                                    1,
                                    `Added +1 copy to fulfill waitlist hold #${hold.id}.`
                                  )
                                }
                                className="px-2.5 py-1 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md cursor-pointer"
                              >
                                Restock +1 (Fulfill)
                              </button>
                              <button
                                type="button"
                                disabled={busyKey === `admin-hold-cancel-${hold.id}`}
                                onClick={() => void handleCancelHold(hold)}
                                className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : activeTab === 'audit' ? (
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Automated Inventory Audit Ledger
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Immutable transaction log recording stock deltas, waitlist conversions, and
                    threshold triggers.
                  </p>
                </div>

                <select
                  aria-label="Filter audit events"
                  value={eventFilter}
                  onChange={(e) => setEventFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-700"
                >
                  <option value="ALL">All Event Types</option>
                  <option value="CHECKOUT">Checkouts</option>
                  <option value="RETURN">Returns</option>
                  <option value="AUTO_HOLD_FULFILLED">Auto Waitlist Fulfilled</option>
                  <option value="LOW_STOCK_ALERT">Low-Stock Alerts</option>
                  <option value="PURCHASE_ORDER_PLACED">Purchase Orders</option>
                  <option value="RESTOCK_RECEIVED">Restocks Received</option>
                  <option value="LOST_WRITEOFF">Lost / Damaged Write-offs</option>
                  <option value="CATALOG_CREATED">Catalog Additions</option>
                </select>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 font-medium">Timestamp</th>
                      <th className="px-4 py-3 font-medium">Event</th>
                      <th className="px-4 py-3 font-medium">Title</th>
                      <th className="px-4 py-3 font-medium text-right">Delta</th>
                      <th className="px-4 py-3 font-medium text-right">Resulting Stock</th>
                      <th className="px-4 py-3 font-medium">Actor</th>
                      <th className="px-6 py-3 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredEvents.map((ev) => (
                      <tr key={ev.id} className="hover:bg-slate-50/70">
                        <td className="px-6 py-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                          {formatDateTime(ev.createdAt)}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] font-medium text-slate-800 whitespace-nowrap">
                          {ev.eventType}
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-900 max-w-xs truncate">
                          {ev.bookTitle}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tabular-nums font-semibold ${
                            ev.delta > 0
                              ? 'text-emerald-700'
                              : ev.delta < 0
                                ? 'text-red-600'
                                : 'text-slate-500'
                          }`}
                        >
                          {ev.delta > 0 ? `+${ev.delta}` : ev.delta}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {ev.resultingAvailable} / {ev.resultingTotal}
                        </td>
                        <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                          {ev.actorName}
                        </td>
                        <td className="px-6 py-3 text-slate-600 min-w-[240px]">{ev.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200">
                <h2 className="text-base font-semibold text-slate-900">
                  Registered Library Directory
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Manage patron standing, monitor active loan utilization, and verify administrator
                  roles.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 font-medium">Name &amp; Email</th>
                      <th className="px-4 py-3 font-medium">Card ID</th>
                      <th className="px-4 py-3 font-medium">Role &amp; Affiliation</th>
                      <th className="px-4 py-3 font-medium text-right">Active Loans</th>
                      <th className="px-4 py-3 font-medium text-right">Unpaid Fees</th>
                      <th className="px-4 py-3 font-medium">Standing</th>
                      <th className="px-6 py-3 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {members.map((m) => (
                      <tr key={m.id} className="hover:bg-slate-50/70">
                        <td className="px-6 py-3.5">
                          <p className="font-medium text-slate-900">{m.name}</p>
                          <p className="text-slate-500">{m.email}</p>
                        </td>
                        <td className="px-4 py-3.5 font-mono tabular-nums text-slate-700">
                          {m.cardNumber}
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="font-medium text-slate-800 capitalize">
                            {m.role === 'admin' ? 'Librarian Admin' : 'Patron Member'}
                          </p>
                          <p className="text-slate-500">{m.department}</p>
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-800">
                          {m.activeLoanCount} / {m.maxLoans}
                          {(m.overdueCount || 0) > 0 && (
                            <span className="block text-[11px] text-red-600">
                              {m.overdueCount} overdue
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-800">
                          {formatCurrency(m.totalFinesCents || 0)}
                        </td>
                        <td className="px-4 py-3.5">
                          <span
                            className={`font-medium capitalize ${
                              m.status === 'active' ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {m.status}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-right whitespace-nowrap">
                          {m.role === 'member' ? (
                            <button
                              type="button"
                              disabled={busyKey === `member-toggle-${m.id}`}
                              onClick={() => void handleToggleMember(m)}
                              className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                                m.status === 'active'
                                  ? 'text-red-700 bg-red-50 hover:bg-red-100'
                                  : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                              }`}
                            >
                              {m.status === 'active' ? 'Suspend' : 'Reactivate'}
                            </button>
                          ) : (
                            <span className="text-slate-400">Protected</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>

      {/* Add / Edit Book Modal */}
      {bookModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 relative max-h-[90vh] overflow-y-auto">
            <button
              type="button"
              onClick={() => setBookModalOpen(false)}
              aria-label="Close modal"
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-800 rounded-lg cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <h2 className="font-display text-xl font-semibold text-slate-900">
              {editingBook ? 'Edit Catalog Title' : 'Catalog New Library Title'}
            </h2>
            <p className="text-xs text-slate-500 mt-1 mb-5">
              Changes immediately update shelf search and automated threshold monitoring.
            </p>

            <form onSubmit={handleSaveBook} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">ISBN-13</label>
                  <input
                    type="text"
                    required
                    disabled={Boolean(editingBook)}
                    value={bookForm.isbn}
                    onChange={(e) => setBookForm({ ...bookForm, isbn: e.target.value })}
                    placeholder="978-0-262-04412-7"
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 disabled:bg-slate-100 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                  <select
                    value={bookForm.category}
                    onChange={(e) => setBookForm({ ...bookForm, category: e.target.value })}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Title</label>
                <input
                  type="text"
                  required
                  value={bookForm.title}
                  onChange={(e) => setBookForm({ ...bookForm, title: e.target.value })}
                  placeholder="Enter book title (e.g., Operating System Concepts)"
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Author</label>
                  <input
                    type="text"
                    required
                    value={bookForm.author}
                    onChange={(e) => setBookForm({ ...bookForm, author: e.target.value })}
                    placeholder="Author full name"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Year</label>
                  <input
                    type="number"
                    required
                    value={bookForm.publicationYear}
                    onChange={(e) =>
                      setBookForm({ ...bookForm, publicationYear: e.target.value })
                    }
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Call Number
                  </label>
                  <input
                    type="text"
                    required
                    value={bookForm.callNumber}
                    onChange={(e) => setBookForm({ ...bookForm, callNumber: e.target.value })}
                    placeholder="QA 76.9 .D3"
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Shelf Location
                  </label>
                  <input
                    type="text"
                    required
                    value={bookForm.shelfLocation}
                    onChange={(e) => setBookForm({ ...bookForm, shelfLocation: e.target.value })}
                    placeholder="Wing C · Stack 12"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Publisher</label>
                  <input
                    type="text"
                    value={bookForm.publisher}
                    onChange={(e) => setBookForm({ ...bookForm, publisher: e.target.value })}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {!editingBook && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Initial Copies
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      required
                      value={bookForm.totalCopies}
                      onChange={(e) => setBookForm({ ...bookForm, totalCopies: e.target.value })}
                      className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                )}
                <div className={editingBook ? 'col-span-2' : ''}>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Automated Reorder Threshold
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    required
                    value={bookForm.reorderThreshold}
                    onChange={(e) =>
                      setBookForm({ ...bookForm, reorderThreshold: e.target.value })
                    }
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Synopsis</label>
                <textarea
                  rows={3}
                  value={bookForm.synopsis}
                  onChange={(e) => setBookForm({ ...bookForm, synopsis: e.target.value })}
                  placeholder="Brief archival summary..."
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setBookModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyKey === 'save-book'}
                  className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
                >
                  {busyKey === 'save-book'
                    ? 'Saving...'
                    : editingBook
                      ? 'Save Changes'
                      : 'Create Catalog Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Receive Restock Modal */}
      {restockModalBook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 relative">
            <button
              type="button"
              onClick={() => setRestockModalBook(null)}
              aria-label="Close restock dialog"
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-800 rounded-lg cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Receive Inventory Shipment
            </h2>
            <p className="text-xs text-slate-600 mt-1">{restockModalBook.title}</p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleQuickRestock(
                  restockModalBook.bookId,
                  restockModalBook.title,
                  Number(restockQty),
                  restockNotes
                );
              }}
              className="mt-4 space-y-4"
            >
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Copies Received
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={restockQty}
                  onChange={(e) => setRestockQty(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Acquisition / Invoice Note (Optional)
                </label>
                <input
                  type="text"
                  value={restockNotes}
                  onChange={(e) => setRestockNotes(e.target.value)}
                  placeholder="PO-2026-884 · Block C replacement batch"
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setRestockModalBook(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyKey === `restock-${restockModalBook.bookId}`}
                  className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
                >
                  Confirm Restock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
