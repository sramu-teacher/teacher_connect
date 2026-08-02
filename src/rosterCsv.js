import { parseCsv, encodeCsv } from "./csv.js";

const HEADER_ALIASES = {
  period: ["period"],
  name: ["name", "student", "student name"],
  first: ["first", "first name", "firstname"],
  last: ["last", "last name", "lastname"],
  academicLevel: ["academic level", "academiclevel", "level"],
  el: ["el", "english learner"],
  elLevel: ["el level", "ellevel", "proficiency", "proficiency level"],
  vision: ["vision"],
  hearing: ["hearing"],
  iep: ["iep", "iep notes", "iep / 504 accommodations", "504", "accommodations"],
  behaviorNotes: ["behavior notes", "behavior", "behaviour notes", "behaviour"],
  friends: ["friends", "pairs well with"],
  avoid: ["avoid", "must not sit near", "avoid pairing"],
};

function findColumnIndex(header, aliases) {
  for (const alias of aliases) {
    const idx = header.findIndex((h) => h.trim().toLowerCase() === alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseBool(value) {
  const v = (value || "").trim().toLowerCase();
  return v === "true" || v === "yes" || v === "y" || v === "1";
}

function splitNameList(value) {
  return (value || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parses a roster CSV, tolerating anything from a bare list of names (no
// header, or a simple "Name" column) up to our own full multi-period
// export (Period, Academic Level, EL, Vision, Hearing, IEP, Behavior
// Notes, Friends, Avoid all present). Extra/unrecognized columns are
// ignored rather than erroring.
export function parseRosterCsv(text) {
  const table = parseCsv(text);
  if (table.length === 0) return { hasHeader: false, hasPeriodColumn: false, rows: [] };

  const headerRow = table[0].map((h) => h.trim().toLowerCase());
  const col = {
    period: findColumnIndex(headerRow, HEADER_ALIASES.period),
    name: findColumnIndex(headerRow, HEADER_ALIASES.name),
    first: findColumnIndex(headerRow, HEADER_ALIASES.first),
    last: findColumnIndex(headerRow, HEADER_ALIASES.last),
    academicLevel: findColumnIndex(headerRow, HEADER_ALIASES.academicLevel),
    el: findColumnIndex(headerRow, HEADER_ALIASES.el),
    elLevel: findColumnIndex(headerRow, HEADER_ALIASES.elLevel),
    vision: findColumnIndex(headerRow, HEADER_ALIASES.vision),
    hearing: findColumnIndex(headerRow, HEADER_ALIASES.hearing),
    iep: findColumnIndex(headerRow, HEADER_ALIASES.iep),
    behaviorNotes: findColumnIndex(headerRow, HEADER_ALIASES.behaviorNotes),
    friends: findColumnIndex(headerRow, HEADER_ALIASES.friends),
    avoid: findColumnIndex(headerRow, HEADER_ALIASES.avoid),
  };
  const hasHeader = col.name !== -1 || col.first !== -1 || col.last !== -1;
  const dataRows = hasHeader ? table.slice(1) : table;

  const rows = dataRows
    .map((cells) => {
      let name = "";
      if (hasHeader && col.name !== -1) {
        name = cells[col.name] || "";
      } else if (hasHeader && (col.first !== -1 || col.last !== -1)) {
        name = [cells[col.first], cells[col.last]].filter(Boolean).join(" ");
      } else {
        name = cells.length >= 2 ? `${cells[1]} ${cells[0]}` : cells[0];
      }
      name = (name || "").trim();
      if (!name) return null;

      const row = { name };
      if (col.period !== -1) row.period = (cells[col.period] || "").trim();
      if (col.academicLevel !== -1) {
        const v = (cells[col.academicLevel] || "").trim().toLowerCase();
        if (v === "low" || v === "medium" || v === "high") row.academicLevel = v;
      }
      if (col.el !== -1) row.el = parseBool(cells[col.el]);
      if (col.elLevel !== -1) row.elLevel = (cells[col.elLevel] || "").trim();
      if (col.vision !== -1) row.vision = parseBool(cells[col.vision]);
      if (col.hearing !== -1) row.hearing = parseBool(cells[col.hearing]);
      if (col.iep !== -1) row.iep = cells[col.iep] || "";
      if (col.behaviorNotes !== -1) row.behaviorNotes = cells[col.behaviorNotes] || "";
      if (col.friends !== -1) row.friendNames = splitNameList(cells[col.friends]);
      if (col.avoid !== -1) row.avoidNames = splitNameList(cells[col.avoid]);
      return row;
    })
    .filter(Boolean);

  return { hasHeader, hasPeriodColumn: col.period !== -1, rows };
}

const CSV_HEADER = [
  "Period", "Name", "Academic Level", "EL", "EL Level", "Vision", "Hearing",
  "IEP", "Behavior Notes", "Friends", "Avoid",
];

// Builds the full multi-period roster export: one row per student across
// every period, in the same column shape parseRosterCsv understands, so
// exporting then re-importing round-trips every roster field (though
// not room layout or seat assignments — those stay JSON-only).
export function buildRosterCsv(periods, periodOrder) {
  const rows = [CSV_HEADER];
  for (const periodName of periodOrder) {
    const students = periods[periodName]?.students || [];
    const byId = Object.fromEntries(students.map((s) => [s.id, s]));
    for (const s of students) {
      rows.push([
        periodName,
        s.name,
        s.academicLevel || "",
        s.el ? "true" : "false",
        s.elLevel || "",
        s.vision ? "true" : "false",
        s.hearing ? "true" : "false",
        s.iep || "",
        s.behaviorNotes || "",
        s.friends.map((id) => byId[id]?.name).filter(Boolean).join("; "),
        s.avoid.map((id) => byId[id]?.name).filter(Boolean).join("; "),
      ]);
    }
  }
  return encodeCsv(rows);
}
