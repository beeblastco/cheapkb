import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: { pairwise_sub: "owner" },
  }),
}));

import { handler as listTags } from "../functions/tags/list";
import { handler as createTag } from "../functions/tags/create";
import { handler as updateTag } from "../functions/tags/update";
import { handler as deleteTag } from "../functions/tags/delete";
import { apiEvent } from "./helpers/events";

const dynamoMock = mockClient(DynamoDBDocumentClient);

function isRateLimitCall(call: any) {
  const input = call.args[0].input;
  return (
    input.Key?.pk?.startsWith("RATE#") || input.Item?.pk?.startsWith("RATE#")
  );
}

describe("tag APIs", () => {
  beforeEach(() => {
    dynamoMock.reset();
  });

  describe("GET /tags", () => {
    it("lists only the authenticated user's tags, sorted by name", async () => {
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            name: "product",
            color: "blue",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
          {
            name: "Research",
            color: "red",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const response = await listTags(apiEvent());

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
          {
            name: "product",
            color: "blue",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
          {
            name: "Research",
            color: "red",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    });

    it("defaults tags stored before colors existed to gray", async () => {
      dynamoMock.on(QueryCommand).resolves({
        Items: [{ name: "legacy", createdAt: "2026-01-01T00:00:00.000Z" }],
      });

      const response = await listTags(apiEvent());

      expect(JSON.parse(response.body).tags[0]).toEqual({
        name: "legacy",
        color: "gray",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("falls back to gray when a stored color is not in the palette", async () => {
      dynamoMock.on(QueryCommand).resolves({
        Items: [{ name: "odd", color: "chartreuse" }],
      });

      const response = await listTags(apiEvent());

      expect(JSON.parse(response.body).tags[0].color).toBe("gray");
    });
  });

  describe("POST /tags", () => {
    it("creates a tag under the user partition with a normalized key", async () => {
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(QueryCommand).resolves({ Count: 0 });
      dynamoMock.on(PutCommand).resolves({});

      const response = await createTag(
        apiEvent({ body: JSON.stringify({ name: "  Research  " }) }),
      );

      expect(response.statusCode).toBe(200);
      const put = dynamoMock
        .commandCalls(PutCommand)
        .find((c) => !isRateLimitCall(c))!.args[0].input;
      expect(put.Item).toEqual(
        expect.objectContaining({
          pk: "USER#owner",
          sk: "TAG#research",
          name: "Research",
          color: "gray",
        }),
      );
      expect(put.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(JSON.parse(response.body).tag.name).toBe("Research");
    });

    it("stores the requested color", async () => {
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(QueryCommand).resolves({ Count: 0 });
      dynamoMock.on(PutCommand).resolves({});

      const response = await createTag(
        apiEvent({
          body: JSON.stringify({ name: "research", color: "purple" }),
        }),
      );

      expect(response.statusCode).toBe(200);
      expect(
        dynamoMock.commandCalls(PutCommand).find((c) => !isRateLimitCall(c))!
          .args[0].input.Item,
      ).toEqual(expect.objectContaining({ color: "purple" }));
      expect(JSON.parse(response.body).tag.color).toBe("purple");
    });

    it("rejects a color outside the palette", async () => {
      const response = await createTag(
        apiEvent({
          body: JSON.stringify({ name: "research", color: "chartreuse" }),
        }),
      );

      expect(response.statusCode).toBe(400);
      expect(
        dynamoMock.commandCalls(PutCommand).filter((c) => !isRateLimitCall(c)),
      ).toHaveLength(0);
    });

    it("returns the stored canonical tag when a differently-cased duplicate is created", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          name: "Research",
          color: "green",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const response = await createTag(
        apiEvent({
          body: JSON.stringify({ name: "RESEARCH", color: "red" }),
        }),
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).tag).toEqual({
        name: "Research",
        color: "green",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(
        dynamoMock.commandCalls(PutCommand).filter((c) => !isRateLimitCall(c)),
      ).toHaveLength(0);
    });

    it("returns the winner's record when a concurrent create wins the race", async () => {
      dynamoMock
        .on(GetCommand)
        .resolvesOnce({})
        .resolves({
          Item: {
            name: "Research",
            color: "green",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });
      dynamoMock.on(QueryCommand).resolves({ Count: 0 });
      dynamoMock.on(PutCommand).rejects(
        Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        }),
      );

      const response = await createTag(
        apiEvent({ body: JSON.stringify({ name: "research" }) }),
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).tag.name).toBe("Research");
    });

    it("reports a conflict when the raced tag is gone rather than claiming success", async () => {
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(QueryCommand).resolves({ Count: 0 });
      dynamoMock.on(PutCommand).rejects(
        Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        }),
      );

      const response = await createTag(
        apiEvent({ body: JSON.stringify({ name: "research" }) }),
      );

      expect(response.statusCode).toBe(409);
    });

    it("rejects creation once the per-user tag cap is reached", async () => {
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(QueryCommand).resolves({ Count: 200 });

      const response = await createTag(
        apiEvent({ body: JSON.stringify({ name: "overflow" }) }),
      );

      expect(response.statusCode).toBe(409);
      expect(
        dynamoMock.commandCalls(PutCommand).filter((c) => !isRateLimitCall(c)),
      ).toHaveLength(0);
    });

    it("rejects an empty tag name", async () => {
      const response = await createTag(
        apiEvent({ body: JSON.stringify({ name: "   " }) }),
      );

      expect(response.statusCode).toBe(400);
      expect(
        dynamoMock.commandCalls(PutCommand).filter((c) => !isRateLimitCall(c)),
      ).toHaveLength(0);
    });
  });

  describe("PATCH /tags/{name}", () => {
    it("recolors the decoded tag in the user partition", async () => {
      dynamoMock.on(UpdateCommand).resolves({
        Attributes: {
          name: "Machine Learning",
          color: "blue",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const response = await updateTag(
        apiEvent({
          pathParameters: { name: "Machine%20Learning" },
          body: JSON.stringify({ color: "blue" }),
        }),
      );

      expect(response.statusCode).toBe(200);
      const update = dynamoMock
        .commandCalls(UpdateCommand)
        .find((c) => !isRateLimitCall(c))!.args[0].input;
      expect(update.Key).toEqual({
        pk: "USER#owner",
        sk: "TAG#machine learning",
      });
      expect(update.ExpressionAttributeValues).toEqual({ ":color": "blue" });
      expect(update.ConditionExpression).toBe("attribute_exists(pk)");
      expect(JSON.parse(response.body).tag).toEqual({
        name: "Machine Learning",
        color: "blue",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("rejects a color outside the palette", async () => {
      const response = await updateTag(
        apiEvent({
          pathParameters: { name: "research" },
          body: JSON.stringify({ color: "chartreuse" }),
        }),
      );

      expect(response.statusCode).toBe(400);
      expect(
        dynamoMock
          .commandCalls(UpdateCommand)
          .filter((c) => !isRateLimitCall(c)),
      ).toHaveLength(0);
    });

    it("rejects a missing color rather than clearing it", async () => {
      const response = await updateTag(
        apiEvent({
          pathParameters: { name: "research" },
          body: JSON.stringify({}),
        }),
      );

      expect(response.statusCode).toBe(400);
      expect(
        dynamoMock
          .commandCalls(UpdateCommand)
          .filter((c) => !isRateLimitCall(c)),
      ).toHaveLength(0);
    });

    it("returns 404 when the tag no longer exists", async () => {
      const conditionFailed = Object.assign(new Error("conditional"), {
        name: "ConditionalCheckFailedException",
      });
      dynamoMock.on(UpdateCommand).rejects(conditionFailed);

      const response = await updateTag(
        apiEvent({
          pathParameters: { name: "ghost" },
          body: JSON.stringify({ color: "blue" }),
        }),
      );

      expect(response.statusCode).toBe(404);
    });
  });

  describe("DELETE /tags/{name}", () => {
    it("deletes the decoded tag from the user partition", async () => {
      dynamoMock.on(DeleteCommand).resolves({});

      const response = await deleteTag(
        apiEvent({
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
