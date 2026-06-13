import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAnswer, qaF1Score } from "./f1.ts";

test("exact match scores 1", () => {
  assert.equal(qaF1Score("the answer is paris", ["The answer is Paris."]), 1);
});

test("complete mismatch scores 0", () => {
  assert.equal(qaF1Score("apple banana cherry", ["dog cat fish"]), 0);
});

test("partial overlap scores strictly between 0 and 1", () => {
  // prediction tokens: [paris, is, capital] (articles removed)
  // reference  tokens: [paris, is, capital, of, france]
  // common = 3, precision = 3/3 = 1, recall = 3/5, f1 = 2*1*0.6/(1+0.6) = 0.75
  const score = qaF1Score("paris is the capital", ["paris is the capital of france"]);
  assert.ok(score > 0 && score < 1, `expected strictly between 0 and 1, got ${score}`);
  assert.ok(Math.abs(score - 0.75) < 1e-9, `expected 0.75, got ${score}`);
});

test("normalization handles case, punctuation, and articles", () => {
  // After normalization both sides become "barack obama".
  assert.equal(normalizeAnswer("The Barack, Obama!"), "barack obama");
  assert.equal(qaF1Score("THE Barack, OBAMA!", ["a Barack Obama"]), 1);
});

test("score is the max over multiple reference answers", () => {
  // Prediction perfectly matches the second reference, mismatches the first.
  const score = qaF1Score("blue whale", ["red fox", "blue whale"]);
  assert.equal(score, 1);
});

test("empty prediction or no references scores 0", () => {
  assert.equal(qaF1Score("", ["something"]), 0);
  assert.equal(qaF1Score("something", []), 0);
});
