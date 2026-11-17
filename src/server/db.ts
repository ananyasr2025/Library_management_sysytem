import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './auth.ts';
import type {
  AdminOverviewStats,
  BookRecord,
  InventoryEventRecord,
  LoanRecord,
  ReservationRecord,
  RestockAlertRecord,
  UserProfile,
} from '../shared/types.ts';

const DB_PATH = path.resolve(process.cwd(), 'library.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('member', 'admin')),
    card_number TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL DEFAULT 'General Member',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
    max_loans INTEGER NOT NULL DEFAULT 5,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    isbn TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    category TEXT NOT NULL,
    publication_year INTEGER NOT NULL,
    publisher TEXT NOT NULL,
    call_number TEXT NOT NULL,
    shelf_location TEXT NOT NULL,
    synopsis TEXT NOT NULL,
    cover_url TEXT NOT NULL,
    total_copies INTEGER NOT NULL DEFAULT 1,
    available_copies INTEGER NOT NULL DEFAULT 1,
    reorder_threshold INTEGER NOT NULL DEFAULT 2,
    archived INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    book_id INTEGER NOT NULL REFERENCES books(id),
    checked_out_at TEXT NOT NULL,
    due_date TEXT NOT NULL,
    returned_at TEXT,
    renewals_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('active', 'returned', 'lost')),
    fine_cents INTEGER NOT NULL DEFAULT 0,
    fine_paid INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    book_id INTEGER NOT NULL REFERENCES books(id),
    created_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('waiting', 'fulfilled', 'cancelled'))
  );

  CREATE TABLE IF NOT EXISTS restock_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id),
    trigger_reason TEXT NOT NULL,
    suggested_qty INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open', 'ordered', 'resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS inventory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id),
    actor_user_id INTEGER REFERENCES users(id),
    event_type TEXT NOT NULL,
    delta INTEGER NOT NULL DEFAULT 0,
    resulting_available INTEGER NOT NULL,
    resulting_total INTEGER NOT NULL,
    notes TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function runInTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  const existing = db.prepare('SELECT value FROM system_meta WHERE key = ?').get('session_secret') as
    | { value: string }
    | undefined;
  if (existing?.value) {
    return existing.value;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO system_meta (key, value) VALUES (?, ?)').run('session_secret', generated);
  return generated;
}

function isoDaysOffset(days: number): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

const DAILY_FINE_PAISE = 1000; // ₹10.00 per day overdue

function computeOverdueMetrics(dueDateIso: string, status: string, storedFinePaise: number) {
  if (status !== 'active') {
    return {
      isOverdue: false,
      daysOverdue: 0,
      daysRemaining: 0,
      computedFineCents: storedFinePaise,
    };
  }
  const diffMs = new Date(dueDateIso).getTime() - Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (diffMs < 0) {
    const daysOverdue = Math.max(1, Math.ceil(Math.abs(diffMs) / dayMs));
    return {
      isOverdue: true,
      daysOverdue,
      daysRemaining: 0,
      computedFineCents: daysOverdue * DAILY_FINE_PAISE,
    };
  }
  const daysRemaining = Math.ceil(diffMs / dayMs);
  return {
    isOverdue: false,
    daysOverdue: 0,
    daysRemaining,
    computedFineCents: storedFinePaise,
  };
}

function logInventoryEvent(params: {
  bookId: number;
  actorUserId: number | null;
  eventType: InventoryEventRecord['eventType'];
  delta: number;
  resultingAvailable: number;
  resultingTotal: number;
  notes: string;
}) {
  db.prepare(
    `INSERT INTO inventory_events (book_id, actor_user_id, event_type, delta, resulting_available, resulting_total, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.bookId,
    params.actorUserId,
    params.eventType,
    params.delta,
    params.resultingAvailable,
    params.resultingTotal,
    params.notes,
    new Date().toISOString()
  );
}

export function evaluateInventoryAutomation(bookId: number, actorUserId: number | null = null) {
  const book = db
    .prepare(
      `SELECT id, title, total_copies, available_copies, reorder_threshold, archived FROM books WHERE id = ?`
    )
    .get(bookId) as
    | {
        id: number;
        title: string;
        total_copies: number;
        available_copies: number;
        reorder_threshold: number;
        archived: number;
      }
    | undefined;

  if (!book || book.archived === 1) return;

  const waitRow = db
    .prepare(`SELECT COUNT(*) as cnt FROM reservations WHERE book_id = ? AND status = 'waiting'`)
    .get(bookId) as { cnt: number };
  const waitingHolds = waitRow.cnt || 0;

  const activeAlert = db
    .prepare(
      `SELECT id, status, trigger_reason, suggested_qty FROM restock_alerts
       WHERE book_id = ? AND status IN ('open', 'ordered')
       ORDER BY id DESC LIMIT 1`
    )
    .get(bookId) as
    | { id: number; status: 'open' | 'ordered'; trigger_reason: string; suggested_qty: number }
    | undefined;

  const needsRestock =
    book.available_copies === 0 ||
    book.available_copies <= book.reorder_threshold ||
    waitingHolds > book.available_copies;

  if (needsRestock) {
    const triggerReason =
      book.available_copies === 0
        ? 'OUT_OF_STOCK'
        : waitingHolds > book.available_copies
          ? 'WAITLIST_DEMAND'
          : 'LOW_STOCK';
    const suggestedQty = Math.max(
      2,
      book.reorder_threshold * 2 - book.available_copies + waitingHolds
    );

    if (activeAlert) {
      if (activeAlert.trigger_reason !== triggerReason || activeAlert.suggested_qty !== suggestedQty) {
        db.prepare(`UPDATE restock_alerts SET trigger_reason = ?, suggested_qty = ? WHERE id = ?`).run(
          triggerReason,
          suggestedQty,
          activeAlert.id
        );
      }
    } else {
      db.prepare(
        `INSERT INTO restock_alerts (book_id, trigger_reason, suggested_qty, status, created_at)
         VALUES (?, ?, ?, 'open', ?)`
      ).run(bookId, triggerReason, suggestedQty, new Date().toISOString());

      logInventoryEvent({
        bookId,
        actorUserId,
        eventType: 'LOW_STOCK_ALERT',
        delta: 0,
        resultingAvailable: book.available_copies,
        resultingTotal: book.total_copies,
        notes: `Automated rule triggered ${triggerReason} alert (available ${book.available_copies}, threshold ${book.reorder_threshold}, holds ${waitingHolds}). Suggested procurement: +${suggestedQty} copies.`,
      });
    }
  } else if (activeAlert) {
    db.prepare(`UPDATE restock_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      activeAlert.id
    );
  }
}

function fulfillNextWaitlistHold(bookId: number): { fulfilledUserId: number; loanId: number } | null {
  const book = db
    .prepare(`SELECT id, title, total_copies, available_copies, archived FROM books WHERE id = ?`)
    .get(bookId) as
    | { id: number; title: string; total_copies: number; available_copies: number; archived: number }
    | undefined;

  if (!book || book.archived === 1 || book.available_copies <= 0) {
    return null;
  }

  const waitingHolds = db
    .prepare(
      `SELECT r.id as hold_id, r.user_id, u.name, u.status as user_status, u.max_loans
       FROM reservations r
       JOIN users u ON u.id = r.user_id
       WHERE r.book_id = ? AND r.status = 'waiting'
       ORDER BY r.created_at ASC, r.id ASC`
    )
    .all(bookId) as Array<{
    hold_id: number;
    user_id: number;
    name: string;
    user_status: string;
    max_loans: number;
  }>;

  for (const hold of waitingHolds) {
    if (hold.user_status !== 'active') continue;
    const activeLoansCount = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM loans WHERE user_id = ? AND status = 'active'`)
        .get(hold.user_id) as { cnt: number }
    ).cnt;
    if (activeLoansCount >= hold.max_loans) continue;

    const alreadyHasBook = db
      .prepare(`SELECT id FROM loans WHERE user_id = ? AND book_id = ? AND status = 'active'`)
      .get(hold.user_id, bookId);
    if (alreadyHasBook) continue;

    const now = new Date().toISOString();
    const dueDate = isoDaysOffset(14);
    db.prepare(`UPDATE reservations SET status = 'fulfilled' WHERE id = ?`).run(hold.hold_id);
    const loanInsert = db
      .prepare(
        `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
         VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
      )
      .run(hold.user_id, bookId, now, dueDate);

    const newAvailable = book.available_copies - 1;
    db.prepare(`UPDATE books SET available_copies = ?, updated_at = ? WHERE id = ?`).run(
      newAvailable,
      now,
      bookId
    );

    logInventoryEvent({
      bookId,
      actorUserId: hold.user_id,
      eventType: 'AUTO_HOLD_FULFILLED',
      delta: -1,
      resultingAvailable: newAvailable,
      resultingTotal: book.total_copies,
      notes: `Waitlist reservation #${hold.hold_id} automatically converted to active loan for ${hold.name}.`,
    });

    return {
      fulfilledUserId: hold.user_id,
      loanId: Number(loanInsert.lastInsertRowid),
    };
  }

  return null;
}

const TARGET_SEED_VERSION = 'smartlib_in_v1';

function seedDatabaseIfNeeded() {
  const seedMeta = db
    .prepare(`SELECT value FROM system_meta WHERE key = ?`)
    .get('seed_version') as { value: string } | undefined;

  if (seedMeta?.value === TARGET_SEED_VERSION) {
    return;
  }

  runInTransaction(() => {
    db.exec(`
      DELETE FROM inventory_events;
      DELETE FROM restock_alerts;
      DELETE FROM reservations;
      DELETE FROM loans;
      DELETE FROM books;
      DELETE FROM users;
    `);

    const now = new Date().toISOString();
    const adminHash = hashPassword('LibrarianAdmin!2026');
    const memberHash = hashPassword('MemberPass!2026');

    const insertUser = db.prepare(
      `INSERT INTO users (email, name, role, card_number, department, status, max_loans, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const adminRes = insertUser.run(
      'arvind.kulkarni@smartlib.in',
      'Dr. Arvind Kulkarni',
      'admin',
      'SL-STAFF-0042',
      'Central Acquisitions & Circulation Desk',
      'active',
      15,
      adminHash,
      isoDaysOffset(-180)
    );
    const adminId = Number(adminRes.lastInsertRowid);

    const ananyaRes = insertUser.run(
      'ananya.sharma@smartlib.in',
      'Ananya Sharma',
      'member',
      'SL-2026-0104',
      'B.Tech Computer Science',
      'active',
      5,
      memberHash,
      isoDaysOffset(-90)
    );
    const ananyaId = Number(ananyaRes.lastInsertRowid);

    const rohanRes = insertUser.run(
      'rohan.deshmukh@smartlib.in',
      'Rohan Deshmukh',
      'member',
      'SL-2026-0119',
      'School of Architecture & Planning',
      'active',
      5,
      memberHash,
      isoDaysOffset(-62)
    );
    const rohanId = Number(rohanRes.lastInsertRowid);

    const meeraRes = insertUser.run(
      'meera.nair@smartlib.in',
      'Meera Nair',
      'member',
      'SL-2026-0131',
      'Civil Services & Public Policy',
      'active',
      5,
      memberHash,
      isoDaysOffset(-40)
    );
    const meeraId = Number(meeraRes.lastInsertRowid);

    const COVER_ARCH = '/src/assets/images/cover_architecture_monograph_1794838843349.jpg';
    const COVER_COMP = '/src/assets/images/cover_systems_computing_1794838843698.jpg';
    const COVER_BOT = '/src/assets/images/cover_botanical_atlas_1794838846180.jpg';
    const COVER_ESSAYS = '/src/assets/images/cover_modern_essays_1794838846767.jpg';

    const seedBooks = [
      {
        isbn: '978-81-7371-146-6',
        title: 'Wings of Fire: An Autobiography',
        author: 'A.P.J. Abdul Kalam & Arun Tiwari',
        category: 'Literature & Biography',
        year: 2023,
        publisher: 'Universities Press India',
        callNumber: 'TL 789.85 .K35',
        shelfLocation: 'Block A · Bay 03',
        synopsis:
          'Chronicles the early life, aerospace research at ISRO and DRDO, and visionary scientific leadership of Dr. A.P.J. Abdul Kalam.',
        coverUrl: COVER_ESSAYS,
        totalCopies: 6,
        availableCopies: 5,
        reorderThreshold: 2,
      },
      {
        isbn: '978-93-5213-524-0',
        title: 'Designing Data-Intensive Applications (Indian Edition)',
        author: 'Martin Kleppmann',
        category: 'Computer Science',
        year: 2024,
        publisher: "Shroff / O'Reilly India",
        callNumber: 'QA 76.9 .D3 K58',
        shelfLocation: 'Block C · Bay 12',
        synopsis:
          'Comprehensive guide to scalable replication, distributed consensus, stream processing, and reliable database internals.',
        coverUrl: COVER_COMP,
        totalCopies: 3,
        availableCopies: 0,
        reorderThreshold: 2,
      },
      {
        isbn: '978-93-5532-534-1',
        title: 'Indian Polity for Civil Services & Academic Reference',
        author: 'M. Laxmikanth',
        category: 'Competitive & Policy',
        year: 2025,
        publisher: 'McGraw Hill Education India',
        callNumber: 'JQ 215 .L39 2025',
        shelfLocation: 'Block D · Bay 01',
        synopsis:
          'Authoritative reference on constitutional law, parliamentary governance, federalism, and statutory institutions in India.',
        coverUrl: COVER_ESSAYS,
        totalCopies: 4,
        availableCopies: 1,
        reorderThreshold: 2,
      },
      {
        isbn: '978-93-8536-060-2',
        title: 'Balkrishna Doshi: Architecture for the People',
        author: 'Mateo Kries & Khushnu Panthaki Hoof',
        category: 'Architecture & Design',
        year: 2022,
        publisher: 'Mapin Publishing Ahmedabad',
        callNumber: 'NA 1510 .D67',
        shelfLocation: 'Block A · Bay 06',
        synopsis:
          'Retrospective monograph on Pritzker laureate Balkrishna Doshi covering Sangath, IIM Bangalore, and low-cost civic housing.',
        coverUrl: COVER_ARCH,
        totalCopies: 4,
        availableCopies: 1,
        reorderThreshold: 2,
      },
      {
        isbn: '978-81-2034-007-7',
        title: 'Introduction to Algorithms (Eastern Economy Edition)',
        author: 'Cormen, Leiserson, Rivest & Stein',
        category: 'Computer Science',
        year: 2024,
        publisher: 'PHI Learning New Delhi',
        callNumber: 'QA 76.6 .I585',
        shelfLocation: 'Block C · Bay 14',
        synopsis:
          'Foundational university reference covering graph theory, dynamic programming, greedy algorithms, and amortised complexity analysis.',
        coverUrl: COVER_COMP,
        totalCopies: 5,
        availableCopies: 4,
        reorderThreshold: 2,
      },
      {
        isbn: '978-81-7296-118-3',
        title: 'Flora of the Western Ghats: A Field Monograph',
        author: 'Dr. Madhav Gadgil & R. Subramanian',
        category: 'Natural Sciences',
        year: 2023,
        publisher: 'Indian Academy of Sciences',
        callNumber: 'QK 358 .G33 2023',
        shelfLocation: 'Block B · Folio 02',
        synopsis:
          'Botanical plates and ecological surveys documenting endemic shola forests, medicinal herbs, and biodiversity corridors.',
        coverUrl: COVER_BOT,
        totalCopies: 4,
        availableCopies: 3,
        reorderThreshold: 1,
      },
      {
        isbn: '978-01-4303-103-1',
        title: 'The Discovery of India',
        author: 'Jawaharlal Nehru',
        category: 'History & Archives',
        year: 2022,
        publisher: 'Penguin Random House India',
        callNumber: 'DS 436 .N44',
        shelfLocation: 'Block D · Bay 04',
        synopsis:
          'Historical and philosophical reflection on India’s civilisational heritage, classical philosophy, and modern independence movement.',
        coverUrl: COVER_ESSAYS,
        totalCopies: 3,
        availableCopies: 2,
        reorderThreshold: 1,
      },
      {
        isbn: '978-81-8598-617-3',
        title: 'Malgudi Days: Complete Archival Edition',
        author: 'R.K. Narayan',
        category: 'Literature & Biography',
        year: 2021,
        publisher: 'Indian Thought Publications Mysuru',
        callNumber: 'PR 9499.3 .N3 M3',
        shelfLocation: 'Block A · Bay 09',
        synopsis:
          'Classic collection of thirty-two short stories set in the fictional South Indian town of Malgudi, capturing everyday warmth and wit.',
        coverUrl: COVER_ESSAYS,
        totalCopies: 5,
        availableCopies: 4,
        reorderThreshold: 2,
      },
      {
        isbn: '978-93-5316-219-1',
        title: 'Database Management Systems & SQL Architectures',
        author: 'Raghu Ramakrishnan & Johannes Gehrke',
        category: 'Computer Science',
        year: 2025,
        publisher: 'McGraw Hill India',
        callNumber: 'QA 76.9 .D3 R36',
        shelfLocation: 'Block C · Bay 11',
        synopsis:
          'Covers relational algebra, B+ tree indexing, normalisation, query optimisation, and ACID transaction recovery for engineering coursework.',
        coverUrl: COVER_COMP,
        totalCopies: 2,
        availableCopies: 0,
        reorderThreshold: 1,
      },
      {
        isbn: '978-05-0028-210-6',
        title: 'Charles Correa: Housing and Urbanisation in India',
        author: 'Charles Correa',
        category: 'Architecture & Design',
        year: 2023,
        publisher: 'UDRI Mumbai Press',
        callNumber: 'NA 1510 .C67',
        shelfLocation: 'Block A · Bay 05',
        synopsis:
          'Explores climate-responsive courtyard architecture, open-to-sky spaces, and high-density urban planning across Indian cities.',
        coverUrl: COVER_ARCH,
        totalCopies: 4,
        availableCopies: 4,
        reorderThreshold: 2,
      },
    ];

    const insertBook = db.prepare(
      `INSERT INTO books (isbn, title, author, category, publication_year, publisher, call_number, shelf_location, synopsis, cover_url, total_copies, available_copies, reorder_threshold, archived, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );

    const bookIds: number[] = [];
    for (const b of seedBooks) {
      const res = insertBook.run(
        b.isbn,
        b.title,
        b.author,
        b.category,
        b.year,
        b.publisher,
        b.callNumber,
        b.shelfLocation,
        b.synopsis,
        b.coverUrl,
        b.totalCopies,
        b.availableCopies,
        b.reorderThreshold,
        now
      );
      const id = Number(res.lastInsertRowid);
      bookIds.push(id);
      logInventoryEvent({
        bookId: id,
        actorUserId: adminId,
        eventType: 'CATALOG_CREATED',
        delta: b.totalCopies,
        resultingAvailable: b.availableCopies,
        resultingTotal: b.totalCopies,
        notes: `Cataloged ${b.totalCopies} initial volume(s) at ${b.shelfLocation}.`,
      });
    }

    // Book 0 (Wings of Fire): total 6, avail 5 -> 1 active loan
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(ananyaId, bookIds[0], isoDaysOffset(-5), isoDaysOffset(9));

    // Book 1 (Designing Data-Intensive): total 3, avail 0 -> 3 active loans (Ananya overdue by 3 days = ₹30)
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(ananyaId, bookIds[1], isoDaysOffset(-17), isoDaysOffset(-3));
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(rohanId, bookIds[1], isoDaysOffset(-8), isoDaysOffset(6));
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 1, 'active', 0, 0)`
    ).run(meeraId, bookIds[1], isoDaysOffset(-12), isoDaysOffset(9));

    // Book 2 (Indian Polity): total 4, avail 1 -> 3 active loans
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(rohanId, bookIds[2], isoDaysOffset(-4), isoDaysOffset(10));
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(meeraId, bookIds[2], isoDaysOffset(-6), isoDaysOffset(8));
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(ananyaId, bookIds[2], isoDaysOffset(-2), isoDaysOffset(12));

    // Book 3 (Balkrishna Doshi): total 4, avail 1 -> 3 active loans (Rohan overdue by 4 days = ₹40)
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(rohanId, bookIds[3], isoDaysOffset(-18), isoDaysOffset(-4));
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(meeraId, bookIds[3], isoDaysOffset(-7), isoDaysOffset(7));
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(adminId, bookIds[3], isoDaysOffset(-1), isoDaysOffset(13));

    // Book 4 (Introduction to Algorithms): total 5, avail 4 -> 1 active loan
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(rohanId, bookIds[4], isoDaysOffset(-5), isoDaysOffset(9));

    // Book 5 (Flora of Western Ghats): total 4, avail 3 -> 1 active loan
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(ananyaId, bookIds[5], isoDaysOffset(-10), isoDaysOffset(4));

    // Book 6 (Discovery of India): total 3, avail 2 -> 1 returned + 1 active
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, returned_at, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, ?, 0, 'returned', 0, 0)`
    ).run(ananyaId, bookIds[6], isoDaysOffset(-32), isoDaysOffset(-18), isoDaysOffset(-20));
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(meeraId, bookIds[6], isoDaysOffset(-2), isoDaysOffset(12));

    // Book 7 (Malgudi Days): total 5, avail 4 -> 1 active loan
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(meeraId, bookIds[7], isoDaysOffset(-3), isoDaysOffset(11));

    // Book 8 (DBMS & SQL Architectures): total 2, avail 0 -> 2 active loans + 1 waiting hold by Ananya
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(rohanId, bookIds[8], isoDaysOffset(-9), isoDaysOffset(5));
    db.prepare(
      `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
       VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
    ).run(meeraId, bookIds[8], isoDaysOffset(-4), isoDaysOffset(10));

    db.prepare(
      `INSERT INTO reservations (user_id, book_id, created_at, status)
       VALUES (?, ?, ?, 'waiting')`
    ).run(ananyaId, bookIds[8], isoDaysOffset(-1));

    for (const id of bookIds) {
      evaluateInventoryAutomation(id, adminId);
    }

    db.prepare(
      `INSERT INTO system_meta (key, value) VALUES ('seed_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(TARGET_SEED_VERSION);
  });
}

seedDatabaseIfNeeded();

export function findUserByEmail(email: string) {
  return db
    .prepare(
      `SELECT id, email, name, role, card_number, department, status, max_loans, password_hash, created_at
       FROM users WHERE LOWER(email) = LOWER(?)`
    )
    .get(email.trim()) as
    | {
        id: number;
        email: string;
        name: string;
        role: 'member' | 'admin';
        card_number: string;
        department: string;
        status: 'active' | 'suspended';
        max_loans: number;
        password_hash: string;
        created_at: string;
      }
    | undefined;
}

export function getUserProfileById(userId: number): UserProfile | null {
  const row = db
    .prepare(
      `SELECT id, email, name, role, card_number, department, status, max_loans, created_at
       FROM users WHERE id = ?`
    )
    .get(userId) as
    | {
        id: number;
        email: string;
        name: string;
        role: 'member' | 'admin';
        card_number: string;
        department: string;
        status: 'active' | 'suspended';
        max_loans: number;
        created_at: string;
      }
    | undefined;
  if (!row) return null;

  const loans = getLoansForUser(userId);
  const activeLoans = loans.filter((l) => l.status === 'active');
  const overdueCount = activeLoans.filter((l) => l.isOverdue).length;
  const totalFinesCents = loans
    .filter((l) => !l.finePaid)
    .reduce((sum, l) => sum + l.computedFineCents, 0);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    cardNumber: row.card_number,
    department: row.department,
    status: row.status,
    maxLoans: row.max_loans,
    createdAt: row.created_at,
    activeLoanCount: activeLoans.length,
    overdueCount,
    totalFinesCents,
  };
}

export function registerMemberAccount(params: {
  email: string;
  name: string;
  password: string;
  department: string;
}): UserProfile {
  return runInTransaction(() => {
    const existing = findUserByEmail(params.email);
    if (existing) {
      throw new Error('An account with this email address already exists.');
    }
    const seq =
      (db.prepare(`SELECT COUNT(*) as cnt FROM users`).get() as { cnt: number }).cnt + 140;
    const cardNumber = `SL-2026-0${seq}`;
    const now = new Date().toISOString();
    const res = db
      .prepare(
        `INSERT INTO users (email, name, role, card_number, department, status, max_loans, password_hash, created_at)
         VALUES (?, ?, 'member', ?, ?, 'active', 5, ?, ?)`
      )
      .run(
        params.email.trim().toLowerCase(),
        params.name.trim(),
        cardNumber,
        params.department.trim() || 'General Member',
        hashPassword(params.password),
        now
      );

    const profile = getUserProfileById(Number(res.lastInsertRowid));
    if (!profile) throw new Error('Failed to load newly created member profile.');
    return profile;
  });
}

export function listCatalogBooks(viewerUserId?: number, includeArchived = false): BookRecord[] {
  const rows = db
    .prepare(
      `SELECT id, isbn, title, author, category, publication_year, publisher, call_number, shelf_location,
              synopsis, cover_url, total_copies, available_copies, reorder_threshold, archived, updated_at
       FROM books
       ${includeArchived ? '' : 'WHERE archived = 0'}
       ORDER BY title ASC`
    )
    .all() as Array<{
    id: number;
    isbn: string;
    title: string;
    author: string;
    category: string;
    publication_year: number;
    publisher: string;
    call_number: string;
    shelf_location: string;
    synopsis: string;
    cover_url: string;
    total_copies: number;
    available_copies: number;
    reorder_threshold: number;
    archived: number;
    updated_at: string;
  }>;

  const activeLoanCounts = new Map<number, number>();
  for (const r of db
    .prepare(`SELECT book_id, COUNT(*) as cnt FROM loans WHERE status = 'active' GROUP BY book_id`)
    .all() as Array<{ book_id: number; cnt: number }>) {
    activeLoanCounts.set(r.book_id, r.cnt);
  }

  const waitlistCounts = new Map<number, number>();
  for (const r of db
    .prepare(`SELECT book_id, COUNT(*) as cnt FROM reservations WHERE status = 'waiting' GROUP BY book_id`)
    .all() as Array<{ book_id: number; cnt: number }>) {
    waitlistCounts.set(r.book_id, r.cnt);
  }

  const userLoanMap = new Map<number, number>();
  const userHoldMap = new Map<number, { id: number; pos: number }>();

  if (viewerUserId) {
    for (const l of db
      .prepare(`SELECT id, book_id FROM loans WHERE user_id = ? AND status = 'active'`)
      .all(viewerUserId) as Array<{ id: number; book_id: number }>) {
      userLoanMap.set(l.book_id, l.id);
    }

    const allWaiting = db
      .prepare(
        `SELECT id, user_id, book_id FROM reservations WHERE status = 'waiting' ORDER BY created_at ASC, id ASC`
      )
      .all() as Array<{ id: number; user_id: number; book_id: number }>;
    const posCounters = new Map<number, number>();
    for (const h of allWaiting) {
      const nextPos = (posCounters.get(h.book_id) ?? 0) + 1;
      posCounters.set(h.book_id, nextPos);
      if (h.user_id === viewerUserId) {
        userHoldMap.set(h.book_id, { id: h.id, pos: nextPos });
      }
    }
  }

  return rows.map((b) => {
    const stockHealth: BookRecord['stockHealth'] =
      b.available_copies <= 0
        ? 'out'
        : b.available_copies <= b.reorder_threshold
          ? 'low'
          : 'healthy';
    const userHold = userHoldMap.get(b.id);
    return {
      id: b.id,
      isbn: b.isbn,
      title: b.title,
      author: b.author,
      category: b.category,
      publicationYear: b.publication_year,
      publisher: b.publisher,
      callNumber: b.call_number,
      shelfLocation: b.shelf_location,
      synopsis: b.synopsis,
      coverUrl: b.cover_url,
      totalCopies: b.total_copies,
      availableCopies: b.available_copies,
      reorderThreshold: b.reorder_threshold,
      archived: b.archived === 1,
      updatedAt: b.updated_at,
      activeLoansCount: activeLoanCounts.get(b.id) ?? 0,
      waitlistCount: waitlistCounts.get(b.id) ?? 0,
      stockHealth,
      userLoanId: userLoanMap.get(b.id) ?? null,
      userHoldId: userHold?.id ?? null,
      userHoldPosition: userHold?.pos ?? null,
    };
  });
}

function mapLoanRows(
  rows: Array<{
    id: number;
    user_id: number;
    user_name: string;
    user_email: string;
    user_card_number: string;
    book_id: number;
    book_title: string;
    book_author: string;
    book_isbn: string;
    book_call_number: string;
    book_cover_url: string;
    checked_out_at: string;
    due_date: string;
    returned_at: string | null;
    renewals_count: number;
    status: 'active' | 'returned' | 'lost';
    fine_cents: number;
    fine_paid: number;
  }>
): LoanRecord[] {
  const holdBookIds = new Set<number>(
    (
      db.prepare(`SELECT DISTINCT book_id FROM reservations WHERE status = 'waiting'`).all() as Array<{
        book_id: number;
      }>
    ).map((r) => r.book_id)
  );

  return rows.map((r) => {
    const metrics = computeOverdueMetrics(r.due_date, r.status, r.fine_cents);
    return {
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      userCardNumber: r.user_card_number,
      bookId: r.book_id,
      bookTitle: r.book_title,
      bookAuthor: r.book_author,
      bookIsbn: r.book_isbn,
      bookCallNumber: r.book_call_number,
      bookCoverUrl: r.book_cover_url,
      checkedOutAt: r.checked_out_at,
      dueDate: r.due_date,
      returnedAt: r.returned_at,
      renewalsCount: r.renewals_count,
      status: r.status,
      fineCents: r.fine_cents,
      finePaid: r.fine_paid === 1,
      isOverdue: metrics.isOverdue,
      daysOverdue: metrics.daysOverdue,
      daysRemaining: metrics.daysRemaining,
      computedFineCents: metrics.computedFineCents,
      hasWaitingHolds: holdBookIds.has(r.book_id),
    };
  });
}

export function getLoansForUser(userId: number): LoanRecord[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.user_id, u.name as user_name, u.email as user_email, u.card_number as user_card_number,
              l.book_id, b.title as book_title, b.author as book_author, b.isbn as book_isbn,
              b.call_number as book_call_number, b.cover_url as book_cover_url,
              l.checked_out_at, l.due_date, l.returned_at, l.renewals_count, l.status, l.fine_cents, l.fine_paid
       FROM loans l
       JOIN users u ON u.id = l.user_id
       JOIN books b ON b.id = l.book_id
       WHERE l.user_id = ?
       ORDER BY CASE WHEN l.status = 'active' THEN 0 ELSE 1 END, l.due_date ASC`
    )
    .all(userId) as Parameters<typeof mapLoanRows>[0];
  return mapLoanRows(rows);
}

export function getAllLoans(): LoanRecord[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.user_id, u.name as user_name, u.email as user_email, u.card_number as user_card_number,
              l.book_id, b.title as book_title, b.author as book_author, b.isbn as book_isbn,
              b.call_number as book_call_number, b.cover_url as book_cover_url,
              l.checked_out_at, l.due_date, l.returned_at, l.renewals_count, l.status, l.fine_cents, l.fine_paid
       FROM loans l
       JOIN users u ON u.id = l.user_id
       JOIN books b ON b.id = l.book_id
       ORDER BY CASE WHEN l.status = 'active' THEN 0 ELSE 1 END, l.due_date ASC`
    )
    .all() as Parameters<typeof mapLoanRows>[0];
  return mapLoanRows(rows);
}

export function getHoldsForUser(userId: number): ReservationRecord[] {
  const allWaiting = db
    .prepare(
      `SELECT id, book_id FROM reservations WHERE status = 'waiting' ORDER BY created_at ASC, id ASC`
    )
    .all() as Array<{ id: number; book_id: number }>;
  const positionById = new Map<number, number>();
  const bookCounters = new Map<number, number>();
  for (const h of allWaiting) {
    const pos = (bookCounters.get(h.book_id) ?? 0) + 1;
    bookCounters.set(h.book_id, pos);
    positionById.set(h.id, pos);
  }

  const rows = db
    .prepare(
      `SELECT r.id, r.user_id, u.name as user_name, u.email as user_email, u.card_number as user_card_number,
              r.book_id, b.title as book_title, b.author as book_author, b.isbn as book_isbn,
              b.cover_url as book_cover_url, b.available_copies as book_available_copies,
              r.created_at, r.status
       FROM reservations r
       JOIN users u ON u.id = r.user_id
       JOIN books b ON b.id = r.book_id
       WHERE r.user_id = ? AND r.status = 'waiting'
       ORDER BY r.created_at DESC`
    )
    .all(userId) as Array<{
    id: number;
    user_id: number;
    user_name: string;
    user_email: string;
    user_card_number: string;
    book_id: number;
    book_title: string;
    book_author: string;
    book_isbn: string;
    book_cover_url: string;
    book_available_copies: number;
    created_at: string;
    status: 'waiting' | 'fulfilled' | 'cancelled';
  }>;

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    userCardNumber: r.user_card_number,
    bookId: r.book_id,
    bookTitle: r.book_title,
    bookAuthor: r.book_author,
    bookIsbn: r.book_isbn,
    bookCoverUrl: r.book_cover_url,
    bookAvailableCopies: r.book_available_copies,
    createdAt: r.created_at,
    status: r.status,
    queuePosition: positionById.get(r.id) ?? 1,
  }));
}

export function getAllActiveHolds(): ReservationRecord[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.user_id, u.name as user_name, u.email as user_email, u.card_number as user_card_number,
              r.book_id, b.title as book_title, b.author as book_author, b.isbn as book_isbn,
              b.cover_url as book_cover_url, b.available_copies as book_available_copies,
              r.created_at, r.status
       FROM reservations r
       JOIN users u ON u.id = r.user_id
       JOIN books b ON b.id = r.book_id
       WHERE r.status = 'waiting'
       ORDER BY r.book_id ASC, r.created_at ASC, r.id ASC`
    )
    .all() as Array<{
    id: number;
    user_id: number;
    user_name: string;
    user_email: string;
    user_card_number: string;
    book_id: number;
    book_title: string;
    book_author: string;
    book_isbn: string;
    book_cover_url: string;
    book_available_copies: number;
    created_at: string;
    status: 'waiting' | 'fulfilled' | 'cancelled';
  }>;

  const bookCounters = new Map<number, number>();
  return rows.map((r) => {
    const pos = (bookCounters.get(r.book_id) ?? 0) + 1;
    bookCounters.set(r.book_id, pos);
    return {
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      userCardNumber: r.user_card_number,
      bookId: r.book_id,
      bookTitle: r.book_title,
      bookAuthor: r.book_author,
      bookIsbn: r.book_isbn,
      bookCoverUrl: r.book_cover_url,
      bookAvailableCopies: r.book_available_copies,
      createdAt: r.created_at,
      status: r.status,
      queuePosition: pos,
    };
  });
}

export function checkoutBook(params: {
  targetUserId: number;
  bookId: number;
  actorUserId: number;
  viaDesk?: boolean;
}) {
  return runInTransaction(() => {
    const user = db
      .prepare(`SELECT id, name, status, max_loans FROM users WHERE id = ?`)
      .get(params.targetUserId) as
      | { id: number; name: string; status: string; max_loans: number }
      | undefined;
    if (!user) throw new Error('Member account not found.');
    if (user.status !== 'active') throw new Error('Member account is currently suspended.');

    const book = db
      .prepare(
        `SELECT id, title, total_copies, available_copies, archived FROM books WHERE id = ?`
      )
      .get(params.bookId) as
      | {
          id: number;
          title: string;
          total_copies: number;
          available_copies: number;
          archived: number;
        }
      | undefined;
    if (!book || book.archived === 1) throw new Error('Book is not available in active catalog.');
    if (book.available_copies <= 0) {
      throw new Error('All copies are currently checked out. Place a hold on this title instead.');
    }

    const activeCount = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM loans WHERE user_id = ? AND status = 'active'`)
        .get(user.id) as { cnt: number }
    ).cnt;
    if (activeCount >= user.max_loans) {
      throw new Error(`Borrowing limit reached (${user.max_loans} active loans maximum).`);
    }

    const duplicate = db
      .prepare(`SELECT id FROM loans WHERE user_id = ? AND book_id = ? AND status = 'active'`)
      .get(user.id, book.id);
    if (duplicate) {
      throw new Error('This member already has an active loan for this title.');
    }

    const now = new Date().toISOString();
    const dueDate = isoDaysOffset(14);
    const loanRes = db
      .prepare(
        `INSERT INTO loans (user_id, book_id, checked_out_at, due_date, renewals_count, status, fine_cents, fine_paid)
         VALUES (?, ?, ?, ?, 0, 'active', 0, 0)`
      )
      .run(user.id, book.id, now, dueDate);

    db.prepare(
      `UPDATE reservations SET status = 'fulfilled' WHERE user_id = ? AND book_id = ? AND status = 'waiting'`
    ).run(user.id, book.id);

    const newAvailable = book.available_copies - 1;
    db.prepare(`UPDATE books SET available_copies = ?, updated_at = ? WHERE id = ?`).run(
      newAvailable,
      now,
      book.id
    );

    logInventoryEvent({
      bookId: book.id,
      actorUserId: params.actorUserId,
      eventType: 'CHECKOUT',
      delta: -1,
      resultingAvailable: newAvailable,
      resultingTotal: book.total_copies,
      notes: params.viaDesk
        ? `Desk checkout issued to ${user.name} (due ${dueDate.slice(0, 10)}).`
        : `Self-service checkout by ${user.name} (due ${dueDate.slice(0, 10)}).`,
    });

    evaluateInventoryAutomation(book.id, params.actorUserId);

    return { loanId: Number(loanRes.lastInsertRowid), dueDate };
  });
}

export function renewLoan(loanId: number, actorUserId: number, isAdmin: boolean) {
  return runInTransaction(() => {
    const loan = db
      .prepare(
        `SELECT id, user_id, book_id, due_date, renewals_count, status FROM loans WHERE id = ?`
      )
      .get(loanId) as
      | {
          id: number;
          user_id: number;
          book_id: number;
          due_date: string;
          renewals_count: number;
          status: string;
        }
      | undefined;
    if (!loan) throw new Error('Loan record not found.');
    if (!isAdmin && loan.user_id !== actorUserId) {
      throw new Error('You may only renew your own active loans.');
    }
    if (loan.status !== 'active') throw new Error('Only active loans can be renewed.');
    if (loan.renewals_count >= 2) {
      throw new Error('Maximum of 2 renewals already reached for this loan.');
    }

    const waitingHolds = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM reservations WHERE book_id = ? AND status = 'waiting'`)
        .get(loan.book_id) as { cnt: number }
    ).cnt;
    if (waitingHolds > 0) {
      throw new Error('Cannot renew: another member is currently waiting in the hold queue.');
    }

    const baseTime = Math.max(Date.now(), new Date(loan.due_date).getTime());
    const newDueDate = new Date(baseTime + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`UPDATE loans SET due_date = ?, renewals_count = renewals_count + 1 WHERE id = ?`).run(
      newDueDate,
      loan.id
    );

    return { newDueDate, renewalsCount: loan.renewals_count + 1 };
  });
}

export function returnLoan(loanId: number, actorUserId: number, isAdmin: boolean) {
  return runInTransaction(() => {
    const loan = db
      .prepare(
        `SELECT l.id, l.user_id, l.book_id, l.due_date, l.status, u.name as user_name
         FROM loans l JOIN users u ON u.id = l.user_id WHERE l.id = ?`
      )
      .get(loanId) as
      | {
          id: number;
          user_id: number;
          book_id: number;
          due_date: string;
          status: string;
          user_name: string;
        }
      | undefined;
    if (!loan) throw new Error('Loan record not found.');
    if (!isAdmin && loan.user_id !== actorUserId) {
      throw new Error('You may only return your own active loans.');
    }
    if (loan.status !== 'active') {
      throw new Error('This loan has already been closed.');
    }

    const book = db
      .prepare(`SELECT id, total_copies, available_copies FROM books WHERE id = ?`)
      .get(loan.book_id) as { id: number; total_copies: number; available_copies: number };

    const metrics = computeOverdueMetrics(loan.due_date, 'active', 0);
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE loans SET status = 'returned', returned_at = ?, fine_cents = ? WHERE id = ?`
    ).run(now, metrics.computedFineCents, loan.id);

    const incrementedAvailable = Math.min(book.total_copies, book.available_copies + 1);
    db.prepare(`UPDATE books SET available_copies = ?, updated_at = ? WHERE id = ?`).run(
      incrementedAvailable,
      now,
      book.id
    );

    logInventoryEvent({
      bookId: book.id,
      actorUserId,
      eventType: 'RETURN',
      delta: 1,
      resultingAvailable: incrementedAvailable,
      resultingTotal: book.total_copies,
      notes: `Returned by ${loan.user_name}${metrics.computedFineCents > 0 ? ` (${metrics.daysOverdue}d overdue, ₹${(metrics.computedFineCents / 100).toFixed(2)} fee assessed)` : ''}.`,
    });

    const autoHold = fulfillNextWaitlistHold(book.id);
    evaluateInventoryAutomation(book.id, actorUserId);

    return {
      returnedLoanId: loan.id,
      fineCents: metrics.computedFineCents,
      autoFulfilledHold: autoHold !== null,
    };
  });
}

export function placeHold(userId: number, bookId: number) {
  return runInTransaction(() => {
    const user = db.prepare(`SELECT id, name, status FROM users WHERE id = ?`).get(userId) as
      | { id: number; name: string; status: string }
      | undefined;
    if (!user || user.status !== 'active') throw new Error('Account not eligible to place holds.');

    const book = db
      .prepare(`SELECT id, available_copies, archived FROM books WHERE id = ?`)
      .get(bookId) as { id: number; available_copies: number; archived: number } | undefined;
    if (!book || book.archived === 1) throw new Error('Book not found.');
    if (book.available_copies > 0) {
      throw new Error('Copies are currently available on shelf—you can borrow immediately.');
    }

    const activeLoan = db
      .prepare(`SELECT id FROM loans WHERE user_id = ? AND book_id = ? AND status = 'active'`)
      .get(userId, bookId);
    if (activeLoan) throw new Error('You already have this title checked out.');

    const existingHold = db
      .prepare(`SELECT id FROM reservations WHERE user_id = ? AND book_id = ? AND status = 'waiting'`)
      .get(userId, bookId);
    if (existingHold) throw new Error('You already have an active hold on this title.');

    const now = new Date().toISOString();
    const res = db
      .prepare(`INSERT INTO reservations (user_id, book_id, created_at, status) VALUES (?, ?, ?, 'waiting')`)
      .run(userId, bookId, now);

    evaluateInventoryAutomation(bookId, userId);

    return { holdId: Number(res.lastInsertRowid) };
  });
}

export function cancelHold(holdId: number, actorUserId: number, isAdmin: boolean) {
  return runInTransaction(() => {
    const hold = db
      .prepare(`SELECT id, user_id, book_id, status FROM reservations WHERE id = ?`)
      .get(holdId) as { id: number; user_id: number; book_id: number; status: string } | undefined;
    if (!hold) throw new Error('Hold record not found.');
    if (!isAdmin && hold.user_id !== actorUserId) {
      throw new Error('You may only cancel your own holds.');
    }
    if (hold.status !== 'waiting') throw new Error('Hold is no longer active.');

    db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?`).run(hold.id);
    evaluateInventoryAutomation(hold.book_id, actorUserId);
  });
}

export function createCatalogBook(
  params: {
    isbn: string;
    title: string;
    author: string;
    category: string;
    publicationYear: number;
    publisher: string;
    callNumber: string;
    shelfLocation: string;
    synopsis: string;
    totalCopies: number;
    reorderThreshold: number;
  },
  adminUserId: number
): BookRecord {
  return runInTransaction(() => {
    const existing = db
      .prepare(`SELECT id FROM books WHERE isbn = ?`)
      .get(params.isbn.trim());
    if (existing) throw new Error('A catalog record with this ISBN already exists.');

    const coverByCategory: Record<string, string> = {
      'Architecture & Design': '/src/assets/images/cover_architecture_monograph_1794838843349.jpg',
      'Computer Science': '/src/assets/images/cover_systems_computing_1794838843698.jpg',
      'Natural Sciences': '/src/assets/images/cover_botanical_atlas_1794838846180.jpg',
      'Literature & Biography': '/src/assets/images/cover_modern_essays_1794838846767.jpg',
      'Competitive & Policy': '/src/assets/images/cover_modern_essays_1794838846767.jpg',
      'History & Archives': '/src/assets/images/cover_modern_essays_1794838846767.jpg',
    };
    const coverUrl =
      coverByCategory[params.category] ||
      '/src/assets/images/cover_modern_essays_1794838846767.jpg';

    const now = new Date().toISOString();
    const res = db
      .prepare(
        `INSERT INTO books (isbn, title, author, category, publication_year, publisher, call_number, shelf_location, synopsis, cover_url, total_copies, available_copies, reorder_threshold, archived, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        params.isbn.trim(),
        params.title.trim(),
        params.author.trim(),
        params.category.trim(),
        params.publicationYear,
        params.publisher.trim() || 'Universities Press India',
        params.callNumber.trim(),
        params.shelfLocation.trim(),
        params.synopsis.trim(),
        coverUrl,
        params.totalCopies,
        params.totalCopies,
        params.reorderThreshold,
        now
      );

    const bookId = Number(res.lastInsertRowid);
    logInventoryEvent({
      bookId,
      actorUserId: adminUserId,
      eventType: 'CATALOG_CREATED',
      delta: params.totalCopies,
      resultingAvailable: params.totalCopies,
      resultingTotal: params.totalCopies,
      notes: `Added new catalog entry (${params.totalCopies} copies at ${params.shelfLocation}).`,
    });
    evaluateInventoryAutomation(bookId, adminUserId);

    const created = listCatalogBooks(adminUserId, true).find((b) => b.id === bookId);
    if (!created) throw new Error('Failed to retrieve newly created catalog title.');
    return created;
  });
}

export function updateCatalogBook(
  bookId: number,
  params: {
    title: string;
    author: string;
    category: string;
    publicationYear: number;
    publisher: string;
    callNumber: string;
    shelfLocation: string;
    synopsis: string;
    reorderThreshold: number;
  },
  adminUserId: number
) {
  return runInTransaction(() => {
    const book = db
      .prepare(`SELECT id, total_copies, available_copies FROM books WHERE id = ?`)
      .get(bookId) as { id: number; total_copies: number; available_copies: number } | undefined;
    if (!book) throw new Error('Book not found.');

    db.prepare(
      `UPDATE books
       SET title = ?, author = ?, category = ?, publication_year = ?, publisher = ?, call_number = ?, shelf_location = ?, synopsis = ?, reorder_threshold = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      params.title.trim(),
      params.author.trim(),
      params.category.trim(),
      params.publicationYear,
      params.publisher.trim(),
      params.callNumber.trim(),
      params.shelfLocation.trim(),
      params.synopsis.trim(),
      params.reorderThreshold,
      new Date().toISOString(),
      bookId
    );

    logInventoryEvent({
      bookId,
      actorUserId: adminUserId,
      eventType: 'CATALOG_UPDATED',
      delta: 0,
      resultingAvailable: book.available_copies,
      resultingTotal: book.total_copies,
      notes: `Metadata or reorder threshold (${params.reorderThreshold}) updated by librarian.`,
    });

    evaluateInventoryAutomation(bookId, adminUserId);
  });
}

export function archiveCatalogBook(bookId: number, adminUserId: number) {
  return runInTransaction(() => {
    const activeLoans = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM loans WHERE book_id = ? AND status = 'active'`)
        .get(bookId) as { cnt: number }
    ).cnt;
    if (activeLoans > 0) {
      throw new Error(`Cannot archive title while ${activeLoans} active loan(s) remain checked out.`);
    }

    const book = db
      .prepare(`SELECT id, total_copies, available_copies FROM books WHERE id = ?`)
      .get(bookId) as { id: number; total_copies: number; available_copies: number } | undefined;
    if (!book) throw new Error('Book not found.');

    db.prepare(`UPDATE books SET archived = 1, updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      bookId
    );
    db.prepare(
      `UPDATE restock_alerts SET status = 'resolved', resolved_at = ? WHERE book_id = ? AND status IN ('open', 'ordered')`
    ).run(new Date().toISOString(), bookId);

    logInventoryEvent({
      bookId,
      actorUserId: adminUserId,
      eventType: 'CATALOG_UPDATED',
      delta: 0,
      resultingAvailable: book.available_copies,
      resultingTotal: book.total_copies,
      notes: 'Title archived from active circulation.',
    });
  });
}

export function restockBookCopies(
  bookId: number,
  quantity: number,
  adminUserId: number,
  notes?: string
) {
  return runInTransaction(() => {
    if (quantity <= 0 || quantity > 100) {
      throw new Error('Restock quantity must be between 1 and 100.');
    }
    const book = db
      .prepare(`SELECT id, total_copies, available_copies FROM books WHERE id = ?`)
      .get(bookId) as { id: number; total_copies: number; available_copies: number } | undefined;
    if (!book) throw new Error('Book not found.');

    const newTotal = book.total_copies + quantity;
    const newAvailable = book.available_copies + quantity;
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE books SET total_copies = ?, available_copies = ?, updated_at = ? WHERE id = ?`
    ).run(newTotal, newAvailable, now, bookId);

    logInventoryEvent({
      bookId,
      actorUserId: adminUserId,
      eventType: 'RESTOCK_RECEIVED',
      delta: quantity,
      resultingAvailable: newAvailable,
      resultingTotal: newTotal,
      notes: notes?.trim() || `Received +${quantity} replacement/expansion copy(ies) into inventory.`,
    });

    let fulfilledCount = 0;
    for (let i = 0; i < quantity; i++) {
      const fulfilled = fulfillNextWaitlistHold(bookId);
      if (!fulfilled) break;
      fulfilledCount++;
    }

    evaluateInventoryAutomation(bookId, adminUserId);
    return { newTotal, newAvailable, fulfilledCount };
  });
}

export function writeOffLostCopy(bookId: number, adminUserId: number, loanId?: number) {
  return runInTransaction(() => {
    const book = db
      .prepare(`SELECT id, total_copies, available_copies FROM books WHERE id = ?`)
      .get(bookId) as { id: number; total_copies: number; available_copies: number } | undefined;
    if (!book) throw new Error('Book not found.');
    if (book.total_copies <= 0) throw new Error('No copies remaining to write off.');

    const now = new Date().toISOString();
    let newAvailable = book.available_copies;
    const newTotal = Math.max(0, book.total_copies - 1);

    if (loanId) {
      const loan = db
        .prepare(`SELECT id, status FROM loans WHERE id = ? AND book_id = ?`)
        .get(loanId, bookId) as { id: number; status: string } | undefined;
      if (!loan || loan.status !== 'active') throw new Error('Active loan not found.');
      // ₹500.00 replacement fee (50000 paise)
      db.prepare(
        `UPDATE loans SET status = 'lost', returned_at = ?, fine_cents = fine_cents + 50000 WHERE id = ?`
      ).run(now, loanId);
    } else {
      if (book.available_copies <= 0) {
        throw new Error('No shelf copy available to write off; mark an active loan as lost instead.');
      }
      newAvailable = book.available_copies - 1;
    }

    db.prepare(
      `UPDATE books SET total_copies = ?, available_copies = ?, updated_at = ? WHERE id = ?`
    ).run(newTotal, newAvailable, now, bookId);

    logInventoryEvent({
      bookId,
      actorUserId: adminUserId,
      eventType: 'LOST_WRITEOFF',
      delta: -1,
      resultingAvailable: newAvailable,
      resultingTotal: newTotal,
      notes: loanId
        ? `Loan #${loanId} marked lost; inventory permanently adjusted (-1 total, ₹500.00 replacement fee assessed).`
        : 'Shelf copy written off as damaged/missing (-1 total, -1 available).',
    });

    evaluateInventoryAutomation(bookId, adminUserId);
  });
}

export function markRestockOrdered(alertId: number, adminUserId: number) {
  return runInTransaction(() => {
    const alert = db
      .prepare(
        `SELECT r.id, r.book_id, r.suggested_qty, r.status, b.available_copies, b.total_copies
         FROM restock_alerts r JOIN books b ON b.id = r.book_id WHERE r.id = ?`
      )
      .get(alertId) as
      | {
          id: number;
          book_id: number;
          suggested_qty: number;
          status: string;
          available_copies: number;
          total_copies: number;
        }
      | undefined;
    if (!alert) throw new Error('Restock alert not found.');
    if (alert.status !== 'open') throw new Error('Restock alert is already ordered or resolved.');

    db.prepare(`UPDATE restock_alerts SET status = 'ordered' WHERE id = ?`).run(alertId);

    logInventoryEvent({
      bookId: alert.book_id,
      actorUserId: adminUserId,
      eventType: 'PURCHASE_ORDER_PLACED',
      delta: 0,
      resultingAvailable: alert.available_copies,
      resultingTotal: alert.total_copies,
      notes: `Purchase order dispatched for +${alert.suggested_qty} copies (Alert #${alert.id}).`,
    });
  });
}

export function waiveLoanFine(loanId: number) {
  return runInTransaction(() => {
    const loan = db.prepare(`SELECT id FROM loans WHERE id = ?`).get(loanId);
    if (!loan) throw new Error('Loan record not found.');
    db.prepare(`UPDATE loans SET fine_paid = 1 WHERE id = ?`).run(loanId);
  });
}

export function toggleMemberStatus(userId: number) {
  return runInTransaction(() => {
    const user = db
      .prepare(`SELECT id, role, status FROM users WHERE id = ?`)
      .get(userId) as { id: number; role: string; status: string } | undefined;
    if (!user) throw new Error('User not found.');
    if (user.role === 'admin') throw new Error('Cannot suspend a librarian administrator account.');
    const nextStatus = user.status === 'active' ? 'suspended' : 'active';
    db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(nextStatus, userId);
    return nextStatus;
  });
}

export function getRestockAlerts(): RestockAlertRecord[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.book_id, b.title as book_title, b.author as book_author, b.isbn as book_isbn,
              b.category as book_category, b.available_copies, b.total_copies, b.reorder_threshold,
              r.trigger_reason, r.suggested_qty, r.status, r.created_at, r.resolved_at
       FROM restock_alerts r
       JOIN books b ON b.id = r.book_id
       ORDER BY CASE WHEN r.status = 'open' THEN 0 WHEN r.status = 'ordered' THEN 1 ELSE 2 END, r.created_at DESC`
    )
    .all() as Array<{
    id: number;
    book_id: number;
    book_title: string;
    book_author: string;
    book_isbn: string;
    book_category: string;
    available_copies: number;
    total_copies: number;
    reorder_threshold: number;
    trigger_reason: 'LOW_STOCK' | 'OUT_OF_STOCK' | 'WAITLIST_DEMAND';
    suggested_qty: number;
    status: 'open' | 'ordered' | 'resolved';
    created_at: string;
    resolved_at: string | null;
  }>;

  const waitMap = new Map<number, number>();
  for (const w of db
    .prepare(`SELECT book_id, COUNT(*) as cnt FROM reservations WHERE status = 'waiting' GROUP BY book_id`)
    .all() as Array<{ book_id: number; cnt: number }>) {
    waitMap.set(w.book_id, w.cnt);
  }

  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    bookTitle: r.book_title,
    bookAuthor: r.book_author,
    bookIsbn: r.book_isbn,
    bookCategory: r.book_category,
    availableCopies: r.available_copies,
    totalCopies: r.total_copies,
    reorderThreshold: r.reorder_threshold,
    waitlistCount: waitMap.get(r.book_id) ?? 0,
    triggerReason: r.trigger_reason,
    suggestedQty: r.suggested_qty,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
}

export function getInventoryEvents(limit = 60): InventoryEventRecord[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.book_id, b.title as book_title, b.isbn as book_isbn,
              e.actor_user_id, COALESCE(u.name, 'System Engine') as actor_name,
              e.event_type, e.delta, e.resulting_available, e.resulting_total, e.notes, e.created_at
       FROM inventory_events e
       JOIN books b ON b.id = e.book_id
       LEFT JOIN users u ON u.id = e.actor_user_id
       ORDER BY e.id DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: number;
    book_id: number;
    book_title: string;
    book_isbn: string;
    actor_user_id: number | null;
    actor_name: string;
    event_type: InventoryEventRecord['eventType'];
    delta: number;
    resulting_available: number;
    resulting_total: number;
    notes: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    bookTitle: r.book_title,
    bookIsbn: r.book_isbn,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    eventType: r.event_type,
    delta: r.delta,
    resultingAvailable: r.resulting_available,
    resultingTotal: r.resulting_total,
    notes: r.notes,
    createdAt: r.created_at,
  }));
}

export function getAllMembers(): UserProfile[] {
  const users = db
    .prepare(
      `SELECT id, email, name, role, card_number, department, status, max_loans, created_at
       FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name ASC`
    )
    .all() as Array<{
    id: number;
    email: string;
    name: string;
    role: 'member' | 'admin';
    card_number: string;
    department: string;
    status: 'active' | 'suspended';
    max_loans: number;
    created_at: string;
  }>;

  const allLoans = getAllLoans();
  return users.map((u) => {
    const userLoans = allLoans.filter((l) => l.userId === u.id);
    const active = userLoans.filter((l) => l.status === 'active');
    const overdue = active.filter((l) => l.isOverdue);
    const unpaidFines = userLoans
      .filter((l) => !l.finePaid)
      .reduce((acc, l) => acc + l.computedFineCents, 0);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      cardNumber: u.card_number,
      department: u.department,
      status: u.status,
      maxLoans: u.max_loans,
      createdAt: u.created_at,
      activeLoanCount: active.length,
      overdueCount: overdue.length,
      totalFinesCents: unpaidFines,
    };
  });
}

export function getAdminOverviewStats(): AdminOverviewStats {
  const bookStats = db
    .prepare(
      `SELECT COUNT(*) as titles, COALESCE(SUM(total_copies), 0) as total_vols, COALESCE(SUM(available_copies), 0) as avail_vols
       FROM books WHERE archived = 0`
    )
    .get() as { titles: number; total_vols: number; avail_vols: number };

  const allLoans = getAllLoans();
  const activeLoans = allLoans.filter((l) => l.status === 'active');
  const overdueLoans = activeLoans.filter((l) => l.isOverdue);
  const unpaidFinesCents = allLoans
    .filter((l) => !l.finePaid)
    .reduce((sum, l) => sum + l.computedFineCents, 0);

  const openAlerts = (
    db.prepare(`SELECT COUNT(*) as cnt FROM restock_alerts WHERE status = 'open'`).get() as {
      cnt: number;
    }
  ).cnt;
  const orderedAlerts = (
    db.prepare(`SELECT COUNT(*) as cnt FROM restock_alerts WHERE status = 'ordered'`).get() as {
      cnt: number;
    }
  ).cnt;
  const activeHolds = (
    db.prepare(`SELECT COUNT(*) as cnt FROM reservations WHERE status = 'waiting'`).get() as {
      cnt: number;
    }
  ).cnt;
  const totalMembers = (
    db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'member'`).get() as { cnt: number }
  ).cnt;

  return {
    totalTitles: bookStats.titles,
    totalVolumes: bookStats.total_vols,
    availableVolumes: bookStats.avail_vols,
    activeLoans: activeLoans.length,
    overdueLoans: overdueLoans.length,
    openAlerts,
    orderedAlerts,
    activeHolds,
    totalMembers,
    unpaidFinesCents,
  };
}
