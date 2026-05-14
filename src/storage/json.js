import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SEED_QUESTIONS } from "../seed/questions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

const DEFAULT_DB = {
  users: {},      // userId -> profile
  attempts: {},   // userId -> QuizAttempt[]
  papers: {},     // userId -> GeneratedPaper[]
  questions: [],  // Question[] — global, managed by admin
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

export const jsonStorage = {
  async getProfile(userId) {
    const db = read();
    return db.users[userId] || null;
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
};
