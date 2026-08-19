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

  it("falls back to dp_list when data_point_list is absent", () => {
    const catalog = parseDpCatalog({
      dp_list: [{ dp_id: 158, type: "enum", values: [0, 1, 2, 3] }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("parses dp_id (primary field name) and non-enum type — adds no range entry", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 159, type: "bool" }],
    });
    expect(catalog.enumRanges.has(159)).toBe(false);
    expect(catalog).not.toBe(EMPTY_DP_CATALOG);
  });

  it("parses id (alternate field name) as fallback for enum type", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ id: 158, type: "enum", values: [0, 1, 2, 3] }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
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

  it("handles string dp_id for enum type", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: "158", type: "enum", values: [0, 1, 2, 3] }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("skips entries with invalid dp_id — valid entry still parsed", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        { dp_id: -1, type: "bool" },
        { dp_id: 0, type: "bool" },
        { type: "bool" },
        { dp_id: 158, type: "enum", values: [0, 1] },
      ],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1]);
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
    expect(catalog.enumRanges.has(158)).toBe(false);
    expect(catalog.enumRanges.has(159)).toBe(false);
    expect(catalog).not.toBe(EMPTY_DP_CATALOG);
  });

  it("handles multiple DPs of mixed types in one response", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        { dp_id: 158, type: "enum", values: [0, 1, 2, 3] },
        { dp_id: 159, type: "bool" },
        { dp_id: 160, type: "integer" },
      ],
    });
    expect(catalog.enumRanges.size).toBe(1);
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
    expect(catalog.enumRanges.has(159)).toBe(false);
    expect(catalog.enumRanges.has(160)).toBe(false);
  });

  it("ignores invalid JSON in stringified values — DP still parsed, no range added", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, type: "enum", values: "not-json" }],
    });
    expect(catalog.enumRanges.has(158)).toBe(false);
    expect(catalog).not.toBe(EMPTY_DP_CATALOG);
  });
});
