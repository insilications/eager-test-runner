import { createMockResources } from "./mock-resources.mjs";
import type { MockResources, MockPage } from "./mock-resources.mjs";
import { TEST_DATA } from "./test-data.mjs";
import type { TestData } from "./test-data.mjs";
import { createTestRunner } from "./test-runner.mjs";
import type {
  FallbackTestRunner,
  FallbackTestSuite,
  TestInfo,
  TestResult,
  WithTestData,
} from "./test-runner.mjs";

const events: string[] = [];
console.log("\nCreating createTestRunner.withDefaultData");
type Context = WithTestData<MockResources>;
const test: FallbackTestSuite<Context> = createTestRunner.withDefaultData<MockResources>({
  createResources: ({ scope, isHeadless }: TestInfo): Promise<MockResources> => {
    events.push(`headless option: ${isHeadless ?? "default"}`);
    return createMockResources(scope, events);
  },
  dataId: "Default",
  // oxlint-disable-next-line legibility/no-trivial-wrapper-functions
  loadTestData: (id: string): TestData | undefined => TEST_DATA.get(id),
  options: { willAttachConsole: false },
});

console.log("\nCreating headlessTest");
const headlessTest: FallbackTestRunner<Context> = test.configure({ isHeadless: true });
console.log("\nCreating headedTest");
const headedTest: FallbackTestRunner<Context> = test.configure({
  isHeadless: false,
  willAttachConsole: true,
});

console.log("\nRegistering a test with the default data");
headlessTest(
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
const twoPageTest: FallbackTestRunner<Context & { secondPage: MockPage }> = headedTest.extend(
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

twoPageTest.withData("NoSnapshots")(
  "a second page test",
  async ({ secondPage, testData }: Context & { secondPage: MockPage }): Promise<void> => {
    events.push(`snapshot count for second page: ${testData.snapshots.length}`);
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
