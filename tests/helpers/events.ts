import type { APIGatewayProxyEventV2, S3Event, SQSEvent } from "aws-lambda";

const API_EVENT: APIGatewayProxyEventV2 = {
  version: "2.0",
  routeKey: "$default",
  rawPath: "/",
  rawQueryString: "",
  headers: { authorization: "Bearer dummy" },
  requestContext: {
    accountId: "123456789012",
    apiId: "api-id",
    domainName: "api.example.com",
    domainPrefix: "api",
    http: {
      method: "GET",
      path: "/",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "vitest",
    },
    requestId: "request-id",
    routeKey: "$default",
    stage: "$default",
    time: "01/Jan/2026:00:00:00 +0000",
    timeEpoch: 1767225600000,
  },
  isBase64Encoded: false,
};

function apiEvent(
  input: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
  return {
    ...API_EVENT,
    ...input,
    headers: { ...API_EVENT.headers, ...input.headers },
    requestContext: input.requestContext ?? API_EVENT.requestContext,
  };
}

function jsonApiEvent(
  body: unknown,
  input: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
  return apiEvent({ ...input, body: JSON.stringify(body) });
}

function s3Event(key = "raw/doc-1/sample.txt", size = 20): S3Event {
  return {
    Records: [
      {
        eventVersion: "2.1",
        eventSource: "aws:s3",
        awsRegion: "us-east-1",
        eventTime: "2026-01-01T00:00:00.000Z",
        eventName: "ObjectCreated:Put",
        userIdentity: { principalId: "principal" },
        requestParameters: { sourceIPAddress: "127.0.0.1" },
        responseElements: {
          "x-amz-request-id": "request-id",
          "x-amz-id-2": "request-id-2",
        },
        s3: {
          s3SchemaVersion: "1.0",
          configurationId: "configuration-id",
          bucket: {
            name: "storage",
            ownerIdentity: { principalId: "principal" },
            arn: "arn:aws:s3:::storage",
          },
          object: {
            key,
            size,
            eTag: "etag",
            sequencer: "sequencer",
          },
        },
      },
    ],
  };
}

function sqsEvent(messageId: string, body: string, receiveCount = 1): SQSEvent {
  return {
    Records: [
      {
        messageId,
        receiptHandle: "receipt",
        body,
        attributes: {
          ApproximateReceiveCount: String(receiveCount),
          SentTimestamp: "0",
          SenderId: "sender",
          ApproximateFirstReceiveTimestamp: "0",
          AWSTraceHeader: "trace",
        },
        messageAttributes: {},
        md5OfBody: "hash",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:queue",
        awsRegion: "us-east-1",
      },
    ],
  };
}

export { apiEvent, jsonApiEvent, s3Event, sqsEvent };
