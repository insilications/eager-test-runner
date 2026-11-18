import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { createMockResources, type MockPage, type MockResources } from "./mock-resources.mjs";
import { TEST_DATA, type TestData } from "./test-data.mjs";
import type {
  DefaultDataConfig,
  FallbackTestRunner,
  FallbackTestSuite,
  TestInfo,
  TestResult,
  TestRunner,
  TestRunnerConfig,
  TestSuite,
  WithTestData,
} from "./test-runner.mjs";
import { createTestRunner, createTestRunnerWithDefaults } from "./test-runner.mjs";

await test("the two factories validate upfront data IDs", (): void => {
  const config: TestRunnerConfig<object> = {
    createResources: (): object => ({}),
    loadTestData: (): undefined => undefined,
  };
  const defaults = { ...config, dataId: "" };
  assert.throws(
    (): void => {
      // @ts-expect-error A defined ID belongs to the defaults factory, even on a variable.
      createTestRunner(defaults);
    },
    { message: "Use `createTestRunnerWithDefaults()` to set a suite data ID.", name: "TypeError" },
  );
  assert.throws(
    (): void => {
      // @ts-expect-error The defaults factory requires an ID.
      createTestRunnerWithDefaults(config);
    },
    { message: "`createTestRunnerWithDefaults()` requires a string dataId.", name: "TypeError" },
  );
});

await test("interleaved handles share registration order and keep their options and types", async (t: TestContext): Promise<void> => {
  t.mock.method(console, "log", (): void => {
    /* noop */
  });
  const started: string[] = [];
  let loads = 0;
  const suite: TestSuite<{
    isHeadless: boolean | undefined;
    dataId: string | undefined;
  }> = createTestRunner({
    createResources: ({
      title,
      isHeadless,
      dataId,
    }: TestInfo): { dataId: string | undefined; isHeadless: boolean | undefined } => {
      started.push(title);
      return { dataId, isHeadless };
    },
    loadTestData: (id: string, opt: TestInfo): TestData | undefined => {
      loads++;
      assert.equal(opt.isHeadless, false);
      return TEST_DATA.get(id);
    },
  });
  const options = { isHeadless: true };
  const headless: TestRunner<{
    isHeadless: boolean | undefined;
    dataId: string | undefined;
  }> = suite.configure(options);
  options.isHeadless = false;
  const enriched: TestRunner<
    {
      isHeadless: boolean | undefined;
      dataId: string | undefined;
    } & {
      readonly testData: TestData;
    } & {
      attachConsole: boolean | undefined;
      path: string;
    }
  > = headless
    .withData("Default")
    .extend(
      (
        { testData }: { testData: TestData },
        info: TestInfo,
      ): { attachConsole: boolean | undefined; path: string } => ({
        attachConsole: info.willAttachConsole,
        path: testData.codemarkPath,
      }),
    )
    .configure({ isHeadless: false, willAttachConsole: true });

  // @ts-expect-error Only the root owns run().
  assert.equal(enriched.run, undefined);
  const rounds = 64;
  const titles: string[] = [];
  for (let i = 0; i < rounds; i++) {
    titles.push(`base ${i}`, `headless ${i}`, `data ${i}`);
    suite(
      `base ${i}`,
      (context: { isHeadless: boolean | undefined; dataId: string | undefined }): void => {
        assert.equal(context.isHeadless, undefined);
        // @ts-expect-error The base context has no testData field.
        assert.equal(context.testData, undefined);
      },
    );
    headless(
      `headless ${i}`,
      ({
        isHeadless,
        dataId,
      }: {
        isHeadless: boolean | undefined;
        dataId: string | undefined;
      }): void => {
        assert.equal(isHeadless, true);
        assert.equal(dataId, undefined);
      },
    );
    enriched(
      `data ${i}`,
      ({
        isHeadless,
        dataId,
        testData,
        path,
        attachConsole,
      }: {
        isHeadless: boolean | undefined;
        dataId: string | undefined;
        testData: TestData;
        path: string;
        attachConsole: boolean | undefined;
      }): void => {
        assert.equal(isHeadless, false);
        assert.equal(dataId, "Default");
        assert.equal(path, testData.codemarkPath);
        assert.equal(attachConsole, true);
      },
    );
  }

  assert.deepEqual(started, []);
  assert.equal(loads, 0);
  const results: readonly TestResult[] = await suite.run();
  assert.deepEqual(
    results.filter(
      (result): result is TestResult & { status: "failed" } => result.status === "failed",
    ),
    [],
  );
  assert.deepEqual(
    results.map((result: TestResult): string => result.title),
    titles,
  );
  assert.deepEqual(started, titles);
  assert.equal(loads, rounds);
  assert.deepEqual(await suite.run(), []);
});

await test("a root data ID is inherited and an override reaches earlier providers", async (): Promise<void> => {
  interface Resources {
    readonly factoryInfo: TestInfo;
  }
  type Context = WithTestData<Resources>;
  type Extended = Context & { readonly providerPath: string };
  const loads: string[] = [];
  const starts: string[] = [];
  const options = { isHeadless: true, willAttachConsole: true };
  const config: DefaultDataConfig<Resources> = {
    createResources: (info: TestInfo): Resources => {
      starts.push(info.title);
      return { factoryInfo: info };
    },
    dataId: "Default",
    loadTestData: (id: string, info: TestInfo): TestData => {
      assert.equal(id, info.dataId);
      loads.push(`${info.title}:${id}:${info.isHeadless}:${info.willAttachConsole}`);
      return { codemarkPath: id, snapshots: [] };
    },
    options,
  };
  const suite: FallbackTestSuite<Context> = createTestRunnerWithDefaults<Resources>(config);
  options.isHeadless = false;
  const derived: FallbackTestRunner<Extended> = suite.extend(
    ({ testData, factoryInfo }: Readonly<Context>, info: TestInfo): { providerPath: string } => {
      assert.strictEqual(factoryInfo, info);
      assert.equal(testData.codemarkPath, info.dataId);
      return { providerPath: testData.codemarkPath };
    },
  );
  const custom: TestRunner<
    Resources & {
      readonly testData: TestData;
    } & {
      readonly providerPath: string;
    }
  > = derived
    .configure({ isHeadless: false })
    .withData("Other")
    .configure({ willAttachConsole: false }) satisfies TestRunner<Extended>;
  function checkBody({ factoryInfo, testData, providerPath }: Extended): void {
    assert.equal(factoryInfo.dataId, testData.codemarkPath);
    assert.equal(providerPath, testData.codemarkPath);
  }
  suite("root", ({ testData }: Context): void => {
    assert.equal(testData.codemarkPath, "Default");
  });
  custom("custom", checkBody);
  derived("sibling", checkBody);
  custom("custom again", checkBody);
  assert.throws(
    (): void => {
      // @ts-expect-error An explicit replacement has already selected the ID on this branch.
      custom.withData("third");
    },
    // biome-ignore lint/performance/useTopLevelRegex: OK
    /already selected/,
  );
  assert.deepEqual(loads, []);
  assert.deepEqual(starts, []);
  const results: readonly TestResult[] = await suite.run();
  assert.deepEqual(
    results.filter((result: TestResult): boolean => result.status === "failed"),
    [],
  );
  assert.deepEqual(loads, [
    "root:Default:true:true",
    "custom:Other:false:false",
    "sibling:Default:true:true",
    "custom again:Other:false:false",
  ]);
  assert.deepEqual(starts, ["root", "custom", "sibling", "custom again"]);
});

await test("only the effective ID is validated before resource setup", async (): Promise<void> => {
  const loads: string[] = [];
  const starts: string[] = [];
  const suite: FallbackTestSuite<WithTestData> = createTestRunnerWithDefaults({
    createResources: ({ title }: TestInfo): object => {
      starts.push(title);
      return {};
    },
    dataId: "missing default",
    loadTestData: (id: string): Promise<TestData | undefined> => {
      loads.push(id);
      return Promise.resolve(
        id === "" ? { codemarkPath: "empty-id.json", snapshots: [] } : undefined,
      );
    },
  });
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const unexpectedBody: () => never = (): never => assert.fail("body ran with unknown data");
  suite("bad default", unexpectedBody);
  suite.withData("missing override")("bad override", unexpectedBody);
  suite.withData("")("valid override", ({ testData }: WithTestData): void => {
    assert.equal(testData.codemarkPath, "empty-id.json");
  });

  const [badDefault, badOverride, passed] = await suite.run();
  assert.ok(badDefault?.status === "failed" && badDefault.error instanceof Error);
  assert.equal(
    badDefault.error.message,
    'Unknown test data ID "missing default" in test "bad default".',
  );
  assert.ok(badOverride?.status === "failed" && badOverride.error instanceof Error);
  assert.equal(
    badOverride.error.message,
    'Unknown test data ID "missing override" in test "bad override".',
  );
  assert.equal(passed?.status, "passed");
  assert.deepEqual(loads, ["missing default", "missing override", ""]);
  assert.deepEqual(starts, ["valid override"]);
});

await test("initial options alone keep a plain context and fallback data remains additive", async (): Promise<void> => {
  const options = { isHeadless: true };
  interface Resources {
    readonly isHeadless: boolean | undefined;
  }
  const plain: TestSuite<Resources> = createTestRunner({
    createResources: ({ isHeadless }: TestInfo): Resources => ({ isHeadless }),
    loadTestData: (): never => assert.fail("lookup on a plain test"),
    options,
  });
  options.isHeadless = false;
  plain("plain", (context: Resources): void => {
    assert.equal(context.isHeadless, true);
    // @ts-expect-error Configuring options alone does not supply testData.
    assert.equal(context.testData, undefined);
  });
  assert.equal((await plain.run())[0]?.status, "passed");

  const resource = { testData: 42 };
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const loadTestData: () => TestData = (): TestData => ({ codemarkPath: "fixture", snapshots: [] });

  createTestRunnerWithDefaults({
    createResources: (): typeof resource => resource,
    // @ts-expect-error Fallback data cannot replace a statically known resource key.
    dataId: "Default",
    loadTestData,
  });
  const hidden: FallbackTestSuite<WithTestData> = createTestRunnerWithDefaults({
    createResources: (): Record<string, unknown> => resource,
    // @ts-expect-error Fallback data cannot replace a statically known resource key.
    dataId: "Default",
    loadTestData,
  });
  hidden.withData("Other")("collision", (): never => assert.fail("body ran after a collision"));
  const [collision] = await hidden.run();
  assert.ok(collision?.status === "failed" && collision.error instanceof Error);
  // biome-ignore lint/performance/useTopLevelRegex: OK
  assert.match(collision.error.message, /already contains the key "testData"/);
});

await test("missing data skips setup and a partial provider failure unwinds every acquisition", async (): Promise<void> => {
  const events: string[] = [];
  const suite: TestSuite<MockResources> = createTestRunner({
    createResources: ({ scope }: TestInfo): Promise<MockResources> =>
      createMockResources(scope, events),
    loadTestData: (id: string): Promise<TestData | undefined> => {
      events.push(`data: ${id}`);
      return Promise.resolve(TEST_DATA.get(id));
    },
  });
  const setupError = new Error("provider failed");
  const closePageError = new Error("extra page cleanup failed");
  const closeTokenError = new Error("token cleanup failed");
  const extraPage: TestRunner<
    MockResources & {
      otherPage: MockPage;
    }
  > = suite.extend(
    async (
      { browser }: Readonly<MockResources>,
      { scope }: TestInfo,
    ): Promise<{
      otherPage: MockPage;
    }> => ({
      otherPage: await scope.acquire(
        (): Promise<MockPage> => browser.newPage(),
        async (page: MockPage): Promise<never> => {
          await page.close();
          throw closePageError;
        },
      ),
    }),
  );
  const broken: TestRunner<
    MockResources & {
      otherPage: MockPage;
    } & Promise<never>
  > = extraPage.extend(
    async (
      _context: Readonly<
        MockResources & {
          otherPage: MockPage;
        }
      >,
      { scope }: TestInfo,
    ): Promise<never> => {
      await scope.acquire(
        (): string => "token",
        (): never => {
          events.push("token: close");
          throw closeTokenError;
        },
      );
      throw setupError;
    },
  );
  extraPage.withData("missing")("bad id", (): never => assert.fail("body ran"));
  broken("bad provider", (): never => assert.fail("body ran"));
  suite("smoke", async ({ apiClient }: MockResources): Promise<void> => {
    assert.equal(await apiClient.ping(), "pong");
    events.push("smoke");
  });

  const [missing, failed, passed] = await suite.run();
  assert.ok(missing?.status === "failed" && missing.error instanceof Error);
  // biome-ignore lint/performance/useTopLevelRegex: OK
  assert.match(missing.error.message, /Unknown test data ID "missing" in test "bad id"/);
  assert.ok(failed?.status === "failed" && failed.error instanceof AggregateError);
  assert.deepEqual(failed.error.errors, [setupError, closeTokenError, closePageError]);
  assert.equal(passed?.status, "passed");
  const open: string[] = ["server: start", "browser: launch", "page: create", "apiClient: create"];
  const close: string[] = ["apiClient: close", "page: close", "browser: close", "server: close"];
  assert.deepEqual(events, [
    "data: missing",
    ...open,
    "page: create",
    "token: close",
    "page: close",
    ...close,
    ...open,
    "smoke",
    ...close,
  ]);
});

await test("extensions reject existing string, symbol and testData keys", async (): Promise<void> => {
  const label: unique symbol = Symbol("label");
  const suite: TestSuite<{
    port: number;
  }> = createTestRunner({
    createResources: (): { port: number } => ({ port: 80 }),
    // oxlint-disable-next-line legibility/no-trivial-wrapper-functions
    loadTestData: (id: string): TestData | undefined => TEST_DATA.get(id),
  });
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const neverRun: () => never = (): never => assert.fail("body ran after a collision");
  // @ts-expect-error Even a replacement of the same type is a collision.
  suite.extend((): { port: number } => ({ port: 81 }))("base key", neverRun);
  const tagged: TestRunner<
    {
      port: number;
    } & object
  > = suite.extend((): Record<symbol, boolean> => ({ [label]: true }));
  const hiddenSymbol: object = { [label]: false };
  tagged.extend((): object => hiddenSymbol)("extension key", neverRun);
  const hiddenData: object = { testData: 0 };
  suite.extend((): object => hiddenData).withData("Default")("data key", neverRun);
  const withData: TestRunner<
    WithTestData<{
      port: number;
    }>
  > = suite.withData("Default").configure({});

  assert.throws(
    (): void => {
      // @ts-expect-error A runner with testData cannot select another data ID.
      withData.withData("again");
    },
    // biome-ignore lint/performance/useTopLevelRegex: OK
    /already selected/,
  );

  const results: readonly TestResult[] = await suite.run();
  assert.deepEqual(
    results.map((result: TestResult): string => {
      assert.ok(result.status === "failed" && result.error instanceof Error);
      return result.error.message;
    }),
    [
      'Test context already contains the key "port".',
      'Test context already contains the key "Symbol(label)".',
      'Test context already contains the key "testData".',
    ],
  );
});

await test("overlapping runs reject and late registrations wait for the next run", async (): Promise<void> => {
  const suite: TestSuite<object> = createTestRunner({
    createResources: (): object => ({}),
    loadTestData: (): undefined => undefined,
  });
  const child: TestRunner<object> = suite.configure({});
  const entered: {
    promise: Promise<void>;
    resolve: (value?: void | PromiseLike<void>) => void;
    reject: (reason?: unknown) => void;
  } = Promise.withResolvers<void>();
  const release: {
    promise: Promise<void>;
    resolve: (value?: void | PromiseLike<void>) => void;
    reject: (reason?: unknown) => void;
  } = Promise.withResolvers<void>();
  child("first", async (): Promise<void> => {
    child("late from body", (): void => {
      /* noop */
    });
    entered.resolve();
    await release.promise;
  });
  const running: Promise<readonly TestResult[]> = suite.run();
  await entered.promise;
  try {
    suite("late from caller", (): never => {
      // oxlint-disable-next-line typescript/only-throw-error
      throw undefined;
    });
    // biome-ignore lint/performance/useTopLevelRegex: The regex is used for assertion, not performance-critical.
    await assert.rejects(suite.run(), /already running/);
  } finally {
    release.resolve();
  }

  const first: readonly TestResult[] = await running;
  assert.deepEqual(
    first.map((result: TestResult): string[] => [result.title, result.status]),
    [["first", "passed"]],
  );
  const next: readonly TestResult[] = await suite.run();
  assert.deepEqual(
    next.map((result: TestResult): string[] => [result.title, result.status]),
    [
      ["late from body", "passed"],
      ["late from caller", "failed"],
    ],
  );
  const failure: TestResult | undefined = next[1];
  assert.ok(failure?.status === "failed" && Object.hasOwn(failure, "error"));
  assert.equal(failure.error, undefined);
  assert.deepEqual(await suite.run(), []);
});
