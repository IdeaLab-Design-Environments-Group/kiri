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

let circle r : poly list =
  let n = 180 in
  let pts =
    List.init n (fun i ->
        let theta = Float.pi *. 2. /. float_of_int n *. float_of_int i in
        (r *. cos theta, r *. sin theta))
  in
  [ pts @ [ List.hd pts ] ]

(** A rounded rectangle, cornered by [rratio] of its shorter side — [1.] rounds it into an oval. *)
let round_rect w h rratio : poly list =
  let per_corner = 10 in
  let radius = Float.min w h *. rratio /. 2. in
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

(** Shortest text that reads back as the same double, so the generated file stays diff-stable and
    does not carry seventeen digits of noise on a number that is exactly 0.03. *)
let fmt (v : float) : string =
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
