// A minimal RFC4180-style CSV encoder/decoder: fields containing a
// comma, quote, or newline are wrapped in double quotes with internal
// quotes doubled. Needed because free-text fields (behavior notes, IEP
// notes) routinely contain commas and newlines once the app allows real
// paragraphs — a naive split(",") can't round-trip that safely.

function needsQuoting(value) {
  return /[",\r\n]/.test(value);
}

function encodeCsvField(value) {
  const str = value == null ? "" : String(value);
  if (!needsQuoting(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

export function encodeCsv(rows) {
  return rows.map((row) => row.map(encodeCsvField).join(",")).join("\r\n");
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip UTF-8 BOM

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
