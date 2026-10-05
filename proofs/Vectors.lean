import Lean.Data.Json
import Proofs

/-!
`lake exe vectors` writes the test vectors in proofs/vectors/. Each one runs a proved
model on a deterministic input; tests/proofs.test.ts runs the TypeScript on the same input
and expects the same output, and checks the source still contains every anchored snippet.
-/

open Lean (Json ToJson toJson)

namespace Vectors

/-- A deterministic pseudo-random sequence, so regenerating gives identical files. -/
def lcg (seed : Nat) : Nat := (seed * 1103515245 + 12345) % 2147483648

def pick (seed : Nat) (xs : List α) (default : α) : α := xs.getD (seed % xs.length) default

/-- Byte length of JSON.stringify(s) for a string, with the JavaScript escapes. -/
def jsonStringBytes (s : String) : Nat :=
  2 + s.toList.foldl (fun n c =>
    n + if c = '"' ∨ c = '\\' ∨ c = '\n' ∨ c = '\r' ∨ c = '\t' ∨ c.toNat = 8 ∨ c.toNat = 12 then 2
      else if c.toNat < 32 then 6 else c.utf8Size) 0

def jsonNatBytes (n : Nat) : Nat := (toString n).length

def jsonArrayBytes (xs : List String) : Nat :=
  2 + (xs.map jsonStringBytes).sum + (xs.length - 1)

def obj (fields : List (String × Json)) : Json := Json.mkObj fields

def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

def nats (xs : List Nat) : Json := Json.arr (xs.map fun n => toJson n).toArray

def write (name : String) (cases : List Json) : IO Unit := do
  IO.FS.createDirAll "vectors"
  IO.FS.writeFile s!"vectors/{name}.json" ((Json.arr cases.toArray).pretty 100 ++ "\n")

/-! ### truncateUtf8 -/

def truncateCases : List Json := Id.run do
  let texts := ["", "hello", "héllo wörld", "€ euro €€", "emoji 😀 mix 😀😀!", "日本語のテキスト", "aé€😀aé€😀"]
  let mut out := []
  for text in texts do
    let bs := text.toUTF8.toList
    for maxBytes in List.range (bs.length + 2) do
      let cut := Proofs.Truncate.truncate bs maxBytes
      let expected := String.fromUTF8! (ByteArray.mk cut.toArray)
      out := out ++ [obj [("text", .str text), ("maxBytes", toJson maxBytes), ("expected", .str expected)]]
  return out

/-! ### fitFilterableMetadata -/

/-- The required fields every vector carries, as JSON and with their byte size. -/
def requiredFields : List (String × Json) :=
  [("documentId", .str "doc_0d1e"), ("userId", .str "user-7"), ("chunkId", .str "chunk_doc_0d1e_12"),
   ("modality", .str "text"), ("embeddingModel", .str "us.cohere.embed-v4:0"),
   ("pageStart", toJson (3 : Nat)), ("pageEnd", toJson (4 : Nat)), ("tokenCount", toJson (700 : Nat))]

def requiredBytes : List Nat :=
  [jsonStringBytes "doc_0d1e", jsonStringBytes "user-7", jsonStringBytes "chunk_doc_0d1e_12",
   jsonStringBytes "text", jsonStringBytes "us.cohere.embed-v4:0", 1, 1, 3]

/-- The filterable size of a record: `{` entries `}`, each `"key":value`, comma separated. -/
def metaBytes (m : Proofs.Metadata.Meta) : Nat :=
  let entries : List Nat :=
    (requiredFields.zip requiredBytes).map (fun (f, b) => jsonStringBytes f.1 + 1 + b) ++
    (m.sourceKey.toList.map fun v => jsonStringBytes "sourceKey" + 1 + jsonStringBytes v) ++
    (m.title.toList.map fun v => jsonStringBytes "title" + 1 + jsonStringBytes v) ++
    (m.tags.toList.map fun v => jsonStringBytes "tags" + 1 + jsonArrayBytes v) ++
    (m.authors.toList.map fun v => jsonStringBytes "authors" + 1 + jsonArrayBytes v)
  2 + entries.sum + (entries.length - 1)

def fits (m : Proofs.Metadata.Meta) : Bool := metaBytes m ≤ 2048

def metaJson (m : Proofs.Metadata.Meta) (extra : List (String × Json)) : Json :=
  obj (requiredFields ++ extra ++ (m.sourceKey.toList.map fun v => ("sourceKey", .str v)) ++
    (m.title.toList.map fun v => ("title", .str v)) ++ (m.tags.toList.map fun v => ("tags", strs v)) ++
    (m.authors.toList.map fun v => ("authors", strs v)))

def word (seed n : Nat) : String :=
  String.ofList ((List.range n).map fun i => pick (seed + i * 7) "abcdéfghij€klmnop😀qrstuvwxyz ".toList 'a')

def metadataCases : List Json := Id.run do
  let mut out := []
  let mut seed := 17
  for scale in [1, 20, 60, 100, 140, 300] do
    for variant in List.range 6 do
      seed := lcg seed
      let tagCount := seed % 21
      let tags := (List.range tagCount).map fun i => word (seed + i) (1 + (seed / 7 + i * 13) % scale % 100)
      let authors := (List.range (seed / 11 % 21)).map fun i => word (seed + 97 * i) (1 + (seed / 3 + i) % scale % 100)
      let m : Proofs.Metadata.Meta :=
        { sourceKey := if variant % 3 = 0 then none else some ("raw/doc_0d1e/" ++ word seed (scale % 150 + 5))
          title := if variant % 4 = 1 then none else some (word (seed + 1) (scale * 3 % 210 + 1))
          tags := if variant = 2 then none else some tags
          authors := if variant = 5 then none else some authors }
      -- text and chunkPreview are not filterable, so they never count against the cap.
      let extra : List (String × Json) := if variant % 2 = 0 then [("text", .str (word seed 3000)), ("chunkPreview", .str (word seed 200))] else []
      out := out ++ [obj [("input", metaJson m extra), ("expected", metaJson (Proofs.Metadata.fit fits m) extra)]]
  return out

/-! ### splitIntoChunks with a one-token-per-character tokenizer -/

def chunkerCases : List Json := Id.run do
  let vocab := ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "x", "yz", "\n", "  ", "         "]
  let mut out := []
  let mut seed := 4242
  for (maxT, overlap) in [(5, 0), (5, 1), (8, 2), (13, 4), (21, 5), (50, 10), (3, 2)] do
    for maxChunks in [4, 1000] do
      for _ in List.range 4 do
        seed := lcg seed
        let pageCount := 1 + seed % 5
        let mut pages : List (Nat × String) := []
        let mut number := 1
        for p in List.range pageCount do
          seed := lcg seed
          number := number + 1 + seed % 3
          let words := (List.range (seed % 12)).map fun i => pick (seed / 5 + i * 31 + p) vocab "x"
          let text := if seed % 7 = 0 then "   " else String.intercalate " " words
          pages := pages ++ [(number, text.trimAscii.copy)]
        let model : List Proofs.Chunker.Page := pages.map fun (n, t) =>
          { number := n, toks := t.toList.map Char.toNat, blank := t.trimAscii.isEmpty }
        let decode : List Nat → String := fun ts => String.ofList (ts.map Char.ofNat)
        let expected : Json := match Proofs.Chunker.chunks maxT overlap maxChunks [10, 10] decode model with
          | .ok cs => obj [("chunks", Json.arr (cs.map fun c =>
              obj [("text", .str c.text), ("pageStart", toJson c.pageStart), ("pageEnd", toJson c.pageEnd)]).toArray)]
          | .error e => obj [("error", .str e)]
        let pagesJson := Json.arr (pages.map fun (n, t) => obj [("pageNumber", toJson n), ("text", .str t)]).toArray
        out := out ++ [obj [("pages", pagesJson), ("maxTokens", toJson maxT), ("overlapTokens", toJson overlap),
          ("maxChunks", toJson maxChunks), ("expected", expected)]]
  return out

/-! ### currentCycle on the Gregorian calendar -/

/-- Days since 1970-01-01 of the first of month m (0 is January), after Howard Hinnant's days_from_civil. -/
def daysFromCivil (y m : Nat) : Int :=
  let y' : Int := if m < 2 then y - 1 else y
  let era := (if y' ≥ 0 then y' else y' - 399) / 400
  let yoe := y' - era * 400
  let mp : Int := (m + 10) % 12
  let doy := (153 * mp + 2) / 5
  let doe := yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146097 + doe - 719468

def monthOf (y0 m0 k : Nat) : Nat × Nat := (y0 + (m0 + k) / 12, (m0 + k) % 12)

def monthStart (y0 m0 : Nat) : Nat → Nat
  | 0 => (daysFromCivil y0 m0).toNat
  | k + 1 => monthStart y0 m0 k + Proofs.Billing.monthDays (monthOf y0 m0 k).1 (monthOf y0 m0 k).2

/-- The calendar the vectors use is an instance of the one the cycle theorems assume. -/
def civil (y0 m0 : Nat) : Proofs.Billing.Calendar where
  start := monthStart y0 m0
  len k := Proofs.Billing.monthDays (monthOf y0 m0 k).1 (monthOf y0 m0 k).2
  len_pos _ := Proofs.Billing.monthDays_pos _ _
  contiguous _ := rfl

def dayMs : Nat := 86400000

def cycleCases : List Json := Id.run do
  let mut out := []
  for (y, m, d) in [(2024, 0, 31), (2024, 1, 29), (2023, 0, 30), (2025, 4, 15), (2026, 11, 31), (2024, 7, 1), (2100, 0, 31)] do
    let c := civil y m
    let anchorMs := fun k => Proofs.Billing.anchor c d k * dayMs
    for k in [0, 1, 2, 5, 13] do
      for offset in [0, 1, dayMs / 2, dayMs * 3 + 7] do
        let now := anchorMs k + offset
        let idx := Proofs.Billing.cycleIndex anchorMs now 0 (now + 1)
        let created := (daysFromCivil y m).toNat * dayMs + (d - 1) * dayMs + 3600000 * 13
        out := out ++ [obj [("createdAtMs", toJson created), ("nowMs", toJson now),
          ("startMs", toJson (anchorMs idx)), ("endMs", toJson (anchorMs (idx + 1)))]]
      let edge := anchorMs (k + 1) - 1
      let idx := Proofs.Billing.cycleIndex anchorMs edge 0 (edge + 1)
      let created := (daysFromCivil y m).toNat * dayMs + (d - 1) * dayMs
      out := out ++ [obj [("createdAtMs", toJson created), ("nowMs", toJson edge),
        ("startMs", toJson (anchorMs idx)), ("endMs", toJson (anchorMs (idx + 1)))]]
  return out

/-! ### storageCostNanoUsd -/

def storageCost (bytes ms : Nat) : Nat :=
  let gb := bytes.toFloat / 1073741824.0
  let prorated := (ms.toFloat / 1000.0 / 2592000.0) * gb
  (prorated * 23000000.0).round.toUInt64.toNat

def storageCostCases : List Json := Id.run do
  let mut out := []
  for bytes in [0, 1, 1000, 52428800, 1073741824, 1610612736, 123456789012] do
    for ms in [0, 1, 999, 1000, 60000, 3600000, 86400000, 2592000000, 2678400000] do
      out := out ++ [obj [("bytes", toJson bytes), ("milliseconds", toJson ms), ("expected", toJson (storageCost bytes ms))]]
  return out

/-! ### packEmbeddingBatches -/

def emptyRequestBytes : Nat :=
  ("{\"input_type\":\"search_document\",\"inputs\":[],\"embedding_types\":[\"float\"],\"output_dimension\":1024,\"max_tokens\":128000,\"truncate\":\"RIGHT\"}").utf8ByteSize

def inputBytes (text : String) : Nat :=
  ("{\"content\":[{\"type\":\"text\",\"text\":}]}").utf8ByteSize + jsonStringBytes text

def packingCases : List Json := Id.run do
  let lim : Proofs.Batching.Limits := { maxItems := 96, maxBytes := 19 * 1024 * 1024, emptyBytes := emptyRequestBytes }
  let mut out := []
  let mut seed := 99
  for n in [0, 1, 5, 96, 97, 150, 200, 300] do
    for owners in [1, 2, 3] do
      seed := lcg seed
      let items := (List.range n).map fun i =>
        let owner := if owners = 1 then 0 else (seed / (i / 40 + 1) + i / 37) % owners
        (s!"user-{owner}", word (seed + i) (1 + (seed + i) % 40))
      let model := items.map fun (u, t) => ({ owner := u.hash.toNat, bytes := inputBytes t } : Proofs.Batching.Item)
      let sizes := match Proofs.Batching.packAll lim model with
        | .ok bs => nats (bs.map List.length)
        | .error _ => .null
      out := out ++ [obj [("items", Json.arr (items.map fun (u, t) => obj [("userId", .str u), ("text", .str t)]).toArray),
        ("batchSizes", sizes)]]
  return out

/-! ### buildFilter -/

def isScalar : Json → Bool
  | .str _ | .num _ | .bool _ => true
  | _ => false

def validOperator (op : String) (v : Json) : Bool :=
  if op = "$gte" ∨ op = "$lte" then (match v with | .num _ => true | _ => false)
  else if op = "$in" then (match v with
    | .arr xs => 0 < xs.size && xs.size ≤ 100 && xs.all isScalar
    | _ => false)
  else isScalar v

/-- The concrete checks buildFilter runs, as the `valid` the isolation theorem allows. -/
def validEntry (_ : String) : Proofs.QueryFilter.Entry Json → Bool
  | .scalar v => isScalar v
  | .ops os => !os.isEmpty && os.all fun (o, v) =>
      ["$eq", "$gte", "$lte", "$in"].contains o && validOperator o v

def filterCases : List Json := Id.run do
  let cases : List (List (String × Proofs.QueryFilter.Entry Json)) :=
    [ [],
      [("userId", .scalar (.str "attacker"))],
      [("title", .scalar (.str "Report")), ("userId", .scalar (.str "attacker"))],
      [("year", .ops [("$gte", toJson (2020 : Nat)), ("$lte", toJson (2024 : Nat))])],
      [("tags", .ops [("$in", strs ["a", "b"])]), ("modality", .scalar (.str "text"))],
      [("userId", .ops [("$in", strs ["attacker", "victim"])]), ("documentId", .scalar (.str "doc-1"))],
      [("$or", .scalar (.str "x"))],
      [("title", .ops [("$ne", .str "x")])],
      [("year", .ops [("$gte", .str "2020")])],
      [("tags", .ops [("$in", strs [])])],
      [("authors", .ops [])],
      [("mimeType", .scalar (.bool true)), ("year", .scalar (toJson (2021 : Nat)))] ]
  let entryJson : Proofs.QueryFilter.Entry Json → Json
    | .scalar v => v
    | .ops os => Json.arr (os.map fun (o, v) => Json.arr #[.str o, v]).toArray
  let entryKind : Proofs.QueryFilter.Entry Json → String
    | .scalar _ => "scalar"
    | .ops _ => "ops"
  return cases.map fun fs =>
    let expected := match Proofs.QueryFilter.buildFilter validEntry (.str "us.cohere.embed-v4:0") (.str "user-7") fs with
      | .ok cs => Json.arr (cs.map fun c => Json.arr #[.str c.key, .str c.op, c.value]).toArray
      | .error _ => obj [("error", .bool true)]
    obj [("filters", Json.arr (fs.map fun (k, e) => Json.arr #[.str k, .str (entryKind e), entryJson e]).toArray),
      ("expected", expected)]

/-! ### normalizeTags -/

def tagCases : List Json :=
  let trim : String → String := fun s => s.trimAscii.copy
  let cases : List (List String) :=
    [[], ["  "], ["a"], ["Alpha", "alpha", "ALPHA"], [" x ", "X", "y", "\ty\t"], ["b", "", "  ", "B ", "c"],
     ["Report 2024", "report 2024", "Report-2024"], ["one", "two", "One", "three", "TWO"]]
  cases.map fun tags =>
    obj [("tags", strs tags), ("expected", match Proofs.Tags.normalize trim String.toLower tags with
      | some kept => strs kept
      | none => .null)]

/-! ### Anchors -/

def anchors : List (String × String) :=
  Proofs.UploadCaps.anchors ++ Proofs.EmbedProtocol.anchors ++ Proofs.StorageAccounting.anchors ++
  Proofs.RateLimit.anchors ++ Proofs.Lifecycle.anchors ++ Proofs.Chunker.anchors ++
  Proofs.Metadata.anchors ++ Proofs.Truncate.anchors ++ Proofs.Batching.anchors ++
  Proofs.Billing.anchors ++ Proofs.QueryFilter.anchors ++ Proofs.Tags.anchors

end Vectors

open Vectors in
def main : IO Unit := do
  write "truncate" truncateCases
  write "metadata" metadataCases
  write "chunker" chunkerCases
  write "cycles" cycleCases
  write "storage-cost" storageCostCases
  write "packing" packingCases
  write "filter" filterCases
  write "tags" tagCases
  write "anchors" (anchors.map fun (file, text) => obj [("file", .str file), ("text", .str text)])
