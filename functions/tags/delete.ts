import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { dynamo, extractUserId } from "../utils";

const TableName = process.env.TAGS_TABLE_NAME!;

/** API handler for DELETE /tags/{name}; removes the caller's tag. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, response: authError } = await extractUserId(event);
  if (authError) return authError;

  const name = decodeTagName(event.pathParameters);
  if (typeof name !== "string") return name;

  await dynamo.send(
    new DeleteCommand({
      TableName: TableName,
      Key: { pk: `USER#${userId}`, sk: `TAG#${name.toLowerCase()}` },
    }),
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name, deleted: true }),
  };
}

/** Reads the tag name from the path, or returns a 400 response when it is invalid. */
function decodeTagName(
  pathParameters: APIGatewayProxyEventV2["pathParameters"],
): string | APIGatewayProxyStructuredResultV2 {
  const raw = pathParameters?.name;
  let decoded: string;
  try {
    decoded = raw ? decodeURIComponent(raw) : "";
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Tag name contains invalid URL encoding" }),
    };
  }
  const name = decoded.trim();
  if (!name) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Tag name is required" }),
    };
  }

  return name;
}
