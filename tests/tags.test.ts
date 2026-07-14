import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../functions/utils", () => ({
  extractUserId: vi.fn().mockResolvedValue({ userId: "owner" }),
}));

import { handler as tags } from "../functions/admin/tags";
import { apiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);

function withMethod(
  method: string,
  input: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
  const base = apiEvent(input);
  return {
    ...base,
    requestContext: {
      ...base.requestContext,
      http: { ...base.requestContext.http, method },
    },
  };
}

describe("tag APIs", () => {
  beforeEach(() => {
    dynamoMock.reset();
  });

  describe("GET /tags", () => {
    it("lists only the authenticated user's tags, sorted by name", async () => {
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          { name: "product", createdAt: "2026-01-02T00:00:00.000Z" },
          { name: "Research", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      });

      const response = await tags(withMethod("GET"));

      expect(response.statusCode).toBe(200);
      expect(dynamoMock.commandCalls(QueryCommand)[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: {
            ":pk": "USER#owner",
            ":prefix": "TAG#",
          },
        }),
      );
      expect(JSON.parse(response.body)).toEqual({
        count: 2,
        tags: [
          { name: "product", createdAt: "2026-01-02T00:00:00.000Z" },
          { name: "Research", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
    });
  });

  describe("POST /tags", () => {
    it("creates a tag under the user partition with a normalized key", async () => {
      dynamoMock.on(PutCommand).resolves({});

      const response = await tags(
        withMethod("POST", { body: JSON.stringify({ name: "  Research  " }) }),
      );

      expect(response.statusCode).toBe(200);
      const put = dynamoMock.commandCalls(PutCommand)[0].args[0].input;
      expect(put.Item).toEqual(
        expect.objectContaining({
          pk: "USER#owner",
          sk: "TAG#research",
          entityType: "Tag",
          name: "Research",
        }),
      );
      expect(put.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(JSON.parse(response.body).tag.name).toBe("Research");
    });

    it("treats creating an existing tag as idempotent success", async () => {
      dynamoMock.on(PutCommand).rejects(
        Object.assign(new Error("exists"), {
          name: "ConditionalCheckFailedException",
        }),
      );

      const response = await tags(
        withMethod("POST", { body: JSON.stringify({ name: "product" }) }),
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).tag.name).toBe("product");
    });

    it("rejects an empty tag name", async () => {
      const response = await tags(
        withMethod("POST", { body: JSON.stringify({ name: "   " }) }),
      );

      expect(response.statusCode).toBe(400);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe("DELETE /tags/{name}", () => {
    it("deletes the decoded tag from the user partition", async () => {
      dynamoMock.on(DeleteCommand).resolves({});

      const response = await tags(
        withMethod("DELETE", {
          pathParameters: { name: "Machine%20Learning" },
        }),
      );

      expect(response.statusCode).toBe(200);
      expect(
        dynamoMock.commandCalls(DeleteCommand)[0].args[0].input.Key,
      ).toEqual({ pk: "USER#owner", sk: "TAG#machine learning" });
    });
  });
});
