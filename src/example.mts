import { createMockResources } from "./mock-resources.mjs";
import type { MockResources } from "./mock-resources.mjs";
import { TEST_DATA } from "./test-data.mjs";
import { createTestRunner } from "./test-runner.mjs";
import type { ResourceScope, TestFunction, TestResult, WithTestData } from "./test-runner.mjs";

const events: string[] = [];
const test: TestFunction<MockResources> = createTestRunner(
  (scope: ResourceScope): Promise<MockResources> => createMockResources(scope, events),
  TEST_DATA,
);

test(
  "initial highlight list",
  { dataId: "Default" },
  async ({ page, testData }: WithTestData<MockResources>): Promise<void> => {
    events.push(
      `snapshot: ${testData.snapshots[0]?.snapshotTestDescription}`,
      `codemark: ${testData.codemarkPath}`,
    );
    await page.goto("https://example.com");
  },
);

test("basic smoke test", async ({ apiClient }: MockResources): Promise<void> => {
  // Even though only apiClient is mentioned, all four resources are created.
  if ((await apiClient.ping()) !== "pong") {
    throw new Error("Unexpected ping response");
  }
  events.push("smoke test: ok");
});

test("a second page test", async ({ page }: MockResources): Promise<void> => {
  await page.goto("https://example.com/another-test");
});

const results: readonly TestResult[] = await test.run();
for (const event of events) {
  console.log("event:", event);
}

console.log("\nResults:");
for (const result of results) {
  console.log(
    `${result.status === "passed" ? "PASS" : "FAIL"} ${result.title} (${result.durationMS.toFixed(2)} ms)`,
  );
  if (result.status === "failed") {
    console.error(result.error);
  }
}

// run() returns a report instead of rejecting for ordinary test failures.
// The executable entry point must therefore decide its own exit status.
if (
  results.some(
    (
      result: TestResult,
    ): result is Readonly<{
      title: string;
      status: "failed";
      durationMS: number;
      error: unknown;
    }> => result.status === "failed",
  )
) {
  process.exitCode = 1;
}
