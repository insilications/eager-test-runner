import path from "node:path";

export interface TestDataSnapshot {
  readonly snapshotPath: string;
  readonly snapshotTestDescription: string;
}

export interface TestData {
  readonly codemarkPath: string;
  readonly snapshots: readonly TestDataSnapshot[];
}

// These are only paths: the runner does NOT open or parse any snapshot files.
// Replace this example registry with your existing TEST_DATA map.
const defaultDir = path.resolve("tests/e2e/fixtures/snapshots/default");

export const TEST_DATA: ReadonlyMap<string, TestData> = new Map([
  [
    "Default",
    {
      codemarkPath: path.join(defaultDir, "codemark.json"),
      snapshots: [
        {
          snapshotPath: path.join(defaultDir, "[initial]_[highlights-list].json5"),
          snapshotTestDescription: "Initial Highlight List",
        },
        {
          snapshotPath: path.join(defaultDir, "[initial]_[filter-bar].json5"),
          snapshotTestDescription: "Initial Filter Bar",
        },
        {
          snapshotPath: path.join(
            defaultDir,
            "[after-filtering-by-bug-tag]_[highlights-list].json5",
          ),
          snapshotTestDescription: "Highlight List After Filtering by BUG tag",
        },
      ],
    },
  ],
  ["NoSnapshots", { codemarkPath: path.join(defaultDir, "codemark.json"), snapshots: [] }],
]);
