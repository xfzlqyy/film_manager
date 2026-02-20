import * as XLSX from "xlsx";
import { categories, createEmptyRecords } from "./config";
import { CategoryDefinition, CategoryId, CategoryRecords, MovieRecord } from "./types";

const chineseDigitMap: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};

const chineseUnitMap: Record<string, number> = {
  十: 10,
  百: 100,
  千: 1000,
  万: 10000
};

function normalizeText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).replace(/\r?\n/g, " ").trim();
}

function normalizeHeader(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function buildAliasSet(category: CategoryDefinition): Set<string> {
  const aliasSet = new Set<string>();
  category.fields.forEach((field) => {
    aliasSet.add(field.label.toLowerCase());
    field.aliases?.forEach((alias) => aliasSet.add(alias.toLowerCase()));
  });
  return aliasSet;
}

function findHeaderIndex(matrix: unknown[][], category: CategoryDefinition): number {
  const aliasSet = buildAliasSet(category);
  const maxRows = Math.min(matrix.length, 30);
  let bestIndex = 0;
  let bestScore = -1;

  for (let index = 0; index < maxRows; index += 1) {
    const row = matrix[index] ?? [];
    const score = row.reduce<number>((count, cell) => {
      const normalized = normalizeHeader(cell);
      return aliasSet.has(normalized) ? count + 1 : count;
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function resolveColumnIndex(
  headerRow: unknown[],
  field: CategoryDefinition["fields"][number],
  fallbackIndex: number
): number {
  const normalizedHeaders = headerRow.map(normalizeHeader);
  const exactIndex = normalizedHeaders.findIndex((item) => item === field.label.toLowerCase());
  if (exactIndex >= 0) {
    return exactIndex;
  }

  if (field.aliases) {
    for (const alias of field.aliases) {
      const aliasIndex = normalizedHeaders.findIndex((item) => item === alias.toLowerCase());
      if (aliasIndex >= 0) {
        return aliasIndex;
      }
    }
  }

  return fallbackIndex;
}

function parseFlatSheet(sheet: XLSX.WorkSheet, category: CategoryDefinition): MovieRecord[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: ""
  });
  if (matrix.length === 0) {
    return [];
  }

  const headerIndex = findHeaderIndex(matrix, category);
  const headerRow = matrix[headerIndex] ?? [];
  const columnIndexByField = new Map<string, number>();
  category.fields.forEach((field, fieldIndex) => {
    columnIndexByField.set(field.key, resolveColumnIndex(headerRow, field, fieldIndex));
  });

  const records: MovieRecord[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] ?? [];
    const record: MovieRecord = { id: `${category.id}-${rowIndex}-${Date.now()}` };
    category.fields.forEach((field) => {
      const columnIndex = columnIndexByField.get(field.key) ?? 0;
      record[field.key] = normalizeText(row[columnIndex]);
    });
    records.push(record);
  }

  return records;
}

function parseNumericSerial(value: string): number | null {
  const normalized = normalizeText(value);
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  return Number(normalized);
}

function parseBluraySerial(value: string): { a: number; b: number } | null {
  const normalized = normalizeText(value);
  const matched = normalized.match(/^(\d+)-(\d+)$/);
  if (!matched) {
    return null;
  }
  return {
    a: Number(matched[1]),
    b: Number(matched[2])
  };
}

function parseChineseNumber(value: string): number | null {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  let total = 0;
  let section = 0;
  let digit = 0;
  let hasValidToken = false;

  for (const char of trimmed) {
    if (char in chineseDigitMap) {
      digit = chineseDigitMap[char];
      hasValidToken = true;
      continue;
    }

    const unit = chineseUnitMap[char];
    if (!unit) {
      return null;
    }
    hasValidToken = true;

    if (unit === 10000) {
      section = (section + (digit || 0)) * unit;
      total += section;
      section = 0;
      digit = 0;
      continue;
    }

    section += (digit || 1) * unit;
    digit = 0;
  }

  const result = total + section + digit;
  if (!hasValidToken || Number.isNaN(result)) {
    return null;
  }
  return result;
}

function parseDiskOrder(value: string): number | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const directNumber = normalized.match(/(\d+)/);
  if (directNumber) {
    return Number(directNumber[1]);
  }

  const diskSuffix = normalized.replace(/^硬盘/u, "").trim();
  return parseChineseNumber(diskSuffix);
}

function parseHddSerialOrder(value: string): number | null {
  const normalized = normalizeText(value);
  const matched = normalized.match(/^(\d+)/);
  return matched ? Number(matched[1]) : null;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base"
  });
}

function compareIntegerSerialRecords(left: MovieRecord, right: MovieRecord): number {
  const leftOrder = parseNumericSerial(left.serial ?? "");
  const rightOrder = parseNumericSerial(right.serial ?? "");

  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  if (leftOrder !== null && rightOrder === null) {
    return -1;
  }
  if (leftOrder === null && rightOrder !== null) {
    return 1;
  }

  const serialTextOrder = compareText(normalizeText(left.serial), normalizeText(right.serial));
  if (serialTextOrder !== 0) {
    return serialTextOrder;
  }

  return compareText(normalizeText(left.title), normalizeText(right.title));
}

function compareBlurayRecords(left: MovieRecord, right: MovieRecord): number {
  const leftSerial = parseBluraySerial(left.serial ?? "");
  const rightSerial = parseBluraySerial(right.serial ?? "");

  if (leftSerial && rightSerial) {
    if (leftSerial.a !== rightSerial.a) {
      return leftSerial.a - rightSerial.a;
    }
    if (leftSerial.b !== rightSerial.b) {
      return leftSerial.b - rightSerial.b;
    }
  } else if (leftSerial && !rightSerial) {
    return -1;
  } else if (!leftSerial && rightSerial) {
    return 1;
  }

  const serialTextOrder = compareText(normalizeText(left.serial), normalizeText(right.serial));
  if (serialTextOrder !== 0) {
    return serialTextOrder;
  }

  return compareText(normalizeText(left.title), normalizeText(right.title));
}

function compareHddRecords(left: MovieRecord, right: MovieRecord): number {
  const leftDisk = normalizeText(left.disk);
  const rightDisk = normalizeText(right.disk);

  const leftDiskOrder = parseDiskOrder(leftDisk);
  const rightDiskOrder = parseDiskOrder(rightDisk);
  if (leftDiskOrder !== null && rightDiskOrder !== null && leftDiskOrder !== rightDiskOrder) {
    return leftDiskOrder - rightDiskOrder;
  }
  if (leftDiskOrder !== null && rightDiskOrder === null) {
    return -1;
  }
  if (leftDiskOrder === null && rightDiskOrder !== null) {
    return 1;
  }

  const diskTextOrder = compareText(leftDisk, rightDisk);
  if (diskTextOrder !== 0) {
    return diskTextOrder;
  }

  const leftSerial = normalizeText(left.serial);
  const rightSerial = normalizeText(right.serial);
  const leftSerialOrder = parseHddSerialOrder(leftSerial);
  const rightSerialOrder = parseHddSerialOrder(rightSerial);

  if (leftSerialOrder !== null && rightSerialOrder !== null && leftSerialOrder !== rightSerialOrder) {
    return leftSerialOrder - rightSerialOrder;
  }
  if (leftSerialOrder !== null && rightSerialOrder === null) {
    return -1;
  }
  if (leftSerialOrder === null && rightSerialOrder !== null) {
    return 1;
  }

  const serialTextOrder = compareText(leftSerial, rightSerial);
  if (serialTextOrder !== 0) {
    return serialTextOrder;
  }

  return compareText(normalizeText(left.title), normalizeText(right.title));
}

function sortHddRecords(records: MovieRecord[]): MovieRecord[] {
  return [...records].sort(compareHddRecords);
}

export function sortCategoryRecords(categoryId: CategoryId, records: MovieRecord[]): MovieRecord[] {
  if (categoryId === "hdd") {
    return sortHddRecords(records);
  }
  if (categoryId === "bluray") {
    return [...records].sort(compareBlurayRecords);
  }
  if (categoryId === "dvd" || categoryId === "collectorBluray") {
    return [...records].sort(compareIntegerSerialRecords);
  }
  return [...records];
}

function isValidDiscRecord(category: CategoryDefinition, record: MovieRecord): boolean {
  const serial = normalizeText(record.serial);
  const title = normalizeText(record.title);
  if (!serial || !title) {
    return false;
  }
  if (category.serialPattern && !category.serialPattern.test(serial)) {
    return false;
  }
  return true;
}

function parseDiscBlockSheet(sheet: XLSX.WorkSheet, category: CategoryDefinition): MovieRecord[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: ""
  });

  const records: MovieRecord[] = [];
  const groupSize = category.fields.length;

  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    const normalizedRow = (matrix[rowIndex] ?? []).map(normalizeText);
    if (normalizedRow.every((cell) => cell === "")) {
      continue;
    }

    for (let columnIndex = 0; columnIndex < normalizedRow.length; columnIndex += groupSize) {
      const record: MovieRecord = { id: `${category.id}-${rowIndex}-${columnIndex}-${Date.now()}` };
      let hasAnyValue = false;

      category.fields.forEach((field, fieldOffset) => {
        const value = normalizeText(normalizedRow[columnIndex + fieldOffset]);
        record[field.key] = value;
        if (value !== "") {
          hasAnyValue = true;
        }
      });

      if (!hasAnyValue) {
        continue;
      }

      if (isValidDiscRecord(category, record)) {
        records.push(record);
      }
    }
  }

  return sortCategoryRecords(category.id, records);
}

function extractDiskName(value: string): string {
  const matched = value.match(/^硬盘[^（(]*/u);
  return (matched?.[0] ?? value).trim();
}

function isDiskHeadingRow(row: string[]): boolean {
  const nonEmptyValues = row.filter((cell) => cell !== "");
  return nonEmptyValues.length === 1 && nonEmptyValues[0].startsWith("硬盘");
}

function isHddHeaderRow(row: string[]): boolean {
  const hasSerial = row.includes("序号");
  const hasTitle = row.includes("电影名称");
  const hasGenre = row.includes("类型");
  return hasSerial && hasTitle && hasGenre;
}

function isLikelyHddBlockLayout(matrix: unknown[][]): boolean {
  let hasDiskHeading = false;
  let hasRepeatedHeader = false;

  for (const row of matrix) {
    const normalizedRow = row.map(normalizeText);
    if (!hasDiskHeading && isDiskHeadingRow(normalizedRow)) {
      hasDiskHeading = true;
    }
    if (!hasRepeatedHeader) {
      const serialHeaderCount = normalizedRow.filter((cell) => cell === "序号").length;
      if (serialHeaderCount >= 2 && normalizedRow.includes("电影名称")) {
        hasRepeatedHeader = true;
      }
    }

    if (hasDiskHeading && hasRepeatedHeader) {
      return true;
    }
  }

  return false;
}

function isValidHddRecord(record: MovieRecord): boolean {
  const disk = normalizeText(record.disk);
  const serial = normalizeText(record.serial);
  const title = normalizeText(record.title);
  if (!disk || !title) {
    return false;
  }
  return /^\d+$/.test(serial);
}

function parseHddBlockSheet(sheet: XLSX.WorkSheet): MovieRecord[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: ""
  });

  const records: MovieRecord[] = [];
  let currentDisk = "";

  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    const normalizedRow = (matrix[rowIndex] ?? []).map(normalizeText);
    if (normalizedRow.every((cell) => cell === "")) {
      continue;
    }

    if (isDiskHeadingRow(normalizedRow)) {
      const headingText = normalizedRow.find((cell) => cell !== "") ?? "";
      currentDisk = extractDiskName(headingText);
      continue;
    }

    if (isHddHeaderRow(normalizedRow)) {
      continue;
    }

    const groupSize = 5;
    for (let columnIndex = 0; columnIndex < normalizedRow.length; columnIndex += groupSize) {
      const record: MovieRecord = {
        id: `hdd-${rowIndex}-${columnIndex}-${Date.now()}`,
        disk: currentDisk,
        serial: normalizeText(normalizedRow[columnIndex]),
        title: normalizeText(normalizedRow[columnIndex + 1]),
        subtitle: normalizeText(normalizedRow[columnIndex + 2]),
        genre: normalizeText(normalizedRow[columnIndex + 3]),
        remark: normalizeText(normalizedRow[columnIndex + 4])
      };

      const hasAnyValue = [record.serial, record.title, record.subtitle, record.genre, record.remark].some(
        (cell) => normalizeText(cell) !== ""
      );
      if (!hasAnyValue) {
        continue;
      }

      if (isValidHddRecord(record)) {
        records.push(record);
      }
    }
  }

  return sortHddRecords(records);
}

function parseHddSheet(sheet: XLSX.WorkSheet, category: CategoryDefinition): MovieRecord[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: ""
  });

  if (isLikelyHddBlockLayout(matrix)) {
    return parseHddBlockSheet(sheet);
  }

  const flatRecords = parseFlatSheet(sheet, category).filter(isValidHddRecord);
  return sortHddRecords(flatRecords);
}

function resolveSheetName(workbook: XLSX.WorkBook, category: CategoryDefinition, orderIndex: number): string | null {
  const exactMatch = workbook.SheetNames.find((sheetName) => sheetName.trim() === category.sheetName);
  if (exactMatch) {
    return exactMatch;
  }

  const fuzzyMatch = workbook.SheetNames.find((sheetName) => sheetName.includes(category.sheetName));
  if (fuzzyMatch) {
    return fuzzyMatch;
  }

  if (orderIndex < workbook.SheetNames.length) {
    return workbook.SheetNames[orderIndex];
  }
  return null;
}

export function parseWorkbook(buffer: ArrayBuffer): CategoryRecords {
  const workbook = XLSX.read(buffer, {
    type: "array",
    codepage: 936
  });

  const records = createEmptyRecords();
  categories.forEach((category, index) => {
    const sheetName = resolveSheetName(workbook, category, index);
    if (!sheetName) {
      records[category.id] = [];
      return;
    }

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      records[category.id] = [];
      return;
    }

    if (category.id === "hdd") {
      records[category.id] = parseHddSheet(sheet, category);
      return;
    }

    const parsedByBlocks = parseDiscBlockSheet(sheet, category);
    if (parsedByBlocks.length > 0) {
      records[category.id] = parsedByBlocks;
      return;
    }

    const parsedFlat = parseFlatSheet(sheet, category).filter((record) => isValidDiscRecord(category, record));
    records[category.id] = sortCategoryRecords(category.id, parsedFlat);
  });

  return records;
}

export function createWorkbook(records: CategoryRecords): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  categories.forEach((category) => {
    const sortedRecords = sortCategoryRecords(category.id, records[category.id]);
    const rows = sortedRecords.map((record) => {
      const row: Record<string, string> = {};
      category.fields.forEach((field) => {
        row[field.label] = normalizeText(record[field.key]);
      });
      return row;
    });

    const worksheet =
      rows.length > 0
        ? XLSX.utils.json_to_sheet(rows, {
            header: category.fields.map((field) => field.label)
          })
        : XLSX.utils.aoa_to_sheet([category.fields.map((field) => field.label)]);

    XLSX.utils.book_append_sheet(workbook, worksheet, category.sheetName);
  });

  return workbook;
}

export function createWorkbookBlob(records: CategoryRecords): Blob {
  const workbook = createWorkbook(records);
  const output = XLSX.write(workbook, {
    type: "array",
    bookType: "xls"
  });
  return new Blob([output], { type: "application/vnd.ms-excel" });
}

export function buildSearchIndex(record: MovieRecord, categoryId: CategoryId): string {
  const values = Object.entries(record)
    .filter(([key]) => key !== "id")
    .map(([, value]) => normalizeText(value).toLowerCase());

  values.push(categoryId.toLowerCase());
  return values.join("|");
}
