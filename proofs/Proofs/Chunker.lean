/-!
`splitIntoChunks` in functions/chunk/index.ts slides a token window over the pages:
it pushes each token, flushes a window once the buffer holds `maxTokens`, keeps the
last `overlapTokens` as the next window's start, and flushes the remainder at the end.
Pages after the first are joined by separator tokens that belong to the previous page.
The model below is that loop, with a ghost `pushed` list recording every token pushed.
-/
namespace Proofs.Chunker

structure Tok where
  id : Nat
  page : Nat
  sep : Bool
  deriving DecidableEq, Repr

/-- A flushed buffer and how many of its tokens arrived since the previous flush. -/
structure Window where
  toks : List Tok
  fresh : Nat
  deriving Repr

structure St where
  out : List Window := []
  buf : List Tok := []
  fresh : Nat := 0
  pushed : List Tok := []

structure Page where
  number : Nat
  toks : List Nat
  /-- `!page.text.trim()`: a blank page is skipped. -/
  blank : Bool

/-- The tokens a window adds: its last `fresh` tokens. -/
def Window.freshToks (w : Window) : List Tok := w.toks.drop (w.toks.length - w.fresh)

def flush (overlap : Nat) (s : St) : St :=
  if s.fresh = 0 then s else
    { s with out := s.out ++ [⟨s.buf, s.fresh⟩], buf := s.buf.drop (s.buf.length - overlap),
             fresh := 0 }

def push (maxT overlap : Nat) (s : St) (t : Tok) : St :=
  let s' : St := { s with buf := s.buf ++ [t], fresh := s.fresh + 1, pushed := s.pushed ++ [t] }
  if maxT ≤ s'.buf.length then flush overlap s' else s'

/-- The separator takes the page of the last buffered token, and only exists when the
buffer is not empty. -/
def pageToks (sepToks : List Nat) (s : St) (p : Page) : List Tok :=
  let sep := match s.buf.getLast? with
    | none => []
    | some last => sepToks.map fun i => ⟨i, last.page, true⟩
  sep ++ p.toks.map fun i => ⟨i, p.number, false⟩

def processPage (maxT overlap : Nat) (sepToks : List Nat) (s : St) (p : Page) : St :=
  if p.blank then s else (pageToks sepToks s p).foldl (push maxT overlap) s

def run (maxT overlap : Nat) (sepToks : List Nat) (pages : List Page) : St :=
  flush overlap (pages.foldl (processPage maxT overlap sepToks) {})

def windows (maxT overlap : Nat) (sepToks : List Nat) (pages : List Page) : List Window :=
  (run maxT overlap sepToks pages).out

/-- The loop invariant, for `0 < overlap + 1 ≤ maxT`:
the buffer stays under `maxT`, its stale part stays within the overlap, every flushed
window is full and the fresh parts of the windows plus the buffer are exactly what was
pushed, and the buffer is the tail of what was pushed. -/
structure Inv (maxT overlap : Nat) (s : St) : Prop where
  bufLt : s.buf.length < maxT
  freshLe : s.fresh ≤ s.buf.length
  staleLe : s.buf.length - s.fresh ≤ overlap
  full : ∀ w ∈ s.out, w.toks.length = maxT ∧ 0 < w.fresh ∧ w.fresh ≤ w.toks.length ∧
    w.toks.length - w.fresh ≤ overlap
  cover : (s.out.flatMap Window.freshToks) ++ s.buf.drop (s.buf.length - s.fresh) = s.pushed
  suffix : s.buf <:+ s.pushed
  inPushed : ∀ w ∈ s.out, w.toks <:+: s.pushed

theorem inv_init (maxT overlap : Nat) (h : 0 < maxT) : Inv maxT overlap {} := by
  constructor <;> simp [h]

theorem suffix_snoc {l p : List α} (t : α) (h : l <:+ p) : l ++ [t] <:+ p ++ [t] := by
  obtain ⟨a, ha⟩ := h; exact ⟨a, by rw [← ha, List.append_assoc]⟩

theorem infix_snoc {l p : List α} (t : α) (h : l <:+: p) : l <:+: p ++ [t] :=
  h.trans (List.prefix_append p [t]).isInfix

theorem inv_push (maxT overlap : Nat) (hlt : overlap < maxT) (s : St) (t : Tok)
    (hi : Inv maxT overlap s) : Inv maxT overlap (push maxT overlap s t) := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7⟩ := hi
  have hd : (s.buf ++ [t]).drop (s.buf.length + 1 - (s.fresh + 1)) =
      s.buf.drop (s.buf.length - s.fresh) ++ [t] := by
    rw [show s.buf.length + 1 - (s.fresh + 1) = s.buf.length - s.fresh by omega,
      List.drop_append_of_le_length (by omega)]
  unfold push; dsimp only; split
  · rename_i hfull
    simp only [List.length_append, List.length_singleton] at hfull
    unfold flush; simp only [show ¬ s.fresh + 1 = 0 by omega, ite_false]
    constructor
    · simp only [List.length_drop, List.length_append, List.length_singleton]; omega
    · simp
    · simp only [List.length_drop, List.length_append, List.length_singleton]; omega
    · intro w hw
      simp only [List.mem_append, List.mem_singleton] at hw
      rcases hw with hw | rfl
      · exact h4 w hw
      · simp only [List.length_append, List.length_singleton]; omega
    · simp only [List.flatMap_append, List.flatMap_singleton, Window.freshToks,
        List.length_append, List.length_singleton, Nat.sub_zero, List.drop_length,
        List.append_nil]
      rw [hd, ← List.append_assoc, h5]
    · exact (List.drop_suffix _ _).trans (suffix_snoc t h6)
    · intro w hw
      simp only [List.mem_append, List.mem_singleton] at hw
      rcases hw with hw | rfl
      · exact infix_snoc t (h7 w hw)
      · exact (suffix_snoc t h6).isInfix
  · rename_i hnf
    simp only [List.length_append, List.length_singleton] at hnf
    constructor
    · simp; omega
    · simp; omega
    · simp; omega
    · exact h4
    · simp only [List.length_append, List.length_singleton]; rw [hd, ← List.append_assoc, h5]
    · exact suffix_snoc t h6
    · exact fun w hw => infix_snoc t (h7 w hw)

theorem push_pushed (maxT overlap : Nat) (s : St) (t : Tok) :
    (push maxT overlap s t).pushed = s.pushed ++ [t] := by
  unfold push flush; dsimp only; split
  · split <;> rfl
  · rfl

theorem foldl_push_pushed (maxT overlap : Nat) :
    ∀ (l : List Tok) (s : St), (l.foldl (push maxT overlap) s).pushed = s.pushed ++ l
  | [], s => by simp
  | t :: l, s => by
    rw [List.foldl_cons, foldl_push_pushed maxT overlap l, push_pushed, List.append_assoc]; rfl

theorem foldl_push_inv (maxT overlap : Nat) (hlt : overlap < maxT) :
    ∀ (l : List Tok) (s : St), Inv maxT overlap s → Inv maxT overlap (l.foldl (push maxT overlap) s)
  | [], _, h => h
  | t :: l, s, h => foldl_push_inv maxT overlap hlt l _ (inv_push maxT overlap hlt s t h)

theorem processPage_inv (maxT overlap : Nat) (hlt : overlap < maxT) (sepToks : List Nat)
    (s : St) (p : Page) (h : Inv maxT overlap s) :
    Inv maxT overlap (processPage maxT overlap sepToks s p) := by
  unfold processPage; split
  · exact h
  · exact foldl_push_inv maxT overlap hlt _ s h

theorem processPage_pushed (maxT overlap : Nat) (sepToks : List Nat) (s : St) (p : Page) :
    (processPage maxT overlap sepToks s p).pushed =
      s.pushed ++ (if p.blank then [] else pageToks sepToks s p) := by
  unfold processPage; split <;> simp [foldl_push_pushed, *]

theorem pages_inv (maxT overlap : Nat) (hlt : overlap < maxT) (sepToks : List Nat) :
    ∀ (pages : List Page) (s : St), Inv maxT overlap s →
      Inv maxT overlap (pages.foldl (processPage maxT overlap sepToks) s)
  | [], _, h => h
  | p :: ps, s, h => pages_inv maxT overlap hlt sepToks ps _ (processPage_inv maxT overlap hlt sepToks s p h)

theorem pageToks_content (sepToks : List Nat) (s : St) (p : Page) :
    (pageToks sepToks s p).filter (fun t => !t.sep) = p.toks.map fun i => ⟨i, p.number, false⟩ := by
  have ht : ∀ l : List Nat, l.filter (fun _ => true) = l := fun l => List.filter_eq_self.2 (by simp)
  have hf : ∀ l : List Nat, l.filter (fun _ => false) = [] := fun l => List.filter_eq_nil_iff.2 (by simp)
  unfold pageToks
  split <;> simp [List.filter_append, List.filter_map, Function.comp_def, ht, hf]

/-- Every token of every non-blank page is pushed, in page order. -/
theorem pages_content (maxT overlap : Nat) (sepToks : List Nat) :
    ∀ (pages : List Page) (s : St),
      (pages.foldl (processPage maxT overlap sepToks) s).pushed.filter (fun t => !t.sep) =
        s.pushed.filter (fun t => !t.sep) ++
          (pages.filter (fun p => !p.blank)).flatMap fun p => p.toks.map fun i => ⟨i, p.number, false⟩
  | [], s => by simp
  | p :: ps, s => by
    rw [List.foldl_cons, pages_content maxT overlap sepToks ps, processPage_pushed]
    by_cases hb : p.blank <;> simp [hb, List.filter_append, pageToks_content]

theorem flush_pushed (overlap : Nat) (s : St) : (flush overlap s).pushed = s.pushed := by
  unfold flush; split <;> rfl

/-- Properties of the windows after the final flush. -/
structure Final (maxT overlap : Nat) (s : St) : Prop where
  bounded : ∀ w ∈ s.out, w.toks.length ≤ maxT ∧ 0 < w.fresh ∧ w.fresh ≤ w.toks.length
  fullButLast : ∀ w ∈ s.out.dropLast, w.toks.length = maxT ∧ w.toks.length - w.fresh ≤ overlap
  cover : s.out.flatMap Window.freshToks = s.pushed
  inPushed : ∀ w ∈ s.out, w.toks <:+: s.pushed

theorem final_flush (maxT overlap : Nat) (s : St) (h : Inv maxT overlap s) :
    Final maxT overlap (flush overlap s) := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7⟩ := h
  unfold flush; split
  · rename_i h0
    refine ⟨fun w hw => ?_, fun w hw => ?_, ?_, h7⟩
    · have := h4 w hw; omega
    · have := h4 w (List.dropLast_subset _ hw); omega
    · simpa [h0] using h5
  · refine ⟨fun w hw => ?_, fun w hw => ?_, ?_, fun w hw => ?_⟩
    · simp only [List.mem_append, List.mem_singleton] at hw
      rcases hw with hw | rfl
      · have := h4 w hw; omega
      · dsimp only; omega
    · simp only [List.dropLast_concat] at hw; have := h4 w hw; omega
    · simpa [Window.freshToks] using h5
    · simp only [List.mem_append, List.mem_singleton] at hw
      rcases hw with hw | rfl
      · exact h7 w hw
      · exact h6.isInfix

theorem run_final (maxT overlap : Nat) (hlt : overlap < maxT) (sepToks : List Nat)
    (pages : List Page) : Final maxT overlap (run maxT overlap sepToks pages) :=
  final_flush maxT overlap _ (pages_inv maxT overlap hlt sepToks pages {} (inv_init maxT overlap (by omega)))

/-- The tokens pushed: every page token, plus the separators between pages. -/
def pushed (maxT overlap : Nat) (sepToks : List Nat) (pages : List Page) : List Tok :=
  (run maxT overlap sepToks pages).pushed

/-- No window holds more than maxTokens tokens. -/
theorem window_size_le (maxT overlap : Nat) (hlt : overlap < maxT) (sepToks : List Nat)
    (pages : List Page) : ∀ w ∈ windows maxT overlap sepToks pages, w.toks.length ≤ maxT :=
  fun w hw => ((run_final maxT overlap hlt sepToks pages).bounded w hw).1

/-- Coverage: the windows' new tokens, in order, are exactly the pushed tokens, so no
text is lost or repeated outside the overlap. -/
theorem windows_cover (maxT overlap : Nat) (hlt : overlap < maxT) (sepToks : List Nat)
    (pages : List Page) :
    (windows maxT overlap sepToks pages).flatMap Window.freshToks = pushed maxT overlap sepToks pages :=
  (run_final maxT overlap hlt sepToks pages).cover

/-- Every token of every non-blank page is pushed, in order, so coverage reaches the text. -/
theorem pushed_content (maxT overlap : Nat) (sepToks : List Nat) (pages : List Page) :
    (pushed maxT overlap sepToks pages).filter (fun t => !t.sep) =
      (pages.filter (fun p => !p.blank)).flatMap fun p => p.toks.map fun i => ⟨i, p.number, false⟩ := by
  unfold pushed run; rw [flush_pushed, pages_content]; simp

theorem freshToks_length (w : Window) (h : w.fresh ≤ w.toks.length) :
    w.freshToks.length = w.fresh := by
  simp [Window.freshToks]; omega

theorem sum_le_mul (ws : List Window) (f : Window → Nat) (m : Nat) (h : ∀ w ∈ ws, f w ≤ m) :
    (ws.map f).sum ≤ ws.length * m := by
  induction ws with
  | nil => simp
  | cons w ws ih =>
    simp only [List.map_cons, List.sum_cons, List.length_cons]
    have := h w (by simp); have := ih fun x hx => h x (by simp [hx])
    rw [Nat.succ_mul]; omega

theorem mul_le_sum (ws : List Window) (f : Window → Nat) (m : Nat) (h : ∀ w ∈ ws, m ≤ f w) :
    ws.length * m ≤ (ws.map f).sum := by
  induction ws with
  | nil => simp
  | cons w ws ih =>
    simp only [List.map_cons, List.sum_cons, List.length_cons]
    have := h w (by simp); have := ih fun x hx => h x (by simp [hx])
    rw [Nat.succ_mul]; omega

theorem cover_length (ws : List Window) (hb : ∀ w ∈ ws, w.fresh ≤ w.toks.length) :
    (ws.flatMap Window.freshToks).length = (ws.map Window.fresh).sum := by
  rw [List.length_flatMap]; congr 1
  exact List.map_congr_left fun w hw => freshToks_length w (hb w hw)

/-- Window count bounds: N tokens need at least N / maxTokens windows, and each window
but the last adds at least maxTokens - overlapTokens new tokens. -/
theorem window_count_bounds (maxT overlap : Nat) (hlt : overlap < maxT) (sepToks : List Nat)
    (pages : List Page) :
    let ws := windows maxT overlap sepToks pages
    let n := (pushed maxT overlap sepToks pages).length
    n ≤ ws.length * maxT ∧ (ws ≠ [] → (ws.length - 1) * (maxT - overlap) < n) := by
  intro ws n
  have hf := run_final maxT overlap hlt sepToks pages
  have hn : n = (ws.map Window.fresh).sum := by
    show (pushed maxT overlap sepToks pages).length = _
    rw [← windows_cover maxT overlap hlt]
    exact cover_length _ fun w hw => (hf.bounded w hw).2.2
  refine ⟨?_, fun hne => ?_⟩
  · rw [hn]; exact sum_le_mul ws _ maxT fun w hw => by
      have := hf.bounded w hw; omega
  · rw [hn, ← List.dropLast_concat_getLast hne, List.map_append, List.sum_append,
      List.length_append, List.length_singleton, Nat.add_sub_cancel]
    have h1 := mul_le_sum ws.dropLast Window.fresh (maxT - overlap) fun w hw => by
      have := hf.fullButLast w hw; omega
    have h2 := (hf.bounded _ (List.getLast_mem hne)).2.1
    simp only [List.map_cons, List.map_nil, List.sum_cons, List.sum_nil]
    rw [List.length_dropLast] at h1 ⊢
    omega

def PageLe (a b : Tok) : Prop := a.page ≤ b.page

theorem const_page_sorted (l : List Nat) (c : Nat) (b : Bool) :
    (l.map fun i => (⟨i, c, b⟩ : Tok)).Pairwise PageLe := by
  induction l with
  | nil => exact List.Pairwise.nil
  | cons x xs ih =>
    simp only [List.map_cons, List.pairwise_cons]
    exact ⟨fun a ha => by simp at ha; obtain ⟨_, _, rfl⟩ := ha; exact Nat.le_refl _, ih⟩

theorem le_last_of_pairwise {l : List Tok} {x : Tok} (hs : l.Pairwise PageLe)
    (hx : l.getLast? = some x) : ∀ a ∈ l, PageLe a x := by
  obtain ⟨ys, rfl⟩ := List.getLast?_eq_some_iff.1 hx
  intro a ha
  rcases List.mem_append.1 ha with ha | ha
  · exact (List.pairwise_append.1 hs).2.2 a ha x (by simp)
  · simp at ha; subst ha; exact Nat.le_refl _

theorem getLast?_of_suffix {l p : List Tok} {x : Tok} (h : l <:+ p) (hx : l.getLast? = some x) :
    p.getLast? = some x := by
  obtain ⟨a, rfl⟩ := h
  obtain ⟨ys, rfl⟩ := List.getLast?_eq_some_iff.1 hx
  rw [← List.append_assoc]; simp

theorem processPage_sorted (maxT overlap : Nat) (sepToks : List Nat) (s : St) (p : Page)
    (hi : Inv maxT overlap s) (hs : s.pushed.Pairwise PageLe)
    (hb : ∀ t ∈ s.pushed, t.page ≤ p.number) :
    (processPage maxT overlap sepToks s p).pushed.Pairwise PageLe := by
  rw [processPage_pushed]; split
  · simpa using hs
  · unfold pageToks
    split
    · rw [List.pairwise_append]
      refine ⟨hs, ?_, ?_⟩
      · exact const_page_sorted _ _ _
      · intro a ha b hb'; simp at hb'; obtain ⟨_, _, rfl⟩ := hb'; exact hb a ha
    · rename_i last hl
      have hmax := le_last_of_pairwise hs (getLast?_of_suffix hi.suffix hl)
      have hlast : last ∈ s.pushed := by
        have := getLast?_of_suffix hi.suffix hl
        exact List.mem_of_getLast? this
      rw [List.pairwise_append, List.pairwise_append]
      refine ⟨hs, ⟨?_, ?_, ?_⟩, ?_⟩
      · exact const_page_sorted _ _ _
      · exact const_page_sorted _ _ _
      · intro a ha b hb'; simp at ha hb'
        obtain ⟨_, _, rfl⟩ := ha; obtain ⟨_, _, rfl⟩ := hb'; exact hb last hlast
      · intro a ha b hb'
        rcases List.mem_append.1 hb' with hb' | hb' <;> simp at hb'
        · obtain ⟨_, _, rfl⟩ := hb'; exact hmax a ha
        · obtain ⟨_, _, rfl⟩ := hb'; exact hb a ha

theorem processPage_bound (maxT overlap : Nat) (sepToks : List Nat) (s : St) (p : Page) (b : Nat)
    (hi : Inv maxT overlap s) (hbs : ∀ t ∈ s.pushed, t.page ≤ b) (hpb : p.number ≤ b) :
    ∀ t ∈ (processPage maxT overlap sepToks s p).pushed, t.page ≤ b := by
  rw [processPage_pushed]; intro t ht
  rcases List.mem_append.1 ht with ht | ht
  · exact hbs t ht
  · split at ht
    · simp at ht
    · unfold pageToks at ht
      split at ht
      · simp at ht; obtain ⟨_, _, rfl⟩ := ht; exact hpb
      · rename_i last hl
        have hlast : last ∈ s.pushed := List.mem_of_getLast? (getLast?_of_suffix hi.suffix hl)
        rcases List.mem_append.1 ht with ht | ht <;> simp at ht
        · obtain ⟨_, _, rfl⟩ := ht; exact hbs last hlast
        · obtain ⟨_, _, rfl⟩ := ht; exact hpb

theorem pages_sorted (maxT overlap : Nat) (hlt : overlap < maxT) (sepToks : List Nat) :
    ∀ (pages : List Page) (s : St), Inv maxT overlap s → s.pushed.Pairwise PageLe →
      (pages.map Page.number).Pairwise (· ≤ ·) →
      (∀ t ∈ s.pushed, ∀ p ∈ pages, t.page ≤ p.number) →
      (pages.foldl (processPage maxT overlap sepToks) s).pushed.Pairwise PageLe
  | [], _, _, hs, _, _ => hs
  | p :: ps, s, hi, hs, hp, hb => by
    rw [List.foldl_cons]
    simp only [List.map_cons, List.pairwise_cons, List.mem_map] at hp
    apply pages_sorted maxT overlap hlt sepToks ps _ (processPage_inv maxT overlap hlt sepToks s p hi)
      (processPage_sorted maxT overlap sepToks s p hi hs fun t ht => hb t ht p (by simp)) hp.2
    intro t ht q hq
    exact processPage_bound maxT overlap sepToks s p q.number hi
      (fun t ht => hb t ht q (by simp [hq])) (hp.1 q.number ⟨q, hq, rfl⟩) t ht

/-- With pages in ascending order, each window's tokens are in page order, so its
first token's page is its pageStart and every token lies within [pageStart, pageEnd]. -/
theorem window_pages_sorted (maxT overlap : Nat) (hlt : overlap < maxT) (sepToks : List Nat)
    (pages : List Page) (hp : (pages.map Page.number).Pairwise (· ≤ ·)) :
    ∀ w ∈ windows maxT overlap sepToks pages, w.toks.Pairwise PageLe := by
  intro w hw
  have hs : (pushed maxT overlap sepToks pages).Pairwise PageLe := by
    unfold pushed run; rw [flush_pushed]
    exact pages_sorted maxT overlap hlt sepToks pages {} (inv_init maxT overlap (by omega))
      List.Pairwise.nil hp (by simp)
  exact hs.sublist ((run_final maxT overlap hlt sepToks pages).inPushed w hw).sublist

/-- A chunk: a window whose decoded text is not blank, with its page range. -/
structure Chunk where
  text : String
  pageStart : Nat
  pageEnd : Nat
  deriving DecidableEq, Repr

/-- `trim` stands for JavaScript's `String.prototype.trim`; no theorem depends on it. -/
def toChunk (decode : List Nat → String) (trim : String → String) (w : Window) : Option Chunk :=
  let text := trim (decode (w.toks.map Tok.id))
  if text.isEmpty then none else
    some ⟨text, (w.toks.head?.map Tok.page).getD 0, (w.toks.getLast?.map Tok.page).getD 0⟩

/-- The chunk stage's result: the chunks, or the ContentError past maxChunks. -/
def chunks (maxT overlap maxChunks : Nat) (sepToks : List Nat) (decode : List Nat → String)
    (trim : String → String) (pages : List Page) : Except String (List Chunk) :=
  let cs := (windows maxT overlap sepToks pages).filterMap (toChunk decode trim)
  if maxChunks < cs.length then .error s!"Document exceeds the {maxChunks} chunk limit" else .ok cs

theorem chunks_le_cap (maxT overlap maxChunks : Nat) (sepToks : List Nat) (decode : List Nat → String)
    (trim : String → String) (pages : List Page) (cs : List Chunk)
    (h : chunks maxT overlap maxChunks sepToks decode trim pages = .ok cs) :
    cs.length ≤ maxChunks := by
  unfold chunks at h; dsimp only at h; split at h
  · cases h
  · cases h; omega

/-- The parse guard in functions/parse/index.ts: reject text longer than
maxChunks × maxTokens × 16 characters before chunking it. Its length counts every page,
blank ones and whitespace included, which `hdensity` below must then cover. -/
def parseGuardRejects (maxChunks maxT textLength : Nat) : Bool :=
  maxChunks * maxT * 16 < textLength

/-- The guard only rejects documents the chunker would split into more windows than
the cap, provided the tokenizer averages at most 16 characters per page token. -/
theorem parseGuard_sound (maxT overlap maxChunks : Nat) (hlt : overlap < maxT) (sepToks : List Nat)
    (pages : List Page) (textLength : Nat)
    (hdensity : textLength ≤ 16 * ((pushed maxT overlap sepToks pages).filter (fun t => !t.sep)).length)
    (hrej : parseGuardRejects maxChunks maxT textLength = true) :
    maxChunks < (windows maxT overlap sepToks pages).length := by
  simp only [parseGuardRejects, decide_eq_true_eq] at hrej
  have hf := List.length_filter_le (fun t : Tok => !t.sep) (pushed maxT overlap sepToks pages)
  have hb := (window_count_bounds maxT overlap hlt sepToks pages).1
  have hmono : ∀ a b : Nat, a * maxT * 16 < b * maxT * 16 → a < b := fun a b h =>
    Nat.lt_of_mul_lt_mul_right (Nat.lt_of_mul_lt_mul_right h)
  apply hmono
  calc maxChunks * maxT * 16 < textLength := hrej
    _ ≤ 16 * (pushed maxT overlap sepToks pages).length := by omega
    _ ≤ 16 * ((windows maxT overlap sepToks pages).length * maxT) := Nat.mul_le_mul_left 16 hb
    _ = _ := by rw [Nat.mul_comm]

/-- Source the model above stands for; tests/proofs.test.ts fails when any of it changes. -/
def anchors : List (String × String) :=
  [("functions/chunk/index.ts", "if (out.length > maxChunks) {"),
   ("functions/chunk/index.ts", "const keepFrom = Math.max(0, buffer.length - overlapTokens);"),
   ("functions/chunk/index.ts", "if (buffer.length >= maxTokens) flush();"),
   ("functions/parse/index.ts", "const MAX_CHARS_PER_TOKEN = 16;"),
   ("functions/parse/index.ts", "if (textLength > maxChunks * maxTokens * MAX_CHARS_PER_TOKEN) {"),
   (".github/workflows/deploy.yml", "CHUNK_MAX_TOKENS: \"700\""),
   (".github/workflows/deploy.yml", "CHUNK_OVERLAP_TOKENS: \"100\"")]

end Proofs.Chunker
