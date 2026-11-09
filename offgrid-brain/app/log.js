"use strict";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;
const setLevel = (l) => { threshold = LEVELS[l] || LEVELS.info; };
function emit(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + (typeof extra === "string" ? extra : JSON.stringify(extra));
  console.log(`[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}${tail}`);
}
module.exports = {
  setLevel,
  debug: (m, e) => emit("debug", m, e),
  info: (m, e) => emit("info", m, e),
  warn: (m, e) => emit("warn", m, e),
  error: (m, e) => emit("error", m, e),
};
