import test from "node:test";
import assert from "node:assert/strict";

import {
  SpansError,
  applyEdits,
  byteOffsetToLineCol,
  sortSpans,
  spansOverlap,
} from "../lib/spans.mjs";

/** Assert that `fn` throws a SpansError with `code`, and return it. */
function throwsSpans(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected the call to throw");
  assert.equal(caught.name, "SpansError");
  assert.equal(caught.code, code);
  return caught;
}

test("applyEdits: two adjacent edits do not overlap", () => {
  const out = applyEdits("abcdef", [
    { start: 0, end: 3, text: "X" },
    { start: 3, end: 6, text: "Y" },
  ]);
  assert.equal(out, "XY");
});

test("applyEdits: an earlier replacement cannot shift a later one", () => {
  assert.equal(
    applyEdits("abcdef", [
      { start: 0, end: 2, text: "AB" },
      { start: 2, end: 4, text: "CD" },
      { start: 4, end: 6, text: "EF" },
    ]),
    "ABCDEF",
  );
  assert.equal(
    applyEdits("0123456789", [
      { start: 0, end: 2, text: "" },
      { start: 8, end: 10, text: "XY" },
    ]),
    "234567XY",
  );
});

test("applyEdits: an insertion on the boundary of a replacement is rejected", () => {
  throwsSpans(
    () =>
      applyEdits("<div></div>", [
        { start: 5, end: 5, text: "hello" },
        { start: 0, end: 5, text: "<p>" },
      ]),
    "spans/overlap",
  );
});

test("applyEdits: overlapping edits are rejected with spans/overlap", () => {
  throwsSpans(
    () =>
      applyEdits("abcdef", [
        { start: 0, end: 4, text: "X" },
        { start: 2, end: 6, text: "Y" },
      ]),
    "spans/overlap",
  );
});

test("applyEdits: a zero-length edit inside a replaced range is an overlap", () => {
  throwsSpans(
    () => applyEdits("abcdef", [{ start: 1, end: 5, text: "X" }, { start: 3, end: 3, text: "!" }]),
    "spans/overlap",
  );
});

test("applyEdits: an edit at offset 0 and one at the end of the file", () => {
  assert.equal(
    applyEdits("abc", [
      { start: 0, end: 0, text: "<" },
      { start: 3, end: 3, text: ">" },
    ]),
    "<abc>",
  );
});

test("applyEdits: an empty edit list returns the text unchanged", () => {
  assert.equal(applyEdits("abc", []), "abc");
  assert.equal(applyEdits("abc"), "abc");
});

test("applyEdits: an out-of-range edit is a spans/range error", () => {
  throwsSpans(() => applyEdits("abc", [{ start: 1, end: 9, text: "" }]), "spans/range");
  throwsSpans(() => applyEdits("abc", [{ start: -1, end: 1, text: "" }]), "spans/range");
  throwsSpans(() => applyEdits("abc", [{ start: 2, end: 1, text: "" }]), "spans/range");
  assert.ok(new SpansError("spans/range", "x") instanceof Error);
});

test("applyEdits: does not mutate the source or the edits", () => {
  const edits = [{ start: 0, end: 1, text: "z" }];
  const out = applyEdits("abc", edits);
  assert.equal(out, "zbc");
  assert.deepEqual(edits, [{ start: 0, end: 1, text: "z" }]);
});

test("spansOverlap: adjacency is not an overlap, sharing an offset is", () => {
  assert.equal(spansOverlap({ start: 0, end: 3 }, { start: 3, end: 6 }), false);
  assert.equal(spansOverlap({ start: 0, end: 3 }, { start: 2, end: 6 }), true);
  assert.equal(spansOverlap({ start: 0, end: 0 }, { start: 0, end: 0 }), true);
  assert.equal(spansOverlap({ start: 0, end: 0 }, { start: 5, end: 5 }), false);
  assert.equal(spansOverlap({ start: 0, end: 0 }, { start: 0, end: 4 }), true);
});

test("sortSpans: ascending by start, input untouched", () => {
  const input = [
    { start: 8, end: 9 },
    { start: 0, end: 2 },
  ];
  const sorted = sortSpans(input);
  assert.deepEqual(sorted.map((s) => s.start), [0, 8]);
  assert.deepEqual(input.map((s) => s.start), [8, 0]);
});

test("byteOffsetToLineCol: first character and end of file", () => {
  assert.deepEqual(byteOffsetToLineCol("abc", 0), { line: 1, column: 1 });
  assert.deepEqual(byteOffsetToLineCol("abc", 3), { line: 1, column: 4 });
});

test("byteOffsetToLineCol: counts characters, not bytes, for multi-byte text", () => {
  const source = "a\n你好\nb";
  // Offsets: 0 'a', 1 '\n', 2 '你', 3 '好', 4 '\n', 5 'b'
  assert.deepEqual(byteOffsetToLineCol(source, 3), { line: 2, column: 2 });
  assert.deepEqual(byteOffsetToLineCol(source, 5), { line: 3, column: 1 });
});

test("byteOffsetToLineCol: CRLF input counts the pair once", () => {
  const source = "a\r\nb\r\nc";
  // Offsets: 0 'a', 1 '\r', 2 '\n', 3 'b', 4 '\r', 5 '\n', 6 'c'
  assert.deepEqual(byteOffsetToLineCol(source, 2), { line: 1, column: 3 });
  assert.deepEqual(byteOffsetToLineCol(source, 3), { line: 2, column: 1 });
  assert.deepEqual(byteOffsetToLineCol(source, 6), { line: 3, column: 1 });
});

test("byteOffsetToLineCol: an offset past the end is clamped", () => {
  assert.deepEqual(byteOffsetToLineCol("ab", 99), { line: 1, column: 3 });
});
