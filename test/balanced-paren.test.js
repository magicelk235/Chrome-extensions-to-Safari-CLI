import { test } from "node:test";
import assert from "node:assert/strict";
import { matchBalancedParen } from "../dist/runtime/shim.js";

// Index of the `(` that opens an importScripts(...) call.
const open = (s) => { const m = /\bimportScripts\s*\(/.exec(s); return m.index + m[0].length - 1; };
const callOf = (s) => { const o = open(s); const e = matchBalancedParen(s, o); return e < 0 ? null : s.slice(o, e); };

test("balances args containing a regex char class /[/*]/", () => {
  assert.equal(callOf('importScripts(x.replace(/[/*]/g,""), "w.js")'), '(x.replace(/[/*]/g,""), "w.js")');
});

test("balances args containing a regex with an escaped slash /\\//", () => {
  assert.equal(callOf('importScripts(s.split(/\\//)[0]+"w.js")'), '(s.split(/\\//)[0]+"w.js")');
});

test("balances nested parens (webpack chunk URL)", () => {
  assert.equal(callOf("importScripts(o.p+o.u(t))"), "(o.p+o.u(t))");
});

test("division is not mistaken for a regex", () => {
  assert.equal(callOf("importScripts(a/b, c)"), "(a/b, c)");
});

test("a real line comment after a value still ends the scan", () => {
  assert.equal(callOf("importScripts(a) //c\n"), "(a)");
});

test("a block comment with a stray ) inside is skipped", () => {
  assert.equal(callOf("importScripts(a /* hi ) */, b)"), "(a /* hi ) */, b)");
});

test("a string containing ) does not close the call early", () => {
  assert.equal(callOf('importScripts("a)b.js")'), '("a)b.js")');
});

test("returns -1 for an unbalanced call", () => {
  assert.equal(matchBalancedParen("importScripts(a, b", open("importScripts(a, b")), -1);
});

// A property whose name equals a regex-preceding keyword (`o.return`, `o.of`, …)
// followed by division must NOT be read as a regex — the `.` marks it a member
// name, not the keyword. Missing this desynced the whole paren scan → UNBALANCED,
// silently dropping importScripts calls and webpack chunks from the background page.
for (const kw of ["return", "in", "of", "new", "delete", "void", "case", "do",
                  "else", "yield", "await", "typeof", "instanceof", "throw"]) {
  test(`division after member '.${kw}' is not a regex`, () => {
    assert.equal(callOf(`importScripts(o.${kw} / 2, "w.js")`), `(o.${kw} / 2, "w.js")`);
  });
}

test("a genuine keyword-led regex is still a regex (return /x/)", () => {
  assert.equal(callOf('importScripts((function(){return /a)b/})(), "w.js")'),
    '((function(){return /a)b/})(), "w.js")');
});
