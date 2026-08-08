# PYP PDFs → Real-time Mock Tests

Yahan apne **previous year paper PDFs** daal de. Phir ek command se sab
real-time mock ban jaayenge (questions + diagram images + answer key).

## Steps

1. PDF file is folder mein copy kar de, e.g.:
   - `neet-2023.pdf`
   - `neet-2024.pdf`

2. (Optional but recommended) Har PDF ke saath ek **meta file** banao —
   same naam + `.meta.json`. Isse title/year aur **answer key** set hoti hai
   (scoring sahi aane ke liye). Example: `neet-2023.meta.json`

   ```json
   {
     "title": "NEET 2023 Solved Paper",
     "examType": "NEET",
     "year": 2023,
     "durationMinutes": 200,
     "answers": ["B","C","B","A","A","B","D","C","D","B"]
   }
   ```

   - `answers` array question ke ORDER mein hona chahiye (Q1, Q2, …).
   - "A/B/C/D" ya 1/2/3/4 dono chalega. Jis question ka answer na pata ho
     wahan `""` ya `null` chhod do.
   - Agar `answers` nahi diya, to parser apne hisaab se correctIndex set karega
     (kabhi galat ho sakta hai — isliye key dena best hai).

3. Backend folder se chalao:
   ```
   node scripts/import-pyp-pdf.mjs            # sab PDF import
   node scripts/import-pyp-pdf.mjs --dry      # sirf parse karke dikhayega
   ```

## Notes
- Jis question mein figure/diagram hota hai, uske page ka **image automatically
  save** hota hai (pageImageUrl) — mock mein dikh jaayega.
- Groq parser free hai (GROQ_API_KEY backend/.env mein hona chahiye).
- Yeh folder git mein commit nahi hota (PDF bade hote hain) — `.gitignore` mein hai.
