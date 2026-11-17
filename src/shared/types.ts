export type UserRole = 'member' | 'admin';

export interface UserProfile {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  cardNumber: string;
  department: string;
  status: 'active' | 'suspended';
  maxLoans: number;
  createdAt: string;
  activeLoanCount?: number;
  overdueCount?: number;
  totalFinesCents?: number;
}

export interface BookRecord {
  id: number;
  isbn: string;
  title: string;
  author: string;
  category: string;
  publicationYear: number;
  publisher: string;
  callNumber: string;
  shelfLocation: string;
  synopsis: string;
  coverUrl: string;
  totalCopies: number;
  availableCopies: number;
  reorderThreshold: number;
  archived: boolean;
  updatedAt: string;
  activeLoansCount: number;
  waitlistCount: number;
  stockHealth: 'healthy' | 'low' | 'out';
  userLoanId?: number | null;
  userHoldId?: number | null;
  userHoldPosition?: number | null;
}

export interface LoanRecord {
  id: number;
  userId: number;
  userName: string;
  userEmail: string;
  userCardNumber: string;
  bookId: number;
  bookTitle: string;
  bookAuthor: string;
  bookIsbn: string;
  bookCallNumber: string;
  bookCoverUrl: string;
  checkedOutAt: string;
  dueDate: string;
  returnedAt: string | null;
  renewalsCount: number;
  status: 'active' | 'returned' | 'lost';
  fineCents: number;
  finePaid: boolean;
  isOverdue: boolean;
  daysOverdue: number;
  daysRemaining: number;
  computedFineCents: number;
  hasWaitingHolds: boolean;
}

export interface ReservationRecord {
  id: number;
  userId: number;
  userName: string;
  userEmail: string;
  userCardNumber: string;
  bookId: number;
  bookTitle: string;
  bookAuthor: string;
  bookIsbn: string;
  bookCoverUrl: string;
  bookAvailableCopies: number;
  createdAt: string;
  status: 'waiting' | 'fulfilled' | 'cancelled';
  queuePosition: number;
}

export interface RestockAlertRecord {
  id: number;
  bookId: number;
  bookTitle: string;
  bookAuthor: string;
  bookIsbn: string;
  bookCategory: string;
  availableCopies: number;
  totalCopies: number;
  reorderThreshold: number;
  waitlistCount: number;
  triggerReason: 'LOW_STOCK' | 'OUT_OF_STOCK' | 'WAITLIST_DEMAND';
  suggestedQty: number;
  status: 'open' | 'ordered' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
}

export interface InventoryEventRecord {
  id: number;
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  actorUserId: number | null;
  actorName: string;
  eventType:
    | 'CHECKOUT'
    | 'RETURN'
    | 'AUTO_HOLD_FULFILLED'
    | 'RESTOCK_RECEIVED'
    | 'LOST_WRITEOFF'
    | 'LOW_STOCK_ALERT'
    | 'CATALOG_CREATED'
    | 'CATALOG_UPDATED'
    | 'PURCHASE_ORDER_PLACED';
  delta: number;
  resultingAvailable: number;
  resultingTotal: number;
  notes: string;
  createdAt: string;
}

export interface AdminOverviewStats {
  totalTitles: number;
  totalVolumes: number;
  availableVolumes: number;
  activeLoans: number;
  overdueLoans: number;
  openAlerts: number;
  orderedAlerts: number;
  activeHolds: number;
  totalMembers: number;
  unpaidFinesCents: number;
}
