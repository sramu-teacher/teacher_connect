import React, { useState, useMemo, useCallback, useRef } from "react";
import { Plus, X, Upload, Download, CloudUpload, CloudDownload, Wand2, AlertTriangle, Users, Ear, Eye, Languages, FileText, ChevronDown, ChevronUp, Trash2, RotateCcw, Grid3x3, Info, Check, Cloud, Loader2, StickyNote, Flag } from "lucide-react";
import { saveJsonToDrive, loadJsonFromDrive, pickRosterFileFromDrive } from "./googleDrive";
import { extractTextFromPdf } from "./pdf";

const DRIVE_FILENAME = "teacher_connect-seating-data.json";

// ---------- Design tokens ----------
// Deep slate / warm paper / brass accent / sage-good / clay-conflict
const T = {
  ink: "#1F2A24",
  paper: "#FAF7F0",
  paperDim: "#F1ECE0",
  graphite: "#3D3D3D",
  line: "#D9D2C0",
  brass: "#B8862F",
  brassSoft: "#EFE1C4",
  sage: "#5C7A5C",
  sageSoft: "#E1EADB",
  clay: "#A6452F",
  claySoft: "#F2DDD5",
  slate: "#2E3A33",
};

const uid = () => Math.random().toString(36).slice(2, 10);

function emptyStudent(name = "") {
  return {
    id: uid(),
    name,
    iep: "",
    el: false,
    elLevel: "",
    behaviorNotes: "",
    vision: false,
    hearing: false,
    academicLevel: "medium", // low, medium, high
    friends: [], // ids they work well with / want near
    avoid: [], // ids they must NOT sit near
    observationLog: [], // [{id, date, text, flagged}]
  };
}

// ---------- Periods ----------
const PERIODS = ["Period 1", "Period 2", "Period 3", "Period 4", "Period 5", "Period 6", "Advisory"];

function defaultPeriodState() {
  return {
    students: [],
    layoutType: "grid", // grid | pods | pairs
    rows: 4,
    cols: 5,
    numPods: 6,
    perPod: 4,
    numPairs: 10,
    pairCols: 5,
    options: {
      balanceAcademic: true,
      separateBehavior: true,
      honorFriends: true,
    },
    assignment: {},
    violations: [],
    hasGenerated: false,
    periodNotes: "",
  };
}

// ---------- Parsing bulk paste ----------
function parseBulkNames(text) {
  return text
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => emptyStudent(name));
}

// ---------- Parsing uploaded roster files (.csv / .txt) ----------
function parseRosterFile(text, filename = "") {
  const isCsv = filename.toLowerCase().endsWith(".csv") || text.includes(",");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  if (isCsv) {
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const nameIdx = header.findIndex((h) => h === "name" || h === "student" || h === "student name");
    const firstIdx = header.findIndex((h) => h === "first" || h === "first name" || h === "firstname");
    const lastIdx = header.findIndex((h) => h === "last" || h === "last name" || h === "lastname");
    const hasHeader = nameIdx !== -1 || firstIdx !== -1 || lastIdx !== -1;
    const dataLines = hasHeader ? lines.slice(1) : lines;

    return dataLines
      .map((line) => {
        const cols = line.split(",").map((c) => c.trim());
        let name = "";
        if (hasHeader && nameIdx !== -1) {
          name = cols[nameIdx] || "";
        } else if (hasHeader && (firstIdx !== -1 || lastIdx !== -1)) {
          name = [cols[firstIdx], cols[lastIdx]].filter(Boolean).join(" ");
        } else {
          name = cols.length >= 2 ? `${cols[1]} ${cols[0]}` : cols[0];
        }
        return name.trim();
      })
      .filter(Boolean)
      .map((name) => emptyStudent(name));
  }

  return lines.map((name) => emptyStudent(name));
}

// ---------- Parsing PDF rosters ----------
// PDF text extraction reconstructs lines from text-item positions, not
// real delimiters, and roster PDFs commonly mix in headers/footers
// (school name, period, dates, codes, column labels) alongside the
// actual names. Filter those out with a few name-shaped heuristics
// rather than treating every non-empty line as a student — still
// best-effort (multi-column layouts can still misread), which is why
// the caller prompts the teacher to review the imported roster after.
const PDF_METADATA_KEYWORDS = [
  "student name", "first name", "last name", "roster", "period", "school",
  "grade", "teacher", "course", "section", "date", "page", "district",
  "attendance", "advisory", "homeroom", "room", "campus", "printed",
  "generated", "code", "class",
];

// Extracts a name from a line of PDF text, or null if the line doesn't
// look like it contains one. Rather than rejecting the whole line when
// it contains a digit, this pulls out the longest run of consecutive
// name-shaped tokens — so a table row like "John Smith  10  Rm 204"
// (grade/room sharing the same visual line as the name, which pdf.js
// merges into one line) still yields "John Smith" instead of nothing.
function extractNameFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/[:@]/.test(trimmed)) return null; // "School: Lincoln High", emails

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const wordPattern = /^[A-Za-z][A-Za-z'-]*[,.]?$/;

  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i <= tokens.length; i++) {
    const isNameWord = i < tokens.length && wordPattern.test(tokens[i]);
    if (isNameWord) {
      if (curLen === 0) curStart = i;
      curLen++;
    } else {
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      curLen = 0;
    }
  }
  if (bestLen < 2 || bestLen > 4) return null; // real names are ~2-4 words

  const candidate = tokens.slice(bestStart, bestStart + bestLen).join(" ");
  const lower = candidate.toLowerCase();
  if (PDF_METADATA_KEYWORDS.some((kw) => lower.includes(kw))) return null;

  return candidate;
}

function parsePdfRosterText(text) {
  return text
    .split(/\r?\n/)
    .map(extractNameFromLine)
    .filter(Boolean)
    .map((name) => emptyStudent(name));
}

// ---------- Seating algorithm ----------
function generateSeatingChart(students, seats, options) {
  const { balanceAcademic, separateBehavior, honorFriends } = options;

  const neighborMap = {};
  seats.forEach((s) => (neighborMap[s.id] = []));
  seats.forEach((a) => {
    seats.forEach((b) => {
      if (a.id === b.id) return;
      const sameGroup = a.groupId && a.groupId === b.groupId;
      const adjacentGrid =
        a.groupId == null &&
        b.groupId == null &&
        a.row === b.row &&
        Math.abs(a.col - b.col) === 1;
      const rowBehind =
        a.groupId == null &&
        b.groupId == null &&
        a.col === b.col &&
        Math.abs(a.row - b.row) === 1;
      if (sameGroup || adjacentGrid || rowBehind) {
        neighborMap[a.id].push(b.id);
      }
    });
  });

  const studentsShuffled = [...students].sort(() => Math.random() - 0.5);
  const seatOrder = [...seats].sort((a, b) => a.row - b.row || a.col - b.col);

  const assignment = {};
  const studentSeat = {};
  const placed = new Set();

  function conflictScore(studentId, seatId) {
    const student = students.find((s) => s.id === studentId);
    let score = 0;
    const neighbors = neighborMap[seatId] || [];
    for (const nSeatId of neighbors) {
      const neighborStudentId = assignment[nSeatId];
      if (!neighborStudentId) continue;
      const neighborStudent = students.find((s) => s.id === neighborStudentId);
      if (!neighborStudent) continue;

      if (
        student.avoid.includes(neighborStudentId) ||
        neighborStudent.avoid.includes(studentId)
      ) {
        score += 10000;
      }
      if (
        honorFriends &&
        (student.friends.includes(neighborStudentId) ||
          neighborStudent.friends.includes(studentId))
      ) {
        score -= 5;
      }
      if (
        separateBehavior &&
        student.behaviorNotes &&
        neighborStudent.behaviorNotes
      ) {
        score += 40;
      }
      if (balanceAcademic && student.academicLevel === neighborStudent.academicLevel) {
        score += 8;
      }
    }
    return score;
  }

  const priorityFront = studentsShuffled.filter(
    (s) => s.vision || s.hearing || (s.el && s.elLevel === "beginning")
  );
  const frontSeats = seatOrder.filter((s) => s.row <= 1);
  const restSeats = seatOrder.filter((s) => s.row > 1);
  const orderedSeatsForFront = [...frontSeats, ...restSeats];

  const remainingStudents = studentsShuffled.filter((s) => !priorityFront.includes(s));
  const fillQueue = [...priorityFront, ...remainingStudents];

  for (const student of fillQueue) {
    let bestSeat = null;
    let bestScore = Infinity;
    const candidateSeats =
      priorityFront.includes(student) && !placed.has(student.id) ? orderedSeatsForFront : seatOrder;

    for (const seat of candidateSeats) {
      if (assignment[seat.id]) continue;
      const score = conflictScore(student.id, seat.id);
      const jitter = Math.random() * 2;
      if (score + jitter < bestScore) {
        bestScore = score + jitter;
        bestSeat = seat;
      }
    }
    if (bestSeat) {
      assignment[bestSeat.id] = student.id;
      studentSeat[student.id] = bestSeat.id;
      placed.add(student.id);
    }
  }

  const violations = [];
  for (const seat of seats) {
    const sid = assignment[seat.id];
    if (!sid) continue;
    const student = students.find((s) => s.id === sid);
    for (const nSeatId of neighborMap[seat.id] || []) {
      const nId = assignment[nSeatId];
      if (!nId) continue;
      if (student.avoid.includes(nId)) {
        const nStudent = students.find((s) => s.id === nId);
        const key = [sid, nId].sort().join("-");
        if (!violations.find((v) => v.key === key)) {
          violations.push({ key, a: student.name, b: nStudent.name });
        }
      }
    }
  }

  return { assignment, violations };
}

// ---------- Seat geometry builders ----------
function buildGrid(rows, cols) {
  const seats = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      seats.push({ id: `r${r}c${c}`, row: r, col: c, groupId: null });
    }
  }
  return seats;
}

function buildPods(numPods, perPod) {
  const seats = [];
  const cols = Math.min(numPods, 4);
  for (let p = 0; p < numPods; p++) {
    const podRow = Math.floor(p / cols);
    const podCol = p % cols;
    for (let i = 0; i < perPod; i++) {
      seats.push({ id: `pod${p}s${i}`, row: podRow, col: podCol, groupId: `pod${p}`, seatIndexInGroup: i });
    }
  }
  return seats;
}

function buildPairs(numPairs, cols) {
  const seats = [];
  for (let p = 0; p < numPairs; p++) {
    const row = Math.floor(p / cols);
    const col = p % cols;
    seats.push({ id: `pair${p}a`, row, col, groupId: `pair${p}`, seatIndexInGroup: 0 });
    seats.push({ id: `pair${p}b`, row, col, groupId: `pair${p}`, seatIndexInGroup: 1 });
  }
  return seats;
}

// ---------- Main App ----------
export default function SeatingChart() {
  const [periods, setPeriods] = useState(() =>
    Object.fromEntries(PERIODS.map((p) => [p, defaultPeriodState()]))
  );
  const [activePeriod, setActivePeriod] = useState(PERIODS[0]);
  const period = periods[activePeriod];

  const [activeTab, setActiveTab] = useState("roster"); // roster | chart
  const [expandedStudentId, setExpandedStudentId] = useState(null);
  const [bulkText, setBulkText] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [draggedStudent, setDraggedStudent] = useState(null);
  const [toast, setToast] = useState(null);
  const [rosterDragOver, setRosterDragOver] = useState(false);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveResult, setDriveResult] = useState(null);
  const [driveBusy, setDriveBusy] = useState(null); // "save" | "load" | null
  const fileInputRef = useRef(null);
  const rosterFileInputRef = useRef(null);

  // Update the active period's slice immutably. Accepts an object patch or a fn(prevPeriod) => patch
  const updatePeriod = useCallback(
    (patch) => {
      setPeriods((prev) => {
        const prevPeriod = prev[activePeriod];
        const resolved = typeof patch === "function" ? patch(prevPeriod) : patch;
        return { ...prev, [activePeriod]: { ...prevPeriod, ...resolved } };
      });
    },
    [activePeriod]
  );

  const seats = useMemo(() => {
    if (period.layoutType === "grid") return buildGrid(period.rows, period.cols);
    if (period.layoutType === "pods") return buildPods(period.numPods, period.perPod);
    if (period.layoutType === "pairs") return buildPairs(period.numPairs, period.pairCols);
    return [];
  }, [period.layoutType, period.rows, period.cols, period.numPods, period.perPod, period.numPairs, period.pairCols]);

  const showToast = useCallback((msg, tone = "sage") => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3200);
  }, []);

  const switchPeriod = (p) => {
    setActivePeriod(p);
    setActiveTab("roster");
    setExpandedStudentId(null);
    setDriveResult(null);
  };

  const addStudent = () => {
    const s = emptyStudent("");
    updatePeriod((p) => ({ students: [...p.students, s] }));
    setExpandedStudentId(s.id);
    setActiveTab("roster");
  };

  const updateStudent = (id, patch) => {
    updatePeriod((p) => ({
      students: p.students.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  };

  const removeStudent = (id) => {
    updatePeriod((p) => ({
      students: p.students
        .filter((s) => s.id !== id)
        .map((s) => ({
          ...s,
          friends: s.friends.filter((f) => f !== id),
          avoid: s.avoid.filter((a) => a !== id),
        })),
    }));
    updatePeriod((p) => {
      const next = { ...p.assignment };
      Object.keys(next).forEach((seatId) => {
        if (next[seatId] === id) delete next[seatId];
      });
      return { assignment: next };
    });
  };

  const toggleRelation = (id, otherId, field) => {
    updatePeriod((p) => ({
      students: p.students.map((s) => {
        if (s.id !== id) return s;
        const has = s[field].includes(otherId);
        return {
          ...s,
          [field]: has ? s[field].filter((x) => x !== otherId) : [...s[field], otherId],
        };
      }),
    }));
  };

  const logObservation = (studentId, text, flagged) => {
    if (!text.trim()) return;
    const entry = {
      id: uid(),
      date: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      text: text.trim(),
      flagged,
    };
    updatePeriod((p) => ({
      students: p.students.map((s) => {
        if (s.id !== studentId) return s;
        const nextLog = [entry, ...s.observationLog];
        const nextBehavior = flagged
          ? (s.behaviorNotes ? `${s.behaviorNotes}\n[${entry.date}] ${entry.text}` : `[${entry.date}] ${entry.text}`)
          : s.behaviorNotes;
        return { ...s, observationLog: nextLog, behaviorNotes: nextBehavior };
      }),
    }));
    showToast(flagged ? "Observation logged and flagged for seating." : "Observation logged.");
  };

  const removeObservation = (studentId, obsId) => {
    updatePeriod((p) => ({
      students: p.students.map((s) =>
        s.id === studentId ? { ...s, observationLog: s.observationLog.filter((o) => o.id !== obsId) } : s
      ),
    }));
  };

  const handleBulkAdd = () => {
    const newStudents = parseBulkNames(bulkText);
    if (newStudents.length === 0) {
      showToast("No names found to add.", "clay");
      return;
    }
    updatePeriod((p) => ({ students: [...p.students, ...newStudents] }));
    setBulkText("");
    setShowBulk(false);
    showToast(`Added ${newStudents.length} student${newStudents.length > 1 ? "s" : ""} to ${activePeriod}.`);
  };

  // Re-uploading the same (or an updated) roster file for a period should
  // never remove or overwrite existing students — it only adds names that
  // aren't already on the roster (matched case-insensitively), and reports
  // the delta so the teacher knows what actually changed.
  const addImportedStudents = (parsedStudents, sourceName, extraNote = "") => {
    if (parsedStudents.length === 0) {
      showToast(`Couldn't find any names in ${sourceName}.`, "clay");
      return { added: 0, duplicates: 0 };
    }
    const existingNames = new Set(period.students.map((s) => s.name.trim().toLowerCase()));
    const newStudents = parsedStudents.filter((s) => !existingNames.has(s.name.trim().toLowerCase()));
    const duplicates = parsedStudents.length - newStudents.length;

    if (newStudents.length === 0) {
      showToast(`Everyone in ${sourceName} is already on the ${activePeriod} roster — nothing new to add.`, "sage");
      return { added: 0, duplicates };
    }

    updatePeriod((p) => ({ students: [...p.students, ...newStudents] }));
    const dupeNote = duplicates > 0 ? ` ${duplicates} already on the roster ${duplicates > 1 ? "were" : "was"} left unchanged.` : "";
    showToast(
      `Added ${newStudents.length} new student${newStudents.length > 1 ? "s" : ""} from ${sourceName} to ${activePeriod}.${dupeNote}${extraNote}`
    );
    return { added: newStudents.length, duplicates };
  };

  const handleRosterFile = (file) => {
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    const isPdf = lowerName.endsWith(".pdf");
    if (!isPdf && !lowerName.endsWith(".csv") && !lowerName.endsWith(".txt")) {
      showToast("Please upload a .csv, .txt, or .pdf file of student names.", "clay");
      return;
    }

    const reader = new FileReader();
    if (isPdf) {
      reader.onload = async (evt) => {
        try {
          const text = await extractTextFromPdf(evt.target.result);
          addImportedStudents(
            parsePdfRosterText(text),
            file.name,
            " PDF layout can affect accuracy — please review the roster."
          );
        } catch {
          showToast("Couldn't read that PDF — it may be a scanned image rather than real text.", "clay");
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (evt) => addImportedStudents(parseRosterFile(evt.target.result, file.name), file.name);
      reader.readAsText(file);
    }
  };

  // Opens Google's file picker so the teacher can choose a Sheet, Doc, CSV,
  // text, or PDF roster from their own Drive; parsed the same way an
  // uploaded file would be.
  const handleDriveImport = async () => {
    setDriveLoading(true);
    setDriveResult(null);
    try {
      const picked = await pickRosterFileFromDrive();
      if (!picked) return; // teacher cancelled the picker
      const isPdf = picked.mimeType === "application/pdf";
      const parsed = isPdf
        ? parsePdfRosterText(await extractTextFromPdf(picked.arrayBuffer))
        : parseRosterFile(new TextDecoder().decode(picked.arrayBuffer), picked.name);
      const { added, duplicates } = addImportedStudents(
        parsed,
        `"${picked.name}"`,
        isPdf ? " PDF layout can affect accuracy — please review the roster." : ""
      );
      setDriveResult({ fileName: picked.name, count: added, duplicates });
    } catch (err) {
      showToast(err.message || "Couldn't import from Drive — try again.", "clay");
    } finally {
      setDriveLoading(false);
    }
  };

  const handleGenerate = () => {
    if (period.students.length === 0) {
      showToast("Add students to the roster first.", "clay");
      return;
    }
    if (seats.length < period.students.length) {
      showToast(`Only ${seats.length} seats for ${period.students.length} students — add more seats.`, "clay");
    }
    const result = generateSeatingChart(period.students, seats, period.options);
    updatePeriod({ assignment: result.assignment, violations: result.violations, hasGenerated: true });
    setActiveTab("chart");
    if (result.violations.length === 0) {
      showToast("Seating chart generated — no avoid-pairs seated together.");
    } else {
      showToast(
        `Generated with ${result.violations.length} unavoidable conflict${result.violations.length > 1 ? "s" : ""} — see notes below the chart.`,
        "clay"
      );
    }
  };

  const buildExportData = () => ({ periods, activePeriod, savedAt: new Date().toISOString() });

  const applyImportedData = (data) => {
    if (data.periods) {
      // ensure every expected period key exists, migrate missing ones
      const merged = Object.fromEntries(PERIODS.map((p) => [p, data.periods[p] || defaultPeriodState()]));
      setPeriods(merged);
    }
    if (data.activePeriod && PERIODS.includes(data.activePeriod)) setActivePeriod(data.activePeriod);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(buildExportData(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `seating-chart-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        applyImportedData(JSON.parse(evt.target.result));
        showToast("Document loaded — all periods restored.");
      } catch {
        showToast("Couldn't read that file — expecting a JSON export from this app.", "clay");
      }
    };
    reader.readAsText(file);
  };

  const handleSaveToDrive = async () => {
    setDriveBusy("save");
    try {
      await saveJsonToDrive(DRIVE_FILENAME, buildExportData());
      showToast("All periods saved to Google Drive.");
    } catch (err) {
      showToast(err.message || "Couldn't save to Google Drive.", "clay");
    } finally {
      setDriveBusy(null);
    }
  };

  const handleLoadFromDrive = async () => {
    setDriveBusy("load");
    try {
      const data = await loadJsonFromDrive();
      if (data) {
        applyImportedData(data);
        showToast("Document loaded from Google Drive.");
      }
    } catch (err) {
      showToast(err.message || "Couldn't load from Google Drive.", "clay");
    } finally {
      setDriveBusy(null);
    }
  };

  const handleDrop = (seatId) => {
    if (!draggedStudent) return;
    updatePeriod((p) => {
      const next = { ...p.assignment };
      const fromSeat = Object.keys(next).find((sid) => next[sid] === draggedStudent);
      const displaced = next[seatId];
      if (fromSeat) next[fromSeat] = displaced || undefined;
      if (!displaced && fromSeat) delete next[fromSeat];
      next[seatId] = draggedStudent;
      return { assignment: next };
    });
    setDraggedStudent(null);
  };

  const unseated = period.students.filter((s) => !Object.values(period.assignment).includes(s.id));
  const studentById = Object.fromEntries(period.students.map((s) => [s.id, s]));

  const flagCounts = {
    iep: period.students.filter((s) => s.iep.trim()).length,
    el: period.students.filter((s) => s.el).length,
    behavior: period.students.filter((s) => s.behaviorNotes.trim()).length,
    vision: period.students.filter((s) => s.vision).length,
    hearing: period.students.filter((s) => s.hearing).length,
  };

  return (
    <div style={{ minHeight: "100vh", background: T.paper, fontFamily: "'Iowan Old Style','Georgia',serif", color: T.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .serif { font-family: 'Fraunces', Georgia, serif; }
        .sans { font-family: 'Inter', system-ui, sans-serif; }
        button { font-family: 'Inter', system-ui, sans-serif; cursor: pointer; }
        input, textarea, select { font-family: 'Inter', system-ui, sans-serif; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: ${T.line}; border-radius: 4px; }
        .seat { transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; }
        .seat:hover { transform: translateY(-2px); }
        .fade-in { animation: fadeIn 0.35s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .spin { animation: spin 0.8s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .tab-underline { position: relative; }
        .tab-underline::after {
          content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
          background: ${T.brass}; transform: scaleX(0); transition: transform 0.2s ease;
        }
        .tab-active::after { transform: scaleX(1); }
        input[type="checkbox"] { accent-color: ${T.brass}; }
        .chip { transition: all 0.15s ease; }
        @media (prefers-reduced-motion: reduce) {
          .seat, .fade-in, .chip { animation: none !important; transition: none !important; }
        }
      `}</style>

      {/* ---------- Header ---------- */}
      <header style={{ borderBottom: `1px solid ${T.line}`, background: T.paper, position: "sticky", top: 0, zIndex: 20 }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 24px 0", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div className="sans" style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: T.brass, fontWeight: 600, marginBottom: 2 }}>
              Roster &amp; Room
            </div>
            <h1 className="serif" style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.01em" }}>
              Seating Intelligence
            </h1>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor="load-json-input" className="sans" style={{ ...btnGhost, margin: 0 }}>
              <Upload size={15} /> Load
            </label>
            <input
              id="load-json-input"
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImport}
              style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            />
            <button onClick={handleExport} className="sans" style={btnGhost}>
              <Download size={15} /> Save
            </button>
            <button
              onClick={handleLoadFromDrive}
              disabled={driveBusy !== null}
              className="sans"
              style={{ ...btnGhost, opacity: driveBusy !== null ? 0.6 : 1 }}
            >
              <CloudDownload size={15} /> {driveBusy === "load" ? "Loading…" : "Load from Drive"}
            </button>
            <button
              onClick={handleSaveToDrive}
              disabled={driveBusy !== null}
              className="sans"
              style={{ ...btnGhost, opacity: driveBusy !== null ? 0.6 : 1 }}
            >
              <CloudUpload size={15} /> {driveBusy === "save" ? "Saving…" : "Save to Drive"}
            </button>
          </div>
        </div>

        {/* Period tabs */}
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "16px 24px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PERIODS.map((p) => {
            const active = p === activePeriod;
            const count = periods[p].students.length;
            return (
              <button
                key={p}
                onClick={() => switchPeriod(p)}
                className="sans"
                style={{
                  padding: "7px 14px",
                  borderRadius: 20,
                  fontSize: 12.5,
                  fontWeight: 700,
                  border: `1px solid ${active ? T.ink : T.line}`,
                  background: active ? T.ink : "transparent",
                  color: active ? T.paper : T.graphite,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {p}
                {count > 0 && (
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: active ? T.paper : T.brass,
                      opacity: active ? 0.85 : 1,
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Roster / Chart tabs */}
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "10px 24px 0", display: "flex", gap: 28 }}>
          {[
            { id: "roster", label: `Roster (${period.students.length})` },
            { id: "chart", label: "Seating Chart" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`sans tab-underline ${activeTab === t.id ? "tab-active" : ""}`}
              style={{
                background: "none",
                border: "none",
                padding: "10px 2px 14px 2px",
                fontSize: 14.5,
                fontWeight: 600,
                color: activeTab === t.id ? T.ink : "#8A8272",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 24px 80px" }}>
        {activeTab === "roster" && (
          <RosterView
            activePeriod={activePeriod}
            students={period.students}
            periodNotes={period.periodNotes}
            setPeriodNotes={(text) => updatePeriod({ periodNotes: text })}
            addStudent={addStudent}
            updateStudent={updateStudent}
            showToast={showToast}
            removeStudent={removeStudent}
            toggleRelation={toggleRelation}
            logObservation={logObservation}
            removeObservation={removeObservation}
            expandedStudentId={expandedStudentId}
            setExpandedStudentId={setExpandedStudentId}
            bulkText={bulkText}
            setBulkText={setBulkText}
            showBulk={showBulk}
            setShowBulk={setShowBulk}
            handleBulkAdd={handleBulkAdd}
            flagCounts={flagCounts}
            handleRosterFile={handleRosterFile}
            rosterFileInputRef={rosterFileInputRef}
            rosterDragOver={rosterDragOver}
            setRosterDragOver={setRosterDragOver}
            driveLoading={driveLoading}
            driveResult={driveResult}
            handleDriveImport={handleDriveImport}
          />
        )}

        {activeTab === "chart" && (
          <ChartView
            students={period.students}
            layoutType={period.layoutType}
            setLayoutType={(v) => updatePeriod({ layoutType: v })}
            rows={period.rows}
            setRows={(v) => updatePeriod({ rows: v })}
            cols={period.cols}
            setCols={(v) => updatePeriod({ cols: v })}
            numPods={period.numPods}
            setNumPods={(v) => updatePeriod({ numPods: v })}
            perPod={period.perPod}
            setPerPod={(v) => updatePeriod({ perPod: v })}
            numPairs={period.numPairs}
            setNumPairs={(v) => updatePeriod({ numPairs: v })}
            pairCols={period.pairCols}
            setPairCols={(v) => updatePeriod({ pairCols: v })}
            options={period.options}
            setOptions={(fnOrObj) =>
              updatePeriod((p) => ({
                options: typeof fnOrObj === "function" ? fnOrObj(p.options) : fnOrObj,
              }))
            }
            seats={seats}
            assignment={period.assignment}
            violations={period.violations}
            hasGenerated={period.hasGenerated}
            handleGenerate={handleGenerate}
            studentById={studentById}
            unseated={unseated}
            draggedStudent={draggedStudent}
            setDraggedStudent={setDraggedStudent}
            handleDrop={handleDrop}
          />
        )}
      </main>

      {toast && (
        <div
          className="fade-in sans"
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: toast.tone === "clay" ? T.clay : T.slate,
            color: T.paper,
            padding: "12px 20px",
            borderRadius: 8,
            fontSize: 13.5,
            fontWeight: 500,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            maxWidth: 480,
            textAlign: "center",
            zIndex: 100,
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

const btnGhost = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  border: `1px solid ${T.line}`,
  borderRadius: 7,
  padding: "8px 14px",
  fontSize: 13.5,
  fontWeight: 600,
  color: T.graphite,
};

const btnPrimary = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: T.ink,
  border: "none",
  borderRadius: 7,
  padding: "11px 18px",
  fontSize: 14,
  fontWeight: 700,
  color: T.paper,
};

// ================= Roster View =================
function RosterView({
  activePeriod,
  students,
  periodNotes,
  setPeriodNotes,
  addStudent,
  updateStudent,
  showToast,
  removeStudent,
  toggleRelation,
  logObservation,
  removeObservation,
  expandedStudentId,
  setExpandedStudentId,
  bulkText,
  setBulkText,
  showBulk,
  setShowBulk,
  handleBulkAdd,
  flagCounts,
  handleRosterFile,
  rosterFileInputRef,
  rosterDragOver,
  setRosterDragOver,
  driveLoading,
  driveResult,
  handleDriveImport,
}) {
  return (
    <div className="fade-in">
      {/* Period notes */}
      <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, padding: "12px 16px", background: T.paperDim, marginBottom: 18 }}>
        <div className="sans" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: "#6B6455", marginBottom: 6, letterSpacing: "0.03em" }}>
          <StickyNote size={13} color={T.brass} /> {activePeriod.toUpperCase()} NOTES
        </div>
        <textarea
          value={periodNotes}
          onChange={(e) => setPeriodNotes(e.target.value)}
          placeholder="General notes about this class — pacing, group dynamics, what worked last time..."
          className="sans"
          style={{ ...inputStyle, minHeight: 44, resize: "vertical", border: "none", background: "transparent", padding: "2px 0" }}
        />
      </div>

      {/* Summary strip */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 22 }}>
        <SummaryChip icon={<FileText size={13} />} label="IEP" count={flagCounts.iep} />
        <SummaryChip icon={<Languages size={13} />} label="EL" count={flagCounts.el} />
        <SummaryChip icon={<AlertTriangle size={13} />} label="Behavior notes" count={flagCounts.behavior} />
        <SummaryChip icon={<Eye size={13} />} label="Vision" count={flagCounts.vision} />
        <SummaryChip icon={<Ear size={13} />} label="Hearing" count={flagCounts.hearing} />
      </div>

      {/* Upload zone — drop a CSV/TXT/PDF roster, or click to browse via native label-for-input */}
      <label
        htmlFor="roster-file-input"
        onDragOver={(e) => {
          e.preventDefault();
          setRosterDragOver(true);
        }}
        onDragLeave={() => setRosterDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setRosterDragOver(false);
          const file = e.dataTransfer.files?.[0];
          handleRosterFile(file);
        }}
        className="sans"
        style={{
          display: "block",
          border: `1.5px dashed ${rosterDragOver ? T.brass : T.line}`,
          borderRadius: 12,
          padding: "28px 20px",
          textAlign: "center",
          background: rosterDragOver ? T.brassSoft : T.paperDim,
          cursor: "pointer",
          marginBottom: 6,
          transition: "background 0.15s ease, border-color 0.15s ease",
        }}
      >
        <Upload size={22} color={T.brass} style={{ marginBottom: 8 }} />
        <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink, marginBottom: 3 }}>
          Upload {activePeriod}'s roster
        </div>
        <div style={{ fontSize: 12.5, color: "#8A8272" }}>
          Drop a .csv, .txt, or .pdf file here, or click to browse — one student per row
          <br />
          PDF text is extracted automatically; scanned/image-only PDFs can't be read.
        </div>
        <input
          id="roster-file-input"
          ref={rosterFileInputRef}
          type="file"
          accept=".csv,.txt,.pdf,text/csv,text/plain,application/pdf"
          onChange={(e) => {
            handleRosterFile(e.target.files?.[0]);
            e.target.value = "";
          }}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />
      </label>
      <div className="sans" style={{ fontSize: 11.5, color: "#A89F8C", marginBottom: 18, textAlign: "center" }}>
        If the file dialog doesn't open on click, use "Paste names instead" below — it always works.
      </div>

      {/* Google Drive import */}
      <div style={{ border: `1px solid ${T.line}`, borderRadius: 12, padding: "16px 18px", background: T.paperDim, marginBottom: 18 }}>
        <div className="sans" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: T.ink, marginBottom: 10 }}>
          <Cloud size={16} color={T.brass} /> Import from Google Drive
        </div>
        <button
          onClick={handleDriveImport}
          disabled={driveLoading}
          className="sans"
          style={{
            ...btnGhost,
            background: driveLoading ? T.paperDim : T.paper,
            opacity: driveLoading ? 0.7 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {driveLoading ? <Loader2 size={14} className="spin" /> : <Cloud size={14} />}
          {driveLoading ? "Opening Drive…" : "Choose a roster file from Drive"}
        </button>
        <div className="sans" style={{ fontSize: 11.5, color: "#A89F8C", marginTop: 8 }}>
          Opens Google's file picker so you can select a Sheet, Doc, CSV, text, or PDF roster from your Drive (including files others shared with you) — names are pulled in the same way as an uploaded file, into {activePeriod}.
        </div>
        {driveResult && (
          <div className="sans fade-in" style={{ fontSize: 12, color: T.sage, marginTop: 8, fontWeight: 600 }}>
            Imported {driveResult.count} new student{driveResult.count !== 1 ? "s" : ""} from "{driveResult.fileName}"
            {driveResult.duplicates > 0 ? ` (${driveResult.duplicates} already on the roster, skipped)` : ""}.
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <button onClick={addStudent} className="sans" style={btnPrimary}>
          <Plus size={16} /> Add student
        </button>
        <button onClick={() => setShowBulk((v) => !v)} className="sans" style={btnGhost}>
          <Users size={15} /> Paste names instead
        </button>
      </div>

      {showBulk && (
        <div className="fade-in" style={{ marginBottom: 22, background: T.paperDim, border: `1px solid ${T.line}`, borderRadius: 10, padding: 16 }}>
          <div className="sans" style={{ fontSize: 12.5, color: "#6B6455", marginBottom: 8 }}>
            Paste one name per line (or comma-separated) into {activePeriod}. You can fill in IEP, EL, and pairing details after.
          </div>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={"Maria Gonzalez\nJamal Whitfield\nEthan Park\n..."}
            className="sans"
            style={{
              width: "100%",
              minHeight: 110,
              border: `1px solid ${T.line}`,
              borderRadius: 8,
              padding: 12,
              fontSize: 13.5,
              resize: "vertical",
              background: T.paper,
              color: T.ink,
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={handleBulkAdd} className="sans" style={{ ...btnPrimary, padding: "8px 16px" }}>
              Add to roster
            </button>
            <button onClick={() => setShowBulk(false)} className="sans" style={btnGhost}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {students.length === 0 ? (
        <EmptyRoster addStudent={addStudent} setShowBulk={setShowBulk} activePeriod={activePeriod} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {students.map((s) => (
            <StudentCard
              key={s.id}
              student={s}
              allStudents={students}
              updateStudent={updateStudent}
              showToast={showToast}
              removeStudent={removeStudent}
              toggleRelation={toggleRelation}
              logObservation={logObservation}
              removeObservation={removeObservation}
              expanded={expandedStudentId === s.id}
              setExpanded={() => setExpandedStudentId(expandedStudentId === s.id ? null : s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyRoster({ addStudent, setShowBulk, activePeriod }) {
  return (
    <div style={{ border: `1.5px dashed ${T.line}`, borderRadius: 12, padding: "56px 24px", textAlign: "center", background: T.paperDim }}>
      <Grid3x3 size={28} color={T.brass} style={{ marginBottom: 12 }} />
      <div className="serif" style={{ fontSize: 19, fontWeight: 600, marginBottom: 6 }}>
        No students in {activePeriod} yet
      </div>
      <div className="sans" style={{ fontSize: 13.5, color: "#8A8272", marginBottom: 18, maxWidth: 380, marginLeft: "auto", marginRight: "auto" }}>
        Add students one at a time with full details, or paste a class list to get everyone in fast.
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
        <button onClick={addStudent} className="sans" style={btnPrimary}>
          <Plus size={16} /> Add one student
        </button>
        <button onClick={() => setShowBulk(true)} className="sans" style={btnGhost}>
          Paste a class list
        </button>
      </div>
    </div>
  );
}

function SummaryChip({ icon, label, count }) {
  return (
    <div
      className="sans"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        border: `1px solid ${T.line}`,
        borderRadius: 20,
        padding: "6px 12px",
        fontSize: 12.5,
        fontWeight: 600,
        color: T.graphite,
        background: T.paper,
      }}
    >
      {icon}
      {label}
      <span style={{ color: T.brass, fontWeight: 700 }}>{count}</span>
    </div>
  );
}

function StudentCard({ student, allStudents, updateStudent, showToast, removeStudent, toggleRelation, logObservation, removeObservation, expanded, setExpanded }) {
  const others = allStudents.filter((s) => s.id !== student.id);
  const [obsText, setObsText] = useState("");
  const [obsFlag, setObsFlag] = useState(false);
  const [iepUploading, setIepUploading] = useState(false);

  // Extracts text from an uploaded IEP document (PDF or plain text) and
  // appends it to this student's existing IEP notes rather than replacing
  // them, so re-uploading an updated IEP each year keeps prior history.
  const handleIepFile = async (file) => {
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    const isPdf = lowerName.endsWith(".pdf");
    if (!isPdf && !lowerName.endsWith(".txt")) {
      showToast("Please upload a .pdf or .txt IEP document.", "clay");
      return;
    }
    setIepUploading(true);
    try {
      const text = (isPdf ? await extractTextFromPdf(await file.arrayBuffer()) : await file.text()).trim();
      if (!text) {
        showToast("Couldn't find any text in that file — it may be a scanned image.", "clay");
        return;
      }
      const stamp = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      const merged = student.iep ? `${student.iep}\n\n--- Uploaded ${stamp} (${file.name}) ---\n${text}` : text;
      updateStudent(student.id, { iep: merged });
      showToast(`IEP document added for ${student.name || "this student"}.`);
    } catch {
      showToast("Couldn't read that IEP document — it may be a scanned image rather than real text.", "clay");
    } finally {
      setIepUploading(false);
    }
  };

  const flags = [];
  if (student.iep.trim()) flags.push({ icon: <FileText size={11} />, label: "IEP" });
  if (student.el) flags.push({ icon: <Languages size={11} />, label: student.elLevel ? `EL · ${student.elLevel}` : "EL" });
  if (student.behaviorNotes.trim()) flags.push({ icon: <AlertTriangle size={11} />, label: "Behavior" });
  if (student.vision) flags.push({ icon: <Eye size={11} />, label: "Vision" });
  if (student.hearing) flags.push({ icon: <Ear size={11} />, label: "Hearing" });

  const submitObservation = () => {
    if (!obsText.trim()) return;
    logObservation(student.id, obsText, obsFlag);
    setObsText("");
    setObsFlag(false);
  };

  return (
    <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.paper, overflow: "hidden" }}>
      <div onClick={setExpanded} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", cursor: "pointer" }}>
        <input
          value={student.name}
          onChange={(e) => updateStudent(student.id, { name: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          placeholder="Student name"
          className="sans"
          style={{ border: "none", outline: "none", background: "transparent", fontSize: 15, fontWeight: 600, color: T.ink, flex: "0 1 220px", minWidth: 140 }}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
          {flags.map((f, i) => (
            <span
              key={i}
              className="sans chip"
              style={{ display: "flex", alignItems: "center", gap: 4, background: T.brassSoft, color: "#7A5A18", borderRadius: 12, padding: "3px 9px", fontSize: 11, fontWeight: 600 }}
            >
              {f.icon}
              {f.label}
            </span>
          ))}
          {student.academicLevel && (
            <span className="sans" style={{ background: T.paperDim, color: "#8A8272", borderRadius: 12, padding: "3px 9px", fontSize: 11, fontWeight: 600, textTransform: "capitalize" }}>
              {student.academicLevel} level
            </span>
          )}
          {student.observationLog.length > 0 && (
            <span className="sans" style={{ display: "flex", alignItems: "center", gap: 4, background: T.sageSoft, color: T.sage, borderRadius: 12, padding: "3px 9px", fontSize: 11, fontWeight: 600 }}>
              <StickyNote size={11} /> {student.observationLog.length}
            </span>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeStudent(student.id);
          }}
          style={{ background: "none", border: "none", color: "#B0A890", padding: 4 }}
          aria-label="Remove student"
        >
          <Trash2 size={15} />
        </button>
        {expanded ? <ChevronUp size={16} color="#8A8272" /> : <ChevronDown size={16} color="#8A8272" />}
      </div>

      {expanded && (
        <div className="fade-in sans" style={{ padding: "4px 16px 20px", borderTop: `1px solid ${T.line}` }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
            <Field label="Academic level">
              <select value={student.academicLevel} onChange={(e) => updateStudent(student.id, { academicLevel: e.target.value })} style={inputStyle}>
                <option value="low">Needs support</option>
                <option value="medium">On level</option>
                <option value="high">Advanced</option>
              </select>
            </Field>

            <Field label="English Learner">
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={student.el} onChange={(e) => updateStudent(student.id, { el: e.target.checked })} />
                  EL student
                </label>
                {student.el && (
                  <select value={student.elLevel} onChange={(e) => updateStudent(student.id, { elLevel: e.target.value })} style={{ ...inputStyle, flex: 1 }}>
                    <option value="">Proficiency level</option>
                    <option value="beginning">Beginning</option>
                    <option value="intermediate">Intermediate</option>
                    <option value="advanced">Advanced</option>
                  </select>
                )}
              </div>
            </Field>

            <Field label="IEP / 504 accommodations" full hint="upload a document to append its text below">
              <textarea
                value={student.iep}
                onChange={(e) => updateStudent(student.id, { iep: e.target.value })}
                placeholder="e.g., preferential seating near instruction, extended time, reduced distractions..."
                style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
              />
              <div style={{ marginTop: 6, position: "relative" }}>
                <label
                  htmlFor={`iep-file-${student.id}`}
                  className="sans"
                  style={{ ...btnGhost, display: "inline-flex", padding: "5px 10px", fontSize: 11.5, opacity: iepUploading ? 0.6 : 1 }}
                >
                  {iepUploading ? <Loader2 size={12} className="spin" /> : <Upload size={12} />}
                  {iepUploading ? "Reading document…" : "Upload IEP document"}
                </label>
                <input
                  id={`iep-file-${student.id}`}
                  type="file"
                  accept=".pdf,.txt,application/pdf,text/plain"
                  onChange={(e) => {
                    handleIepFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                  style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
                />
              </div>
            </Field>

            <Field label="Behavior notes" full hint="also updated automatically by flagged observations below">
              <textarea
                value={student.behaviorNotes}
                onChange={(e) => updateStudent(student.id, { behaviorNotes: e.target.value })}
                placeholder="e.g., off-task when seated near peers, escalates with talkative neighbors..."
                style={{ ...inputStyle, minHeight: 50, resize: "vertical" }}
              />
            </Field>

            <Field label="Sensory">
              <div style={{ display: "flex", gap: 14 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={student.vision} onChange={(e) => updateStudent(student.id, { vision: e.target.checked })} />
                  Vision — needs front
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={student.hearing} onChange={(e) => updateStudent(student.id, { hearing: e.target.checked })} />
                  Hearing — needs front
                </label>
              </div>
            </Field>
          </div>

          {others.length > 0 && (
            <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Field label="Pairs well with" hint="friend / positive-working pairing">
                <RelationPicker student={student} others={others} field="friends" toggleRelation={toggleRelation} tone="sage" />
              </Field>
              <Field label="Must not sit near" hint="known conflict — treated as a hard rule">
                <RelationPicker student={student} others={others} field="avoid" toggleRelation={toggleRelation} tone="clay" />
              </Field>
            </div>
          )}

          {/* Quick observations */}
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#6B6455", marginBottom: 8, letterSpacing: "0.02em", display: "flex", alignItems: "center", gap: 5 }}>
              <StickyNote size={12} color={T.brass} /> QUICK OBSERVATIONS
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={obsText}
                onChange={(e) => setObsText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitObservation()}
                placeholder="e.g., distracted next to Ethan today — moved seats"
                style={{ ...inputStyle, flex: 1, minWidth: 180 }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: T.clay, whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={obsFlag} onChange={(e) => setObsFlag(e.target.checked)} />
                <Flag size={11} /> Flag for seating
              </label>
              <button onClick={submitObservation} className="sans" style={{ ...btnGhost, padding: "7px 12px" }}>
                Log
              </button>
            </div>

            {student.observationLog.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, maxHeight: 140, overflowY: "auto" }}>
                {student.observationLog.map((o) => (
                  <div
                    key={o.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      fontSize: 12.5,
                      color: T.graphite,
                      background: o.flagged ? T.claySoft : T.paperDim,
                      borderRadius: 7,
                      padding: "6px 10px",
                    }}
                  >
                    <span style={{ fontWeight: 700, color: "#8A8272", flexShrink: 0 }}>{o.date}</span>
                    <span style={{ flex: 1 }}>{o.text}</span>
                    {o.flagged && <Flag size={11} color={T.clay} style={{ flexShrink: 0, marginTop: 2 }} />}
                    <button onClick={() => removeObservation(student.id, o.id)} style={{ background: "none", border: "none", color: "#B0A890", padding: 0, flexShrink: 0 }}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RelationPicker({ student, others, field, toggleRelation, tone }) {
  const activeColor = tone === "sage" ? T.sage : T.clay;
  const activeBg = tone === "sage" ? T.sageSoft : T.claySoft;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 110, overflowY: "auto", padding: 2 }}>
      {others
        .filter((o) => o.name.trim())
        .map((o) => {
          const active = student[field].includes(o.id);
          return (
            <button
              key={o.id}
              onClick={() => toggleRelation(student.id, o.id, field)}
              className="chip"
              style={{
                border: `1px solid ${active ? activeColor : T.line}`,
                background: active ? activeBg : "transparent",
                color: active ? activeColor : "#8A8272",
                borderRadius: 14,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {active && <Check size={10} style={{ marginRight: 3, marginBottom: -1 }} />}
              {o.name}
            </button>
          );
        })}
    </div>
  );
}

function Field({ label, hint, full, children }) {
  return (
    <div style={{ gridColumn: full ? "1 / -1" : "auto" }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "#6B6455", marginBottom: 6, letterSpacing: "0.02em" }}>
        {label}
        {hint && <span style={{ fontWeight: 400, color: "#A89F8C" }}> — {hint}</span>}
      </div>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%",
  border: `1px solid ${T.line}`,
  borderRadius: 7,
  padding: "8px 10px",
  fontSize: 13,
  background: T.paper,
  color: T.ink,
  outline: "none",
};

// ================= Chart View =================
function ChartView({
  students,
  layoutType,
  setLayoutType,
  rows,
  setRows,
  cols,
  setCols,
  numPods,
  setNumPods,
  perPod,
  setPerPod,
  numPairs,
  setNumPairs,
  pairCols,
  setPairCols,
  options,
  setOptions,
  seats,
  assignment,
  violations,
  hasGenerated,
  handleGenerate,
  studentById,
  unseated,
  draggedStudent,
  setDraggedStudent,
  handleDrop,
}) {
  const seatCount = seats.length;

  return (
    <div className="fade-in">
      {/* Controls */}
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 20, marginBottom: 24, alignItems: "start" }}>
        <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, padding: 18, background: T.paperDim }}>
          <div className="sans" style={{ fontSize: 12, fontWeight: 700, color: "#6B6455", marginBottom: 12, letterSpacing: "0.03em" }}>
            ROOM LAYOUT
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {[
              { id: "grid", label: "Rows & columns" },
              { id: "pods", label: "Pods / tables" },
              { id: "pairs", label: "Pairs" },
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setLayoutType(opt.id)}
                className="sans"
                style={{
                  padding: "7px 13px",
                  borderRadius: 7,
                  fontSize: 12.5,
                  fontWeight: 600,
                  border: `1px solid ${layoutType === opt.id ? T.ink : T.line}`,
                  background: layoutType === opt.id ? T.ink : "transparent",
                  color: layoutType === opt.id ? T.paper : T.graphite,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {layoutType === "grid" && (
            <div style={{ display: "flex", gap: 20 }}>
              <NumberField label="Rows" value={rows} setValue={setRows} min={1} max={10} />
              <NumberField label="Columns" value={cols} setValue={setCols} min={1} max={10} />
            </div>
          )}
          {layoutType === "pods" && (
            <div style={{ display: "flex", gap: 20 }}>
              <NumberField label="Number of pods" value={numPods} setValue={setNumPods} min={1} max={12} />
              <NumberField label="Seats per pod" value={perPod} setValue={setPerPod} min={2} max={6} />
            </div>
          )}
          {layoutType === "pairs" && (
            <div style={{ display: "flex", gap: 20 }}>
              <NumberField label="Number of pairs" value={numPairs} setValue={setNumPairs} min={1} max={20} />
              <NumberField label="Columns of pairs" value={pairCols} setValue={setPairCols} min={1} max={8} />
            </div>
          )}

          <div className="sans" style={{ fontSize: 12, color: seatCount < students.length ? T.clay : "#8A8272", marginTop: 12, fontWeight: 600 }}>
            {seatCount} seats for {students.length} students
            {seatCount < students.length && " — add more seats"}
          </div>
        </div>

        <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, padding: 18, background: T.paperDim }}>
          <div className="sans" style={{ fontSize: 12, fontWeight: 700, color: "#6B6455", marginBottom: 12, letterSpacing: "0.03em" }}>
            PRIORITIES
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <ToggleRow label="Balance academic levels within groups" checked={options.balanceAcademic} onChange={(v) => setOptions((o) => ({ ...o, balanceAcademic: v }))} />
            <ToggleRow label="Separate students with behavior notes" checked={options.separateBehavior} onChange={(v) => setOptions((o) => ({ ...o, separateBehavior: v }))} />
            <ToggleRow label="Honor positive pairings when possible" checked={options.honorFriends} onChange={(v) => setOptions((o) => ({ ...o, honorFriends: v }))} />
          </div>
          <button onClick={handleGenerate} className="sans" style={{ ...btnPrimary, marginTop: 16, width: "100%", justifyContent: "center", background: T.brass }}>
            <Wand2 size={16} /> {hasGenerated ? "Regenerate chart" : "Generate seating chart"}
          </button>
        </div>
      </div>

      {violations.length > 0 && (
        <div
          className="sans fade-in"
          style={{ display: "flex", gap: 10, alignItems: "flex-start", background: T.claySoft, border: `1px solid ${T.clay}55`, borderRadius: 9, padding: "12px 16px", marginBottom: 18, fontSize: 13, color: "#7A3323" }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>{violations.length} pairing{violations.length > 1 ? "s" : ""} couldn't be fully separated</strong> given the room size —{" "}
            {violations.map((v, i) => (
              <span key={v.key}>
                {v.a} &amp; {v.b}
                {i < violations.length - 1 ? ", " : ""}
              </span>
            ))}
            . Try a larger layout or drag students manually below.
          </div>
        </div>
      )}

      {hasGenerated ? (
        <SeatGrid layoutType={layoutType} seats={seats} assignment={assignment} studentById={studentById} draggedStudent={draggedStudent} setDraggedStudent={setDraggedStudent} handleDrop={handleDrop} />
      ) : (
        <div style={{ border: `1.5px dashed ${T.line}`, borderRadius: 12, padding: "56px 24px", textAlign: "center", background: T.paperDim }}>
          <Wand2 size={26} color={T.brass} style={{ marginBottom: 10 }} />
          <div className="serif" style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
            Set your room, then generate
          </div>
          <div className="sans" style={{ fontSize: 13.5, color: "#8A8272" }}>
            The chart will honor avoid-pairs, IEP front-row needs, EL support, and behavior separation automatically.
          </div>
        </div>
      )}

      {hasGenerated && unseated.length > 0 && (
        <div className="sans" style={{ marginTop: 20, fontSize: 12.5, color: T.clay, fontWeight: 600 }}>
          Unseated (not enough seats): {unseated.map((s) => s.name).join(", ")}
        </div>
      )}

      {hasGenerated && (
        <div className="sans" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#A89F8C" }}>
          <Info size={12} /> Drag any student onto another seat to swap manually.
        </div>
      )}
    </div>
  );
}

function NumberField({ label, value, setValue, min, max }) {
  return (
    <div>
      <div className="sans" style={{ fontSize: 11.5, fontWeight: 600, color: "#8A8272", marginBottom: 4 }}>
        {label}
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => setValue(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        className="sans"
        style={{ ...inputStyle, width: 64 }}
      />
    </div>
  );
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <label className="sans" style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13, color: T.graphite, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function SeatGrid({ layoutType, seats, assignment, studentById, draggedStudent, setDraggedStudent, handleDrop }) {
  if (layoutType === "pods") {
    const groups = {};
    seats.forEach((s) => {
      if (!groups[s.groupId]) groups[s.groupId] = [];
      groups[s.groupId].push(s);
    });
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 18 }}>
        {Object.entries(groups).map(([groupId, groupSeats]) => (
          <div key={groupId} style={{ border: `1px solid ${T.line}`, borderRadius: 10, padding: 12, background: T.paperDim }}>
            <div className="sans" style={{ fontSize: 10.5, fontWeight: 700, color: "#A89F8C", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Table {parseInt(groupId.replace("pod", "")) + 1}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {groupSeats.map((seat) => (
                <SeatCell key={seat.id} seat={seat} student={assignment[seat.id] ? studentById[assignment[seat.id]] : null} draggedStudent={draggedStudent} setDraggedStudent={setDraggedStudent} handleDrop={handleDrop} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (layoutType === "pairs") {
    const groups = {};
    seats.forEach((s) => {
      if (!groups[s.groupId]) groups[s.groupId] = [];
      groups[s.groupId].push(s);
    });
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        {Object.entries(groups).map(([groupId, groupSeats]) => (
          <div key={groupId} style={{ border: `1px solid ${T.line}`, borderRadius: 10, padding: 10, background: T.paperDim, display: "flex", gap: 8 }}>
            {groupSeats.map((seat) => (
              <SeatCell key={seat.id} seat={seat} student={assignment[seat.id] ? studentById[assignment[seat.id]] : null} draggedStudent={draggedStudent} setDraggedStudent={setDraggedStudent} handleDrop={handleDrop} wide />
            ))}
          </div>
        ))}
      </div>
    );
  }

  const maxRow = Math.max(...seats.map((s) => s.row), 0);
  const maxCol = Math.max(...seats.map((s) => s.col), 0);
  return (
    <div>
      <div className="sans" style={{ textAlign: "center", fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#A89F8C", marginBottom: 14, textTransform: "uppercase" }}>
        Front of room
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
        {Array.from({ length: maxRow + 1 }).map((_, r) => (
          <div key={r} style={{ display: "flex", gap: 10 }}>
            {Array.from({ length: maxCol + 1 }).map((_, c) => {
              const seat = seats.find((s) => s.row === r && s.col === c);
              if (!seat) return <div key={c} style={{ width: 108 }} />;
              return (
                <SeatCell key={seat.id} seat={seat} student={assignment[seat.id] ? studentById[assignment[seat.id]] : null} draggedStudent={draggedStudent} setDraggedStudent={setDraggedStudent} handleDrop={handleDrop} />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function SeatCell({ seat, student, draggedStudent, setDraggedStudent, handleDrop, wide }) {
  const flagIcons = [];
  if (student?.iep.trim()) flagIcons.push(<FileText key="iep" size={10} />);
  if (student?.el) flagIcons.push(<Languages key="el" size={10} />);
  if (student?.behaviorNotes.trim()) flagIcons.push(<AlertTriangle key="beh" size={10} />);
  if (student?.vision) flagIcons.push(<Eye key="vis" size={10} />);
  if (student?.hearing) flagIcons.push(<Ear key="hear" size={10} />);

  return (
    <div
      draggable={!!student}
      onDragStart={() => student && setDraggedStudent(student.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => handleDrop(seat.id)}
      className="seat sans"
      style={{
        width: wide ? 108 : 100,
        minHeight: 64,
        border: `1.5px solid ${student ? T.ink : T.line}`,
        borderRadius: 8,
        background: student ? T.paper : "transparent",
        padding: "8px 9px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        boxShadow: student ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
        cursor: student ? "grab" : "default",
      }}
    >
      {student ? (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: T.ink, lineHeight: 1.2, marginBottom: flagIcons.length ? 4 : 0 }}>
            {student.name || "—"}
          </div>
          {flagIcons.length > 0 && <div style={{ display: "flex", gap: 4, color: T.brass }}>{flagIcons}</div>}
        </>
      ) : (
        <div style={{ fontSize: 11, color: "#C7BFAB", textAlign: "center" }}>empty</div>
      )}
    </div>
  );
}
