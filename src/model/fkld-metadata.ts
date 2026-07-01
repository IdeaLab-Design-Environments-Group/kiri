/**
 * Pure data-shaping for the FKLD metadata panel — adapted from AKDE's
 * `fkld-metadata-summary.ts`. Returns ordered sections/rows so the view layer
 * is a thin DOM wrapper. Every value comes from the FKLD/FOLD object itself.
 */
import type { FoldFile } from "./fold-file.js";

export interface SummaryRow {
  term: string;
  value: string;
}

export interface SummarySection {
  title: string;
  rows: SummaryRow[];
  emptyMessage?: string;
}

const ASSIGNMENT_ORDER = ["M", "V", "F", "B", "C", "U"] as const;
const ASSIGNMENT_LABEL: Record<string, string> = {
  M: "mountain",
  V: "valley",
  F: "facet (flat)",
  B: "boundary",
  C: "cut",
  U: "unassigned",
};
const CUT_SUBTYPE_ORDER = [
  "major",
  "minor",
  "seam",
  "dart",
  "auxetic",
  "vent",
  "tab",
] as const;

export function summarizeFkldForDisplay(fkld: FoldFile | null): SummarySection[] {
  if (!fkld) return [];
  return [
    summarizeHeader(fkld),
    summarizeTopology(fkld),
    summarizeAssignments(fkld),
    summarizeCutSubtypes(fkld),
    summarizeMolecules(fkld),
    summarizeArchitecture(fkld),
  ];
}

function summarizeHeader(fkld: FoldFile): SummarySection {
  const classes = arrayOr<string>(fkld.file_classes);
  return {
    title: "File header",
    rows: [
      { term: "file_spec", value: formatNumber(fkld.file_spec) },
      { term: "file_creator", value: stringOr(fkld.file_creator, "—") },
      { term: "frame_title", value: stringOr(fkld.frame_title, "—") },
      { term: "file_classes", value: classes.length > 0 ? classes.join(", ") : "—" },
    ],
  };
}

function summarizeTopology(fkld: FoldFile): SummarySection {
  return {
    title: "Topology",
    rows: [
      { term: "vertices_coords", value: String(fkld.vertices_coords?.length ?? 0) },
      { term: "edges_vertices", value: String(fkld.edges_vertices?.length ?? 0) },
      { term: "faces_vertices", value: String(fkld.faces_vertices?.length ?? 0) },
    ],
  };
}

function summarizeAssignments(fkld: FoldFile): SummarySection {
  const breakdown = countBy(fkld.edges_assignment ?? []);
  return {
    title: "edges_assignment",
    rows: ASSIGNMENT_ORDER.map((letter) => ({
      term: `${letter}  ${ASSIGNMENT_LABEL[letter]}`,
      value: String(breakdown.get(letter) ?? 0),
    })),
  };
}

function summarizeCutSubtypes(fkld: FoldFile): SummarySection {
  const raw = fkld["fkld:edges_cutType"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { title: "fkld:edges_cutType", rows: [], emptyMessage: "Not present." };
  }
  const breakdown = countBy(raw.filter((v): v is string => typeof v === "string"));
  const nullCount = raw.reduce<number>((acc, v) => acc + (v == null ? 1 : 0), 0);
  const rows: SummaryRow[] = CUT_SUBTYPE_ORDER.map((subtype) => ({
    term: subtype,
    value: String(breakdown.get(subtype) ?? 0),
  }));
  rows.push({ term: "null  (non-cut edges)", value: String(nullCount) });
  return { title: "fkld:edges_cutType", rows };
}

function summarizeMolecules(fkld: FoldFile): SummarySection {
  const theta = fkld["fkld:edges_moleculeTheta"];
  const width = fkld["fkld:edges_moleculeWidth"];
  const populated = Array.isArray(theta) ? theta.filter((v) => v != null).length : 0;
  const sampleTheta = Array.isArray(theta)
    ? (theta.find((v) => typeof v === "number") as number | undefined)
    : undefined;
  const sampleWidth = Array.isArray(width)
    ? (width.find((v) => typeof v === "number") as number | undefined)
    : undefined;
  return {
    title: "Molecules",
    rows: [
      { term: "edges carrying (θ, w)", value: String(populated) },
      { term: "θ (sample)", value: sampleTheta !== undefined ? formatRadAsDeg(sampleTheta) : "—" },
      { term: "w (sample, mm)", value: sampleWidth !== undefined ? formatNumber(sampleWidth) : "—" },
    ],
  };
}

function summarizeArchitecture(fkld: FoldFile): SummarySection {
  const arch = fkld["fkld:meta_architecture"] as Record<string, unknown> | undefined;
  if (!arch || typeof arch !== "object") {
    return { title: "fkld:meta_architecture", rows: [], emptyMessage: "Not present." };
  }
  return {
    title: "fkld:meta_architecture",
    rows: flattenObject(arch).map(([term, value]) => ({ term, value })),
  };
}

// ---- helpers --------------------------------------------------------------
function countBy(items: ReadonlyArray<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

function flattenObject(obj: Record<string, unknown>, prefix = ""): [string, string][] {
  const rows: [string, string][] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rows.push(...flattenObject(value as Record<string, unknown>, path));
    } else if (Array.isArray(value)) {
      rows.push([path, JSON.stringify(value)]);
    } else {
      rows.push([path, value == null ? "—" : formatLeaf(value)]);
    }
  }
  return rows;
}

function formatLeaf(value: unknown): string {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function formatNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatRadAsDeg(rad: number): string {
  return `${formatNumber((rad * 180) / Math.PI)}°`;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function arrayOr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
