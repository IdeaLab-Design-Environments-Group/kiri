(** Generates [src/model/footprints.generated.ts] from the vendored KiCad footprints.

    The component library is not written by hand. Pad sizes and pitches are the part's, taken from its
    manufacturer's own footprint file, so a number in the app is a number from a datasheet rather than
    one somebody measured off a drawing. Twice already a switch pitch was wrong here — 2.54mm assumed
    from a package name, then 2.5mm read off a datasheet page — and both times the file said 2.5mm
    exactly. Reading the file is the fix.

    The library is no longer a list either. [footprints/fab/] holds the vendored KiCad FabLib, and every
    [.kicad_mod] in it is emitted, so adding a part is dropping a file in that directory. Two things
    therefore have to be derived rather than typed: what to call each part, and what to say about it.

    Run with [npm run footprints]. The output is committed so the app builds without OCaml. *)

let dir = "../footprints/fab/"

(** {1 Ids}

    An id is a TypeScript identifier, so it is the filename with every character that cannot appear in
    one replaced by [_], runs of those collapsed, and a leading [_] if the result would start with a
    digit. That is a rule rather than a table, which is the point: a new file needs no code change, and
    the id it gets is predictable from its name.

    [LED_1206.kicad_mod] is already an identifier and comes through untouched; so do [R_1206], [C_1206]
    and [R_2010]. The three below are aliased because the app and its tests already name those parts,
    and no rule over [Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm] reaches [SW_SPDT]. An alias
    replaces the derived id rather than adding a second export, so each footprint still has exactly one
    name. *)
let aliases =
  [ ("Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm", "SW_SPDT");
    ("Button_CnK_PTS636.0_6x3.5mm", "SW_PUSH");
    ("Battery-Holder_Coin-Cell_CR2032_Linx_BAT-HLD-001", "BAT_COIN_20") ]

let is_ident_char c =
  (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c = '_'

let derive_id (stem : string) : string =
  let b = Buffer.create (String.length stem) in
  String.iter
    (fun c ->
      if is_ident_char c && c <> '_' then Buffer.add_char b c
      else if Buffer.length b > 0 && Buffer.nth b (Buffer.length b - 1) <> '_' then
        Buffer.add_char b '_')
    stem;
  let s = Buffer.contents b in
  let n = String.length s in
  let s = if n > 0 && s.[n - 1] = '_' then String.sub s 0 (n - 1) else s in
  if s = "" then "part"
  else if s.[0] >= '0' && s.[0] <= '9' then "_" ^ s
  else s

let id_of (stem : string) : string =
  match List.assoc_opt stem aliases with Some a -> a | None -> derive_id stem

(** {1 Notes}

    A note is what the palette shows, so it has to read like a part and not like a path. The footprint's
    own [descr] is that sentence where it has one; [tags] is the fallback, because half the files whose
    [descr] is only a datasheet URL still tag themselves "switch spdt right angle slide". A bare URL is
    not a description of anything, so it is stripped out wherever it appears and what is left of the
    prose is kept. With neither field there is nothing to read but the filename, which at least becomes
    words. *)

let collapse_ws (s : string) : string =
  let b = Buffer.create (String.length s) in
  let space = ref true in
  String.iter
    (fun c ->
      let c = if c = '\n' || c = '\r' || c = '\t' then ' ' else c in
      if c = ' ' then (if not !space then Buffer.add_char b ' ');
      if c <> ' ' then Buffer.add_char b c;
      space := c = ' ')
    s;
  let s = Buffer.contents b in
  let n = String.length s in
  if n > 0 && s.[n - 1] = ' ' then String.sub s 0 (n - 1) else s

let starts_with prefix s =
  String.length s >= String.length prefix && String.sub s 0 (String.length prefix) = prefix

(** A word is a URL once any bracket or quote it opens with is set aside — one FabLib [descr] reads
    "TQFP, 144 Pin (http://…), generated with …", and the parenthesis must not save the link. *)
let is_url (w : string) : bool =
  let i = ref 0 in
  while
    !i < String.length w
    && match w.[!i] with '(' | '[' | '<' | '"' | '\'' -> true | _ -> false
  do
    incr i
  done;
  let w = String.sub w !i (String.length w - !i) in
  starts_with "http://" w || starts_with "https://" w

let strip_urls (s : string) : string =
  String.split_on_char ' ' s |> List.filter (fun w -> not (is_url w)) |> String.concat " "

(** Trailing punctuation left behind once a URL is taken out of the middle of a sentence. *)
let tidy (s : string) : string =
  let n = ref (String.length s) in
  while !n > 0 && (match s.[!n - 1] with ' ' | ',' | ';' | ':' | '-' | '(' -> true | _ -> false) do
    decr n
  done;
  let s = String.sub s 0 !n in
  let i = ref 0 in
  while !i < String.length s && s.[!i] = ' ' do incr i done;
  String.sub s !i (String.length s - !i)

(** The filename as words. Only [_] becomes a space: a hyphen in a FabLib name is part of a word
    ("Coin-Cell", "BAT-HLD-001") and taking it out reads worse than leaving it in. *)
let humanise (stem : string) : string =
  String.map (fun c -> if c = '_' then ' ' else c) stem |> collapse_ws

let note_of (stem : string) (top : Kicad.sexp list) : string =
  let field name =
    match Kicad.named top name with v :: _ -> collapse_ws (Kicad.text v) | [] -> ""
  in
  let descr = tidy (collapse_ws (strip_urls (field "descr"))) in
  let tags = tidy (field "tags") in
  if descr <> "" then descr else if tags <> "" then tags else humanise stem

(** {1 Emission} *)

let quote s =
  let b = Buffer.create (String.length s + 2) in
  Buffer.add_char b '"';
  String.iter
    (fun c ->
      match c with
      | '"' -> Buffer.add_string b "\\\""
      | '\\' -> Buffer.add_string b "\\\\"
      | '\n' -> Buffer.add_string b "\\n"
      | '\r' -> Buffer.add_string b "\\r"
      | '\t' -> Buffer.add_string b "\\t"
      | c -> Buffer.add_char b c)
    s;
  Buffer.add_char b '"';
  Buffer.contents b

(** A note goes into a doc comment as well as a string, and one [*/] in a datasheet blurb would end the
    comment early and leave the rest of the file as code. *)
let comment_safe (s : string) : string =
  let b = Buffer.create (String.length s) in
  String.iteri
    (fun i c ->
      if c = '/' && i > 0 && s.[i - 1] = '*' then Buffer.add_string b " /" else Buffer.add_char b c)
    s;
  Buffer.contents b

(** {1 Which half a part is emitted into}

    All 159 parts are emitted, but only some of them into the module the app imports eagerly. A rail
    can pass through two terminals, or three where it steps across the part; a forty-pin connector has
    no meaning spliced into a run of copper tape, and the whole library in the main bundle is a
    megabyte of pad outlines for parts nobody can place. So the placeable ones are emitted into
    [footprints.generated.ts] and the rest into [footprints.rest.generated.ts], which the palette pulls
    in on demand.

    This repeats a decision that already lives in [placement()] in [src/model/parts.ts], which is a
    thing to be uneasy about — this codebase has been bitten once by two readings of a footprint
    disagreeing. The reason it is allowed here and not there: if the two disagree the only consequence
    is that a part loads from the slower half. The palette calls [placement()] on both lists and never
    consults the split, so nothing becomes unreachable and nothing is miscut. It is a bundling hint,
    not a fact about the part — and [footprints.test.ts] asserts the two agree over all 159 so that a
    drift is loud rather than quietly expensive.

    A terminal is a pad on copper whose name is not empty and is not the parser's [_1] suffix for a
    repeat of an unnamed one, which is [isTerminal] in [footprint.ts] read back into OCaml. *)

let is_terminal (name, (p : Kicad.pad)) =
  let copper = List.exists (fun l -> l = "F.Cu" || l = "B.Cu") p.layers in
  let suffix_of_unnamed =
    String.length name > 1 && name.[0] = '_'
    && String.for_all (fun c -> c >= '0' && c <= '9') (String.sub name 1 (String.length name - 1))
  in
  copper && name <> "" && not suffix_of_unnamed

let max_in_series = 3

let placeable (pads : Kicad.footprint) =
  let n = List.length (List.filter is_terminal pads) in
  n >= 2 && n <= max_in_series

type entry = { file : string; id : string; note : string; pads : Kicad.footprint }

let emit_pad (name, (p : Kicad.pad)) =
  let x, y = p.pos in
  Printf.printf "  %s: {\n" (quote name);
  Printf.printf "    shape: %s,\n" (quote p.shape);
  Printf.printf "    pos: [%s, %s],\n" (Kicad.fmt x) (Kicad.fmt y);
  Printf.printf "    layers: [%s],\n" (String.concat ", " (List.map quote p.layers));
  Printf.printf "    index: %d,\n" p.index;
  (match p.drill with
   | Some d ->
       Printf.printf "    drill: { diameter: %s, start: %s, end: %s, plated: %b },\n"
         (Kicad.fmt d.diameter) (quote d.start_layer) (quote d.end_layer) d.plated
   | None -> ());
  print_string "  },\n"

let emit_component e =
  Printf.printf "\n/** %s — from `%s`. */\n" (comment_safe e.note) e.file;
  Printf.printf "export const %s: Footprint = {\n" e.id;
  List.iter emit_pad e.pads;
  print_string "};\n"

let emit_header () =
  print_string
    {|/**
 * **Model** — the component library.
 *
 * GENERATED by `npm run footprints` from the KiCad footprints in `footprints/fab/`, which is the
 * vendored KiCad FabLib. Do not edit: drop a .kicad_mod in that directory, or change
 * `ocaml/footprints.ml`, and regenerate. Every file in the directory is emitted, so there is no list
 * here to fall out of step with what is on disk.
 *
 * The FabLib is 159 footprints and about a megabyte of pad outlines, which is four times the rest of
 * the app. Most of it is parts a rail cannot pass through — a forty-pin connector has no meaning
 * spliced into a run of copper tape — so this module holds only the ones that can be placed, and
 * `footprints.rest.generated.ts` holds the others for the palette to pull in on demand. That split is
 * a bundling decision and nothing more: whether a part can be placed is `placement()` in `parts.ts`,
 * which is asked about parts from both halves.
 *
 * A footprint is its pads, keyed by the pad name the part's own datasheet uses. Each pad carries its
 * outline as an SVG path about its own origin, where that origin sits in the part, which layers it
 * belongs to, and a drill if it is a hole. Coordinates are inches with y up — see `ocaml/kicad.ml`
 * for why, and `footprint.ts` for the helpers that read them.
 *
 * Whether a part can actually go in series on a rail is NOT recorded here. It is read off the pads by
 * `placement()` in `parts.ts`, which is the same reading `acrossPart` and `partFit` already do; a
 * second copy of that decision in generated data is a second copy to drift.
 */

/** A hole through the board, as opposed to a pad on it. */
export interface Drill {
  diameter: number;
  start: string;
  end: string;
  plated: boolean;
}

/** One terminal — or, with no copper layer, one mechanical hole. */
export interface Pad {
  /** The outline as an SVG path, inches, about this pad's own origin. */
  shape: string;
  /** Where that origin sits in the footprint, inches, y up. */
  pos: [number, number];
  layers: string[];
  /** The part's own pad number, 1-based. */
  index: number;
  drill?: Drill;
}

/** A part, as its pads. */
export type Footprint = Record<string, Pad>;

/** A library entry: the footprint plus what to call it. */
export interface Component {
  id: string;
  /** What the part is, in the words of its own footprint file's `descr` or `tags`. */
  note: string;
  footprint: Footprint;
}
|}

(** The other half's preamble. It takes its types from the eager module rather than restating them, so
    there is one `Component` in the app and a part from either list is the same kind of thing. *)
let emit_rest_header () =
  print_string
    {|/**
 * **Model** — the rest of the component library.
 *
 * GENERATED by `npm run footprints`. Do not edit — see `footprints.generated.ts`, which holds the
 * types, the parts a rail can pass through, and the reason there are two files.
 *
 * These are the parts that cannot go in series on a rail: everything with one terminal and nothing to
 * bridge, and everything with four or more, which a run of copper tape has no way through. They are
 * emitted so the palette can show them and say why it will not place them, rather than leaving a user
 * hunting for a USB socket to conclude the app is broken. Reach them with a dynamic `import()`; a
 * megabyte of pad outlines has no business in the main bundle.
 *
 * Membership of this file is a bundling decision, not a fact about a part. `placement()` in `parts.ts`
 * is the only thing that decides what can be placed, and it is asked about parts from both halves.
 */
import type { Component, Footprint } from "./footprints.generated.js";
|}

let emit_catalogue name doc library =
  Printf.printf "\n/** %s */\n" doc;
  Printf.printf "export const %s: Component[] = [\n" name;
  List.iter
    (fun e ->
      Printf.printf "  { id: %s, note: %s, footprint: %s },\n" (quote e.id) (quote e.note) e.id)
    library;
  print_string "];\n"

(** {1 The scan} *)

let ends_with suffix s =
  String.length s >= String.length suffix
  && String.sub s (String.length s - String.length suffix) (String.length suffix) = suffix

(** Every [.kicad_mod] in the directory, in filename order so the output does not depend on the order
    the filesystem happens to hand them back. Anything else in there — the FabLib's LICENSE — is skipped
    rather than guessed at. *)
let scan () : entry list =
  let files = Sys.readdir dir in
  Array.sort compare files;
  let taken = Hashtbl.create 256 in
  Array.to_list files
  |> List.filter (ends_with ".kicad_mod")
  |> List.map (fun file ->
         let stem = Filename.remove_extension file in
         let src =
           let ic = open_in_bin (dir ^ file) in
           let len = in_channel_length ic in
           let s = really_input_string ic len in
           close_in ic;
           s
         in
         let top = match Kicad.parse src with Kicad.L items -> items | _ -> [] in
         (* Two files could sanitise onto the same identifier. None in the FabLib do, but a suffix is
            cheaper than a build that emits the same const twice and fails to compile. *)
         let base = id_of stem in
         let id = ref base in
         let n = ref 1 in
         while Hashtbl.mem taken !id do
           incr n;
           id := Printf.sprintf "%s_%d" base !n
         done;
         Hashtbl.add taken !id ();
         { file; id = !id; note = note_of stem top; pads = Kicad.of_string src })
  |> List.sort (fun a b -> compare a.id b.id)

(** Two modules out of one scan, chosen by argv so [build.sh] can write each through its own temp file
    and neither can be half-written by a run that fails. *)
let () =
  let library = scan () in
  let placeable, rest = List.partition (fun e -> placeable e.pads) library in
  match if Array.length Sys.argv > 1 then Sys.argv.(1) else "" with
  | "rest" ->
      emit_rest_header ();
      List.iter emit_component rest;
      emit_catalogue "REST_COMPONENTS"
        "The parts a rail cannot pass through, by id — offered, but not placeable." rest
  | _ ->
      emit_header ();
      List.iter emit_component placeable;
      emit_catalogue "COMPONENTS"
        "Every part a rail can take, by id. Whether it can is `placement()`'s to say, not this list's."
        placeable
