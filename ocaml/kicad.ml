(** KiCad footprints, read into the pad representation the rest of the app draws from.

    A [.kicad_mod] file is an s-expression: a [module] whose direct children include one [pad] per
    terminal. This reads those pads and nothing else — no silkscreen, no courtyard, no fabrication
    outline — because a pad is the only part of a footprint that copper tape has to land on.

    Two conversions happen on the way in, and both matter downstream:

    - {b Units.} KiCad is millimetres; the representation is inches, so every coordinate is scaled by
      1/25.4. Consumers convert back at the point of use, which is also where the sheet scale is known.
    - {b Y axis.} KiCad's Y grows downward. It is negated here so a pad above the body has a positive
      y, matching the flat-pattern convention used everywhere else in the model.

    Pad outlines arrive as one of five KiCad shapes and leave as an SVG path, so a pad's geometry is a
    single string whatever it started as and the drawing code has one case instead of five.

    One deliberate departure from the format's usual reading: [np_thru_hole] pads are kept. They are
    not electrical — they are the mechanical holes a part is seated by, the switch's two locating pegs
    for instance — and dropping them would lose the holes we cut. They are marked by carrying no
    copper layer, so anything looking for a terminal still skips them. *)

type sexp = Atom of string | Str of string | L of sexp list

exception Parse_error of string

(** {1 The s-expression reader} *)

let parse (src : string) : sexp =
  let n = String.length src in
  let pos = ref 0 in
  let peek () = if !pos >= n then '\000' else src.[!pos] in
  let is_ws c = c = ' ' || c = '\t' || c = '\n' || c = '\r' in
  let skip_ws () = while !pos < n && is_ws (peek ()) do incr pos done in
  let rec expr () =
    skip_ws ();
    if !pos >= n then raise (Parse_error "unexpected end of input")
    else if peek () = '(' then list_ ()
    else atom ()
  and list_ () =
    incr pos;
    let items = ref [] in
    let rec loop () =
      skip_ws ();
      if !pos >= n then raise (Parse_error "unterminated list")
      else if peek () = ')' then incr pos
      else (
        items := expr () :: !items;
        loop ())
    in
    loop ();
    L (List.rev !items)
  and atom () =
    if peek () = '"' then string_ ()
    else begin
      let b = Buffer.create 16 in
      let rec loop () =
        if !pos >= n then ()
        else
          let c = peek () in
          if is_ws c || c = '(' || c = ')' || c = '"' then ()
          else if c = '\\' then begin
            incr pos;
            if !pos < n then (Buffer.add_char b src.[!pos]; incr pos);
            loop ()
          end
          else (Buffer.add_char b c; incr pos; loop ())
      in
      loop ();
      Atom (Buffer.contents b)
    end
  and string_ () =
    incr pos;
    let b = Buffer.create 16 in
    let rec loop () =
      if !pos >= n then raise (Parse_error "unterminated string literal")
      else
        let c = src.[!pos] in
        if c = '"' then incr pos
        else if c = '\\' then begin
          incr pos;
          if !pos < n then begin
            (match src.[!pos] with
             | 'r' -> Buffer.add_char b '\r'
             | 'n' -> Buffer.add_char b '\n'
             | 't' -> Buffer.add_char b '\t'
             | 'f' -> Buffer.add_char b '\012'
             | 'b' -> Buffer.add_char b '\b'
             | c -> Buffer.add_char b c);
            incr pos
          end;
          loop ()
        end
        else (Buffer.add_char b c; incr pos; loop ())
    in
    loop ();
    Str (Buffer.contents b)
  in
  let e = expr () in
  skip_ws ();
  e

let text = function Atom a -> a | Str s -> s | L _ -> ""
let num s = try float_of_string (text s) with _ -> 0.

(** The tail of the direct child list headed by [name] — [(at 1 2)] under ["at"] gives [1; 2].
    Absent keys read as empty, which is how optional fields such as a rotation stay optional. *)
let named (items : sexp list) (name : string) : sexp list =
  let rec find = function
    | [] -> []
    | L (h :: tail) :: _ when text h = name -> tail
    | _ :: rest -> find rest
  in
  find items

let child (items : sexp list) (name : string) : sexp list option =
  let rec find = function
    | [] -> None
    | (L (h :: _) as e) :: _ when text h = name -> (match e with L l -> Some l | _ -> None)
    | _ :: rest -> find rest
  in
  find items

(** {1 Pad outlines}

    Every shape becomes a list of closed polylines in inches, centred on the pad's own origin. *)

type poly = (float * float) list

let rectangle w h : poly list =
  [ [ (-.w /. 2., h /. 2.); (w /. 2., h /. 2.); (w /. 2., -.h /. 2.);
      (-.w /. 2., -.h /. 2.); (-.w /. 2., h /. 2.) ] ]

(** {2 How finely a curve is tessellated}

    Every arc leaves here as straight chords, so the only question is how far a chord may fall inside
    the true curve. The answer is a length, not a point count: the pads here run from a 1.2mm drill to
    a 17.8mm coin-cell ring, so a count that suits one is either coarse or ruinous on the other.

    [chord_tolerance] is that length — the sagitta, the deepest gap between a chord and the arc it
    replaces. 5µm is chosen against what the geometry is for. A pad is cut out of copper tape on a
    craft cutter: blade kerf is around 0.2mm and repeat positioning around 0.1mm, so the machine
    cannot express 5µm and neither can the tape, which tears at that scale. On screen, a 20mm part
    filling an 800-pixel view puts a pixel at 25µm, so the error is a fifth of one. The tolerance
    therefore sits an order of magnitude below the finest thing either the cutter or the display
    resolves, and two orders below the 0.1mm at which a pad's placement starts to matter.

    For a chord subtending [theta] on a circle of radius [r] the sagitta is exactly r(1 - cos(θ/2)),
    so the widest admissible step is θ_max = 2·acos(1 - tol/r) and an arc of [sweep] radians needs
    ⌈sweep/θ_max⌉ of them. Every pad in the library then costs what its own size asks for: the 1.6mm
    drill pad that dominates the count comes out at 32 chords where 180 used to sit, the smallest circle
    here (1.2mm) at 28, and the 17.8mm coin-cell ring — by far the largest — at 96.

    One floor on top of the arithmetic: never fewer than 16 chords to a full revolution, i.e. 4 to a
    quarter. Below that the chord error stops being what you notice — a corner made of two segments
    reads as a chamfer at any zoom, however small its sagitta — and the small roundrect corners here
    (0.0375mm on the tightest pad, which the sagitta alone would give two segments) do exactly that. *)

let chord_tolerance = 0.005 /. 25.4

(** Chords needed to sweep [sweep] radians on a circle of radius [r] within {!chord_tolerance},
    never fewer than [floor]. *)
let arc_steps ~floor:min_steps r sweep =
  if r <= 0. then min_steps
  else
    let ratio = chord_tolerance /. r in
    if ratio >= 2. then min_steps (* tolerance swallows the whole circle *)
    else
      let theta_max = 2. *. acos (1. -. ratio) in
      Stdlib.max min_steps (int_of_float (Float.ceil (sweep /. theta_max)))

(** A circle, tessellated a quarter at a time so the count is always a multiple of four.

    That is not tidiness. A vertex on each axis is what makes the polygon's bounding box exactly the
    pad's own size, and the bounding box is what everything downstream reads a pad's dimensions from —
    the router's pitch, the pad the copper is scaled onto. Left to the raw count, a 17.8mm ring came
    out at 94 chords with no vertex at the top, so its box was 5µm short in y and 0 in x, and drawing
    it into a square turned that into a visible ellipse. Four extra chords buy an exact box. *)
let circle r : poly list =
  let n = 4 * arc_steps ~floor:4 r (Float.pi /. 2.) in
  let pts =
    List.init n (fun i ->
        let theta = Float.pi *. 2. /. float_of_int n *. float_of_int i in
        (r *. cos theta, r *. sin theta))
  in
  [ pts @ [ List.hd pts ] ]

(** KiCad's trapezoid: a rectangle whose two opposite sides are shortened by [(rect_delta dx dy)],
    which is how a pad is drawn to fan out towards a package's corner. Following KiCad's own
    [TransformTrapezoidToPolygon], with half-sizes [hw]/[hh] and half-deltas [ddx]/[ddy] the corners
    are (-hw ± ddy, ±hh ± ddx) — [dx] tilts the left and right edges, leaving the pad taller at -x
    and shorter at +x, and [dy] tilts the top and bottom the same way. Zero deltas reduce to exactly
    {!rectangle}, corner for corner, which is the only case the vendored library actually contains:
    its two trapezoid pads (in [Sensor_Optical_ST_VL53L5CXV0GC]) carry no [rect_delta] at all, so the
    sign convention above is taken from KiCad's source rather than confirmed against a file here. *)
let trapezoid w h dx dy : poly list =
  let hw = w /. 2. and hh = h /. 2. and ddx = dx /. 2. and ddy = dy /. 2. in
  (* Listed from the top-left corner and negated into the y-up frame, so the winding and the starting
     corner match {!rectangle}. *)
  let pts =
    [ (-.hw +. ddy, hh +. ddx); (hw -. ddy, hh -. ddx);
      (hw +. ddy, -.hh +. ddx); (-.hw -. ddy, -.hh -. ddx) ]
  in
  [ pts @ [ List.hd pts ] ]

(** A rounded rectangle, cornered by [rratio] of its shorter side — [1.] rounds it into an oval. *)
let round_rect w h rratio : poly list =
  let radius = Float.min w h *. rratio /. 2. in
  let per_corner = arc_steps ~floor:4 radius (Float.pi /. 2.) + 1 in
  let corner (cx, cy) f =
    List.init per_corner (fun i ->
        let angle = Float.pi /. 2. *. float_of_int i /. float_of_int (per_corner - 1) in
        f cx cy radius angle)
  in
  let tl = (-.w /. 2. +. radius, -.h /. 2. +. radius) in
  let tr = (w /. 2. -. radius, -.h /. 2. +. radius) in
  let br = (w /. 2. -. radius, h /. 2. -. radius) in
  let bl = (-.w /. 2. +. radius, h /. 2. -. radius) in
  let pts =
    corner tl (fun cx cy r a -> (cx -. r *. cos a, cy -. r *. sin a))
    @ corner tr (fun cx cy r a -> (cx +. r *. sin a, cy -. r *. cos a))
    @ corner br (fun cx cy r a -> (cx +. r *. cos a, cy +. r *. sin a))
    @ corner bl (fun cx cy r a -> (cx -. r *. sin a, cy +. r *. cos a))
  in
  [ pts @ [ List.hd pts ] ]

let rotate_shape (shape : poly list) (deg : float) : poly list =
  if deg = 0. then shape
  else
    let d = deg /. 180. *. Float.pi in
    List.map
      (List.map (fun (x, y) -> ((x *. cos d) -. (y *. sin d), (y *. cos d) +. (x *. sin d))))
      shape

(** {1 Emission} *)

(** The grid every emitted length is snapped to, in inches.

    Shortest-round-trip alone is not enough. A coordinate that came out of a cosine is irrational, so
    the shortest text that reads back as the same double is all seventeen digits of it —
    [-0.02755905511811024] to say "0.7mm". Across the library that is most of the generated file, and
    the file is parsed on every page load.

    So the number is snapped first, and the grid follows the same argument as {!chord_tolerance}: an
    outline already carries up to 5µm of tessellation error, and the grid must be negligible against
    that rather than merely small. At one percent of the budget the snapping may move a point by at
    most 50nm, so the step is at most 100nm — 3.9e-6 inch, rounded down to a decimal 1e-6. That is a
    12.7nm half-step: a quarter of one percent of the chord budget, four thousand times finer than a
    craft cutter can position, and about a tenth the wavelength of visible light. Nothing downstream
    can tell the difference, and the coordinate above becomes [-0.027559].

    The grid is written as a divisor rather than a step, because a rounded value has to be reached by
    {i dividing} by the power of ten: division is correctly rounded, so [39370. /. 1e6] is the same
    double the decimal literal [0.03937] parses to, and the shortest-round-trip search below then
    finds those five digits. Multiplying by [1e-6] lands an ulp away and the search prints all
    seventeen digits again. *)
let coordinate_grid = 1e6

(** Shortest text that reads back as the same point on {!coordinate_grid}, so the generated file stays
    diff-stable and does not carry seventeen digits of noise on a number that is exactly 0.03. *)
let fmt (v : float) : string =
  let v = Float.round (v *. coordinate_grid) /. coordinate_grid in
  let v = if v = 0. then 0. else v in
  let rec try_prec p =
    if p > 17 then Printf.sprintf "%.17g" v
    else
      let s = Printf.sprintf "%.*g" p v in
      if float_of_string s = v then s else try_prec (p + 1)
  in
  try_prec 1

let path_d (shape : poly list) : string =
  let b = Buffer.create 128 in
  List.iter
    (fun poly ->
      List.iteri
        (fun i (x, y) ->
          Buffer.add_string b (Printf.sprintf "%s %s %s " (if i = 0 then "M" else "L") (fmt x) (fmt y)))
        poly)
    shape;
  Buffer.contents b

(** {1 The representation} *)

type drill = { diameter : float; start_layer : string; end_layer : string; plated : bool }

type pad = {
  shape : string;  (** the outline as an SVG path, inches, about the pad's own origin *)
  pos : float * float;  (** where that origin sits in the footprint, inches, y up *)
  layers : string list;
  index : int;  (** order of first appearance, 1-based — a stable id for a pad name *)
  drill : drill option;
}

type footprint = (string * pad) list

let scale = 1. /. 25.4

(** [*.Cu] means both sides, so it expands to the two real layers rather than staying a wildcard the
    consumers would each have to understand. *)
let convert_layers (layers : string list) : string list =
  List.concat_map
    (fun l ->
      match String.index_opt l '.' with
      | Some i when String.sub l 0 i = "*" ->
          let suffix = String.sub l (i + 1) (String.length l - i - 1) in
          [ "F." ^ suffix; "B." ^ suffix ]
      | _ -> [ l ])
    layers

let of_string (src : string) : footprint =
  let top = match parse src with L items -> items | _ -> [] in
  (* Pads accumulate under their KiCad name; a name used more than once (a split pad, a pair of
     mounting holes both called "") keeps the first and suffixes the rest. *)
  let acc : (string * pad list ref) list ref = ref [] in
  let push name p =
    match List.assoc_opt name !acc with
    | Some l -> l := p :: !l
    | None -> acc := !acc @ [ (name, ref [ p ]) ]
  in
  List.iter
    (fun line ->
      match line with
      | L (head :: name_s :: kind_s :: shape_s :: _) when text head = "pad" ->
          let items = match line with L l -> l | _ -> [] in
          let kind = text kind_s in
          if kind = "smd" || kind = "thru_hole" || kind = "np_thru_hole" then begin
            let name = text name_s in
            let at_raw = named items "at" in
            let at =
              match at_raw with
              | x :: y :: _ -> (num x *. scale, -.(num y *. scale))
              | _ -> (0., 0.)
            in
            let rotate = match at_raw with _ :: _ :: r :: _ -> num r | _ -> 0. in
            (* A mechanical hole carries no copper, which is what marks it as not a terminal. *)
            let layers =
              if kind = "np_thru_hole" then [ "outline"; "Thru.Hole" ]
              else convert_layers (List.map text (named items "layers"))
            in
            let size = List.map (fun s -> num s *. scale) (named items "size") in
            let w = match size with w :: _ -> w | [] -> 0. in
            let h = match size with _ :: h :: _ -> h | _ -> w in
            let geometry =
              match text shape_s with
              | "rect" -> rectangle w h
              | "roundrect" ->
                  let ratio = match named items "roundrect_rratio" with r :: _ -> num r | [] -> 0. in
                  round_rect w h ratio
              | "trapezoid" ->
                  let dx, dy =
                    match named items "rect_delta" with
                    | x :: y :: _ -> (num x *. scale, num y *. scale)
                    | _ -> (0., 0.)
                  in
                  trapezoid w h dx dy
              | "circle" -> circle (w /. 2.)
              | "oval" -> round_rect w h 1.
              | "custom" -> (
                  (* The outline lives in the first primitive's polygon point list. *)
                  match child items "primitives" with
                  | Some (_ :: L prim :: _) -> (
                      match child prim "pts" with
                      | Some (_ :: pts) ->
                          [ List.filter_map
                              (function
                                | L (_ :: x :: y :: _) -> Some (num x *. scale, -.(num y *. scale))
                                | _ -> None)
                              pts ]
                      | _ -> [])
                  | _ -> [])
              | other ->
                  prerr_endline ("kicad: unhandled pad shape " ^ other);
                  []
            in
            let geometry = rotate_shape geometry rotate in
            let drill_line = child items "drill" in
            let drill =
              match drill_line with
              | Some (_ :: d :: _) when text d <> "oval" && float_of_string_opt (text d) <> None ->
                  Some
                    { diameter = num d *. scale; start_layer = "F.Cu"; end_layer = "B.Cu"; plated = true }
              | _ -> None
            in
            (* An oval drill is a slot, not a hole: it is emitted as its own cut outline alongside
               the pad, because no single diameter describes it. *)
            (match drill_line with
             | Some (_ :: d :: w_s :: h_s :: _) when text d = "oval" ->
                 let slot = rotate_shape (round_rect (num w_s *. scale) (num h_s *. scale) 1.) rotate in
                 push (name ^ "_plated_cut")
                   { shape = path_d slot; pos = at; layers = [ "outline"; "Thru.Hole" ]; index = 0; drill = None }
             | _ -> ());
            push name { shape = path_d geometry; pos = at; layers; index = 0; drill }
          end
      | _ -> ())
    top;
  (* Flatten, suffixing repeats, and number the pads in the order they were first seen. *)
  let out = ref [] in
  List.iter
    (fun (name, pads) ->
      match List.rev !pads with
      | [ single ] -> out := (name, single) :: !out
      | many ->
          List.iteri
            (fun i p -> out := ((if i = 0 then name else Printf.sprintf "%s_%d" name i), p) :: !out)
            many)
    !acc;
  (* KiCad lists pads in whatever order the footprint was drawn — often backwards. Numbered pads are
     put back in their own order so pad 1 is first, and everything unnumbered (mechanical holes, whose
     KiCad name is empty) follows in declaration order. Sorting here is what makes [index] mean the
     same thing for every part. *)
  let ordered =
    List.rev !out
    |> List.mapi (fun i named -> (i, named))
    |> List.stable_sort (fun (i, (a, _)) (j, (b, _)) ->
           match (int_of_string_opt a, int_of_string_opt b) with
           | Some x, Some y -> compare x y
           | Some _, None -> -1
           | None, Some _ -> 1
           | None, None -> compare i j)
    |> List.map snd
  in
  List.mapi (fun i (name, p) -> (name, { p with index = i + 1 })) ordered

let of_file (path : string) : footprint =
  let ic = open_in_bin path in
  let len = in_channel_length ic in
  let s = really_input_string ic len in
  close_in ic;
  of_string s
