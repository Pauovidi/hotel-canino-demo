import { hotelDemoConfig } from "@/lib/hotel/integrations/config";
import type {
  DemoReservationRecord,
  HotelSlot,
  MonthOccupancySnapshot,
  SheetCellUpdate,
  SheetCellMetadataUpdate,
  SheetColorPlan,
  SheetWritePlan,
  SheetsAvailabilityInput,
  SheetsAvailabilityResult,
  SheetsWriteResult,
} from "@/lib/hotel/integrations/types";
import { buildPetKey, normalizeIdentifierPart } from "@/lib/hotel/domain/identifiers";
import {
  addDays,
  expandStayWindow,
  isValidStayWindow,
  parseDateOnly,
} from "@/lib/hotel/engines/time";
import {
  getSheetNameForMonthKey,
  mergeSheetsColorPalette,
  mergeSheetsLayout,
} from "@/lib/hotel/config/sheets";
import { CLIENT_WORKBOOK_ROOM_LABELS } from "@/lib/hotel/config/sheets-contract";
import type {
  SheetAdapterContext,
  SheetStructureIssue,
  SheetStructureReport,
} from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const SHEETS_RESERVATION_ID_NOTE_KEY = "SMP_RESERVATION_ID";
export const SHEETS_CANCELLED_RESERVATION_ID_NOTE_KEY = "SMP_CANCELLED_RESERVATION_ID";

export function columnIndexToLetter(columnIndex: number): string {
  if (columnIndex < 1) {
    throw new Error(`La columna debe ser mayor que 0. Recibido: ${columnIndex}`);
  }

  let current = columnIndex;
  let result = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - remainder - 1) / 26);
  }

  return result;
}

export function letterToColumnIndex(letter: string): number {
  const normalized = letter.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error(`Columna invalida: ${letter}`);
  }

  return normalized.split("").reduce((value, char) => value * 26 + (char.charCodeAt(0) - 64), 0);
}

export function getSheetRange(
  layout: ReturnType<typeof mergeSheetsLayout>,
): string {
  return `A1:${columnIndexToLetter(layout.lastRelevantColumnIndex)}${layout.summaryRowEndIndex}`;
}

export function getSheetNameForMonth(
  monthKey: string,
  context?: Partial<SheetAdapterContext>,
): string {
  const layout = mergeSheetsLayout(context?.layout);
  return (
    context?.sheetTitleByMonthKey?.[monthKey] ??
    getSheetNameForMonthKey(monthKey, layout.sheetNaming, layout.sheetNameMap)
  );
}

export function isBlankCell(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

export function normalizeCell(value: unknown): string {
  return isBlankCell(value) ? "" : String(value).trim();
}

export function normalizeSheetTitle(value: unknown): string {
  return normalizeCell(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getEffectiveMonthDayCount(
  monthKey: string,
  layout: ReturnType<typeof mergeSheetsLayout>,
): number {
  return Math.min(layout.dayCount, getMonthDays(monthKey));
}

function getEffectiveLastDayColumnIndex(
  monthKey: string,
  layout: ReturnType<typeof mergeSheetsLayout>,
): number {
  return layout.firstDayColumnIndex + getEffectiveMonthDayCount(monthKey, layout) - 1;
}

function getMatrixCell(values: string[][], rowIndex: number, columnIndex: number): string {
  return normalizeCell(values[rowIndex - 1]?.[columnIndex - 1]);
}

function setMatrixCell(values: string[][], rowIndex: number, columnIndex: number, value: string): void {
  while (values.length < rowIndex) {
    values.push([]);
  }

  const row = values[rowIndex - 1];
  while (row.length < columnIndex) {
    row.push("");
  }

  row[columnIndex - 1] = value;
}

export function getMonthDays(monthKey: string): number {
  const parsed = parseDateOnly(`${monthKey}-01`);
  const next = new Date(parsed.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return Math.round((next.getTime() - parsed.getTime()) / MS_PER_DAY);
}

export function dayNumberToDate(monthKey: string, dayNumber: number): string {
  return addDays(`${monthKey}-01`, dayNumber - 1);
}

export function getOccupiedDatesForStay(
  input: Pick<SheetsAvailabilityInput, "entryDate" | "entrySlot" | "exitDate" | "exitSlot">,
): string[] {
  return Array.from(
    new Set(getOccupiedSlotsForStay(input).map((point) => point.date)),
  );
}

function getOccupiedSlotsForStay(
  input: Pick<SheetsAvailabilityInput, "entryDate" | "entrySlot" | "exitDate" | "exitSlot">,
): Array<{ date: string; slot: HotelSlot }> {
  const window = {
    checkIn: { date: input.entryDate, slot: input.entrySlot },
    checkOut: { date: input.exitDate, slot: input.exitSlot },
  };

  if (!isValidStayWindow(window)) {
    return [];
  }

  if (input.entryDate === input.exitDate) {
    const sameDaySlots = new Set<HotelSlot>();

    if (input.entrySlot === "morning") {
      sameDaySlots.add("morning");
      sameDaySlots.add("afternoon");
    } else {
      sameDaySlots.add("afternoon");
    }

    if (input.exitSlot === "morning") {
      sameDaySlots.add("morning");
    } else {
      sameDaySlots.add("morning");
      sameDaySlots.add("afternoon");
    }

    return Array.from(sameDaySlots).map((slot) => ({
      date: input.entryDate,
      slot,
    }));
  }

  const slots: Array<{ date: string; slot: HotelSlot }> = [];
  let currentDate = input.entryDate;

  while (currentDate <= input.exitDate) {
    const isEntryDate = currentDate === input.entryDate;
    const isExitDate = currentDate === input.exitDate;

    if (isEntryDate && input.entrySlot === "morning") {
      slots.push({ date: currentDate, slot: "morning" });
      slots.push({ date: currentDate, slot: "afternoon" });
    } else if (isEntryDate) {
      slots.push({ date: currentDate, slot: "afternoon" });
    } else if (isExitDate && input.exitSlot === "morning") {
      slots.push({ date: currentDate, slot: "morning" });
    } else if (isExitDate) {
      slots.push({ date: currentDate, slot: "morning" });
      slots.push({ date: currentDate, slot: "afternoon" });
    } else {
      slots.push({ date: currentDate, slot: "morning" });
      slots.push({ date: currentDate, slot: "afternoon" });
    }

    currentDate = addDays(currentDate, 1);
  }

  return Array.from(
    new Map(slots.map((slot) => [`${slot.date}:${slot.slot}`, slot])).values(),
  );
}

interface ColumnDescriptor {
  columnIndex: number;
  date: string;
  slot: HotelSlot;
}

interface RowDescriptor {
  rowIndex: number;
  sourceLabel: string;
  label: string | null;
  isReservable: boolean;
}

interface UnitDescriptor {
  rowIndex: number;
  rowIndices: number[];
  sourceLabel: string;
  label: string;
}

interface OccupiedUnitSlot {
  rowIndex: number;
  columnIndex: number;
  date: string;
  slot: HotelSlot;
  value: string;
}

interface AvailabilityUnitCheck {
  unit: UnitDescriptor;
  analyzedColumns: ColumnDescriptor[];
  occupiedSlots: OccupiedUnitSlot[];
  conflictingSlots: OccupiedUnitSlot[];
  status: "free" | "occupied";
}

function normalizeUnitLabel(label: string): string {
  const normalized = normalizeCell(label);
  const match = normalized.match(/^(?:HAB|CHENIL|BOX|ROOM)\s*(\d+)$/i);
  if (match) {
    return `CHENIL ${match[1]}`;
  }

  return normalized;
}

function isReservableUnitLabel(label: string): boolean {
  return /^(?:HAB|CHENIL|BOX|ROOM)\s*\d+$/i.test(normalizeCell(label));
}

export function inferDogCount(label: string): number {
  const compact = normalizeIdentifierPart(label).replace(/-+/g, " ");
  const explicitPlus = label.match(/\+\s*(\d+)/);
  if (explicitPlus) {
    const parsed = Number(explicitPlus[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const splitCount = compact
    .split(/\s+(?:y|e|and)\s+|\s*[\/,&]\s*|\s+\+\s+/i)
    .map((part: string) => part.trim())
    .filter(Boolean).length;

  return Math.max(1, splitCount);
}

function parseDayHeaders(
  values: string[][],
  layout: ReturnType<typeof mergeSheetsLayout>,
  monthKey: string,
): { headers: number[]; issues: SheetStructureIssue[] } {
  const headerRow = values[layout.dayHeaderRowIndex - 1] ?? [];
  const headers: number[] = [];
  const issues: SheetStructureIssue[] = [];
  const lastExpectedDayColumn = getEffectiveLastDayColumnIndex(monthKey, layout);
  const expectedDayCount = getEffectiveMonthDayCount(monthKey, layout);

  for (let column = layout.firstDayColumnIndex; column <= lastExpectedDayColumn; column += 1) {
    const cell = normalizeCell(headerRow[column - 1]);
    if (!cell) {
      issues.push({
        code: "missing_day_header",
        message: `Falta el encabezado de dia esperado en la columna ${columnIndexToLetter(column)}.`,
        severity: "error",
        column,
        row: layout.dayHeaderRowIndex,
      });
      continue;
    }

    const parsed = Number(cell);
    const expectedDay = column - layout.firstDayColumnIndex + 1;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > expectedDayCount || parsed !== expectedDay) {
      issues.push({
        code: "invalid_day_header",
        message: `El encabezado de dia en la columna ${columnIndexToLetter(column)} no es valido: ${cell}`,
        severity: "error",
        column,
        row: layout.dayHeaderRowIndex,
      });
      continue;
    }

    headers.push(parsed);
  }

  if (headers.length === 0) {
    issues.push({
      code: "missing_day_header",
      message: "No se encontraron encabezados de dias en la fila configurada.",
      severity: "error",
      row: layout.dayHeaderRowIndex,
    });
  }

  return { headers, issues };
}

export function validateMonthGrid(
  values: string[][],
  monthKey: string,
  context?: Partial<SheetAdapterContext>,
  sheetName = getSheetNameForMonth(monthKey, context),
): SheetStructureReport {
  const layout = mergeSheetsLayout(context?.layout);
  const issues: SheetStructureIssue[] = [];
  const rowCount = values.length;
  const maxColumns = Math.max(0, ...values.map((row) => row.length));
  const expectedSheetName = getSheetNameForMonth(monthKey, context);
  const expectedDayLastColumn = getEffectiveLastDayColumnIndex(monthKey, layout);

  if (rowCount < layout.dayHeaderRowIndex) {
    issues.push({
      code: "range_too_small",
      message: "El rango leido no alcanza la fila de encabezados.",
      severity: "error",
      row: rowCount,
    });
  }

  if (maxColumns < expectedDayLastColumn) {
    issues.push({
      code: "range_too_small",
      message: "El rango leido no alcanza todas las columnas de dias.",
      severity: "error",
      column: maxColumns,
    });
  }

  const titleCell =
    layout.titleRowIndex > 0
      ? getMatrixCell(values, layout.titleRowIndex, layout.firstDayColumnIndex)
      : "";
  if (layout.titleRequired && layout.titleRowIndex > 0 && !titleCell) {
    issues.push({
      code: "missing_title",
      message: "La hoja no tiene un titulo en la cabecera esperada.",
      severity: "warning",
      row: layout.titleRowIndex,
      column: layout.firstDayColumnIndex,
    });
  }

  const dayHeaderResult = parseDayHeaders(values, layout, monthKey);
  issues.push(...dayHeaderResult.issues);

  if (normalizeSheetTitle(sheetName) !== normalizeSheetTitle(expectedSheetName)) {
    issues.push({
      code: "unexpected_sheet_name",
      message: `Se esperaba la hoja ${expectedSheetName} y se encontro ${sheetName}.`,
      severity: "warning",
    });
  }

  for (let roomIndex = 1; roomIndex <= 16; roomIndex += 1) {
    const rowIndex = layout.firstDataRowIndex + (roomIndex - 1) * 2;
    if (rowIndex > layout.lastDataRowIndex) {
      break;
    }

    const label = normalizeSheetTitle(getMatrixCell(values, rowIndex, layout.labelColumnIndex));
    if (!label.startsWith(`hab ${roomIndex}`)) {
      issues.push({
        code: "invalid_special_label",
        message: `La fila ${rowIndex} debe identificarse como HAB ${roomIndex}.`,
        severity: "error",
        row: rowIndex,
        column: layout.labelColumnIndex,
      });
    }
  }

  const specialLabelExpectations: Array<{ row: number; label: string }> = [
    { row: 36, label: "cocina" },
    { row: 38, label: "entrada" },
    { row: 40, label: "ocupacion" },
    { row: 41, label: "total ocupacion" },
    { row: 42, label: "% ocupacion" },
    { row: 43, label: "tesoreria" },
  ];

  for (const expected of specialLabelExpectations) {
    const actual = normalizeSheetTitle(getMatrixCell(values, expected.row, layout.labelColumnIndex));
    if (actual !== expected.label) {
      issues.push({
        code: "invalid_special_label",
        message: `La fila ${expected.row} no coincide con la etiqueta operativa esperada (${expected.label}).`,
        severity: "error",
        row: expected.row,
        column: layout.labelColumnIndex,
      });
    }
  }

  let occupiedCells = 0;
  for (let row = layout.firstDataRowIndex; row <= Math.min(layout.lastDataRowIndex, rowCount); row += 1) {
    for (let column = layout.firstDayColumnIndex; column <= layout.lastDayColumnIndex; column += 1) {
      if (column > expectedDayLastColumn) {
        continue;
      }
      if (!isBlankCell(getMatrixCell(values, row, column))) {
        occupiedCells += 1;
      }
    }
  }

  if (occupiedCells === 0) {
    issues.push({
      code: "missing_data_rows",
      message: "La hoja no contiene ocupacion visible en el bloque de datos.",
      severity: "warning",
      row: layout.firstDataRowIndex,
    });
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    monthKey,
    sheetName,
    layout,
    issues,
    rowCount,
    dayHeaders: dayHeaderResult.headers,
    occupiedCells,
  };
}

function getDateFromHeader(monthKey: string, dayNumber: number): string | null {
  const daysInMonth = getMonthDays(monthKey);
  if (dayNumber < 1 || dayNumber > daysInMonth) {
    return null;
  }

  return dayNumberToDate(monthKey, dayNumber);
}

function countOccupiedRowsForColumn(
  values: string[][],
  unitDescriptors: UnitDescriptor[],
  columnIndex: number,
): number {
  return unitDescriptors.reduce((count, unit) => {
    const hasOccupancy = unit.rowIndices.some(
      (rowIndex) => !isBlankCell(getMatrixCell(values, rowIndex, columnIndex)),
    );
    return count + (hasOccupancy ? 1 : 0);
  }, 0);
}

function inferCapacityFromGrid(
  values: string[][],
  monthKey: string,
  layout: ReturnType<typeof mergeSheetsLayout>,
): number {
  const capacityRowIndex = layout.summaryRowStartIndex + 1;
  const lastDayColumnIndex = getEffectiveLastDayColumnIndex(monthKey, layout);
  const capacities: number[] = [];

  for (let columnIndex = layout.firstDayColumnIndex; columnIndex <= lastDayColumnIndex; columnIndex += 1) {
    const parsed = Number(getMatrixCell(values, capacityRowIndex, columnIndex));
    if (Number.isFinite(parsed) && parsed > 0) {
      capacities.push(parsed);
    }
  }

  return capacities[0] ?? hotelDemoConfig.defaultCapacityPerMonth + hotelDemoConfig.overflowCapacityPerMonth;
}

function buildColumnDescriptors(
  values: string[][],
  monthKey: string,
  layout: ReturnType<typeof mergeSheetsLayout>,
): ColumnDescriptor[] {
  const descriptors: ColumnDescriptor[] = [];
  const lastDayColumnIndex = getEffectiveLastDayColumnIndex(monthKey, layout);

  for (
    let columnIndex = layout.firstDayColumnIndex;
    columnIndex <= lastDayColumnIndex;
    columnIndex += 1
  ) {
    const rawHeader = getMatrixCell(values, layout.dayHeaderRowIndex, columnIndex);
    const dayNumber = Number(rawHeader);

    if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > getEffectiveMonthDayCount(monthKey, layout)) {
      continue;
    }

    const date = getDateFromHeader(monthKey, dayNumber);
    if (!date) {
      continue;
    }

    descriptors.push({
      columnIndex,
      date,
      slot:
        layout.occupancyMode === "slot-grid" &&
        (columnIndex - layout.firstDayColumnIndex) % 2 === 1
          ? "afternoon"
          : "morning",
    });
  }

  return descriptors;
}

function buildRowDescriptors(
  values: string[][],
  layout: ReturnType<typeof mergeSheetsLayout>,
): RowDescriptor[] {
  const searchRanges: Array<[number, number]> =
    layout.searchRowRanges?.map((range) => [range.startRowIndex, range.endRowIndex]) ?? [
      [layout.firstDataRowIndex, layout.lastDataRowIndex],
    ];
  const descriptors: RowDescriptor[] = [];
  let currentLabel: string | null = null;
  let currentReservable = false;

  for (const [startRow, endRow] of searchRanges) {
    currentLabel = null;
    currentReservable = false;

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      const sourceLabel = normalizeCell(getMatrixCell(values, rowIndex, layout.labelColumnIndex));

      if (sourceLabel) {
        currentReservable = isReservableUnitLabel(sourceLabel);
        currentLabel = currentReservable ? normalizeUnitLabel(sourceLabel) : null;
      }

      descriptors.push({
        rowIndex,
        sourceLabel,
        label: currentLabel,
        isReservable: currentReservable && currentLabel !== null,
      });
    }
  }

  return descriptors;
}

function buildUnitDescriptors(
  values: string[][],
  layout: ReturnType<typeof mergeSheetsLayout>,
): UnitDescriptor[] {
  const searchRanges: Array<[number, number]> =
    layout.searchRowRanges?.map((range) => [range.startRowIndex, range.endRowIndex]) ?? [
      [layout.firstDataRowIndex, layout.lastDataRowIndex],
    ];
  const descriptors: UnitDescriptor[] = [];
  let currentUnit: UnitDescriptor | null = null;

  for (const [startRow, endRow] of searchRanges) {
    currentUnit = null;

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      const sourceLabel = normalizeCell(getMatrixCell(values, rowIndex, layout.labelColumnIndex));

      if (sourceLabel) {
        if (isReservableUnitLabel(sourceLabel)) {
          currentUnit = {
            rowIndex,
            rowIndices: [rowIndex],
            sourceLabel,
            label: normalizeUnitLabel(sourceLabel),
          };
          descriptors.push(currentUnit);
        } else {
          currentUnit = null;
        }
        continue;
      }

      if (currentUnit) {
        currentUnit.rowIndices.push(rowIndex);
      }
    }
  }

  return descriptors;
}

function selectColumnsForAvailability(
  allDescriptors: ColumnDescriptor[],
  occupiedSlots: Array<{ date: string; slot: HotelSlot }>,
  layout: ReturnType<typeof mergeSheetsLayout>,
): ColumnDescriptor[] {
  if (layout.occupancyMode === "slot-grid") {
    const requestedPoints = new Set(
      occupiedSlots.map((slot) => `${slot.date}:${slot.slot}`),
    );

    return allDescriptors.filter((descriptor) =>
      requestedPoints.has(`${descriptor.date}:${descriptor.slot}`),
    );
  }

  const requestedDates = new Set(occupiedSlots.map((slot) => slot.date));
  return allDescriptors.filter((descriptor) => requestedDates.has(descriptor.date));
}

function inspectAvailabilityByUnit(
  values: string[][],
  reservation: Pick<SheetsAvailabilityInput, "entryDate" | "entrySlot" | "exitDate" | "exitSlot">,
  context?: Partial<SheetAdapterContext>,
) {
  const layout = mergeSheetsLayout(context?.layout);
  const occupiedSlots = getOccupiedSlotsForStay(reservation);
  const monthKey = reservation.entryDate.slice(0, 7);
  const descriptors = buildColumnDescriptors(values, monthKey, layout);
  const columnsToCheck = selectColumnsForAvailability(descriptors, occupiedSlots, layout);
  const unitDescriptors = buildUnitDescriptors(values, layout);
  const requestedSlotKeys = new Set(
    occupiedSlots.map((slot) => `${slot.date}:${slot.slot}`),
  );
  const requestedDates = new Set(columnsToCheck.map((descriptor) => descriptor.date));
  const unitChecks = unitDescriptors.map<AvailabilityUnitCheck>((unit) => {
    const occupiedUnitSlots = buildUnitOccupiedSlots(values, layout, unit, monthKey).filter(
      (slot) => requestedDates.has(slot.date),
    );
    const conflictingSlots = occupiedUnitSlots.filter((slot) =>
      requestedSlotKeys.has(`${slot.date}:${slot.slot}`),
    );

    return {
      unit,
      analyzedColumns: columnsToCheck,
      occupiedSlots: occupiedUnitSlots,
      conflictingSlots,
      status: conflictingSlots.length === 0 ? "free" : "occupied",
    };
  });

  const freeUnits = unitChecks.filter((check) => check.status === "free");

  return {
    layout,
    monthKey,
    columnsToCheck,
    unitChecks,
    freeUnits,
  };
}

function collectRowOccupancySegments(
  values: string[][],
  layout: ReturnType<typeof mergeSheetsLayout>,
  rowIndex: number,
  monthKey: string,
): Array<{
  start: ColumnDescriptor;
  end: ColumnDescriptor;
  labels: string[];
}> {
  const descriptors = buildColumnDescriptors(values, monthKey, layout);
  const segments: Array<{
    start: ColumnDescriptor;
    end: ColumnDescriptor;
    labels: string[];
  }> = [];
  let current: {
    start: ColumnDescriptor;
    end: ColumnDescriptor;
    labels: string[];
  } | null = null;

  for (const descriptor of descriptors) {
    const cell = normalizeCell(getMatrixCell(values, rowIndex, descriptor.columnIndex));

    if (cell) {
      if (!current) {
        current = { start: descriptor, end: descriptor, labels: [cell] };
      } else {
        current.end = descriptor;
        current.labels.push(cell);
      }
      continue;
    }

    if (current) {
      segments.push(current);
      current = null;
    }
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

function buildUnitOccupiedSlots(
  values: string[][],
  layout: ReturnType<typeof mergeSheetsLayout>,
  unit: UnitDescriptor,
  monthKey: string,
): OccupiedUnitSlot[] {
  const columnDescriptors = buildColumnDescriptors(values, monthKey, layout);

  return unit.rowIndices.flatMap((rowIndex) =>
    collectRowOccupancySegments(values, layout, rowIndex, monthKey).flatMap((segment) => {
      const firstValue = segment.labels[0] ?? unit.label;
      const window =
        layout.occupancyMode === "slot-grid"
          ? {
              checkIn: { date: segment.start.date, slot: segment.start.slot },
              checkOut: { date: segment.end.date, slot: segment.end.slot },
            }
          : segment.start.date === segment.end.date
            ? {
                checkIn: { date: segment.start.date, slot: "morning" as const },
                checkOut: { date: segment.end.date, slot: "afternoon" as const },
              }
            : {
                checkIn: { date: segment.start.date, slot: "afternoon" as const },
                checkOut: { date: segment.end.date, slot: "morning" as const },
              };

      return expandStayWindow(window).map((occupiedSlot) => {
        const descriptor = columnDescriptors.find(
          (candidate) =>
            candidate.date === occupiedSlot.date &&
            (layout.occupancyMode !== "slot-grid" || candidate.slot === occupiedSlot.slot),
        );

        return {
          rowIndex,
          columnIndex: descriptor?.columnIndex ?? layout.firstDayColumnIndex,
          date: occupiedSlot.date,
          slot: occupiedSlot.slot,
          value: firstValue,
        };
      });
    }),
  );
}

function collectRowSegments(
  values: string[][],
  layout: ReturnType<typeof mergeSheetsLayout>,
  row: RowDescriptor,
  monthKey: string,
  sheetName: string,
): DemoReservationRecord[] {
  if (!row.isReservable || !row.label) {
    return [];
  }

  const rowLabel = row.label;
  const segments = collectRowOccupancySegments(values, layout, row.rowIndex, monthKey);

  return segments.map((segment, segmentIndex) => {
    const petName = segment.labels[0] ?? rowLabel ?? `Fila ${row.rowIndex}`;
    const petKey = buildPetKey(petName, rowLabel || undefined);
    const entryDate = segment.start.date;
    const exitDate = segment.end.date;
    const entrySlot =
      layout.occupancyMode === "slot-grid"
        ? segment.start.slot
        : segment.start.date === segment.end.date
          ? "morning"
          : "afternoon";
    const exitSlot =
      layout.occupancyMode === "slot-grid"
        ? segment.end.slot
        : segment.start.date === segment.end.date
          ? "afternoon"
          : "morning";

    return {
      id: `sheet-${monthKey}-r${row.rowIndex}-s${segmentIndex}`,
      petKey,
      petName,
      ownerName: rowLabel || undefined,
      phoneE164: undefined,
      entryDate,
      entrySlot,
      exitDate,
      exitSlot,
      dogs: inferDogCount(petName),
      notes: undefined,
      status: "confirmed",
      source: "mock",
      sheetName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
}

export function buildMonthSnapshotFromGrid(
  values: string[][],
  monthKey: string,
  context?: Partial<SheetAdapterContext>,
  sheetName = getSheetNameForMonth(monthKey, context),
): MonthOccupancySnapshot {
  const layout = mergeSheetsLayout(context?.layout);
  const colorPalette = mergeSheetsColorPalette(context?.colorPalette);
  const capacity = inferCapacityFromGrid(values, monthKey, layout);
  const occupiedByDate: Record<string, { morning: number; afternoon: number }> = {};
  const reservations: DemoReservationRecord[] = [];
  const descriptors = buildColumnDescriptors(values, monthKey, layout);
  const unitDescriptors = buildUnitDescriptors(values, layout);
  const rowDescriptors = buildRowDescriptors(values, layout);

  for (const descriptor of descriptors) {
    const occupiedCount = countOccupiedRowsForColumn(
      values,
      unitDescriptors,
      descriptor.columnIndex,
    );
    const snapshot = occupiedByDate[descriptor.date] ?? {
      morning: 0,
      afternoon: 0,
    };

    if (layout.occupancyMode === "slot-grid") {
      snapshot[descriptor.slot] = occupiedCount;
    } else {
      snapshot.morning = occupiedCount;
      snapshot.afternoon = occupiedCount;
    }

    occupiedByDate[descriptor.date] = snapshot;
  }

  for (const row of rowDescriptors) {
    reservations.push(...collectRowSegments(values, layout, row, monthKey, sheetName));
  }

  const colorPlan: SheetColorPlan[] = [];
  for (const descriptor of descriptors) {
    const count =
      layout.occupancyMode === "slot-grid"
        ? occupiedByDate[descriptor.date]?.[descriptor.slot] ?? 0
        : occupiedByDate[descriptor.date]?.morning ?? 0;
    const ratio = count / capacity;
    const color =
      ratio >= 1
        ? colorPalette.noAvailability
        : ratio >= 0.75
          ? colorPalette.review
          : ratio >= 0.5
            ? colorPalette.reminder
            : ratio >= 0.25
              ? colorPalette.available
              : colorPalette.pending;

    colorPlan.push({
      row: layout.dayHeaderRowIndex,
      column: descriptor.columnIndex,
      color,
      label: `${descriptor.date} ${descriptor.slot} (${count})`,
    });
  }

  const titleCell =
      layout.titleRowIndex > 0
        ? getMatrixCell(values, layout.titleRowIndex, layout.firstDayColumnIndex)
        : "";
  if (layout.titleRequired && layout.titleRowIndex > 0 && !isBlankCell(titleCell)) {
    colorPlan.push({
      row: layout.titleRowIndex,
      column: layout.firstDayColumnIndex,
      color: colorPalette.header,
      label: sheetName,
    });
  }

  return {
    monthKey,
    sheetName,
    capacityBySlot: {
      morning: capacity,
      afternoon: capacity,
    },
    occupiedByDate,
    reservations,
    colorPlan,
  };
}

export function buildAvailabilityResult(
  snapshot: MonthOccupancySnapshot,
  input: SheetsAvailabilityInput,
  values: string[][],
  context?: Partial<SheetAdapterContext>,
): SheetsAvailabilityResult {
  const remainingByDate: Record<string, { morning: number; afternoon: number }> = {};
  const freeUnitsNeeded = Math.max(1, input.dogs);
  const availableUnits = [] as Array<{
    rowIndex: number;
    rowIndices: number[];
    label: string;
    sourceLabel?: string;
  }>;
  const conflicts = new Set<string>();
  const analyzedColumns = [] as Array<{
    columnIndex: number;
    columnLetter: string;
    date: string;
    slot: HotelSlot;
  }>;
  const analyzedRows = [] as Array<{
    rowIndex: number;
    rowIndices?: number[];
    label?: string;
    sourceLabel?: string;
    analyzedColumns: string[];
    occupiedSlots?: string[];
    conflictingSlots?: string[];
    blockedCells: Array<{
      cell: string;
      columnIndex: number;
      date: string;
      slot: HotelSlot;
      value: string;
    }>;
    status: "free" | "occupied" | "ignored";
    reason?: string;
  }>;

  const layout = mergeSheetsLayout(context?.layout);
  const inspectionByUnit = inspectAvailabilityByUnit(values, input, context);
  const requestedSlots = getOccupiedSlotsForStay(input);
  const requestedWindowIsValid = isValidStayWindow({
    checkIn: { date: input.entryDate, slot: input.entrySlot },
    checkOut: { date: input.exitDate, slot: input.exitSlot },
  });

  if (!requestedWindowIsValid || inspectionByUnit.columnsToCheck.length === 0) {
    return {
      available: false,
      conflicts: [],
      remainingByDate,
      monthKey: snapshot.monthKey,
      sheetName: snapshot.sheetName,
      debug: {
        monthKey: snapshot.monthKey,
        sheetName: snapshot.sheetName,
        checkedWindow: {
          entryDate: input.entryDate,
          entrySlot: input.entrySlot,
          exitDate: input.exitDate,
          exitSlot: input.exitSlot,
          dogs: input.dogs,
        },
        requestedSlots: [],
        analyzedColumns: [],
        analyzedRows: [],
        summary: requestedWindowIsValid
          ? "No se han encontrado columnas de ocupación para el rango solicitado en la hoja mensual."
          : "La ventana solicitada no es válida y no se puede evaluar disponibilidad.",
      },
    };
  }

  for (const descriptor of inspectionByUnit.columnsToCheck) {
    analyzedColumns.push({
      columnIndex: descriptor.columnIndex,
      columnLetter: columnIndexToLetter(descriptor.columnIndex),
      date: descriptor.date,
      slot: descriptor.slot,
    });
  }

  if (layout.occupancyMode === "slot-grid") {
    for (const descriptor of inspectionByUnit.columnsToCheck) {
      const freeCount = inspectionByUnit.unitChecks.filter((check) =>
        !check.occupiedSlots.some(
          (slot) => slot.date === descriptor.date && slot.slot === descriptor.slot,
        ),
      ).length;
      const bucket = remainingByDate[descriptor.date] ?? { morning: 0, afternoon: 0 };
      bucket[descriptor.slot] = freeCount;
      remainingByDate[descriptor.date] = bucket;
    }
  } else {
    for (const descriptor of inspectionByUnit.columnsToCheck) {
      remainingByDate[descriptor.date] = {
        morning: inspectionByUnit.unitChecks.filter((check) =>
          !check.occupiedSlots.some(
            (slot) => slot.date === descriptor.date && slot.slot === "morning",
          ),
        ).length,
        afternoon: inspectionByUnit.unitChecks.filter((check) =>
          !check.occupiedSlots.some(
            (slot) => slot.date === descriptor.date && slot.slot === "afternoon",
          ),
        ).length,
      };
    }
  }

  for (const check of inspectionByUnit.unitChecks) {
    const blockedCells = check.conflictingSlots.map((slot) => ({
      cell: `${columnIndexToLetter(slot.columnIndex)}${slot.rowIndex}`,
      columnIndex: slot.columnIndex,
      date: slot.date,
      slot: slot.slot,
      value: slot.value,
    }));

    blockedCells.forEach((cell) => conflicts.add(cell.value));
    analyzedRows.push({
      rowIndex: check.unit.rowIndex,
      rowIndices: check.unit.rowIndices,
      label: check.unit.label,
      sourceLabel: check.unit.sourceLabel || undefined,
      analyzedColumns: check.analyzedColumns.map((descriptor) =>
        `${columnIndexToLetter(descriptor.columnIndex)}:${descriptor.date}`,
      ),
      occupiedSlots: check.occupiedSlots.map((slot) => `${slot.date}:${slot.slot}`),
      conflictingSlots: check.conflictingSlots.map((slot) => `${slot.date}:${slot.slot}`),
      blockedCells,
      status: blockedCells.length === 0 ? "free" : "occupied",
      reason:
        blockedCells.length === 0
          ? "La unidad es compatible: no tiene ningún slot ocupado que choque con la nueva reserva."
          : `La unidad entra en conflicto en los slots ${check.conflictingSlots
              .map((slot) => `${slot.date}:${slot.slot}`)
              .join(", ")}.`,
    });

    if (blockedCells.length === 0) {
      availableUnits.push({
        rowIndex: check.unit.rowIndex,
        rowIndices: check.unit.rowIndices,
        label: check.unit.label,
        sourceLabel: check.unit.sourceLabel || undefined,
      });
    }
  }

  const suggestedUnits = availableUnits.slice(0, freeUnitsNeeded);
  const isAvailable = availableUnits.length >= freeUnitsNeeded;
  const summary = isAvailable
    ? `Se han encontrado ${availableUnits.length} unidades libres durante todo el tramo; propuesta principal: ${suggestedUnits[0]?.label ?? "sin etiqueta"}.`
    : `No hay ninguna unidad completamente libre durante todo el tramo solicitado. Se analizaron ${inspectionByUnit.unitChecks.length} unidades reales y ninguna cumple continuidad completa.`;

  return {
    available: isAvailable,
    conflicts: isAvailable ? [] : Array.from(conflicts),
    remainingByDate,
    monthKey: snapshot.monthKey,
    sheetName: snapshot.sheetName,
    suggestedUnit: suggestedUnits[0],
    suggestedUnits,
    debug: {
      monthKey: snapshot.monthKey,
      sheetName: snapshot.sheetName,
      checkedWindow: {
        entryDate: input.entryDate,
        entrySlot: input.entrySlot,
        exitDate: input.exitDate,
        exitSlot: input.exitSlot,
        dogs: input.dogs,
      },
      requestedSlots: requestedSlots.map((slot) => `${slot.date}:${slot.slot}`),
      analyzedColumns,
      analyzedRows,
      summary,
    },
  };
}

export function findAvailableRowForReservation(
  values: string[][],
  reservation: Pick<SheetsAvailabilityInput, "entryDate" | "entrySlot" | "exitDate" | "exitSlot">,
  context?: Partial<SheetAdapterContext>,
): number | null {
  const inspection = inspectAvailabilityByUnit(values, reservation, context);
  return inspection.freeUnits[0]?.unit.rowIndex ?? null;
}

export function findAvailableRowsForReservation(
  values: string[][],
  reservation: Pick<SheetsAvailabilityInput, "entryDate" | "entrySlot" | "exitDate" | "exitSlot" | "dogs">,
  context?: Partial<SheetAdapterContext>,
): number[] {
  const inspection = inspectAvailabilityByUnit(values, reservation, context);
  const unitsNeeded = Math.max(1, Math.ceil(reservation.dogs));
  return inspection.freeUnits
    .slice(0, unitsNeeded)
    .map((unit) => unit.unit.rowIndex);
}

function statusToColor(
  status: DemoReservationRecord["status"],
  context?: Partial<SheetAdapterContext>,
): string {
  const palette = mergeSheetsColorPalette(context?.colorPalette);

  switch (status) {
    case "available":
      return palette.available;
    case "no_availability":
      return palette.noAvailability;
    case "confirmed":
      return palette.confirmed;
    case "cancelled":
      return palette.review;
    case "needs_review":
      return palette.review;
    case "pending":
    default:
      return palette.pending;
  }
}

function occupiedCellUpdates(
  rowIndex: number,
  reservation: DemoReservationRecord,
  values: string[][],
  context?: Partial<SheetAdapterContext>,
  visibleValue = reservation.petName,
): { updates: SheetCellUpdate[]; colors: SheetColorPlan[]; metadata: SheetCellMetadataUpdate[] } {
  const layout = mergeSheetsLayout(context?.layout);
  const occupiedSlots = getOccupiedSlotsForStay({
    entryDate: reservation.entryDate,
    entrySlot: reservation.entrySlot,
    exitDate: reservation.exitDate,
    exitSlot: reservation.exitSlot,
  });
  const descriptors = buildColumnDescriptors(values, reservation.entryDate.slice(0, 7), layout);
  const color = statusToColor(reservation.status, context);
  const updates: SheetCellUpdate[] = [];
  const colors: SheetColorPlan[] = [];
  const metadata: SheetCellMetadataUpdate[] = [];
  const seenCells = new Set<string>();
  const note = buildReservationCellNote(reservation);

  for (const occupiedSlot of occupiedSlots) {
    const descriptor = descriptors.find(
      (candidate) =>
        candidate.date === occupiedSlot.date &&
        (layout.occupancyMode !== "slot-grid" || candidate.slot === occupiedSlot.slot),
    );

    if (!descriptor) {
      continue;
    }

    const columnIndex = descriptor.columnIndex;
    const cell = `${columnIndexToLetter(columnIndex)}${rowIndex}`;
    if (seenCells.has(cell)) {
      continue;
    }

    seenCells.add(cell);
    updates.push({ cell, value: visibleValue });
    colors.push({
      row: rowIndex,
      column: columnIndex,
      color,
      label: visibleValue,
    });
    metadata.push({
      cell,
      note,
    });
  }

  return { updates, colors, metadata };
}

export function buildReservationCellNote(reservation: DemoReservationRecord): string {
  return [
    `${SHEETS_RESERVATION_ID_NOTE_KEY}=${reservation.id}`,
    `Mascota: ${reservation.petName}`,
    reservation.ownerName ? `Cliente: ${reservation.ownerName}` : undefined,
    reservation.ownerEmail ? `Email: ${reservation.ownerEmail}` : undefined,
    `Entrada: ${reservation.entryDate} ${reservation.entrySlot}`,
    reservation.entryTime ? `Hora entrada: ${reservation.entryTime}` : undefined,
    `Salida: ${reservation.exitDate} ${reservation.exitSlot}`,
    reservation.exitTime ? `Hora salida: ${reservation.exitTime}` : undefined,
    `Perros: ${reservation.dogs}`,
    reservation.price !== undefined ? `Precio: ${reservation.price} EUR` : undefined,
    reservation.priceSource ? `Fuente precio: ${reservation.priceSource}` : undefined,
    reservation.wantsVisit === true
      ? "Visita previa: sí"
      : reservation.wantsVisit === false
        ? "Visita previa: no"
        : undefined,
    reservation.foodNotes ? `Alimentación: ${reservation.foodNotes}` : undefined,
    reservation.medicationNotes ? `Medicación: ${reservation.medicationNotes}` : undefined,
    reservation.originalRequestedCheckInTime
      ? `Hora entrada solicitada: ${reservation.originalRequestedCheckInTime}`
      : undefined,
    reservation.normalizedCheckInTime
      ? `Hora entrada aplicada: ${reservation.normalizedCheckInTime}`
      : undefined,
    reservation.originalRequestedCheckOutTime
      ? `Hora salida solicitada: ${reservation.originalRequestedCheckOutTime}`
      : undefined,
    reservation.normalizedCheckOutTime
      ? `Hora salida aplicada: ${reservation.normalizedCheckOutTime}`
      : undefined,
    reservation.bathRequested ? "Baño/peluquería: solicitado" : undefined,
    reservation.specialNotes ? `Notas: ${reservation.specialNotes}` : undefined,
    `Escrito por sistema: ${new Date().toISOString()}`,
  ].filter(Boolean).join("\n");
}

export function buildCancelledReservationCellNote(
  reservationId: string,
  cancelledAt: string,
): string {
  return [
    `${SHEETS_CANCELLED_RESERVATION_ID_NOTE_KEY}=${reservationId}`,
    `Cancelada sin coste adicional: ${cancelledAt}`,
    "Celda liberada por el sistema de reservas.",
  ].join("\n");
}

export function noteHasReservationId(note: string | undefined, reservationId: string): boolean {
  return Boolean(note?.includes(`${SHEETS_RESERVATION_ID_NOTE_KEY}=${reservationId}`));
}

export function buildWritePlanForReservation(
  reservation: DemoReservationRecord,
  values: string[][],
  context?: Partial<SheetAdapterContext>,
): SheetWritePlan {
  const layout = mergeSheetsLayout(context?.layout);
  const monthKey = reservation.entryDate.slice(0, 7);
  const sheetName = reservation.sheetName ?? getSheetNameForMonth(monthKey, context);
  const rows = findAvailableRowsForReservation(values, reservation, context);
  const targetRows = rows.length > 0 ? rows : [layout.lastDataRowIndex];
  const unitCount = targetRows.length;
  const updates: SheetCellUpdate[] = [];
  const colors: SheetColorPlan[] = [];
  const metadata: SheetCellMetadataUpdate[] = [];

  targetRows.forEach((targetRow, index) => {
    const visibleValue =
      unitCount > 1 ? `${reservation.petName} (${index + 1}/${unitCount})` : reservation.petName;
    const rowPlan = occupiedCellUpdates(targetRow, reservation, values, context, visibleValue);
    updates.push(...rowPlan.updates);
    colors.push(...rowPlan.colors);
    metadata.push(...rowPlan.metadata);
  });

  return {
    sheetName,
    reservationId: reservation.id,
    petName: reservation.petName,
    rowHint: targetRows[0],
    colorPlan: colors,
    cellUpdates: updates,
    metadataUpdates: metadata,
  };
}

export function applyWritePlanToMatrix(
  values: string[][],
  plan: SheetWritePlan,
): string[][] {
  const next = values.map((row) => [...row]);
  for (const update of plan.cellUpdates) {
    const columnIndex = letterToColumnIndex(update.cell.replace(/\d+/g, ""));
    const rowIndex = Number(update.cell.replace(/^[A-Z]+/, ""));
    if (!Number.isInteger(rowIndex) || rowIndex < 1 || columnIndex < 1) {
      continue;
    }
    setMatrixCell(next, rowIndex, columnIndex, update.value);
  }

  return next;
}

export function buildWriteResult(
  plan: SheetWritePlan,
  mode: "mock" | "real",
): SheetsWriteResult {
  return {
    ok: true,
    reservationId: plan.reservationId,
    sheetName: plan.sheetName,
    petName: plan.petName,
    rowHint: plan.rowHint,
    colorPlan: plan.colorPlan,
    cellUpdates: plan.cellUpdates,
    metadataUpdates: plan.metadataUpdates,
    mode,
  };
}

export function seedBlankMonthMatrix(
  monthKey: string,
  context?: Partial<SheetAdapterContext>,
): string[][] {
  const layout = mergeSheetsLayout(context?.layout);
  const rows: string[][] = Array.from({ length: layout.summaryRowEndIndex }, () => []);
  const monthDayCount = getEffectiveMonthDayCount(monthKey, layout);
  const lastDayColumnIndex = layout.firstDayColumnIndex + monthDayCount - 1;

  if (layout.occupancyMode === "slot-grid") {
    for (let day = 1; day <= monthDayCount; day += 1) {
      const baseColumn = layout.firstDayColumnIndex + (day - 1) * 2;
      setMatrixCell(rows, layout.dayHeaderRowIndex, baseColumn, String(day));
      if (baseColumn + 1 <= layout.lastDayColumnIndex) {
        setMatrixCell(rows, layout.dayHeaderRowIndex, baseColumn + 1, String(day));
      }
    }
  } else {
    for (let day = 1; day <= monthDayCount; day += 1) {
      setMatrixCell(rows, layout.dayHeaderRowIndex, layout.firstDayColumnIndex + day - 1, String(day));
    }
  }

  for (const room of CLIENT_WORKBOOK_ROOM_LABELS) {
    if (
      room.rowIndex < layout.firstDataRowIndex ||
      room.rowIndex > layout.lastDataRowIndex
    ) {
      continue;
    }

    setMatrixCell(rows, room.rowIndex, layout.labelColumnIndex, room.label);
  }

  setMatrixCell(rows, layout.summaryRowStartIndex, layout.labelColumnIndex, "OCUPACIÓN");
  setMatrixCell(rows, layout.summaryRowStartIndex + 1, layout.labelColumnIndex, "TOTAL OCUPACIÓN");
  setMatrixCell(rows, layout.summaryRowStartIndex + 2, layout.labelColumnIndex, "% OCUPACIÓN");
  setMatrixCell(rows, layout.summaryRowStartIndex + 3, layout.labelColumnIndex, "TESORERIA");

  for (let day = 1; day <= monthDayCount; day += 1) {
    const column = layout.firstDayColumnIndex + day - 1;
    setMatrixCell(
      rows,
      layout.summaryRowStartIndex,
      column,
      `=COUNTA(${columnIndexToLetter(column)}${layout.firstDataRowIndex}:${columnIndexToLetter(column)}${layout.lastDataRowIndex})`,
    );
    setMatrixCell(rows, layout.summaryRowStartIndex + 1, column, "=16");
    setMatrixCell(rows, layout.summaryRowStartIndex + 2, column, `=${columnIndexToLetter(column)}${layout.summaryRowStartIndex}/${columnIndexToLetter(column)}${layout.summaryRowStartIndex + 1}`);
    setMatrixCell(rows, layout.summaryRowStartIndex + 3, column, `=${columnIndexToLetter(column)}${layout.summaryRowStartIndex}*20`);
  }

  setMatrixCell(rows, layout.summaryRowStartIndex + 4, lastDayColumnIndex - 1, "TOTAL");
  setMatrixCell(rows, layout.summaryRowStartIndex + 4, lastDayColumnIndex, `=SUM(B${layout.summaryRowStartIndex + 3}:${columnIndexToLetter(lastDayColumnIndex)}${layout.summaryRowStartIndex + 3})`);

  setMatrixCell(rows, 46, layout.labelColumnIndex, "Sociable");
  setMatrixCell(rows, 47, layout.labelColumnIndex, "No comparte");
  setMatrixCell(rows, 48, layout.labelColumnIndex, "No sociable");
  setMatrixCell(rows, 49, layout.labelColumnIndex, "Nuevo");
  setMatrixCell(rows, 50, layout.labelColumnIndex, "Antiguo (no se recuerda carácter)");
  setMatrixCell(rows, 51, layout.labelColumnIndex, "Pasar el dia");
  setMatrixCell(rows, 52, layout.labelColumnIndex, "Escuela de dia");

  return rows;
}
