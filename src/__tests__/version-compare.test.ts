import { describe, expect, it } from "vitest";
import { compareVersions } from "../version-compare.js";

describe("compareVersions (план 32)", () => {
  it("равные, младшие и старшие версии", () => {
    expect(compareVersions("2.12.3", "2.12.3")).toBe(0);
    expect(compareVersions("2.12.2", "2.12.3")).toBe(-1);
    expect(compareVersions("2.13.0", "2.12.3")).toBe(1);
  });

  it("ведущая v и пробелы по краям срезаются", () => {
    expect(compareVersions("v2.12.3", "2.12.3")).toBe(0);
    expect(compareVersions("  2.12.3  ", "v 2.12.3")).toBeNull(); // пробел внутри — мусор, не сравнение
    expect(compareVersions("  v2.12.3  ", "2.12.3")).toBe(0);
  });

  it("пререлиз ниже релиза того же ядра (semver §9)", () => {
    expect(compareVersions("2.0.0-fork.1", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "2.0.0-fork.1")).toBe(1);
    expect(compareVersions("2.12.3-rc.1", "2.12.3")).toBe(-1);
    expect(compareVersions("2.12.3", "2.12.3-rc.1")).toBe(1);
  });

  it("оба пререлиза — по идентификаторам: число как число, буквы лексически, число ниже букв (semver §11)", () => {
    expect(compareVersions("2.12.3-rc.2", "2.12.3-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-2", "1.0.0-10")).toBe(-1);
    expect(compareVersions("1.0.0-01", "1.0.0-1")).toBe(0); // ведущие нули не важны
    expect(compareVersions("1.0.0-1.alpha", "1.0.0-1.beta")).toBe(-1);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBe(1);
    // меньший набор идентификаторов ниже при равном префиксе
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
  });

  it("не три числовых сегмента, мусор и пустая строка — null (не «равно»)", () => {
    expect(compareVersions("2.12", "2.12.3")).toBeNull();
    expect(compareVersions("2.12.3.4", "2.12.3")).toBeNull();
    expect(compareVersions("next", "2.12.3")).toBeNull();
    expect(compareVersions("vNext", "2.12.3")).toBeNull();
    expect(compareVersions("", "2.12.3")).toBeNull();
    expect(compareVersions("2.12.3", "2.12.3-rc..1")).toBeNull(); // пустой идентификатор пререлиза
  });

  it("build-метаданные отбрасываются до сравнения", () => {
    expect(compareVersions("2.12.3+build.5", "2.12.3")).toBe(0);
    expect(compareVersions("2.12.3+build.5", "2.12.4")).toBe(-1);
    expect(compareVersions("2.12.4", "2.12.3+build.5")).toBe(1);
  });
});
