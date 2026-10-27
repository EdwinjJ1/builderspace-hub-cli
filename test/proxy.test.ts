import { describe, expect, it, vi } from "vitest";

import { enableEnvProxy, maskProxy, matchesNoProxy, proxyRoute } from "../src/core/proxy.js";

describe("enableEnvProxy", () => {
  const node = (setGlobalProxyFromEnv?: (env: object) => unknown, execArgv: string[] = []) => ({
    setGlobalProxyFromEnv,
    execArgv,
  });

  it("switches fetch onto the proxy variables when one is set", () => {
    const set = vi.fn();
    const env = { HTTPS_PROXY: "http://127.0.0.1:7897" };
    expect(enableEnvProxy(env, node(set))).toBe("active");
    expect(set).toHaveBeenCalledWith(env);
  });

  it("leaves Node alone when no proxy is set", () => {
    const set = vi.fn();
    expect(enableEnvProxy({ NO_PROXY: "localhost" }, node(set))).toBe("active");
    expect(set).not.toHaveBeenCalled();
  });

  it("trusts NODE_USE_ENV_PROXY and --use-env-proxy, even on a Node that cannot switch at run time", () => {
    expect(enableEnvProxy({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://p:1" }, node())).toBe("active");
    expect(enableEnvProxy({ HTTPS_PROXY: "http://p:1" }, node(undefined, ["--use-env-proxy"]))).toBe("active");
  });

  it("says when this Node cannot follow the variables", () => {
    expect(enableEnvProxy({ HTTPS_PROXY: "http://p:1" }, node())).toBe("unsupported");
  });

  it("survives a proxy Node refuses, instead of failing every command", () => {
    const set = vi.fn(() => {
      throw new Error("ERR_PROXY_INVALID_CONFIG");
    });
    expect(enableEnvProxy({ HTTPS_PROXY: "127.0.0.1:7897" }, node(set))).toBe("rejected");
  });
});

describe("proxyRoute", () => {
  it("uses the variable for the Hub's scheme, lower case first, with no fallback", () => {
    expect(proxyRoute({ HTTPS_PROXY: "http://a:1", https_proxy: "http://b:2" }, "https://hub.example.test")).toEqual({
      variable: "https_proxy",
      proxy: "http://b:2",
      valid: true,
      bypassed: false,
    });
    expect(proxyRoute({ HTTP_PROXY: "http://a:1" }, "https://hub.example.test")).toMatchObject({
      variable: "HTTPS_PROXY",
      proxy: null,
    });
    expect(proxyRoute({ HTTP_PROXY: "http://a:1" }, "http://localhost:3210")).toMatchObject({
      variable: "HTTP_PROXY",
      proxy: "http://a:1",
    });
  });

  it("only accepts a full http(s) URL", () => {
    expect(proxyRoute({ HTTPS_PROXY: "127.0.0.1:7897" }, "https://h.test").valid).toBe(false);
    expect(proxyRoute({ HTTPS_PROXY: "socks5://127.0.0.1:7897" }, "https://h.test").valid).toBe(false);
    expect(proxyRoute({ HTTPS_PROXY: "https://proxy.test:443" }, "https://h.test").valid).toBe(true);
  });

  it("goes direct for a Hub in NO_PROXY, lower case first", () => {
    const env = { HTTP_PROXY: "http://p:1", NO_PROXY: "localhost", no_proxy: "other.test" };
    expect(proxyRoute(env, "http://localhost:3210").bypassed).toBe(false);
    expect(proxyRoute({ ...env, no_proxy: undefined }, "http://localhost:3210").bypassed).toBe(true);
  });
});

describe("maskProxy", () => {
  it("never shows a proxy password", () => {
    expect(maskProxy("http://user:secret@proxy.test:8080")).toBe("http://***@proxy.test:8080");
    expect(maskProxy("user:secret@proxy.test:8080")).toBe("***@proxy.test:8080");
    expect(maskProxy("http://127.0.0.1:7897/")).toBe("http://127.0.0.1:7897");
    expect(maskProxy("127.0.0.1:7897")).toBe("127.0.0.1:7897");
  });
});

describe("matchesNoProxy", () => {
  const hub = new URL("https://hub.example.test");

  it("matches the forms Node documents", () => {
    expect(matchesNoProxy("*", hub)).toBe(true);
    expect(matchesNoProxy("hub.example.test", hub)).toBe(true);
    expect(matchesNoProxy("example.test", hub)).toBe(false);
    expect(matchesNoProxy(".example.test", hub)).toBe(true);
    expect(matchesNoProxy("*.example.test", hub)).toBe(true);
    expect(matchesNoProxy(" localhost , HUB.example.test ", hub)).toBe(true);
  });

  it("honours ports and IPv6 hosts", () => {
    expect(matchesNoProxy("hub.example.test:443", hub)).toBe(true);
    expect(matchesNoProxy("hub.example.test:8443", hub)).toBe(false);
    expect(matchesNoProxy("::1", new URL("http://[::1]:3210"))).toBe(true);
    expect(matchesNoProxy("[::1]:3210", new URL("http://[::1]:3210"))).toBe(true);
    expect(matchesNoProxy("127.0.0.1", new URL("http://127.0.0.1:3210"))).toBe(true);
  });
});
