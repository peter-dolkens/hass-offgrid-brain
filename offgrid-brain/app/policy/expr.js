/* VENDORED from offgrid-sim/web/expr.js — DO NOT EDIT HERE.
   Edit the simulator copy, then run ha-addon/offgrid-brain/tools/sync-policy-engine.sh
   Source sha256: 808eb0d4f0470d864c9d2d73945a739af841df4f850e73b7de426f2f2300c57a */
/* Tiny safe expression language for load/heat-source rules.
   Compiles a string to a fast closure (ctx)=>number. No eval / Function.
   Supports: numbers, true/false, vars, + - * / %, comparisons, and/or/not (& |
   ! keywords too), ternary ?:, parentheses, and funcs if/min/max/clamp/abs/floor.
   Booleans are 1/0; comparisons and logic return 1/0; truthiness = nonzero. */
(function (root) {
  "use strict";

  const FUNCS = {
    if: (c, a, b) => (c ? a : b),
    min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
    clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
    abs: Math.abs, floor: Math.floor, round: Math.round,
  };

  function tokenize(s) {
    const t = []; let i = 0;
    const two = ["&&", "||", ">=", "<=", "==", "!="];
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\n") { i++; continue; }
      if (/[0-9.]/.test(c)) { let j = i + 1; while (j < s.length && /[0-9.]/.test(s[j])) j++; t.push({ t: "num", v: parseFloat(s.slice(i, j)) }); i = j; continue; }
      if (/[a-zA-Z_]/.test(c)) { let j = i + 1; while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++; t.push({ t: "id", v: s.slice(i, j) }); i = j; continue; }
      const pair = s.slice(i, i + 2);
      if (two.includes(pair)) { t.push({ t: "op", v: pair }); i += 2; continue; }
      if ("+-*/%()<>!?:,".includes(c)) { t.push({ t: "op", v: c }); i++; continue; }
      throw "Unexpected character '" + c + "'";
    }
    t.push({ t: "end" });
    return t;
  }

  function compile(src, vars) {
    const allowed = new Set(vars || []);
    let toks, pos;
    const peek = () => toks[pos], next = () => toks[pos++];
    const eat = (v) => { const k = next(); if (k.v !== v) throw "Expected '" + v + "'"; };
    const isKw = (k, w) => k.t === "id" && k.v === w;

    function primary() {
      const k = next();
      if (k.t === "num") { const v = k.v; return () => v; }
      if (k.t === "op" && k.v === "(") { const e = expr(); eat(")"); return e; }
      if (k.t === "op" && (k.v === "-" )) { const e = unary(); return c => -e(c); }
      if (k.t === "op" && (k.v === "!")) { const e = unary(); return c => (e(c) ? 0 : 1); }
      if (k.t === "id") {
        if (k.v === "true") return () => 1;
        if (k.v === "false") return () => 0;
        if (k.v === "not") { const e = unary(); return c => (e(c) ? 0 : 1); }
        if (peek().t === "op" && peek().v === "(") {   // function call
          const fn = FUNCS[k.v]; if (!fn) throw "Unknown function '" + k.v + "'";
          next(); const args = [];
          if (!(peek().t === "op" && peek().v === ")")) { args.push(expr()); while (peek().v === ",") { next(); args.push(expr()); } }
          eat(")");
          return c => fn(...args.map(a => a(c)));
        }
        if (!allowed.has(k.v)) throw "Unknown variable '" + k.v + "'";
        const name = k.v; return c => { const v = c[name]; return typeof v === "boolean" ? (v ? 1 : 0) : +v || 0; };
      }
      throw "Unexpected token";
    }
    function unary() { return primary(); }
    function mul() { let l = unary(); while (peek().t === "op" && "*/%".includes(peek().v)) { const o = next().v; const r = unary(); const a = l; l = o === "*" ? c => a(c) * r(c) : o === "/" ? c => a(c) / r(c) : c => a(c) % r(c); } return l; }
    function add() { let l = mul(); while (peek().t === "op" && "+-".includes(peek().v)) { const o = next().v; const r = mul(); const a = l; l = o === "+" ? c => a(c) + r(c) : c => a(c) - r(c); } return l; }
    function cmp() { let l = add(); while (peek().t === "op" && [">", "<", ">=", "<=", "==", "!="].includes(peek().v)) { const o = next().v; const r = add(); const a = l; l = c => { const x = a(c), y = r(c); return (o === ">" ? x > y : o === "<" ? x < y : o === ">=" ? x >= y : o === "<=" ? x <= y : o === "==" ? x === y : x !== y) ? 1 : 0; }; } return l; }
    function and() { let l = cmp(); while ((peek().t === "op" && peek().v === "&&") || isKw(peek(), "and")) { next(); const r = cmp(); const a = l; l = c => (a(c) && r(c)) ? 1 : 0; } return l; }
    function or() { let l = and(); while ((peek().t === "op" && peek().v === "||") || isKw(peek(), "or")) { next(); const r = and(); const a = l; l = c => (a(c) || r(c)) ? 1 : 0; } return l; }
    function expr() {
      const cond = or();
      if (peek().t === "op" && peek().v === "?") { next(); const a = expr(); eat(":"); const b = expr(); return c => (cond(c) ? a(c) : b(c)); }
      return cond;
    }

    try {
      toks = tokenize(src); pos = 0;
      const fn = expr();
      if (peek().t !== "end") throw "Unexpected trailing input";
      return { ok: true, fn: (ctx) => { const v = fn(ctx); return isFinite(v) ? v : 0; } };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const Expr = { compile };
  if (typeof module !== "undefined" && module.exports) module.exports = Expr;
  else root.Expr = Expr;
})(typeof window !== "undefined" ? window : globalThis);
