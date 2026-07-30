import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { handler as chunkHandler } from "../chunk";
import { handler as embedHandler } from "../embed";
import { handler as parseHandler } from "../parse";

const STAGE_HANDLERS = {
  chunk: chunkHandler,
  embed: embedHandler,
  parse: parseHandler,
};

type Stage = keyof typeof STAGE_HANDLERS;

// One queue feeds every stage so Lambda idle-polls a single event source
// instead of three, which is where the SQS free tier was being spent.
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  const byStage = new Map<Stage, SQSRecord[]>();

  for (const record of event.Records) {
    const stage = readStage(record);
    if (!stage) {
      console.error("[pipeline] Unroutable record:", record.messageId);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const group = byStage.get(stage);
    if (group) {
      group.push(record);
    } else {
      byStage.set(stage, [record]);
    }
  }

  for (const [stage, records] of byStage) {
    try {
      const result = await STAGE_HANDLERS[stage]({
        ...event,
        Records: records,
      });
      batchItemFailures.push(...result.batchItemFailures);
    } catch (err) {
      // A stage handler should never throw, but if it does only its own
      // records are failed so the other stages in this batch still commit.
      console.error(`[pipeline] Stage ${stage} threw:`, err);
      for (const record of records) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
  }

  return { batchItemFailures };
}

function readStage(record: SQSRecord): Stage | undefined {
  try {
    const { stage } = JSON.parse(record.body);
    return typeof stage === "string" &&
      Object.hasOwn(STAGE_HANDLERS, stage)
      ? (stage as Stage)
      : undefined;
  } catch {
    return undefined;
  }
}
