import { createMockResources } from "./mock-resources.mjs";
import type { MockResources, MockPage } from "./mock-resources.mjs";
import { TEST_DATA } from "./test-data.mjs";
import type { TestData } from "./test-data.mjs";
import { createTestRunner } from "./test-runner.mjs";
import type { TestInfo, TestResult, TestRunner, TestSuite, WithTestData } from "./test-runner.mjs";

const events: string[] = [];
console.log("\nCreating test");
const test: TestSuite<MockResources> = createTestRunner<MockResources>({
  createResources: ({ scope, isHeadless }: TestInfo): Promise<MockResources> => {
    events.push(`headless option: ${isHeadless ?? "default"}`);
    return createMockResources(scope, events);
  },
  // oxlint-disable-next-line legibility/no-trivial-wrapper-functions
  loadTestData: (id: string): TestData | undefined => TEST_DATA.get(id),
});

console.log("\nCreating headlessTest");
const headlessTest: TestRunner<MockResources> = test.configure({ isHeadless: true });
console.log("\nCreating headedTest");
const headedTest: TestRunner<MockResources> = test.configure({
  isHeadless: false,
  willAttachConsole: true,
});

console.log("\nCreating headlessTest.withData");
headlessTest.withData("Default")(
  "initial highlight list",
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

console.log("\nCreating twoPageTest");
const twoPageTest: TestRunner<MockResources & { secondPage: MockPage }> = headedTest.extend(
  async (
    { browser }: Readonly<MockResources>,
    { scope }: TestInfo,
  ): Promise<{ secondPage: MockPage }> => ({
    secondPage: await scope.acquire(
      (): Promise<MockPage> => browser.newPage(),
      (page: MockPage): Promise<void> => page.close(),
    ),
  }),
);

twoPageTest(
  "a second page test",
  async ({ secondPage }: MockResources & { secondPage: MockPage }): Promise<void> => {
    await secondPage.goto("https://example.com/another-test");
  },
);

console.debug("\nRunning tests...\n");
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
  results.some((result: TestResult): result is Readonly<TestResult> => result.status === "failed")
) {
  process.exitCode = 1;
}
