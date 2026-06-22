import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SEED_QUESTIONS } from "../seed/questions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

const DEFAULT_DB = {
  users: {},        // userId -> profile
  accounts: {},     // userId -> { email, passwordHash }
  attempts: {},     // userId -> QuizAttempt[]
  papers: {},       // userId -> GeneratedPaper[]
  questions: [],    // Question[] — global, managed by admin
  documents: [],    // Document[] — uploaded PDF metadata
  pdfPages: [],     // Raw PDF pages extracted when using the new raw parser
  notes: [],        // Note[] — { id, classId, subjectId, chapterId, title, content, attachments, meta, createdAt }
  tests: [],        // Test[] — { id, title, classId, targetTags, durationMinutes, questionIds, published, authorId }
  classes: [],      // ClassRoom[]
  memberships: [],  // Membership[]
  assignments: [],  // Assignment[]  — paper assigned to class
  topics: [],       // Topic[]       — { id, subject, classLevel?, examType?, name, createdAt }
  flashcards: [],   // Flashcard[]   — { id, subject, topic, classLevel?, examType?, question, answer, difficulty?, createdAt }
  pyps: [],         // PreviousYearPaper[] — { id, title, examType, year, subject?, durationMinutes?, questions[], createdAt }
  referrals: [],    // Referral[] — { id, referrerId, referredUserId, referralCode, ... }
  commissions: [],  // CommissionTransaction[] — { id, referrerId, buyerId, orderId, ... }
  payouts: [],      // Payout[] — { id, userId, amount, transactionNote, paidAt }
  studentRewards: [], // StudentReward[] — { id, userId, coins, premiumDays, reason, createdAt }
  payments: [],     // Payment[] — { id, userId, email, name, plan, amount, currency, orderId, paymentId, status, createdAt }
};

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

function read() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_DB, ...parsed };
  } catch {
    return { ...DEFAULT_DB };
  }
}

function write(db) {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function findAccountByEmail(email) {
  const db = read();
  const normalizedEmail = email?.trim().toLowerCase();
  const accounts = db.accounts || {};
  for (const [userId, account] of Object.entries(accounts)) {
    if (account.email === normalizedEmail) {
      return { userId, ...account };
    }
  }
  return null;
}

export const jsonStorage = {
  async getProfile(userId) {
    const db = read();
    return db.users[userId] || null;
  },
  
  async getProfileByEmail(email) {
    const db = read();
    const normalizedEmail = email.trim().toLowerCase();
    for (const [userId, profile] of Object.entries(db.users || {})) {
      if (profile.email?.toLowerCase() === normalizedEmail) {
        return { id: userId, ...profile };
      }
    }
    return null;
  },

  /**
   * Lookup a profile by ANY of: email, username (case-insensitive), or phone.
   * Used for the multi-identifier login flow.
   */
  async getProfileByIdentifier(identifier) {
    const db = read();
    const raw = String(identifier || "").trim();
    if (!raw) return null;
    const norm = raw.toLowerCase();
    const phoneDigits = raw.replace(/\D/g, "");
    for (const [userId, profile] of Object.entries(db.users || {})) {
      if (profile.email?.toLowerCase() === norm) return { id: userId, ...profile };
      if (profile.username?.toLowerCase() === norm) return { id: userId, ...profile };
      const pDigits = (profile.phone || "").replace(/\D/g, "");
      if (phoneDigits && pDigits && pDigits === phoneDigits) return { id: userId, ...profile };
    }
    return null;
  },
  
  async saveProfile(userId, profile) {
    const db = read();
    db.users[userId] = profile;
    write(db);
    return profile;
  },
  async getAttempts(userId) {
    const db = read();
    return db.attempts[userId] || [];
  },
  async addAttempt(userId, attempt) {
    const db = read();
    db.attempts[userId] = [attempt, ...(db.attempts[userId] || [])];
    write(db);
    return attempt;
  },
  async getPapers(userId) {
    const db = read();
    return db.papers[userId] || [];
  },
  async addPaper(userId, paper) {
    const db = read();
    db.papers[userId] = [paper, ...(db.papers[userId] || [])];
    write(db);
    return paper;
  },
  // Cross-user lookup by id. Used by GET /api/papers/:id, which then
  // authorizes the caller (owner OR approved-class-member) separately.
  async getPaperById(paperId) {
    const db = read();
    for (const list of Object.values(db.papers || {})) {
      const found = (list || []).find((p) => p.id === paperId);
      if (found) return found;
    }
    return null;
  },
  async deletePaper(userId, paperId) {
    const db = read();
    db.papers[userId] = (db.papers[userId] || []).filter((p) => p.id !== paperId);
    write(db);
  },
  async resetUser(userId) {
    const db = read();
    db.attempts[userId] = [];
    db.papers[userId] = [];
    db.memberships = (db.memberships || []).filter((membership) => membership.studentId !== userId);
    if (db.users[userId]) {
      db.users[userId] = {
        ...db.users[userId],
        streak: 0,
        totalPoints: 0,
        lastQuizDate: "",
      };
    }
    write(db);
  },

  async getAllProfiles() {
    const db = read();
    return Object.entries(db.users).map(([id, profile]) => ({ id, ...profile }));
  },

  async findAccountByEmail(email) {
    return findAccountByEmail(email);
  },

  async createAccount(userId, email, passwordHash) {
    const normalizedEmail = email.trim().toLowerCase();
    const db = read();
    if (findAccountByEmail(normalizedEmail)) {
      throw new Error("Account already exists");
    }
    db.accounts = db.accounts || {};
    db.accounts[userId] = { email: normalizedEmail, passwordHash };
    write(db);
    return { userId, email: normalizedEmail };
  },

  async verifyAccount(email, passwordHash) {
    const account = findAccountByEmail(email);
    if (!account || account.passwordHash !== passwordHash) return null;
    return account;
  },

  // ----- Questions (admin-managed, global) -----
  async ensureSeed() {
    const db = read();
    if (!Array.isArray(db.questions) || db.questions.length === 0) {
      db.questions = SEED_QUESTIONS.slice();
      write(db);
      console.log(`[storage:json] seeded ${db.questions.length} questions`);
    }
  },
  async getQuestions() {
    const db = read();
    return db.questions || [];
  },
  async addQuestions(questions) {
    const db = read();
    const existing = db.questions || [];
    const existingIds = new Set(existing.map((q) => q.id));
    const fresh = questions.filter((q) => !existingIds.has(q.id));
    db.questions = [...fresh, ...existing];
    write(db);
    return fresh;
  },
  async updateQuestion(id, updates) {
    const db = read();
    const idx = (db.questions || []).findIndex((q) => q.id === id);
    if (idx === -1) return null;
    db.questions[idx] = { ...db.questions[idx], ...updates, id };
    write(db);
    return db.questions[idx];
  },
  async deleteQuestion(id) {
    const db = read();
    db.questions = (db.questions || []).filter((q) => q.id !== id);
    write(db);
  },

  // ----- Documents (uploaded PDFs) -----
  async addDocument(doc) {
    const db = read();
    db.documents = [doc, ...(db.documents || [])];
    write(db);
    return doc;
  },
  async getDocuments() {
    const db = read();
    return db.documents || [];
  },
  async getDocument(id) {
    const db = read();
    return (db.documents || []).find((d) => d.id === id) || null;
  },

  // ----- Classes -----
  async getClasses() {
    const db = read();
    return db.classes || [];
  },
  async getClass(id) {
    const db = read();
    return (db.classes || []).find((c) => c.id === id) || null;
  },
  async getClassByCode(code) {
    const db = read();
    const norm = String(code || "").trim().toUpperCase();
    return (db.classes || []).find((c) => c.code.toUpperCase() === norm) || null;
  },
  async getClassesByTeacher(teacherId) {
    const db = read();
    return (db.classes || []).filter((c) => c.teacherId === teacherId);
  },
  async addClass(cls) {
    const db = read();
    db.classes = [cls, ...(db.classes || [])];
    write(db);
    return cls;
  },

  // ----- Memberships -----
  async getMemberships() {
    const db = read();
    return db.memberships || [];
  },
  async getMembershipsByClass(classId) {
    const db = read();
    return (db.memberships || []).filter((m) => m.classId === classId);
  },
  async getMembershipsByStudent(studentId) {
    const db = read();
    return (db.memberships || []).filter((m) => m.studentId === studentId);
  },
  async addMembership(m) {
    const db = read();
    db.memberships = [m, ...(db.memberships || [])];
    write(db);
    return m;
  },
  async updateMembership(id, updates) {
    const db = read();
    const idx = (db.memberships || []).findIndex((m) => m.id === id);
    if (idx === -1) return null;
    db.memberships[idx] = { ...db.memberships[idx], ...updates, id };
    write(db);
    return db.memberships[idx];
  },

  // ----- Assignments (paper -> class) -----
  async getAssignments() {
    const db = read();
    return db.assignments || [];
  },
  async getAssignmentsByClass(classId) {
    const db = read();
    return (db.assignments || []).filter((a) => a.classId === classId);
  },
  async getAssignmentsByPaper(paperId) {
    const db = read();
    return (db.assignments || []).filter((a) => a.paperId === paperId);
  },
  async addAssignment(a) {
    const db = read();
    db.assignments = [a, ...(db.assignments || [])];
    write(db);
    return a;
  },
  async deleteAssignment(id) {
    const db = read();
    db.assignments = (db.assignments || []).filter((a) => a.id !== id);
    write(db);
  },

  // ----- Topics (admin-managed catalogue, surfaced in PaperGenerate) -----
  async getTopics() {
    const db = read();
    return db.topics || [];
  },
  async addTopic(topic) {
    const db = read();
    const list = db.topics || [];
    // Case-insensitive uniqueness on (subject, classLevel, examType, name)
    const norm = (s) => String(s || "").trim().toLowerCase();
    const dup = list.find(
      (t) =>
        norm(t.subject) === norm(topic.subject) &&
        norm(t.classLevel) === norm(topic.classLevel) &&
        norm(t.examType) === norm(topic.examType) &&
        norm(t.name) === norm(topic.name),
    );
    if (dup) return dup;
    db.topics = [topic, ...list];
    write(db);
    return topic;
  },
  async deleteTopic(id) {
    const db = read();
    db.topics = (db.topics || []).filter((t) => t.id !== id);
    write(db);
  },

  // ----- Flashcards (admin-managed deck data for the student app) -----
  async getFlashcards() {
    const db = read();
    return db.flashcards || [];
  },
  async addFlashcard(card) {
    const db = read();
    db.flashcards = [card, ...(db.flashcards || [])];
    write(db);
    return card;
  },
  async deleteFlashcard(id) {
    const db = read();
    db.flashcards = (db.flashcards || []).filter((c) => c.id !== id);
    write(db);
  },

  // ----- Previous Year Papers / Mocks (admin-curated, global) -----
  // We strip the question payload off list endpoints because PYPs can be
  // hundreds of questions; the student app fetches the full detail only
  // when a specific PYP is opened.
  async getPyps() {
    const db = read();
    return (db.pyps || []).map((p) => ({
      id: p.id,
      title: p.title,
      examType: p.examType,
      year: p.year,
      subject: p.subject,
      durationMinutes: p.durationMinutes,
      questionCount: Array.isArray(p.questions) ? p.questions.length : 0,
      createdAt: p.createdAt,
    }));
  },
  async getPyp(id) {
    const db = read();
    return (db.pyps || []).find((p) => p.id === id) || null;
  },
  async addPyp(pyp) {
    const db = read();
    db.pyps = [pyp, ...(db.pyps || [])];
    write(db);
    return pyp;
  },
  async deletePyp(id) {
    const db = read();
    db.pyps = (db.pyps || []).filter((p) => p.id !== id);
    write(db);
  },
  // ----- Notes -----
  async getNotes(query = {}) {
    const db = read();
    let list = db.notes || [];
    if (query.classId) list = list.filter((n) => String(n.classId) === String(query.classId));
    if (query.subjectId) list = list.filter((n) => String(n.subjectId) === String(query.subjectId));
    if (query.chapterId) list = list.filter((n) => String(n.chapterId) === String(query.chapterId));
    if (query.q) {
      const q = String(query.q || "").toLowerCase();
      list = list.filter((n) => (n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q));
    }
    return list;
  },
  async getNote(id) {
    const db = read();
    return (db.notes || []).find((n) => n.id === id) || null;
  },
  async addNote(note) {
    const db = read();
    const row = { ...(note || {}), createdAt: new Date().toISOString() };
    db.notes = [row, ...(db.notes || [])];
    write(db);
    return row;
  },
  async updateNote(id, updates) {
    const db = read();
    const idx = (db.notes || []).findIndex((n) => n.id === id);
    if (idx >= 0) {
      db.notes[idx] = { ...db.notes[idx], ...updates };
      write(db);
      return db.notes[idx];
    }
    return null;
  },
  async deleteNote(id) {
    const db = read();
    db.notes = (db.notes || []).filter((n) => n.id !== id);
    write(db);
    return true;
  },

  // ----- Tests -----
  async getTests(query = {}) {
    const db = read();
    let list = db.tests || [];
    if (query.classId) list = list.filter((t) => String(t.classId) === String(query.classId));
    if (query.published !== undefined) list = list.filter((t) => Boolean(t.published) === Boolean(query.published));
    return list;
  },
  async getTest(id) {
    const db = read();
    return (db.tests || []).find((t) => t.id === id) || null;
  },

  // ----- Referrals & Commissions -----
  async getProfileByReferralCode(code) {
    const db = read();
    const norm = String(code || "").trim().toLowerCase();
    if (!norm) return null;
    for (const [userId, profile] of Object.entries(db.users || {})) {
      if ((profile.referralCode || "").toLowerCase() === norm) return { id: userId, ...profile };
    }
    return null;
  },
  async addReferral(r) {
    const db = read();
    const row = { id: r.id || `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...r };
    db.referrals = [row, ...(db.referrals || [])];
    write(db);
    return row;
  },
  async getReferralByReferredUser(userId) {
    const db = read();
    return (db.referrals || []).find((r) => r.referredUserId === userId) || null;
  },
  async getReferralsByReferrer(referrerId) {
    const db = read();
    return (db.referrals || []).filter((r) => r.referrerId === referrerId);
  },
  async getAllReferrals() {
    const db = read();
    return db.referrals || [];
  },
  async addCommission(c) {
    const db = read();
    const row = {
      id: c.id || `com_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      updatedAt: new Date().toISOString(),
      ...c,
    };
    db.commissions = [row, ...(db.commissions || [])];
    write(db);
    return row;
  },
  async getCommissionByOrderId(orderId) {
    const db = read();
    if (!orderId) return null;
    return (db.commissions || []).find((c) => c.orderId === orderId) || null;
  },
  async getCommissionsByReferrer(referrerId) {
    const db = read();
    return (db.commissions || []).filter((c) => c.referrerId === referrerId);
  },
  async getAllCommissions() {
    const db = read();
    return db.commissions || [];
  },
  async updateCommission(id, updates) {
    const db = read();
    const idx = (db.commissions || []).findIndex((c) => c.id === id);
    if (idx === -1) return null;
    db.commissions[idx] = { ...db.commissions[idx], ...updates, id, updatedAt: new Date().toISOString() };
    write(db);
    return db.commissions[idx];
  },
  async addPayout(p) {
    const db = read();
    const row = {
      id: p.id || `pay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      paidAt: p.paidAt || new Date().toISOString(),
      ...p,
    };
    db.payouts = [row, ...(db.payouts || [])];
    write(db);
    return row;
  },
  async getPayoutsByUser(userId) {
    const db = read();
    return (db.payouts || []).filter((p) => p.userId === userId);
  },
  async getAllPayouts() {
    const db = read();
    return db.payouts || [];
  },
  async addStudentReward(r) {
    const db = read();
    const row = {
      id: r.id || `rew_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: r.createdAt || new Date().toISOString(),
      ...r,
    };
    db.studentRewards = [row, ...(db.studentRewards || [])];
    write(db);
    return row;
  },
  async getStudentRewardsByUser(userId) {
    const db = read();
    return (db.studentRewards || []).filter((r) => r.userId === userId);
  },
  async addTest(test) {
    const db = read();
    const row = { ...(test || {}), createdAt: new Date().toISOString() };
    db.tests = [row, ...(db.tests || [])];
    write(db);
    return row;
  },

  // ----- Payments ledger (subscription purchases) -----
  // Every verified Razorpay payment is appended here so the admin panel can
  // surface subscription history and revenue without re-querying Razorpay.
  async addPayment(payment) {
    const db = read();
    const row = {
      id: payment.id || `pmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      status: payment.status || "captured",
      createdAt: payment.createdAt || new Date().toISOString(),
      ...payment,
    };
    db.payments = [row, ...(db.payments || [])];
    write(db);
    return row;
  },
  async getAllPayments() {
    const db = read();
    return db.payments || [];
  },
};
