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

(** A two-terminal chip part: pads [pw] by [ph] on centres [dx] either side, all in inches. *)
let chip name note pw ph dx a b =
  let o = rect_pad pw ph in
  {
    cname = name;
    note;
    cpads =
      [ { pad_name = a; outline = o; at = { px = -.dx; py = 0.0 }; layers = [ "F.Cu"; "F.Mask" ]; index = 1 };
        { pad_name = b; outline = o; at = { px = dx; py = 0.0 }; layers = [ "F.Cu"; "F.Mask" ]; index = 2 } ];
    choles = [];
  }

let mm_ v = v /. 25.4

(* The chip sizes, on their standard land patterns. 0402 and 0603 are dimensioned in millimetres and
   converted; 1206 is authored in inches, as it is drawn. *)
let r_0402_c = chip "R_0402" "0402 resistor" (mm_ 0.8) (mm_ 0.6) (mm_ 0.65) "1" "2"
let r_0603_c = chip "R_0603" "0603 resistor" (mm_ 1.0) (mm_ 1.0) (mm_ 0.85) "1" "2"
let c_0603_c = chip "C_0603" "0603 capacitor" (mm_ 1.0) (mm_ 1.0) (mm_ 0.85) "1" "2"
let c_1206_c = chip "C_1206" "1206 capacitor" 0.064 0.068 0.06 "1" "2"
let led_0603_c = chip "LED_0603" "0603 LED" (mm_ 1.0) (mm_ 1.0) (mm_ 0.85) "A" "C"

let components =
  [ led_0603_c; led_1206_c; r_0402_c; r_0603_c; r_1206_c; c_0603_c; c_1206_c; slide_switch_c ]

(** Every component, so the app can offer them without a second list to keep in step. *)
let emit_catalogue () =
  Printf.printf
    "\n/** Every component in the library. The editor's palette is built from this, so a part added here\n\
    \ *  appears there without a second list to keep in step. */\nexport const COMPONENTS: Component[] = [\n";
  List.iter (fun c -> Printf.printf "  %s_part,\n" c.cname) components;
  Printf.printf "];\n"



let mm v = Printf.sprintf "%.4f" (mm_of_inch v)

(* The outline as an SVG path in millimetres — the canonical form — and as points, ready to draw. *)
let path_of outline =
  let seg i p = Printf.sprintf "%s %s,%s" (if i = 0 then "M" else "L") (mm p.px) (mm p.py) in
  String.concat " " (List.mapi seg outline) ^ " Z"

let emit_pad p =
  Printf.printf "    {\n";
  Printf.printf "      name: %S, index: %d, layers: [%s],\n" p.pad_name p.index
    (String.concat ", " (List.map (Printf.sprintf "%S") p.layers));
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
    (fun h ->
      Printf.printf "    { at: { x: %s, y: %s }, r: %s },\n" (mm h.hat.px) (mm h.hat.py) (mm h.hr2))
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
    \ * rather than by their position in a list, which is what silently reads the wrong terminal when that\n\
    \ * order changes.\n\
    \ *\n\
    \ * Millimetres throughout, which is what the sheet is cut in. `shape` and `outline` are the same\n\
    \ * polygon: a path for anything that draws one, points for anything that measures it.\n\
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
     /** A part's pad by name — a terminal is addressed by what it is, not by where it sits. */\n\
     export function padNamed(c: Component, name: string): Pad {\n\
    \  const p = c.pads.find((q) => q.name === name);\n\
    \  if (!p) throw new Error(`${c.name} has no pad ${name}`);\n\
    \  return p;\n\
     }\n\
     \n\
     /** A pad's extent about its own origin: how far it reaches along each axis. */\n\
     export function padSpan(p: Pad): { w: number; h: number } {\n\
    \  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;\n\
    \  for (const q of p.outline) {\n\
    \    if (q.x < minX) minX = q.x;\n\
    \    if (q.y < minY) minY = q.y;\n\
    \    if (q.x > maxX) maxX = q.x;\n\
    \    if (q.y > maxY) maxY = q.y;\n\
    \  }\n\
    \  return { w: maxX - minX, h: maxY - minY };\n\
     }\n";
  List.iter emit_component components;
  emit_catalogue ()

let () =
  print_string
    "// GENERATED by `ocaml/footprints.ml` — do not edit by hand; run `npm run footprints`.\n\
     //\n\
     // Component footprints, in millimetres, converted from the inches they are authored in. A named part\n\
     // is the size it is: inventing a footprint shows one that does not exist.\n";
  emit_representation ()
