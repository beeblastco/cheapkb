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
import { ArrowUp, ImagePlus, X } from "lucide-react";
import { useRef, useState } from "react";

const TOP_K_OPTIONS = [
  { label: "3 results", value: "3" },
  { label: "5 results", value: "5" },
  { label: "10 results", value: "10" },
];
const QUERY_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_QUERY_IMAGE_BYTES = 5 * 1024 * 1024;

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
  const [image, setImage] = useState<{ dataUri: string; name: string } | null>(
    null,
  );
  const [imageError, setImageError] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [topK, setTopK] = useState("5");
  const [loading, setLoading] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);

  async function submit() {
    const question = query.trim();
    if ((!question && !image) || loading) return;
    const displayQuestion = [image ? `Image: ${image.name}` : "", question]
      .filter(Boolean)
      .join("\n");
    setCurrentQuestion(displayQuestion);
    setQuery("");
    setLoading(true);
    try {
      const data = await request("POST", "/query", {
        ...(question ? { query: question } : {}),
        ...(image ? { image: image.dataUri } : {}),
        topK: Number(topK),
      });
      setTurns((current) => [
        ...current,
        {
          error: "",
          id: crypto.randomUUID(),
          question: displayQuestion,
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
      setImage(null);
      setLoading(false);
    }
  }

  async function selectImage(file: File | undefined) {
    setImageError("");
    if (!file) return;
    if (!QUERY_IMAGE_TYPES.has(file.type)) {
      setImageError("Choose a JPEG, PNG, WebP, or GIF image.");
      return;
    }
    if (file.size > MAX_QUERY_IMAGE_BYTES) {
      setImageError("Query images must be 5 MB or smaller.");
      return;
    }
    try {
      setImage({ dataUri: await readDataUri(file), name: file.name });
    } catch {
      setImageError("Could not read the query image.");
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
                        Search your documents and images
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
        {image || imageError ? (
          <div
            className={
              imageError ? "text-destructive" : "text-muted-foreground"
            }
          >
            {imageError || image?.name}
            {image ? (
              <Button
                aria-label="Remove query image"
                onClick={() => setImage(null)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            ) : null}
          </div>
        ) : null}
        <input
          accept="image/gif,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(event) => {
            void selectImage(event.target.files?.[0]);
            event.target.value = "";
          }}
          ref={imageInput}
          type="file"
        />
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
            placeholder="Search with text, an image, or both…"
            value={query}
          />
          <InputGroupAddon align="block-end">
            <InputGroupButton
              aria-label="Add query image"
              disabled={loading}
              onClick={() => imageInput.current?.click()}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ImagePlus />
            </InputGroupButton>
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
              disabled={(!query.trim() && !image) || loading}
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

function readDataUri(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read query image"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
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
                    ? `Found ${turn.results.length} relevant result${turn.results.length === 1 ? "" : "s"}.`
                    : "No relevant results found."}
              </BubbleContent>
            </Bubble>
            {turn.results.slice(0, 3).map((result, index) => (
              <Bubble key={`${result.documentId}-${index}`} variant="ghost">
                <BubbleContent>
                  {result.text ||
                    (result.modality === "image"
                      ? result.title || "Image result"
                      : "")}
                </BubbleContent>
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
