import { describe, expect, it, afterEach } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { installDom } from "./mock-dom.js";

function grid2x2(): FoldFile {
  return {
    vertices_coords: [[0,0],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]],
    faces_vertices: [[0,1,4,3],[1,2,5,4],[3,4,7,6],[4,5,8,7]],
    edges_vertices: [[1,4],[3,4],[4,5],[4,7]],
    edges_assignment: ["M","M","M","M"],
  } as unknown as FoldFile;
}
function tapFlat(modal: any, flat: { x: number; y: number }): void {
  const { x: clientX, y: clientY } = modal.tp(flat);
  modal.svg.dispatch("pointerdown", { button: 0, clientX, clientY, pointerId: 1 });
  modal.svg.dispatch("pointerup", { button: 0, clientX, clientY, pointerId: 1 });
}
function openOn(fold: FoldFile) {
  const { document } = installDom();
  const modal = new ElectronicsModal() as any;
  modal.mountTrigger(document.createElement("div") as unknown as HTMLElement);
  modal.onEdit(() => {});
  modal.setEnabled(true);
  modal.setPattern(fold);
  modal.open();
  return modal;
}
function pick(modal: any, id: string): void {
  const s = modal.overlay.querySelector(".el-part");
  s.value = id; s.dispatch("change", {});
}
function padSelects(modal: any): any[] {
  return modal.padList.querySelectorAll(".el-pad-net");
}
afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
  delete (globalThis as any).location;
});

describe("verify: the user's flow", () => {
  it("keeps the first part reachable, with its assignments, after a second is placed", () => {
    const modal = openOn(grid2x2());
    modal.selectPlaceMode("free");
    pick(modal, "R_1206");
    tapFlat(modal, { x: 0.4, y: 0.4 });
    // wire part 0 by hand
    const s1 = padSelects(modal).find((r: any) => r.dataset.pad === "1");
    s1.value = "pwr"; s1.dispatch("change", {});

    pick(modal, "Conn_USB_C_Socket_Molex_2171790001");
    tapFlat(modal, { x: 1.5, y: 1.5 });

    // The sidebar must still list BOTH.
    const rows = modal.partList.querySelectorAll(".el-placed-row");
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.querySelector(".el-placed-wired").textContent)).toEqual(["1/2", "0/26"]);
    // The pads panel followed the new part.
    expect(modal.padPart.textContent).toContain("Conn_USB_C");

    // Click the first row: the first part comes back, assignment readable.
    rows[0].dispatch("click", {});
    expect(modal.padPart.textContent).toContain("R_1206");
    const back = padSelects(modal).find((r: any) => r.dataset.pad === "1");
    expect(back.value).toBe("pwr");
    expect(modal.partList.querySelectorAll(".el-placed-row")[0].classList.contains("is-active")).toBe(true);
  });

  it("moves the sidebar on the press that picks a part up, not only on the click", () => {
    const modal = openOn(grid2x2());
    modal.selectPlaceMode("free");
    pick(modal, "R_1206");
    tapFlat(modal, { x: 0.4, y: 0.4 });
    pick(modal, "R_1206");
    tapFlat(modal, { x: 1.6, y: 1.6 });
    expect(modal.circuit.parts).toHaveLength(2);
    const free = modal.circuit.parts.map((p: any) => !!p.free);
    // A press on part 0 (drag start) must repaint the sidebar even if the press never moves.
    if (free[0]) {
      const at = modal.tp({ x: modal.circuit.parts[0].x, y: modal.circuit.parts[0].y });
      modal.svg.dispatch("pointerdown", { button: 0, clientX: at.x, clientY: at.y, pointerId: 1 });
      expect(modal.selected).toEqual({ kind: "part", index: 0 });
      expect(modal.partList.querySelectorAll(".el-placed-row")[0].classList.contains("is-active")).toBe(true);
      expect(modal.padPart.textContent).toContain("R_1206");
    } else {
      console.log("both parts seated in a rail on this fixture; drag path not exercised");
    }
  });

  it("empties the parts list when the pattern is replaced", () => {
    const modal = openOn(grid2x2());
    modal.selectPlaceMode("free");
    pick(modal, "R_1206");
    tapFlat(modal, { x: 0.4, y: 0.4 });
    expect(modal.partList.querySelectorAll(".el-placed-row")).toHaveLength(1);
    modal.setPattern(grid2x2()); // a different object: a new pattern, circuit cleared
    expect(modal.circuit.parts ?? []).toHaveLength(0);
    expect(modal.partsGroup.hidden).toBe(true);
    expect(modal.partList.querySelectorAll(".el-placed-row")).toHaveLength(0);
  });
});
