import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../functions/utils", () => ({
  extractUserId: vi.fn().mockResolvedValue({ userId: "owner" }),
}));

import { handler as getDocument } from "../functions/admin/get";
import { handler as listDocuments } from "../functions/admin/list";
import { apiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("document read APIs", () => {
  beforeEach(() => {
    dynamoMock.reset();
  });

  describe("GET /documents", () => {
    it("queries only the authenticated user's index partition", async () => {
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            documentId: "doc-1",
            title: "Document",
            status: "EMBEDDED",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const response = await listDocuments(apiEvent());

      expect(response.statusCode).toBe(200);
      expect(dynamoMock.commandCalls(QueryCommand)[0].args[0].input).toEqual(
        expect.objectContaining({
          IndexName: "GSI2",
          ExpressionAttributeValues: { ":pk": "USER#owner" },
        }),
      );
      expect(JSON.parse(response.body)).toMatchObject({
        count: 1,
        documents: [{ documentId: "doc-1" }],
      });
    });
  });

  describe("GET /documents/{id}", () => {
    it("does not expose chunks owned by another user", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { documentId: "doc-1", userId: "another-user" },
      });

      const response = await getDocument(
        apiEvent({ pathParameters: { id: "doc-1" } }),
      );

      expect(response.statusCode).toBe(404);
      expect(dynamoMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("returns API-visible chunk metadata for the owner", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { documentId: "doc-1", userId: "owner", title: "Document" },
      });
      dynamoMock.on(QueryCommand).resolves({
        Count: 1,
        Items: [
          {
            chunkId: "chunk-1",
            pageStart: 1,
            pageEnd: 2,
            tokenCount: 100,
            status: "EMBEDDED",
            internalValue: "hidden",
          },
        ],
      });

      const response = await getDocument(
        apiEvent({ pathParameters: { id: "doc-1" } }),
      );
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body.chunkCount).toBe(1);
      expect(body.chunks).toEqual([
        {
          chunkId: "chunk-1",
          pageStart: 1,
          pageEnd: 2,
          tokenCount: 100,
          status: "EMBEDDED",
        },
      ]);
    });
  });
});
