import { describe, expect, it, vi } from "vitest";
import { cosineSimilarity, embeddingProfile, embeddingValues, findTopK, passageText, queryText, sameEmbeddingProfile, validEmbedding } from "../embeddings.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("P10_MODEL_DOWNLOAD_FORBIDDEN"); }),
}));
const vector = (...values: number[]) => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  return bytes;
};

describe("P10 generation preprocessing identity", () => {
  it("records complete actual model/preprocessing with unknown concrete revision", () => {
    expect(JSON.parse(embeddingProfile("p10-e5-model", 2))).toEqual({
      dim: 2, dtype: "q8", input_text_format: "kind: name — summary", max_length: 256,
      model: "p10-e5-model", normalize: true, passage_prefix: "passage: ", pooling: "mean",
      query_prefix: "query: ", revision: null,
    });
    expect(passageText("text", "p10-e5-model")).toBe("passage: text");
    expect(queryText("text", "p10-e5-model")).toBe("query: text");
  });

  it("ignores only learned dimension, never model/preprocessing/unknown profile", () => {
    const profile = embeddingProfile("p10-model", 2);
    expect(sameEmbeddingProfile(profile, embeddingProfile("p10-model", 3))).toBe(true);
    expect(sameEmbeddingProfile(profile, embeddingProfile("p10-other", 2))).toBe(false);
    expect(sameEmbeddingProfile(profile, JSON.stringify({ ...JSON.parse(profile), normalize: false }))).toBe(false);
    for (const invalid of ["null", "[]", "{broken"]) expect(sameEmbeddingProfile(invalid, invalid)).toBe(false);
  });
});

describe("P10 float32 vector eligibility", () => {
  it("reads unaligned buffers and preserves cosine compatibility", () => {
    const padded = Buffer.alloc(9);
    vector(1, 0).copy(padded, 1);
    const unaligned = padded.subarray(1);
    expect([...embeddingValues(unaligned)]).toEqual([1, 0]);
    expect(cosineSimilarity(unaligned, vector(1, 0))).toBeCloseTo(1);
    expect(cosineSimilarity(vector(1, 0), vector(0, 0))).toBe(0);
  });

  it.each([Buffer.alloc(0), Buffer.alloc(3), vector(0, 0), vector(NaN, 1), vector(Infinity, 1), vector(1, 0, 0)])("rejects malformed/nonfinite/zero/wrong dimension buffer %j", (buffer) => {
    expect(validEmbedding(buffer, 2)).toBe(false);
  });

  it("filters bad candidates without throwing or displacing a valid candidate", () => {
    const candidates = [
      ["good", vector(1, 0)], ["zero", vector(0, 0)], ["nan", vector(NaN, 1)],
      ["wrongdim", vector(1, 0, 0)], ["malformed", Buffer.alloc(3)], ["null", null],
    ].map(([id, embedding]) => ({ id: id as string, name: "name", kind: "feature", summary: "", embedding: embedding as Buffer | null }));
    expect(findTopK(vector(1, 0), candidates, 10)).toEqual([{ id: "good", similarity: 1 }]);
  });
});
