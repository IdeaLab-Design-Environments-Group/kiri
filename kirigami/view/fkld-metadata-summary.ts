/**
 * Pure data-shaping for `FkldMetadataView`. The view delegates "what to
 * display" to this module so the formatting rules can be tested in a
 * node-only environment without jsdom. The view itself is then a thin
 * DOM wrapper around the section/row arrays returned here.
 *
 * Every value comes from the FKLD object — no fallback to KirigamiState
 * — so the screen and the exported file always agree.
 */

import type { FkldFile } from "../model/fkld-export.js";

/** One labelled row in a metadata section. */
export interface SummaryRow {
  /** Left column label (e.g. "edges_vertices", "M  mountain"). */
  term: string;
  /** Right column value, already formatted as a display string. */
  value: string;
}

/** One section in the FKLD metadata panel. */
export interface SummarySection {
  /** Section heading shown above the rows. */
  title: string;
  /** Rows in display order. */
  rows: SummaryRow[];
  /**
   * Optional empty-state placeholder rendered instead of the rows when
   * the section has no meaningful content (e.g. a missing extension).
   */
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

/**
 * Build the full ordered list of sections for an FKLD file. Returns an
 * empty array for null input — callers (the view) substitute their own
 * empty-state UI.
 */
export function summarizeFkldForDisplay(fkld: FkldFile | null): SummarySection[] {
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

function summarizeHeader(fkld: FkldFile): SummarySection {
  const classes = arrayOr<string>(fkld.file_classes);
  return {
    title: "File header",
    rows: [
      { term: "file_spec", value: formatNumber(fkld.file_spec) },
      { term: "file_creator", value: stringOr(fkld.file_creator, "—") },
      { term: "file_classes", value: classes.length > 0 ? classes.join(", ") : "—" },
    ],
  };
}

function summarizeTopology(fkld: FkldFile): SummarySection {
  return {
    title: "Topology",
    rows: [
      { term: "vertices_coords", value: String(fkld.vertices_coords?.length ?? 0) },
      { term: "edges_vertices", value: String(fkld.edges_vertices?.length ?? 0) },
      { term: "faces_vertices", value: String(fkld.faces_vertices?.length ?? 0) },
    ],
  };
}

function summarizeAssignments(fkld: FkldFile): SummarySection {
  const breakdown = countBy(fkld.edges_assignment ?? []);
  return {
    title: "edges_assignment",
    rows: ASSIGNMENT_ORDER.map((letter) => ({
      term: `${letter}  ${ASSIGNMENT_LABEL[letter]}`,
      value: String(breakdown.get(letter) ?? 0),
    })),
  };
}

function summarizeCutSubtypes(fkld: FkldFile): SummarySection {
  const raw = fkld["fkld:edges_cutType"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      title: "fkld:edges_cutType",
      rows: [],
      emptyMessage: "Not present.",
    };
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

function summarizeMolecules(fkld: FkldFile): SummarySection {
  const theta = fkld["fkld:edges_moleculeTheta"];
  const width = fkld["fkld:edges_moleculeWidth"];
  const dihedral = fkld["fkld:edges_dihedralTarget"];

  const populated = Array.isArray(theta)
    ? theta.filter((v) => v != null).length
    : 0;
  const sampleTheta = Array.isArray(theta)
    ? (theta.find((v) => typeof v === "number") as number | undefined)
    : undefined;
  const sampleWidth = Array.isArray(width)
    ? (width.find((v) => typeof v === "number") as number | undefined)
    : undefined;
  const dihedralWithTarget = Array.isArray(dihedral)
    ? dihedral.filter((v) => v != null).length
    : 0;

  return {
    title: "Molecules",
    rows: [
      { term: "edges carrying (θ, w)", value: String(populated) },
      {
        term: "θ (uniform sample)",
        value: sampleTheta !== undefined ? formatRadAsDeg(sampleTheta) : "—",
      },
      {
        term: "w (uniform sample, mm)",
        value: sampleWidth !== undefined ? formatNumber(sampleWidth) : "—",
      },
      {
        term: "edges carrying dihedralTarget",
        value: String(dihedralWithTarget),
      },
    ],
  };
}

function summarizeArchitecture(fkld: FkldFile): SummarySection {
  const arch = fkld["fkld:meta_architecture"] as
    | Record<string, unknown>
    | undefined;
  if (!arch || typeof arch !== "object") {
    return {
      title: "fkld:meta_architecture",
      rows: [],
      emptyMessage: "Not present.",
    };
  }
  return {
    title: "fkld:meta_architecture",
    rows: flattenObject(arch).map(([term, value]) => ({ term, value })),
  };
}

function countBy(items: ReadonlyArray<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    out.set(item, (out.get(item) ?? 0) + 1);
  }
  return out;
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix = "",
): [string, string][] {
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
  const deg = (rad * 180) / Math.PI;
  return `${formatNumber(deg)}°`;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function arrayOr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
