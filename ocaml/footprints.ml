(* Footprints, from Neil Gershenfeld's fab-modules [pcb.py].
 *
 * That library is the authority here: its part classes carry the pad sizes and spacings that have actually
 * been cut and stuffed. Each part below quotes the class it came from and keeps the original inches beside
 * the millimetres, so a value can be checked against the source without converting anything by hand.
 *
 * This is a generator, not a runtime. It prints a TypeScript module the app imports, so the numbers live in
 * one place and cross into the app as data. The app's own hot path stays in TypeScript, where it measured
 * faster than either OCaml route to the browser. *)

let mm_of_inch inches = inches *. 25.4

(* ---- The component representation ------------------------------------------------------------------
 *
 * A component is a set of NAMED pads. Each carries an outline of its own, a position on the part, the
 * layers it belongs to, and its pin number:
 *
 *   pad  =  name  x  outline (a closed polygon)  x  position  x  layers  x  index
 *
 * Two things this buys over a width and a height. A pad can be any shape — a rectangle is a special case,
 * and nothing has to be re-modelled when one is not. And a pad has a NAME, so a part's terminals can be
 * addressed as "common" or "A" rather than by their order in a list, which is what the routing actually
 * wants to say.
 *
 * Positions and outlines are authored in inches, as the parts themselves are dimensioned, and emitted in
 * millimetres, which is what the sheet is cut in. Both are printed so either can be checked. *)

type pt = { px : float; py : float }

type cpad = {
  pad_name : string;
  (* Closed polygon about the pad's OWN origin, in inches. First point repeated at the end is not needed. *)
  outline : pt list;
  (* Where the pad sits on the part, in inches, about the part's origin. *)
  at : pt;
  layers : string list;
  index : int;
}

type hole2 = { hat : pt; hr2 : float }

type component = {
  cname : string;
  note : string;
  cpads : cpad list;
  choles : hole2 list;
}

(** A rectangular pad, the common case: [w] by [h] inches about its own centre. *)
let rect_pad w h =
  [ { px = -.w /. 2.0; py = h /. 2.0 };
    { px = w /. 2.0; py = h /. 2.0 };
    { px = w /. 2.0; py = -.h /. 2.0 };
    { px = -.w /. 2.0; py = -.h /. 2.0 } ]

let led_1206_c =
  (* 1206 LED: pads .064 x .068in on .11in centres, anode and cathode. *)
  let o = rect_pad 0.064 0.068 in
  {
    cname = "LED_1206";
    note = "1206 LED";
    cpads =
      [ { pad_name = "A"; outline = o; at = { px = -0.055; py = 0.0 }; layers = [ "F.Cu"; "F.Mask" ]; index = 1 };
        { pad_name = "C"; outline = o; at = { px = 0.055; py = 0.0 }; layers = [ "F.Cu"; "F.Mask" ]; index = 2 } ];
    choles = [];
  }

let r_1206_c =
  (* 1206 resistor: the same pads on .12in centres, unnamed terminals. *)
  let o = rect_pad 0.064 0.068 in
  {
    cname = "R_1206";
    note = "1206 resistor";
    cpads =
      [ { pad_name = "1"; outline = o; at = { px = -0.06; py = 0.0 }; layers = [ "F.Cu"; "F.Mask" ]; index = 1 };
        { pad_name = "2"; outline = o; at = { px = 0.06; py = 0.0 }; layers = [ "F.Cu"; "F.Mask" ]; index = 2 } ];
    choles = [];
  }

let slide_switch_c =
  (* SPDT slide switch: three terminals on .098in centres, .039 x .047in each, and two .034in mounting
     holes at ±.059in.

     One departure from the usual layout, taken from the part in hand: the COMMON is on the opposite edge.
     The usual arrangement puts all three in a row at y = .1. This switch has its two throws on one edge and
     the common alone on the other, which is what lets a rail run straight through the part — in at the
     common on one side, out at a throw on the other — instead of having to detour round it. *)
  let o = rect_pad 0.039 0.047 in
  {
    cname = "slide_switch";
    note = "SPDT slide switch, common on the far edge";
    cpads =
      [ { pad_name = "throw_a"; outline = o; at = { px = -0.098; py = 0.1 }; layers = [ "F.Cu"; "F.Mask" ]; index = 1 };
        { pad_name = "common"; outline = o; at = { px = 0.0; py = -0.1 }; layers = [ "F.Cu"; "F.Mask" ]; index = 2 };
        { pad_name = "throw_b"; outline = o; at = { px = 0.098; py = 0.1 }; layers = [ "F.Cu"; "F.Mask" ]; index = 3 } ];
    choles =
      [ { hat = { px = -0.059; py = 0.0 }; hr2 = 0.034 /. 2.0 };
        { hat = { px = 0.059; py = 0.0 }; hr2 = 0.034 /. 2.0 } ];
  }

let components = [ led_1206_c; r_1206_c; slide_switch_c ]

let mm v = Printf.sprintf "%.4f" (mm_of_inch v)

(* The outline as an SVG path in millimetres — the canonical form — and as points, ready to draw. *)
let path_of outline =
  let seg i p = Printf.sprintf "%s %s,%s" (if i = 0 then "M" else "L") (mm p.px) (mm p.py) in
  String.concat " " (List.mapi seg outline) ^ " Z"

let emit_pad p =
  Printf.printf "    {\n";
  Printf.printf "      name: %S, index: %d, layers: [%s],\n" p.pad_name p.index
    (String.concat "; " (List.map (Printf.sprintf "%S") p.layers) |> String.split_on_char ';'
     |> String.concat ",");
  Printf.printf "      at: { x: %s, y: %s },\n" (mm p.at.px) (mm p.at.py);
  Printf.printf "      shape: %S,\n" (path_of p.outline);
  Printf.printf "      outline: [%s],\n"
    (String.concat ", "
       (List.map (fun q -> Printf.sprintf "{ x: %s, y: %s }" (mm q.px) (mm q.py)) p.outline));
  Printf.printf "    },\n"

let emit_component c =
  Printf.printf "\n/** %s. Generated — see `ocaml/footprints.ml`. */\n" c.note;
  Printf.printf "export const %s_part: Component = {\n" c.cname;
  Printf.printf "  name: %S,\n  note: %S,\n  pads: [\n" c.cname c.note;
  List.iter emit_pad c.cpads;
  Printf.printf "  ],\n  holes: [\n";
  List.iter
    (fun h -> Printf.printf "    { at: { x: %s, y: %s }, r: %s },\n" (mm h.hat.px) (mm h.hat.py) (mm h.hr2))
    c.choles;
  Printf.printf "  ],\n};\n"

let emit_representation () =
  print_string
    "\n\
     /**\n\
     \ * A component: named pads, each with an outline of its own.\n\
     \ *\n\
     \ * A pad is not a width and a height. It is a polygon, so any shape is expressible and a rectangle is\n\
     \ * just the common case; and it has a NAME, so a part's terminals can be addressed as `common` or `A`\n\
     \ * rather than by their position in a list.\n\
     \ *\n\
     \ * Millimetres throughout, which is what the sheet is cut in. `shape` and `outline` are the same\n\
     \ * polygon: a path for anything that wants to draw one directly, points for anything that has to\n\
     \ * measure it.\n\
     \ */\n\
     export interface Pad {\n\
    \  name: string;\n\
    \  index: number;\n\
    \  layers: string[];\n\
    \  /** Where the pad sits on the part, about the part's origin. */\n\
    \  at: { x: number; y: number };\n\
    \  /** The pad's outline about its own origin, as an SVG path. */\n\
    \  shape: string;\n\
    \  /** The same outline, as points. */\n\
    \  outline: { x: number; y: number }[];\n\
     }\n\
     \n\
     export interface Component {\n\
    \  name: string;\n\
    \  note: string;\n\
    \  pads: Pad[];\n\
    \  holes: { at: { x: number; y: number }; r: number }[];\n\
     }\n\
     \n\
     /** A part's pad by name — the terminals are addressed by what they are, not where they sit. */\n\
     export function padNamed(c: Component, name: string): Pad {\n\
    \  const p = c.pads.find((q) => q.name === name);\n\
    \  if (!p) throw new Error(`${c.name} has no pad ${name}`);\n\
    \  return p;\n\
     }\n";
  List.iter emit_component components

type pad = {
  cx : float;      (* centre, inches *)
  cy : float;
  w : float;       (* size, inches *)
  h : float;
  label : string;  (* 'A'/'C' on an LED, empty where the part does not mark its pads *)
}

type hole = { hx : float; hy : float; hr : float }

type part = {
  name : string;
  source : string; (* the pcb.py class, and the manufacturer's part where it names one *)
  pads : pad list;
  holes : hole list;
}

(* [pad_1206 = cube(-.032,.032,-.034,.034,0,0)] *)
let pad_1206 = (0.064, 0.068)

let led_1206 =
  (* class LED_1206: shape at ∓.06, pads at ∓.055, labelled A and C *)
  let w, h = pad_1206 in
  {
    name = "LED_1206";
    source = "pcb.py class LED_1206 - 1206 LED";
    pads =
      [
        { cx = -0.055; cy = 0.0; w; h; label = "A" };
        { cx = 0.055; cy = 0.0; w; h; label = "C" };
      ];
    holes = [];
  }

let r_1206 =
  (* class R_1206: two pads at ±.06, unlabelled *)
  let w, h = pad_1206 in
  {
    name = "R_1206";
    source = "pcb.py class R_1206 - 1206 resistor";
    pads =
      [ { cx = -0.06; cy = 0.0; w; h; label = "" }; { cx = 0.06; cy = 0.0; w; h; label = "" } ];
    holes = [];
  }

let slide_switch =
  (* class slide_switch: pads .039 x .047 at x = -.098, 0, .098 and y = .1;
     holes .034 across at x = ±.118/2, y = 0.

     One deliberate departure from pcb.py, from the part in hand: the COMMON is on the opposite edge.
     pcb.py puts all three pads at y = .1, in a row. The switch being fitted has its two throws on one edge
     and the common alone on the other, which is what lets a rail run straight through the part — in at the
     common on one side, out at a throw on the other — instead of having to detour round it. Pad sizes,
     pitch and mounting holes are the library's untouched. *)
  {
    name = "slide_switch";
    source = "pcb.py class slide_switch - C&K AYZ0102AGRLC (common moved to the far edge)";
    pads =
      [
        { cx = -0.098; cy = 0.1; w = 0.039; h = 0.047; label = "1" };
        { cx = 0.0; cy = -0.1; w = 0.039; h = 0.047; label = "2 common" };
        { cx = 0.098; cy = 0.1; w = 0.039; h = 0.047; label = "3" };
      ];
    holes = [ { hx = -0.118 /. 2.0; hy = 0.0; hr = 0.034 /. 2.0 }; { hx = 0.118 /. 2.0; hy = 0.0; hr = 0.034 /. 2.0 } ];
  }

let parts = [ led_1206; r_1206; slide_switch ]

let f v = Printf.sprintf "%.4f" (mm_of_inch v)

let emit_pad p =
  Printf.sprintf
    "    { cx: %s, cy: %s, w: %s, h: %s, label: %S },"
    (f p.cx) (f p.cy) (f p.w) (f p.h) p.label

let emit_hole h = Printf.sprintf "    { cx: %s, cy: %s, r: %s }," (f h.hx) (f h.hy) (f h.hr)

let emit p =
  Printf.printf "\n/** %s. Generated — see `ocaml/footprints.ml`. */\n" p.source;
  Printf.printf "export const %s: Footprint = {\n" p.name;
  Printf.printf "  name: %S,\n  source: %S,\n" p.name p.source;
  Printf.printf "  pads: [\n";
  List.iter (fun pd -> print_endline (emit_pad pd)) p.pads;
  Printf.printf "  ],\n  holes: [\n";
  List.iter (fun h -> print_endline (emit_hole h)) p.holes;
  Printf.printf "  ],\n};\n"

let () =
  print_string
    "// GENERATED by `ocaml/footprints.ml` — do not edit by hand; run `npm run footprints`.\n\
     //\n\
     // Footprints from fab-modules `pcb.py`, in millimetres. Every value is that library's own, converted\n\
     // from the inches it is authored in: a named part is the size it is, and inventing a footprint shows\n\
     // one that does not exist.\n\n\
     /** A part's copper: pads, and any holes it is mounted through. Millimetres, origin at the part. */\n\
     export interface Footprint {\n\
    \  name: string;\n\
    \  source: string;\n\
    \  pads: { cx: number; cy: number; w: number; h: number; label: string }[];\n\
    \  holes: { cx: number; cy: number; r: number }[];\n\
     }\n";
  List.iter emit parts;
  emit_representation ()
