import crypto from "crypto";
import { supabase } from "../supabase.js";
import { jsonStorage } from "./json.js";

function handleError(error) {
  if (error) {
    console.error("[supabase error]", error.message || error);
    throw error;
  }
}

// Convert camelCase to snake_case (handles acronyms properly)
function toSnakeCase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(toSnakeCase);

  const converted = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase();
    converted[snakeKey] = value;
  }
  return converted;
}

// Convert snake_case to camelCase
function toCamelCase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(toCamelCase);

  const converted = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
    converted[camelKey] = value;
  }
  return converted;
}

export const supabaseStorage = {
  // ===== PROFILES =====
  async getProfile(userId) {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getProfileByEmail(email) {
    const normalizedEmail = email.trim().toLowerCase();
    const { data, error } = await supabase.from("profiles").select("*").eq("email", normalizedEmail).single();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getProfileByIdentifier(identifier) {
    const raw = String(identifier || "").trim();
    if (!raw) return null;
    const norm = raw.toLowerCase();

    // Try email (case-insensitive)
    {
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .ilike("email", norm)
        .maybeSingle();
      if (data) return toCamelCase(data);
    }
    // Try username (case-insensitive)
    {
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .ilike("username", norm)
        .maybeSingle();
      if (data) return toCamelCase(data);
    }
    // Try phone (exact + digits-only fallback)
    {
      const phoneDigits = raw.replace(/\D/g, "");
      if (phoneDigits) {
        const { data } = await supabase
          .from("profiles")
          .select("*")
          .or(`phone.eq.${raw},phone.eq.${phoneDigits}`)
          .maybeSingle();
        if (data) return toCamelCase(data);
      }
    }
    return null;
  },

  async saveProfile(userId, profile) {
    const dbPayload = toSnakeCase({ id: userId, ...profile });
    const { data, error } = await supabase
      .from("profiles")
      .upsert(dbPayload, { onConflict: "id" })
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getAllProfiles() {
    const { data, error } = await supabase.from("profiles").select("*");
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async findAccountByEmail(email) {
    const normalizedEmail = email.trim().toLowerCase();
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, password_hash")
      .eq("email", normalizedEmail)
      .single();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? { userId: data.id, email: data.email, passwordHash: data.password_hash } : null;
  },

  async createAccount(userId, email, passwordHash) {
    const normalizedEmail = email.trim().toLowerCase();
    const { data, error } = await supabase
      .from("profiles")
      .insert([{ id: userId, email: normalizedEmail, password_hash: passwordHash }])
      .select()
      .single();
    handleError(error);
    return data ? { userId: data.id, email: data.email } : null;
  },

  async verifyAccount(email, passwordHash) {
    const normalizedEmail = email.trim().toLowerCase();
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, password_hash")
      .eq("email", normalizedEmail)
      .single();
    if (error && error.code !== "PGRST116") handleError(error);
    if (!data || data.password_hash !== passwordHash) return null;
    return { userId: data.id, email: data.email };
  },

  // ===== ATTEMPTS (Quiz Results) =====
  async getAttempts(userId) {
    const { data, error } = await supabase
      .from("attempts")
      .select("*")
      .eq("user_id", userId)
      .order("date", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addAttempt(userId, attempt) {
    const dbPayload = toSnakeCase({ id: attempt.id || crypto.randomUUID(), user_id: userId, ...attempt });
    const { data, error } = await supabase
      .from("attempts")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  // ===== PAPERS (Generated Question Papers) =====
  async getPapers(userId) {
    const { data, error } = await supabase
      .from("papers")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async getPaperById(paperId) {
    const { data, error } = await supabase
      .from("papers")
      .select("*")
      .eq("id", paperId)
      .maybeSingle();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async addPaper(userId, paper) {
    const ALLOWED = new Set([
      "id",
      "user_id",
      "title",
      "exam_type",
      "subject",
      "topic",
      "difficulty",
      "questions",
      "duration_minutes",
      "created_at",
    ]);
    const raw = toSnakeCase({ user_id: userId, ...paper });
    const dbPayload = Object.fromEntries(
      Object.entries(raw).filter(([k]) => ALLOWED.has(k))
    );
    const { data, error } = await supabase
      .from("papers")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    const persisted = data ? toCamelCase(data) : null;
    if (persisted && paper && typeof paper === "object") {
      for (const [k, v] of Object.entries(paper)) {
        if (!(k in persisted)) persisted[k] = v;
      }
    }
    return persisted;
  },

  async deletePaper(userId, paperId) {
    const { error } = await supabase
      .from("papers")
      .delete()
      .eq("id", paperId)
      .eq("user_id", userId);
    handleError(error);
  },

  async resetUser(userId) {
    const profileReset = {
      streak: 0,
      total_points: 0,
      last_quiz_date: "",
    };

    const results = await Promise.all([
      supabase.from("attempts").delete().eq("user_id", userId),
      supabase.from("papers").delete().eq("user_id", userId),
      supabase.from("memberships").delete().eq("student_id", userId),
      supabase.from("profiles").update(profileReset).eq("id", userId),
    ]);

    results.forEach((result) => handleError(result.error));
  },

  // ===== QUESTIONS (Global Question Bank) =====
  async ensureSeed() {
    // no-op — Supabase tables are managed via migrations
  },

  async getQuestions() {
    const { data, error } = await supabase.from("questions").select("*");
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addQuestions(questions) {
    const dbPayload = questions.map(q => toSnakeCase(q));
    const { data, error } = await supabase
      .from("questions")
      .upsert(dbPayload, { onConflict: "id" })
      .select();
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async updateQuestion(id, updates) {
    const dbPayload = toSnakeCase(updates);
    const { data, error } = await supabase
      .from("questions")
      .update(dbPayload)
      .eq("id", id)
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async deleteQuestion(id) {
    const { error } = await supabase.from("questions").delete().eq("id", id);
    handleError(error);
  },

  // ===== DOCUMENTS (PDF Uploads) =====
  async addDocument(doc) {
    const dbPayload = toSnakeCase(doc);
    const { data, error } = await supabase
      .from("documents")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getDocuments() {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async getDocument(id) {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", id)
      .single();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async savePdfPages({ pdfName, pages }) {
    if (!Array.isArray(pages) || pages.length === 0) return [];
    // Note: Store in questions or a separate tracking mechanism
    // For now, just return the pages as processed
    return pages;
  },

  // ===== CLASSES =====
  async getClasses() {
    const { data, error } = await supabase
      .from("classes")
      .select("*")
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async getClass(id) {
    const { data, error } = await supabase
      .from("classes")
      .select("*")
      .eq("id", id)
      .single();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getClassByCode(code) {
    const norm = String(code || "").trim().toUpperCase();
    const { data, error } = await supabase
      .from("classes")
      .select("*")
      .ilike("code", norm)
      .limit(1)
      .maybeSingle();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getClassesByTeacher(teacherId) {
    const { data, error } = await supabase
      .from("classes")
      .select("*")
      .eq("teacher_id", teacherId)
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addClass(cls) {
    const dbPayload = toSnakeCase({ id: cls.id || crypto.randomUUID(), ...cls });
    const { data, error } = await supabase
      .from("classes")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  // ===== MEMBERSHIPS =====
  async getMemberships() {
    const { data, error } = await supabase
      .from("memberships")
      .select("*")
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async getMembershipsByClass(classId) {
    const { data, error } = await supabase
      .from("memberships")
      .select("*")
      .eq("class_id", classId)
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async getMembershipsByStudent(studentId) {
    const { data, error } = await supabase
      .from("memberships")
      .select("*")
      .eq("student_id", studentId)
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addMembership(m) {
    const dbPayload = toSnakeCase({ id: m.id || crypto.randomUUID(), ...m });
    const { data, error } = await supabase
      .from("memberships")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async updateMembership(id, updates) {
    const dbPayload = toSnakeCase(updates);
    const { data, error } = await supabase
      .from("memberships")
      .update(dbPayload)
      .eq("id", id)
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  // ===== ASSIGNMENTS =====
  async getAssignments() {
    const { data, error } = await supabase
      .from("assignments")
      .select("*")
      .order("assigned_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async getAssignmentsByClass(classId) {
    const { data, error } = await supabase
      .from("assignments")
      .select("*")
      .eq("class_id", classId)
      .order("assigned_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async getAssignmentsByPaper(paperId) {
    const { data, error } = await supabase
      .from("assignments")
      .select("*")
      .eq("paper_id", paperId)
      .order("assigned_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addAssignment(a) {
    const dbPayload = toSnakeCase({ id: a.id || crypto.randomUUID(), ...a });
    const { data, error } = await supabase
      .from("assignments")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async deleteAssignment(id) {
    const { error } = await supabase.from("assignments").delete().eq("id", id);
    handleError(error);
  },

  // ===== TOPICS (Syllabus) =====
  async getTopics() {
    const { data, error } = await supabase
      .from("topics")
      .select("*")
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addTopic(topic) {
    const dbPayload = toSnakeCase({ id: topic.id || crypto.randomUUID(), ...topic });
    const { data, error } = await supabase
      .from("topics")
      .upsert([dbPayload], { onConflict: "id" })
      .select()
      .single();
    if (error && error.code !== "PGRST116") {
      const { data: existing } = await supabase
        .from("topics")
        .select("*")
        .ilike("subject", topic.subject)
        .ilike("name", topic.name)
        .maybeSingle();
      if (existing) return toCamelCase(existing);
      handleError(error);
    }
    return data ? toCamelCase(data) : null;
  },

  async deleteTopic(id) {
    const { error } = await supabase.from("topics").delete().eq("id", id);
    handleError(error);
  },

  // ===== FLASHCARDS =====
  async getFlashcards() {
    try {
      const { data, error } = await supabase
        .from("flashcards")
        .select("*")
        .order("created_at", { ascending: false });
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        return await jsonStorage.getFlashcards?.() || [];
      }
      handleError(error);
      return data ? data.map(toCamelCase) : [];
    } catch (e) {
      console.warn("[flashcards fallback]", e.message);
      return await jsonStorage.getFlashcards?.() || [];
    }
  },

  async addFlashcard(card) {
    try {
      const dbPayload = toSnakeCase({ id: card.id || crypto.randomUUID(), ...card });
      const { data, error } = await supabase
        .from("flashcards")
        .insert([dbPayload])
        .select()
        .single();
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        return await jsonStorage.addFlashcard?.(card) || card;
      }
      handleError(error);
      return data ? toCamelCase(data) : card;
    } catch (e) {
      console.warn("[flashcards fallback]", e.message);
      return await jsonStorage.addFlashcard?.(card) || card;
    }
  },

  async deleteFlashcard(id) {
    try {
      const { error } = await supabase.from("flashcards").delete().eq("id", id);
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        return await jsonStorage.deleteFlashcard?.(id);
      }
      handleError(error);
    } catch (e) {
      console.warn("[flashcards fallback]", e.message);
      return await jsonStorage.deleteFlashcard?.(id);
    }
  },

  // ===== PREVIOUS YEAR PAPERS =====
  async getPyps() {
    const { data, error } = await supabase
      .from("pyps")
      .select("id, title, exam_type, year, subject, duration_minutes, questions, created_at")
      .order("created_at", { ascending: false });
    if (error && (error.code === "PGRST205" || error.code === "42P01")) {
      console.warn("[storage:supabase] pyps table missing");
      return [];
    }
    handleError(error);
    return (data || []).map((row) => ({
      id: row.id,
      title: row.title,
      examType: row.exam_type,
      year: row.year,
      subject: row.subject,
      durationMinutes: row.duration_minutes,
      questionCount: Array.isArray(row.questions) ? row.questions.length : 0,
      createdAt: row.created_at,
    }));
  },

  async getPyp(id) {
    const { data, error } = await supabase.from("pyps").select("*").eq("id", id).single();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async addPyp(pyp) {
    const payload = toSnakeCase({
      id: pyp.id || crypto.randomUUID(),
      title: pyp.title,
      examType: pyp.examType,
      year: pyp.year,
      subject: pyp.subject ?? null,
      durationMinutes: pyp.durationMinutes ?? null,
      questions: pyp.questions,
      createdAt: pyp.createdAt || new Date().toISOString(),
    });
    const { data, error } = await supabase.from("pyps").insert([payload]).select().single();
    handleError(error);
    return data ? toCamelCase(data) : pyp;
  },

  async deletePyp(id) {
    const { error } = await supabase.from("pyps").delete().eq("id", id);
    handleError(error);
  },

  // ===== NOTES =====
  async getNotes(query) {
    try {
      let qry = supabase.from("notes").select("*");
      
      if (query?.subject) qry = qry.eq("subject", query.subject);
      if (query?.chapter) qry = qry.eq("chapter", query.chapter);
      if (query?.examType) qry = qry.eq("exam_type", query.examType);
      if (query?.classLevel) qry = qry.eq("class_level", query.classLevel);
      if (query?.board) qry = qry.eq("board", query.board);
      if (query?.uploadedBy) qry = qry.eq("uploaded_by", query.uploadedBy);
      if (query?.q) {
        const searchTerm = `%${query.q}%`;
        qry = qry.or(`title.ilike.${searchTerm},description.ilike.${searchTerm}`);
      }
      
      // Default sort by created_at desc (newest first)
      qry = qry.order("created_at", { ascending: false });
      
      const { data, error } = await qry;
      handleError(error);
      return data ? data.map(toCamelCase) : [];
    } catch (e) {
      console.warn("[supabase.getNotes]", e.message);
      return await jsonStorage.getNotes?.(query) || [];
    }
  },

  async getNote(id) {
    try {
      const { data, error } = await supabase
        .from("notes")
        .select("*")
        .eq("id", id)
        .single();
      handleError(error);
      return data ? toCamelCase(data) : null;
    } catch (e) {
      console.warn("[supabase.getNote]", e.message);
      return await jsonStorage.getNote?.(id) || null;
    }
  },

  async addNote(note) {
    try {
      const payload = toSnakeCase({ ...note, createdAt: new Date().toISOString() });
      const { data, error } = await supabase
        .from("notes")
        .insert([payload])
        .select()
        .single();
      handleError(error);
      return data ? toCamelCase(data) : null;
    } catch (e) {
      console.warn("[supabase.addNote]", e.message);
      return await jsonStorage.addNote?.(note) || null;
    }
  },

  async updateNote(id, updates) {
    try {
      const payload = toSnakeCase(updates);
      const { data, error } = await supabase
        .from("notes")
        .update(payload)
        .eq("id", id)
        .select()
        .single();
      handleError(error);
      return data ? toCamelCase(data) : null;
    } catch (e) {
      console.warn("[supabase.updateNote]", e.message);
      return null;
    }
  },

  async deleteNote(id) {
    try {
      const { error } = await supabase
        .from("notes")
        .delete()
        .eq("id", id);
      handleError(error);
      return true;
    } catch (e) {
      console.warn("[supabase.deleteNote]", e.message);
      return false;
    }
  },

  async getTests(query) {
    return await jsonStorage.getTests?.(query) || [];
  },

  async addTest(test) {
    return await jsonStorage.addTest?.(test) || null;
  },

  async getTest(id) {
    return await jsonStorage.getTest?.(id) || null;
  },
};
