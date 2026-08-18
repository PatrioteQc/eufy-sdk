import { parseDpCatalog, EMPTY_DP_CATALOG } from "../dp-catalog.js";

describe("parseDpCatalog", () => {
  it("returns EMPTY_DP_CATALOG for null/undefined/non-object inputs", () => {
    expect(parseDpCatalog(null)).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog(undefined)).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog(42)).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog("string")).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog([])).toBe(EMPTY_DP_CATALOG);
  });

  it("returns EMPTY_DP_CATALOG when data_point_list is absent or empty", () => {
    expect(parseDpCatalog({})).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog({ data_point_list: [] })).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog({ data_point_list: null })).toBe(EMPTY_DP_CATALOG);
  });

  it("parses dp_id (primary field name) and bool type", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 159, type: "bool" }],
    });
    expect(catalog.dpIds.has(159)).toBe(true);
    expect(catalog.enumRanges.has(159)).toBe(false);
  });

  it("parses id (alternate field name) as fallback", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ id: 158, type: "enum", values: [0, 1, 2, 3] }],
    });
    expect(catalog.dpIds.has(158)).toBe(true);
  });

  it("parses enum range from a plain number array", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, type: "enum", values: [0, 1, 2, 3] }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("parses enum range from a JSON-stringified number array", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, type: "enum", values: "[0,1,2,3]" }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it('parses enum range from a JSON-stringified {"range":[...]} object', () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, type: "enum", values: '{"range":["0","1","2","3"]}' }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("parses numeric-string values within a plain array", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, type: "Enum", values: ["0", "1", "2"] }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2]);
  });

  it("handles string dp_id", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: "158", type: "enum", values: [0, 1, 2, 3] }],
    });
    expect(catalog.dpIds.has(158)).toBe(true);
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("skips entries with invalid dp_id", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        { dp_id: -1, type: "bool" },
        { dp_id: 0, type: "bool" },
        { type: "bool" },
        { dp_id: 159, type: "bool" },
      ],
    });
    expect(catalog.dpIds.size).toBe(1);
    expect(catalog.dpIds.has(159)).toBe(true);
  });

  it("returns EMPTY_DP_CATALOG when all entries are invalid", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: -1 }, {}],
    });
    expect(catalog).toBe(EMPTY_DP_CATALOG);
  });

  it("does not add enum range when values is missing or empty", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        { dp_id: 158, type: "enum" },
        { dp_id: 159, type: "enum", values: [] },
      ],
    });
    expect(catalog.dpIds.has(158)).toBe(true);
    expect(catalog.dpIds.has(159)).toBe(true);
    expect(catalog.enumRanges.has(158)).toBe(false);
    expect(catalog.enumRanges.has(159)).toBe(false);
  });

  it("handles multiple DPs of mixed types in one response", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        { dp_id: 158, type: "enum", values: [0, 1, 2, 3] },
        { dp_id: 159, type: "bool" },
        { dp_id: 160, type: "integer" },
      ],
    });
    expect(catalog.dpIds.size).toBe(3);
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
    expect(catalog.enumRanges.has(159)).toBe(false);
    expect(catalog.enumRanges.has(160)).toBe(false);
  });

  it("ignores invalid JSON in stringified values", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, type: "enum", values: "not-json" }],
    });
    expect(catalog.dpIds.has(158)).toBe(true);
    expect(catalog.enumRanges.has(158)).toBe(false);
  });
});
