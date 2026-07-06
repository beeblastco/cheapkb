import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = Resource.Meta.name;

export async function handler(event: any) {
  const jobId = event.pathParameters?.id;
  if (!jobId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Job ID is required" }),
    };
  }

  const result = await dynamo.send(
    new GetCommand({
      TableName,
      Key: { pk: `JOB#${jobId}`, sk: "META" },
    }),
  );
  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Job not found" }),
    };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job: result.Item }),
  };
}
