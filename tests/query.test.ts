import { describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: {
    Meta: { name: "table" },
    Storage: { name: "storage" },
  },
}));

import { buildFilter } from "../functions/query/index";

describe("query tenant filter", () => {
  it("always uses the authenticated user and ignores a caller override", () => {
    expect(
      buildFilter({ userId: "attacker", year: { $gte: 2024 } }, "owner"),
    ).toEqual({ userId: "owner", year: { $gte: 2024 } });
  });

  it("rejects unknown metadata keys", () => {
    expect(() => buildFilter({ secret: "value" }, "owner")).toThrow(
      "Unsupported filter",
    );
  });
});
