import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { checkRateLimit } from "../functions/utils";

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("rate limit buckets", () => {
  beforeEach(() => dynamoMock.reset());

  it("uses an operation-specific key", async () => {
    dynamoMock.on(GetCommand).resolves({});
    dynamoMock.on(PutCommand).resolves({});

    await checkRateLimit("user", "table", "QUERY", 100, 100);

    expect(dynamoMock.commandCalls(PutCommand)[0].args[0].input.Item?.sk).toBe(
      "LIMIT#QUERY",
    );
  });
});
