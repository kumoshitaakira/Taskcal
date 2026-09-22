import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMonthlyCsv, CSV_COLUMNS, type CsvManifest } from "@/adapters/csv/monthly-csv";

const fixture = path.resolve("fixtures/dev/month-2026-09");
async function input() {
  return {
    csv: await readFile(path.join(fixture, "schedule.csv"), "utf8"),
    manifest: JSON.parse(
      await readFile(path.join(fixture, "manifest.json"), "utf8"),
    ) as CsvManifest,
  };
}

function editFirstRow(csv: string, column: (typeof CSV_COLUMNS)[number], value: string): string {
  const lines = csv.trimEnd().split("\n");
  const cells = lines[1].split(",");
  cells[CSV_COLUMNS.indexOf(column)] = value;
  lines[1] = cells.join(",");
  return lines.join("\n") + "\n";
}

describe("月内固定CSV（正式採用前の入出力）", () => {
  it("A06: 保存・別読込・行順変更でもID、状態と内容版を保持する", async () => {
    const { csv, manifest } = await input();
    const first = parseMonthlyCsv(csv, manifest);
    const directory = await mkdtemp(path.join(tmpdir(), "taskcal-csv-"));
    try {
      const output = path.join(directory, "normalized.csv");
      await writeFile(output, first.normalizedCsv, { flag: "wx" });
      const persisted = await readFile(output, "utf8");
      const [header, ...rows] = persisted.trimEnd().split("\n");
      // BOM・CRLF・集合の順序は意味を変えない。
      manifest.staffIds.reverse();
      manifest.days?.reverse().forEach((day) => day.assignmentIds.reverse());
      const again = parseMonthlyCsv(
        "\uFEFF" + [header, ...rows.reverse()].join("\r\n") + "\r\n",
        manifest,
      );
      expect(again).toEqual(first);
      expect(again.assignments).toHaveLength(7);
      expect(again.assignments.map((row) => row.status)).toEqual(
        expect.arrayContaining(["SCHEDULED", "COMPLETED", "CANCELLED"]),
      );
      expect(again.assignments.every((row) => row.sourceCaseId === undefined)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("A06: 時間変更で勤務IDは保持し、内容版だけを変更する", async () => {
    const { csv, manifest } = await input();
    const first = parseMonthlyCsv(csv, manifest);
    const edited = parseMonthlyCsv(
      editFirstRow(csv, "startAt", "2026-09-01T10:15:00+09:00"),
      manifest,
    );
    expect(edited.assignments.map((row) => row.shiftAssignmentId)).toEqual(
      first.assignments.map((row) => row.shiftAssignmentId),
    );
    expect(edited.sourceRevision).not.toBe(first.sourceRevision);
  });

  it("A09: 全日を宣言したfixtureのみCOMPLETE。空日を明示している", async () => {
    const { csv, manifest } = await input();
    const result = parseMonthlyCsv(csv, manifest);
    expect(result.completeness).toBe("COMPLETE");
    expect(result.missingDates).toEqual([]);
    expect(result.manifest.days).toHaveLength(30);
    expect(result.manifest.days?.find((day) => day.date === "2026-09-02")?.assignmentIds).toEqual(
      [],
    );
  });

  it("A09: 空日の宣言欠落でもINCOMPLETE。範囲宣言なしはUNKNOWN", async () => {
    const { csv, manifest } = await input();
    const full = parseMonthlyCsv(csv, manifest);
    manifest.days = manifest.days?.filter((day) => day.date !== "2026-09-02");
    const partial = parseMonthlyCsv(csv, manifest);
    expect(partial.completeness).toBe("INCOMPLETE");
    expect(partial.missingDates).toEqual(["2026-09-02"]);
    expect(partial.sourceRevision).not.toBe(full.sourceRevision);
    delete manifest.days;
    const unknown = parseMonthlyCsv(csv, manifest);
    expect(unknown.completeness).toBe("UNKNOWN");
    expect(unknown.missingDates).toHaveLength(30);
  });

  it("A09: 取得済み日の行欠落を完全な入力として受理しない", async () => {
    const { csv, manifest } = await input();
    const [header, , ...rows] = csv.trimEnd().split("\n");
    expect(() => parseMonthlyCsv([header, ...rows].join("\n"), manifest)).toThrow("勤務ID集合");
  });

  it("明示的に全日空の月と、全日未取得を区別する", async () => {
    const { manifest } = await input();
    manifest.days?.forEach((day) => {
      day.assignmentIds = [];
    });
    expect(parseMonthlyCsv(CSV_COLUMNS.join(",") + "\n", manifest).completeness).toBe("COMPLETE");
    manifest.days = [];
    expect(parseMonthlyCsv(CSV_COLUMNS.join(","), manifest).completeness).toBe("INCOMPLETE");
  });

  it.each([
    ["shiftAssignmentId", ""],
    ["shiftAssignmentId", "row-1"],
    ["staffId", "00000004-0000-4000-8000-000000000099"],
    ["roleCode", "OTHER"],
    ["status", "UNKNOWN_STATUS"],
    ["businessDate", "2026-09-31"],
    ["startAt", "2026-09-01T10:01:00+09:00"],
    ["startAt", "2026-09-01T10:00:00Z"],
    ["startAt", "2026-09-01T18:00:00+09:00"],
    ["endAt", "2026-09-02T00:00:00+09:00"],
  ] as const)("不正・範囲外入力を拒否する: %s=%s", async (column, value) => {
    const { csv, manifest } = await input();
    expect(() => parseMonthlyCsv(editFirstRow(csv, column, value), manifest)).toThrow();
  });

  it("重複IDを行順や内容が違っても拒否する", async () => {
    const { csv, manifest } = await input();
    const duplicate = csv.trimEnd() + "\n" + csv.split("\n")[1] + "\n";
    expect(() => parseMonthlyCsv(duplicate, manifest)).toThrow("勤務IDが重複");
  });

  it("未知の勤務状態は既存契約どおりOUT_OF_SCOPEで返す", async () => {
    const { csv, manifest } = await input();
    expect(() => parseMonthlyCsv(editFirstRow(csv, "status", "UNKNOWN_STATUS"), manifest)).toThrow(
      expect.objectContaining({ code: "OUT_OF_SCOPE" }),
    );
  });

  it("同じ勤務表IDを別営業日に使えない", async () => {
    const { csv, manifest } = await input();
    manifest.days![1].scheduleId = manifest.days![0].scheduleId;
    expect(() => parseMonthlyCsv(csv, manifest)).toThrow("一対一");
  });

  it("宣言の重複日、不正な日、他月、余分なキーを拒否する", async () => {
    const { csv, manifest } = await input();
    expect(() =>
      parseMonthlyCsv(csv, { ...manifest, days: [manifest.days![0], manifest.days![0]] }),
    ).toThrow();
    expect(() => parseMonthlyCsv(csv, { ...manifest, month: "2026-10" })).toThrow();
    expect(() => parseMonthlyCsv(csv, { ...manifest, trusted: true })).toThrow();
    manifest.days![0].date = "2026-09-31";
    expect(() => parseMonthlyCsv(csv, manifest)).toThrow();
  });

  it("月末日数を検査する（閏年2月）", async () => {
    const { manifest } = await input();
    const csv = CSV_COLUMNS.join(",");
    expect(
      parseMonthlyCsv(csv, { ...manifest, month: "2024-02", days: [] }).missingDates,
    ).toHaveLength(29);
    expect(
      parseMonthlyCsv(csv, { ...manifest, month: "2026-02", days: [] }).missingDates,
    ).toHaveLength(28);
  });

  it("固定形式外の列・引用符・空行を黙って捨てない", async () => {
    const { csv, manifest } = await input();
    for (const bad of [
      csv.replace("scheduleId", "name"),
      csv + "\n",
      csv.replace("FLOOR", '"FLOOR"'),
      csv.replace("FLOOR", "FLOOR,extra"),
    ]) {
      expect(() => parseMonthlyCsv(bad, manifest)).toThrow();
    }
  });

  it("通常勤務8時間は保持し、代替勤務の4時間超は拒否する", async () => {
    const { csv, manifest } = await input();
    expect(parseMonthlyCsv(csv, manifest).assignments[0].sourceCaseId).toBeUndefined();
    expect(() =>
      parseMonthlyCsv(
        editFirstRow(csv, "sourceCaseId", "00000005-0000-4000-8000-000000000002"),
        manifest,
      ),
    ).toThrow("最長追加勤務");
  });

  it("異常入力の原文をエラーに出さない", async () => {
    const { csv, manifest } = await input();
    try {
      parseMonthlyCsv(editFirstRow(csv, "staffId", "private-input-value"), manifest);
      expect.fail("不正入力を受理した");
    } catch (error) {
      expect(String(error)).not.toContain("private-input-value");
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
  });
});
