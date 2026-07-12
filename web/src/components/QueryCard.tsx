import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { groupResults } from "@/lib/client";
import type { QueryResult } from "@/lib/types";
import { LoaderCircle, Search } from "lucide-react";
import { useState } from "react";

export function QueryCard({
  request,
}: {
  request: (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<QueryResult[]>([]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError("");
    try {
      const data = await request("POST", "/query", {
        query: query.trim(),
        topK: Number(topK) || 5,
      });
      setResults((data.results as QueryResult[]) || []);
    } catch (requestError) {
      setError((requestError as Error).message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  const groups = groupResults(results);
  return (
    <div className="lg:col-span-4">
      <Card className="lg:sticky lg:top-24">
        <CardHeader>
          <CardTitle>Query</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <Field htmlFor="query-question" label="Question">
              <Textarea
                disabled={loading}
                id="query-question"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="What is RAG?"
                required
                value={query}
              />
            </Field>
            <Field htmlFor="query-top-k" label="Top K">
              <Input
                id="query-top-k"
                max="50"
                min="1"
                onChange={(event) => setTopK(Number(event.target.value))}
                type="number"
                value={topK}
              />
            </Field>
            <Button
              className="w-full cursor-pointer"
              disabled={loading}
              type="submit"
            >
              {loading ? (
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Search className="size-4" />
              )}
              Search
            </Button>
          </form>
          <div className="mt-5 space-y-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!loading && results.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {results.length} results across {groups.length} documents
              </p>
            )}
            {!loading && !error && query && results.length === 0 && (
              <p className="text-sm text-muted-foreground">No results.</p>
            )}
            {groups.map((group) => (
              <details
                className="group overflow-hidden rounded-lg border border-border bg-muted/30"
                key={group.document.documentId}
                open
              >
                <summary className="cursor-pointer list-none bg-muted px-3 py-2 hover:bg-muted/80">
                  <p className="truncate text-sm font-medium text-foreground">
                    {group.document.title || group.document.documentId}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    best {group.maxScore.toFixed(3)} · {group.chunks.length}{" "}
                    chunk
                    {group.chunks.length === 1 ? "" : "s"}
                  </p>
                </summary>
                <div className="divide-y divide-border">
                  {group.chunks
                    .sort((a, b) => (b.score || 0) - (a.score || 0))
                    .map((chunk, index) => (
                      <div className="p-3" key={`${chunk.documentId}-${index}`}>
                        <p className="mb-1 text-xs text-muted-foreground">
                          score {(chunk.score || 0).toFixed(3)}
                        </p>
                        <p className="text-sm leading-6 text-foreground">
                          {chunk.text || ""}
                        </p>
                      </div>
                    ))}
                </div>
              </details>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
