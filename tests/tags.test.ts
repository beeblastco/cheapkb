import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
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
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(QueryCommand).resolves({ Count: 0 });
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

    it("returns the stored canonical tag when a differently-cased duplicate is created", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { name: "Research", createdAt: "2026-01-01T00:00:00.000Z" },
      });

      const response = await tags(
        withMethod("POST", { body: JSON.stringify({ name: "RESEARCH" }) }),
      );

      expect(response.statusCode).toBe(200);
      // The already-stored casing/createdAt wins, not the request's casing.
      expect(JSON.parse(response.body).tag).toEqual({
        name: "Research",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it("rejects creation once the per-user tag cap is reached", async () => {
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(QueryCommand).resolves({ Count: 200 });

      const response = await tags(
        withMethod("POST", { body: JSON.stringify({ name: "overflow" }) }),
      );

      expect(response.statusCode).toBe(409);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
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
