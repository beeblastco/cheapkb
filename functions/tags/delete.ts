import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { decodeTagName, dynamo, extractUserId } from "../utils";

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
