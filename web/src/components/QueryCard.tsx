import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Message,
  MessageContent,
  MessageFooter,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { groupResults } from "@/lib/client";
import type { QueryResult } from "@/lib/types";
import { ArrowUp } from "lucide-react";
import { useState } from "react";

const TOP_K_OPTIONS = [
  { label: "3 results", value: "3" },
  { label: "5 results", value: "5" },
  { label: "10 results", value: "10" },
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
  onUsageChange,
}: {
  request: (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  onView: (documentId: string) => void;
  onUsageChange?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [topK, setTopK] = useState("5");
  const [loading, setLoading] = useState(false);

  async function submit() {
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
      // Refresh usage after a billed query. Future backend can push usage
      // updates here instead of polling from the parent.
      onUsageChange?.();
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

  return (
    <Card className="h-full">
      <CardContent className="min-h-0 flex-1 overflow-hidden">
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                {!turns.length && !loading ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyDescription>
                        Ask questions about your documents
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {turns.map((turn) => (
                  <MessageScrollerItem
                    key={turn.id}
                    messageId={turn.id}
                    scrollAnchor
                  >
                    <MessageGroup turn={turn} onView={onView} />
                  </MessageScrollerItem>
                ))}
                {loading ? (
                  <MessageScrollerItem scrollAnchor>
                    <Message align="end">
                      <MessageContent>
                        <Bubble>
                          <BubbleContent>{currentQuestion}</BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                    <Message>
                      <MessageContent>
                        <Bubble variant="muted">
                          <BubbleContent>
                            <Spinner />
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-3">
        <InputGroup>
          <InputGroupTextarea
            aria-label="Ask a question"
            disabled={loading}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Ask about your documents…"
            value={query}
          />
          <InputGroupAddon align="block-end">
            <Select
              items={TOP_K_OPTIONS}
              onValueChange={(value) => value && setTopK(value)}
              value={topK}
            >
              <SelectTrigger aria-label="Number of results" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {TOP_K_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <InputGroupButton
              aria-label="Send question"
              className="ml-auto"
              disabled={!query.trim() || loading}
              onClick={() => void submit()}
              size="icon-sm"
              type="button"
              variant="default"
            >
              <ArrowUp />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </CardFooter>
    </Card>
  );
}

function MessageGroup({
  turn,
  onView,
}: {
  turn: ChatTurn;
  onView: (documentId: string) => void;
}) {
  const groups = groupResults(turn.results);
  return (
    <div className="flex flex-col gap-8">
      <Message align="end">
        <MessageContent>
          <Bubble>
            <BubbleContent>{turn.question}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Message>
        <MessageContent>
          <BubbleGroup>
            <Bubble variant={turn.error ? "destructive" : "muted"}>
              <BubbleContent>
                {turn.error
                  ? turn.error
                  : turn.results.length
                    ? `Found ${turn.results.length} relevant passage${turn.results.length === 1 ? "" : "s"}.`
                    : "No relevant passages found."}
              </BubbleContent>
            </Bubble>
            {turn.results.slice(0, 3).map((result, index) => (
              <Bubble key={`${result.documentId}-${index}`} variant="ghost">
                <BubbleContent>{result.text}</BubbleContent>
              </Bubble>
            ))}
          </BubbleGroup>
          {groups.length ? (
            <MessageFooter className="flex-col items-start gap-1">
              {groups.map((group) => (
                <Button
                  key={group.document.documentId}
                  onClick={() => onView(group.document.documentId)}
                  size="xs"
                  variant="ghost"
                >
                  {group.document.title || group.document.documentId}
                </Button>
              ))}
            </MessageFooter>
          ) : null}
        </MessageContent>
      </Message>
    </div>
  );
}
