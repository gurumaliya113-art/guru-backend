import { describe, it, expect } from "vitest";
import {
  letterToIndex,
  normaliseCorrectIndex,
  extractInlineAnswer,
  safeCorrectIndex,
} from "./answer-key.js";

describe("letterToIndex", () => {
  it("maps every printed key spelling to the right option", () => {
    const cases = {
      A: 0, a: 0, "(A)": 0, "A)": 0, "[a]": 0, "A.": 0,
      B: 1, b: 1, "(B)": 1, "Ans: B": 1, "Answer: B": 1, "Option B": 1, "opt b": 1,
      C: 2, "Correct Answer: Option C": 2, "correct answer - c": 2, "Sol: (C)": 2,
      D: 3, "answer key: d": 3, "ANS.(D)": 3,
      1: 0, 2: 1, 3: 2, 4: 3,
    };
    for (const [input, expected] of Object.entries(cases)) {
      expect(letterToIndex(input), `input=${input}`).toBe(expected);
    }
  });

  it("returns null for anything that is not a real key", () => {
    for (const bad of [null, undefined, "", "   ", "E", "e", "5", "0", "none", "?", "-", "AB", "Answer"]) {
      expect(letterToIndex(bad), `input=${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe("normaliseCorrectIndex", () => {
  it("keeps a valid 0..3 index", () => {
    expect(normaliseCorrectIndex(0)).toBe(0);
    expect(normaliseCorrectIndex(3)).toBe(3);
  });

  it("never invents an answer when the value is missing or out of range", () => {
    for (const bad of [null, undefined, -1, 4, 99, 1.5, NaN, "", "x", {}, []]) {
      expect(normaliseCorrectIndex(bad), `input=${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("accepts letter/label strings a model may emit in this field", () => {
    expect(normaliseCorrectIndex("2")).toBe(2);
    expect(normaliseCorrectIndex("B")).toBe(1);
    expect(normaliseCorrectIndex("Option D")).toBe(3);
  });
});

describe("extractInlineAnswer", () => {
  it("pulls a trailing answer line off the stem and removes it", () => {
    const r = extractInlineAnswer("What is 2+2?\nOptions...\nAns: (C)");
    expect(r?.index).toBe(2);
    expect(r?.cleanedText).toBe("What is 2+2?\nOptions...");
  });

  it("handles the common printed variants", () => {
    expect(extractInlineAnswer("Q\nAnswer: B")?.index).toBe(1);
    expect(extractInlineAnswer("Q\nCorrect Answer: Option D")?.index).toBe(3);
    expect(extractInlineAnswer("Q\nans - a")?.index).toBe(0);
  });

  it("does not mistake prose or option text for a key", () => {
    expect(extractInlineAnswer("The answer is 5 m/s and the speed doubles")).toBeNull();
    expect(extractInlineAnswer("Which option is correct?")).toBeNull();
    expect(extractInlineAnswer("")).toBeNull();
  });
});

describe("safeCorrectIndex", () => {
  it("rejects an index that points past the available options", () => {
    expect(safeCorrectIndex(3, 2)).toBeNull();
    expect(safeCorrectIndex(1, 2)).toBe(1);
  });

  it("returns null rather than 0 when there is no key", () => {
    expect(safeCorrectIndex(undefined, 4)).toBeNull();
    expect(safeCorrectIndex(null, 4)).toBeNull();
  });
});
