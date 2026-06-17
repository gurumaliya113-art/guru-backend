Gurutron API Specification — Learning features

Scope: notes, past-year questions (PYQ), practice questions, quizzes/tests, assignments, scores, rankings, and AI doubt chat.

Authentication: server uses session cookies. All endpoints that modify data or return personalized data require authentication (session). Public read endpoints may be open depending on product policy.

Base path: `/api`

## Resources

### Models (minimal)
- `Class` { id, name }                        -- e.g. `10`, `12`, `NEET-Repeat`
- `Subject` { id, classId, name }
- `Chapter` { id, subjectId, name }
- `Note` { id, classId, subjectId, chapterId, title, content, attachments, meta }
- `Question` { id, classId, subjectId, chapterId, type, text, choices, answer, solution, year, tags }
- `Test` { id, title, classId, targetTags, durationMinutes, questionIds, published, authorId }
- `Attempt` { id, testId, userId, startedAt, endedAt, answers, score, perQuestionResult }
- `Assignment` { id, title, classId, testId, dueDate, assignedBy }
- `Score` { userId, testId, score, percentile, correctCount, total }
- `UserProfile` { id, name, role, classId, city, state, country }

## Endpoints

Notes
- GET `/api/notes` — query: `class`, `subject`, `chapter`, `q` (search), `limit`, `page`.
  - Returns paginated list of `Note` objects.
- GET `/api/notes/:id` — returns single note.
- POST `/api/notes` — (auth: teacher/admin) create note. body: `{classId, subjectId, chapterId, title, content, attachments}`

Questions / PYQ / Practice
- GET `/api/questions` — query: `class`, `subject`, `chapter`, `type` (pyq|practice|all), `year`, `tags`, `limit`, `page`.
  - Returns list of `Question` objects. For `type=pyq` filter by `year` or `tags`.
- GET `/api/questions/:id` — returns question (optionally hide `answer` for practice mode unless user requested solution).
- POST `/api/questions` — (auth: teacher/admin) create question.

Quizzes / Tests
- POST `/api/tests` — (auth teacher/admin) create test. body: `{title, classId, targetTags, durationMinutes, questionIds | generatorSpec}`
- GET `/api/tests/:id` — returns test metadata (no answers).
- POST `/api/tests/:id/attempt` — (auth user) start attempt; returns `{attemptId, questions, expiresAt}` (server may randomize order).
- POST `/api/tests/:id/attempt/:attemptId/submit` — submit answers; returns `{score, perQuestionResult, timeTaken}`.
- GET `/api/users/:userId/attempts` — list attempts for user.

Assignments
- POST `/api/assignments` — (auth teacher) create assignment (ties to a `testId`).
- GET `/api/assignments` — query by `classId`, `assignedTo`.

Scores & Leaderboards
- GET `/api/users/:userId/scores` — authenticated access to user's scores and history.
- GET `/api/tests/:id/scores` — class/school-level scores for a test (auth teacher/admin).
- GET `/api/rankings` — query params: `scope=class|city|state|national`, `classId`, `city`, `state`, `limit`.
  - Returns ranking list: `{rank, userId, name, score, percentile}`

AI Doubt Chat
- POST `/api/chat` — (auth optional) body: `{message, context?{classId,subjectId,chapterId,resourceIds}}`
  - Returns `{reply, sources}` where `sources` are note/question IDs used for grounding.
  - Optional streaming support later.

Search & Filters
- Support full-text `q` across notes/questions and filtering by tags, difficulty, year.

Pagination
- Standard `limit` and `page` or use cursor-based pagination for lists.

Errors
- 401 for unauthenticated on protected endpoints.
- 400 for bad request.
- 404 for missing resources.

Storage
- By default use existing JSON storage adapter (`src/storage/json.js`). Data layout suggestions:
  - `data/notes.json`, `data/questions.json`, `data/tests.json`, `data/attempts.json`, `data/assignments.json`, `data/scores.json`
  - Keep indexes by `classId`/`subjectId` for faster query in-memory.

Security & CORS
- Keep `credentials: 'include'` on front-end fetches and ensure backend CORS allows `http://localhost:5173` with `credentials: true`.
- Session cookie should be `HttpOnly`, `sameSite: 'lax'` for dev with `secure: false`.

Notes on Implementation Priority (MVP)
1. `GET /api/notes`, `GET /api/questions` with filtering and search.
2. `POST /api/tests` + `POST /api/tests/:id/attempt` + submit flow with scoring.
3. `GET /api/rankings` computed from `scores` (class and national simple aggregation).
4. `POST /api/chat` integrated with local notes/questions for grounding.

Next actions I will take (unless you want to change storage):
- Implement basic endpoints using `src/storage/json.js` and add a new router `src/routes/learning.js` that exposes the above endpoints.

If you prefer Supabase for storage and ranking queries, tell me and I'll scaffold integration instead.
