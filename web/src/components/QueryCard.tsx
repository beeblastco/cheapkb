import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { groupResults } from "@/lib/client";
import type { QueryResult } from "@/lib/types";
import { ArrowUp, Bot, FileText, Sparkles, UserRound } from "lucide-react";
import { useState } from "react";

const SUGGESTIONS = [
  "Summarize the key points",
  "What are the main themes?",
  "Find the most relevant evidence",
];

interface ChatTurn {
  error: string;
  id: string;
  question: string;
  results: QueryResult[];
}

export function QueryCard({
  request,
  onView,
}: {
  request: (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  onView: (documentId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [topK, setTopK] = useState("5");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const question = query.trim();
    if (!question || loading) return;
    setCurrentQuestion(question);
    setQuery("");
    setLoading(true);
    try {
      const data = await request("POST", "/query", {
        query: question,
        topK: Number(topK),
      });
      setTurns((current) => [
        ...current,
        {
          error: "",
          id: crypto.randomUUID(),
          question,
          results: (data.results as QueryResult[]) || [],
        },
      ]);
    } catch (requestError) {
      setTurns((current) => [
        ...current,
        {
          error: (requestError as Error).message,
          id: crypto.randomUUID(),
          question,
          results: [],
        },
      ]);
    } finally {
      setCurrentQuestion("");
      setLoading(false);
    }
  }

  const latestTurn = turns[turns.length - 1];
  const groups = groupResults(latestTurn?.results || []);

  return (
    <Card className="min-h-[calc(100dvh-6rem)] gap-0 overflow-hidden py-0 lg:sticky lg:top-20">
      <CardHeader className="flex-row items-center justify-between border-b border-border py-4">
        <div>
          <CardTitle>Ask cheapkb</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Search your indexed documents
          </p>
        </div>
        <Select onValueChange={setTopK} value={topK}>
          <SelectTrigger aria-label="Number of results" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="3">3 results</SelectItem>
            <SelectItem value="5">5 results</SelectItem>
            <SelectItem value="10">10 results</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>

      <CardContent className="flex min-h-[calc(100dvh-10.1rem)] flex-col p-0">
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 p-4">
            {!turns.length && !loading && (
              <div className="flex min-h-72 flex-col items-center justify-center text-center">
                <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/40">
                  <Sparkles className="size-4 text-primary" />
                </div>
                <p className="mt-4 text-sm font-medium">
                  Ask across your knowledge base
                </p>
                <p className="mt-1 max-w-64 text-xs leading-5 text-muted-foreground">
                  cheapkb returns the most relevant passages and their source
                  documents.
                </p>
              </div>
            )}

            {turns.map((turn) => (
              <div className="space-y-4" key={turn.id}>
                <div className="flex justify-end gap-2">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
                    {turn.question}
                  </div>
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                    <UserRound className="size-3.5" />
                  </div>
                </div>
                <AssistantMessage turn={turn} />
              </div>
            ))}

            {loading && (
              <div className="space-y-4">
                <div className="flex justify-end gap-2">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
                    {currentQuestion}
                  </div>
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                    <UserRound className="size-3.5" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Bot className="size-3.5" />
                  </div>
                  <div className="w-full max-w-[85%] space-y-2 rounded-2xl rounded-tl-sm border border-border bg-muted/30 p-3">
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                </div>
              </div>
            )}

            {groups.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <FileText className="size-3.5 text-muted-foreground" />
                  <p className="text-xs font-medium">Related documents</p>
                </div>
                <div className="space-y-1.5">
                  {groups.map((group) => (
                    <Button
                      className="h-auto w-full justify-between px-3 py-2 text-left"
                      key={group.document.documentId}
                      onClick={() => onView(group.document.documentId)}
                      variant="outline"
                    >
                      <span className="truncate">
                        {group.document.title || group.document.documentId}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {group.maxScore.toFixed(3)}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="border-t border-border bg-card/40 p-3">
          {!turns.length && !loading && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <Button
                  className="h-7 px-2.5 text-[11px]"
                  key={suggestion}
                  onClick={() => setQuery(suggestion)}
                  variant="outline"
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          )}
          <Separator className="mb-3" />
          <form
            className="flex items-end gap-2 rounded-xl border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring/30"
            onSubmit={submit}
          >
            <Textarea
              aria-label="Ask a question"
              className="max-h-32 min-h-10 resize-none border-0 p-2 shadow-none focus-visible:ring-0"
              disabled={loading}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Ask your documents…"
              value={query}
            />
            <Button
              aria-label="Send question"
              disabled={!query.trim() || loading}
              size="icon"
              type="submit"
            >
              <ArrowUp />
            </Button>
          </form>
          <p className="mt-2 text-center text-[10px] text-muted-foreground">
            Retrieval only · answers are grounded in indexed passages
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function AssistantMessage({ turn }: { turn: ChatTurn }) {
  const groups = groupResults(turn.results);
  return (
    <div className="flex gap-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <Bot className="size-3.5" />
      </div>
      <div className="min-w-0 max-w-[88%] space-y-3">
        <div className="rounded-2xl rounded-tl-sm border border-border bg-muted/30 p-3 text-sm leading-6">
          {turn.error
            ? turn.error
            : turn.results.length
              ? `I found ${turn.results.length} relevant passage${turn.results.length === 1 ? "" : "s"} across ${groups.length} document${groups.length === 1 ? "" : "s"}.`
              : "I could not find a relevant passage in the indexed documents."}
        </div>
        {turn.results.slice(0, 3).map((result, index) => (
          <div
            className="rounded-xl border border-border bg-card p-3"
            key={`${result.documentId}-${index}`}
          >
            <p className="line-clamp-4 text-xs leading-5 text-muted-foreground">
              {result.text}
            </p>
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              score {(result.score || 0).toFixed(3)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
