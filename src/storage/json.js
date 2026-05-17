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
  classes: [],      // ClassRoom[]
  memberships: [],  // Membership[]
  assignments: [],  // Assignment[]  — paper assigned to class
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
  async deletePaper(userId, paperId) {
    const db = read();
    db.papers[userId] = (db.papers[userId] || []).filter((p) => p.id !== paperId);
    write(db);
  },
  async resetUser(userId) {
    const db = read();
    db.attempts[userId] = [];
    db.papers[userId] = [];
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
};
