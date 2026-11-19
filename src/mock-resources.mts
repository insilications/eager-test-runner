import type { TestData } from "./test-data.mjs";
import type { ResourceScope, TestInfo, WithTestData } from "./test-runner.mjs";

export class MockPage {
  public constructor(private readonly events: string[]) {}
  // oxlint-disable-next-line typescript/require-await
  public async goto(url: string): Promise<void> {
    this.events.push(`page: goto ${url}`);
  }
  // oxlint-disable-next-line typescript/require-await
  public async close(): Promise<void> {
    this.events.push("page: close");
  }
}

// These classes are deliberately small and require no browser or network.
// The events array makes setup/teardown order easy to observe and assert.
export class MockServer {
  public constructor(private readonly events: string[]) {}
  // oxlint-disable-next-line typescript/require-await
  public static async start(events: string[]): Promise<MockServer> {
    events.push("server: start");
    return new MockServer(events);
  }
  // oxlint-disable-next-line typescript/require-await
  public async close(): Promise<void> {
    this.events.push("server: close");
  }
}

export class MockBrowser {
  public constructor(private readonly events: string[]) {}
  // oxlint-disable-next-line typescript/require-await
  public static async launch(events: string[], testData: TestData): Promise<MockBrowser> {
    events.push(`browser: launch with ${testData.codemarkPath}`);
    return new MockBrowser(events);
  }
  // oxlint-disable-next-line typescript/require-await
  public async newPage(): Promise<MockPage> {
    this.events.push("page: create");
    return new MockPage(this.events);
  }
  // oxlint-disable-next-line typescript/require-await
  public async close(): Promise<void> {
    this.events.push("browser: close");
  }
}

export class MockApiClient {
  public constructor(private readonly events: string[]) {
    events.push("apiClient: create");
  }
  // oxlint-disable-next-line typescript/require-await
  public async ping(): Promise<string> {
    return "pong";
  }
  // oxlint-disable-next-line typescript/require-await
  public async close(): Promise<void> {
    this.events.push("apiClient: close");
  }
}

export interface MockResources {
  apiClient: MockApiClient;
  browser: MockBrowser;
  page: MockPage;
  server: MockServer;
}

/** Initialize all four resources, with cleanup registered per acquisition. */
export async function createMockResources(
  events: string[],
  context: Readonly<WithTestData>,
  testInfo: Readonly<TestInfo>,
): Promise<MockResources> {
  const scope: ResourceScope = testInfo.scope;
  const server: MockServer = await scope.acquire(
    (): Promise<MockServer> => MockServer.start(events),
    (value: MockServer): Promise<void> => value.close(),
  );
  const browser: MockBrowser = await scope.acquire(
    (): Promise<MockBrowser> => MockBrowser.launch(events, context.testData),
    (value: MockBrowser): Promise<void> => value.close(),
  );
  const page: MockPage = await scope.acquire(
    (): Promise<MockPage> => browser.newPage(),
    (value: MockPage): Promise<void> => value.close(),
  );
  const apiClient: MockApiClient = await scope.acquire(
    (): MockApiClient => new MockApiClient(events),
    (value: MockApiClient): Promise<void> => value.close(),
  );

  return { apiClient, browser, page, server };
}
