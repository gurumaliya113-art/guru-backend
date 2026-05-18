import { supabase } from "../supabase.js";

function handleError(error) {
  if (error) throw error;
}

// Convert camelCase to snake_case (handles acronyms properly)
function toSnakeCase(obj) {
  const converted = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key
      .replace(/([a-z])([A-Z])/g, '$1_$2')           // lowercase to uppercase
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')    // sequence of capitals
      .toLowerCase();
    converted[snakeKey] = value;
  }
  return converted;
}

// Convert snake_case to camelCase
function toCamelCase(obj) {
  if (!obj) return obj;
  const converted = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
    converted[camelKey] = value;
  }
  return converted;
}

export const supabaseStorage = {
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

  /**
   * Lookup a profile by ANY of: email, username (case-insensitive), or phone.
   * Used for the multi-identifier login flow. Returns the first match.
   */
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
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .or(`phone.eq.${raw},phone.eq.${phoneDigits}`)
        .maybeSingle();
      if (data) return toCamelCase(data);
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
    const dbPayload = toSnakeCase({ user_id: userId, ...attempt });
    const { data, error } = await supabase
      .from("attempts")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getPapers(userId) {
    const { data, error } = await supabase
      .from("papers")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addPaper(userId, paper) {
    // Whitelist: only persist columns that exist on the `papers` table.
    // The frontend may send extras (e.g. `skipHeader`) which would otherwise
    // make the INSERT fail with PGRST204 and lose the paper silently.
    const ALLOWED = new Set([
      "id",
      "user_id",
      "title",
      "exam_type",
      "subject",
      "topic",
      "difficulty",
      "questions",
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
    // Re-attach client-only fields (e.g. skipHeader) so the API response
    // matches what the frontend sent, even though they aren't persisted.
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
    const profileReset = toSnakeCase({
      streak: 0,
      totalPoints: 0,
      lastQuizDate: "",
    });

    const results = await Promise.all([
      supabase.from("attempts").delete().eq("user_id", userId),
      supabase.from("papers").delete().eq("user_id", userId),
      supabase.from("profiles").update(profileReset).eq("id", userId),
    ]);

    results.forEach((result) => handleError(result.error));
  },

  async ensureSeed() {
    // no-op — Supabase tables are managed via migrations.
  },

  async getQuestions() {
    const { data, error } = await supabase.from("questions").select("*");
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addQuestions(questions) {
    const dbPayload = questions.map(toSnakeCase);
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

  // ----- Documents (uploaded PDFs) -----
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

  // ----- Classes -----
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
    // Codes are stored uppercase by the generator, but be defensive with ilike.
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
    const dbPayload = toSnakeCase(cls);
    const { data, error } = await supabase
      .from("classes")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  // ----- Memberships -----
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
    const dbPayload = toSnakeCase(m);
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

  // ----- Assignments -----
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
    const dbPayload = toSnakeCase(a);
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

  // ----- Topics (admin-managed catalogue, surfaced in PaperGenerate) -----
  async getTopics() {
    const { data, error } = await supabase
      .from("topics")
      .select("*")
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },
  async addTopic(topic) {
    const dbPayload = toSnakeCase(topic);
    // Upsert with the unique constraint on (subject, class_level, exam_type, name)
    // — if the row already exists we just return it instead of erroring out.
    const { data, error } = await supabase
      .from("topics")
      .upsert([dbPayload], { onConflict: "id" })
      .select()
      .single();
    if (error) {
      // Duplicate against the case-insensitive unique index — fetch the existing
      // row so callers always get a valid topic back.
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

  // ----- Previous Year Papers / Mocks -----
  // Schema (see supabase-pyp-migration.sql):
  //   pyps(id text pk, title text, exam_type text, year int, subject text,
  //        duration_minutes int, questions jsonb, created_at timestamptz)
  async getPyps() {
    const { data, error } = await supabase
      .from("pyps")
      .select("id,title,exam_type,year,subject,duration_minutes,questions,created_at")
      .order("created_at", { ascending: false });
    // PostgREST surfaces "missing table" as PGRST205 / 42P01. Treat that as
    // an empty catalogue so the student page renders cleanly until the
    // operator runs `supabase-pyp-migration.sql`.
    if (error && (error.code === "PGRST205" || error.code === "42P01")) {
      console.warn("[storage:supabase] pyps table missing — run supabase-pyp-migration.sql");
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
      id: pyp.id,
      title: pyp.title,
      examType: pyp.examType,
      year: pyp.year,
      subject: pyp.subject ?? null,
      durationMinutes: pyp.durationMinutes ?? null,
      questions: pyp.questions,
      createdAt: pyp.createdAt,
    });
    const { data, error } = await supabase.from("pyps").insert(payload).select().single();
    handleError(error);
    return data ? toCamelCase(data) : pyp;
  },
  async deletePyp(id) {
    const { error } = await supabase.from("pyps").delete().eq("id", id);
    handleError(error);
  },
};
