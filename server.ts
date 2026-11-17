import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  makeAuthMiddleware,
  verifyPassword,
} from './src/server/auth.ts';
import type { AuthenticatedRequest } from './src/server/auth.ts';
import {
  archiveCatalogBook,
  cancelHold,
  checkoutBook,
  createCatalogBook,
  findUserByEmail,
  getAdminOverviewStats,
  getAllActiveHolds,
  getAllLoans,
  getAllMembers,
  getHoldsForUser,
  getInventoryEvents,
  getLoansForUser,
  getRestockAlerts,
  getSessionSecret,
  getUserProfileById,
  listCatalogBooks,
  markRestockOrdered,
  placeHold,
  registerMemberAccount,
  renewLoan,
  restockBookCopies,
  returnLoan,
  toggleMemberStatus,
  updateCatalogBook,
  waiveLoanFine,
  writeOffLostCopy,
} from './src/server/db.ts';

const PORT = Number(process.env.PORT) || 3000;
const sessionSecret = getSessionSecret();
const { requireAuth, requireAdmin } = makeAuthMiddleware(sessionSecret);

const app = express();
app.use(express.json({ limit: '1mb' }));

function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

// ============================================================================
// Authentication Routes
// ============================================================================

app.post('/api/auth/login', (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const portalRole = req.body?.portalRole ? String(req.body.portalRole) : undefined;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const userRow = findUserByEmail(email);
    if (!userRow || !verifyPassword(password, userRow.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    if (portalRole === 'admin' && userRow.role !== 'admin') {
      res.status(403).json({
        error: 'Access denied: Member accounts do not have Librarian Admin privileges.',
      });
      return;
    }

    const profile = getUserProfileById(userRow.id);
    if (!profile) {
      res.status(404).json({ error: 'Account profile not found.' });
      return;
    }

    const token = createSessionToken(profile.id, profile.role, sessionSecret);
    setSessionCookie(res, token);
    res.json({ token, user: profile });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Unable to complete sign-in.' });
  }
});

app.post('/api/auth/register', (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim();
    const name = String(req.body?.name || '').trim();
    const password = String(req.body?.password || '');
    const department = String(req.body?.department || 'General Patron').trim();

    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (name.length < 2) {
      res.status(400).json({ error: 'Please enter your full name.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      return;
    }

    const profile = registerMemberAccount({ email, name, password, department });
    const token = createSessionToken(profile.id, profile.role, sessionSecret);
    setSessionCookie(res, token);
    res.status(201).json({ token, user: profile });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registration failed.';
    res.status(400).json({ error: message });
  }
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = getUserProfileById(req.auth!.uid);
    if (!profile) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    res.json({ user: profile });
  } catch (err) {
    console.error('Fetch current user error:', err);
    res.status(500).json({ error: 'Unable to load account profile.' });
  }
});

app.post('/api/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// ============================================================================
// Authenticated Catalog Route
// ============================================================================

app.get('/api/catalog', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const isAdmin = req.auth?.role === 'admin';
    const includeArchived = isAdmin && req.query.archived === '1';
    const allBooks = listCatalogBooks(req.auth?.uid, includeArchived);
    const books = isAdmin ? allBooks : allBooks.filter((b) => b.availableCopies > 0);
    res.json({ books });
  } catch (err) {
    console.error('Catalog load error:', err);
    res.status(500).json({ error: 'Unable to load library catalog.' });
  }
});

// ============================================================================
// Patron / Member Routes (Authenticated)
// ============================================================================

app.get('/api/member/dashboard', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.auth!.uid;
    const profile = getUserProfileById(userId);
    if (!profile) {
      res.status(404).json({ error: 'Member profile not found.' });
      return;
    }
    const loans = getLoansForUser(userId);
    const holds = getHoldsForUser(userId);
    const books = listCatalogBooks(userId, false).filter((b) => b.availableCopies > 0);
    res.json({ profile, loans, holds, books });
  } catch (err) {
    console.error('Member dashboard error:', err);
    res.status(500).json({ error: 'Failed to load member dashboard.' });
  }
});

app.post('/api/member/borrow', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const bookId = Number(req.body?.bookId);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      res.status(400).json({ error: 'Invalid book ID.' });
      return;
    }
    const result = checkoutBook({
      targetUserId: req.auth!.uid,
      bookId,
      actorUserId: req.auth!.uid,
      viaDesk: false,
    });
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to borrow book.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/member/loans/:loanId/renew', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const loanId = Number(req.params.loanId);
    if (!Number.isInteger(loanId) || loanId <= 0) {
      res.status(400).json({ error: 'Invalid loan ID.' });
      return;
    }
    const result = renewLoan(loanId, req.auth!.uid, req.auth!.role === 'admin');
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to renew loan.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/member/loans/:loanId/return', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const loanId = Number(req.params.loanId);
    if (!Number.isInteger(loanId) || loanId <= 0) {
      res.status(400).json({ error: 'Invalid loan ID.' });
      return;
    }
    const result = returnLoan(loanId, req.auth!.uid, req.auth!.role === 'admin');
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to return book.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/member/holds', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const bookId = Number(req.body?.bookId);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      res.status(400).json({ error: 'Invalid book ID.' });
      return;
    }
    const result = placeHold(req.auth!.uid, bookId);
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to place hold.';
    res.status(400).json({ error: message });
  }
});

app.delete('/api/member/holds/:holdId', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const holdId = Number(req.params.holdId);
    if (!Number.isInteger(holdId) || holdId <= 0) {
      res.status(400).json({ error: 'Invalid hold ID.' });
      return;
    }
    cancelHold(holdId, req.auth!.uid, req.auth!.role === 'admin');
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to cancel hold.';
    res.status(400).json({ error: message });
  }
});

// ============================================================================
// Librarian Administrator Routes (Strictly Role-Guarded)
// ============================================================================

app.get(
  '/api/admin/dashboard',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = getAdminOverviewStats();
      const books = listCatalogBooks(req.auth!.uid, false);
      const alerts = getRestockAlerts();
      const loans = getAllLoans();
      const holds = getAllActiveHolds();
      const events = getInventoryEvents(80);
      const members = getAllMembers();
      res.json({ stats, books, alerts, loans, holds, events, members });
    } catch (err) {
      console.error('Admin dashboard error:', err);
      res.status(500).json({ error: 'Failed to load librarian administration data.' });
    }
  }
);

app.post('/api/admin/books', requireAuth, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = req.body || {};
    const isbn = String(body.isbn || '').trim();
    const title = String(body.title || '').trim();
    const author = String(body.author || '').trim();
    const category = String(body.category || 'General Collection').trim();
    const publicationYear = Number(body.publicationYear) || new Date().getFullYear();
    const publisher = String(body.publisher || 'Universities Press India').trim();
    const callNumber = String(body.callNumber || '').trim();
    const shelfLocation = String(body.shelfLocation || '').trim();
    const synopsis = String(body.synopsis || '').trim();
    const totalCopies = Number(body.totalCopies);
    const reorderThreshold = Number(body.reorderThreshold ?? 2);

    if (!isbn || !title || !author || !callNumber || !shelfLocation) {
      res.status(400).json({
        error: 'ISBN, title, author, call number, and shelf location are required.',
      });
      return;
    }
    if (!Number.isInteger(totalCopies) || totalCopies < 1 || totalCopies > 200) {
      res.status(400).json({ error: 'Total copies must be an integer between 1 and 200.' });
      return;
    }

    const created = createCatalogBook(
      {
        isbn,
        title,
        author,
        category,
        publicationYear,
        publisher,
        callNumber,
        shelfLocation,
        synopsis: synopsis || 'Cataloged library monograph.',
        totalCopies,
        reorderThreshold: Number.isInteger(reorderThreshold) && reorderThreshold >= 0 ? reorderThreshold : 2,
      },
      req.auth!.uid
    );
    res.status(201).json({ book: created });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to create catalog record.';
    res.status(400).json({ error: message });
  }
});

app.patch(
  '/api/admin/books/:bookId',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const bookId = Number(req.params.bookId);
      const body = req.body || {};
      if (!Number.isInteger(bookId) || bookId <= 0) {
        res.status(400).json({ error: 'Invalid book ID.' });
        return;
      }
      updateCatalogBook(
        bookId,
        {
          title: String(body.title || ''),
          author: String(body.author || ''),
          category: String(body.category || ''),
          publicationYear: Number(body.publicationYear) || new Date().getFullYear(),
          publisher: String(body.publisher || ''),
          callNumber: String(body.callNumber || ''),
          shelfLocation: String(body.shelfLocation || ''),
          synopsis: String(body.synopsis || ''),
          reorderThreshold: Math.max(0, Number(body.reorderThreshold ?? 2)),
        },
        req.auth!.uid
      );
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update catalog record.';
      res.status(400).json({ error: message });
    }
  }
);

app.delete(
  '/api/admin/books/:bookId',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const bookId = Number(req.params.bookId);
      if (!Number.isInteger(bookId) || bookId <= 0) {
        res.status(400).json({ error: 'Invalid book ID.' });
        return;
      }
      archiveCatalogBook(bookId, req.auth!.uid);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to archive book.';
      res.status(400).json({ error: message });
    }
  }
);

app.post(
  '/api/admin/books/:bookId/restock',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const bookId = Number(req.params.bookId);
      const quantity = Number(req.body?.quantity);
      const notes = req.body?.notes ? String(req.body.notes) : undefined;
      if (!Number.isInteger(bookId) || bookId <= 0) {
        res.status(400).json({ error: 'Invalid book ID.' });
        return;
      }
      const result = restockBookCopies(bookId, quantity, req.auth!.uid, notes);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Restock failed.';
      res.status(400).json({ error: message });
    }
  }
);

app.post(
  '/api/admin/books/:bookId/writeoff',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const bookId = Number(req.params.bookId);
      const loanId = req.body?.loanId ? Number(req.body.loanId) : undefined;
      if (!Number.isInteger(bookId) || bookId <= 0) {
        res.status(400).json({ error: 'Invalid book ID.' });
        return;
      }
      writeOffLostCopy(bookId, req.auth!.uid, loanId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Write-off failed.';
      res.status(400).json({ error: message });
    }
  }
);

app.post(
  '/api/admin/alerts/:alertId/order',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const alertId = Number(req.params.alertId);
      if (!Number.isInteger(alertId) || alertId <= 0) {
        res.status(400).json({ error: 'Invalid alert ID.' });
        return;
      }
      markRestockOrdered(alertId, req.auth!.uid);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to place purchase order.';
      res.status(400).json({ error: message });
    }
  }
);

app.post(
  '/api/admin/circulation/checkout',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const targetUserId = Number(req.body?.userId);
      const bookId = Number(req.body?.bookId);
      if (!Number.isInteger(targetUserId) || !Number.isInteger(bookId)) {
        res.status(400).json({ error: 'Valid patron and book selection required.' });
        return;
      }
      const result = checkoutBook({
        targetUserId,
        bookId,
        actorUserId: req.auth!.uid,
        viaDesk: true,
      });
      res.status(201).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Desk checkout failed.';
      res.status(400).json({ error: message });
    }
  }
);

app.post(
  '/api/admin/loans/:loanId/return',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const loanId = Number(req.params.loanId);
      if (!Number.isInteger(loanId) || loanId <= 0) {
        res.status(400).json({ error: 'Invalid loan ID.' });
        return;
      }
      const result = returnLoan(loanId, req.auth!.uid, true);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Return check-in failed.';
      res.status(400).json({ error: message });
    }
  }
);

app.post(
  '/api/admin/loans/:loanId/waive-fine',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const loanId = Number(req.params.loanId);
      if (!Number.isInteger(loanId) || loanId <= 0) {
        res.status(400).json({ error: 'Invalid loan ID.' });
        return;
      }
      waiveLoanFine(loanId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to waive fee.';
      res.status(400).json({ error: message });
    }
  }
);

app.post(
  '/api/admin/members/:userId/toggle-status',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        res.status(400).json({ error: 'Invalid member ID.' });
        return;
      }
      const nextStatus = toggleMemberStatus(userId);
      res.json({ status: nextStatus });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update member status.';
      res.status(400).json({ error: message });
    }
  }
);

// ============================================================================
// Frontend Vite / Static Serving
// ============================================================================

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (isProd && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SmartLib server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
