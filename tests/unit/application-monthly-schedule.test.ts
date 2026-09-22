import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMonthlyCsv, type CsvManifest } from "@/adapters/csv/monthly-csv";
import { createMonthlyScheduleSnapshot } from "@/application/monthly-schedule";

const fixture = path.resolve("fixtures/dev/month-2026-09");

async function input() {
  return {
    csv: await readFile(path.join(fixture, "schedule.csv"), "utf8"),
    manifest: JSON.parse(
      await readFile(path.join(fixture, "manifest.json"), "utf8"),
    ) as CsvManifest,
  };
}

describe("application monthly schedule conversion", () => {
  it("A09: 完全なCSVからsourceRevisionを保持したsnapshotを作る", async () => {
    const { csv, manifest } = await input();
    const monthlyCsv = parseMonthlyCsv(csv, manifest);
    const snapshot = createMonthlyScheduleSnapshot(monthlyCsv);

    expect(snapshot).toMatchObject({
      storeId: monthlyCsv.manifest.storeId,
      timezone: "Asia/Tokyo",
      month: "2026-09",
      sourceRevision: monthlyCsv.sourceRevision,
      staffIds: monthlyCsv.manifest.staffIds,
      completeness: "COMPLETE",
    });
    expect(snapshot.assignments).toHaveLength(monthlyCsv.assignments.length);
  });

  it.each(["INCOMPLETE", "UNKNOWN"] as const)(
    "A09: %sのCSVはsnapshotへ変換しない",
    async (completeness) => {
      const { csv, manifest } = await input();
      const monthlyCsv = parseMonthlyCsv(csv, manifest);
      const incomplete = { ...monthlyCsv, completeness };

      expect(() => createMonthlyScheduleSnapshot(incomplete)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    },
  );

  it("A09: 完全と宣言されても対象月の日付宣言が欠けていれば拒否する", async () => {
    const { csv, manifest } = await input();
    const monthlyCsv = parseMonthlyCsv(csv, manifest);
    const forgedComplete = {
      ...monthlyCsv,
      manifest: {
        ...monthlyCsv.manifest,
        days: monthlyCsv.manifest.days?.slice(0, -1),
      },
      missingDates: [],
      completeness: "COMPLETE" as const,
    };

    expect(() => createMonthlyScheduleSnapshot(forgedComplete)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
